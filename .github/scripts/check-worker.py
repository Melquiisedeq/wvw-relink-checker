#!/usr/bin/env python3
"""Is wvwrelink.com/api still being fed, still answering, and still shut?

The two Apps Scripts push after every tick, and a push that stops is silent:
the sheets carry on, the page falls back to them, and the history in D1 just
thins out. /api/saude says when each source last reported, which is the one
thing to ask from outside.

Then the two reads the page tries first, in the shape it reads them - a read
that fails costs the page nothing, since it falls back to the sheets, which is
exactly why nobody would notice it failing.

The Supabase readers (supabase/leitor.mjs) deliver to /api every 2 minutes from
both sides: both must have delivered lately, the summary of the matches must be
fresh and made of known sources, and it must not run ahead of the game's own
API - which only a stolen signing secret can do.

And the doors that must stay shut, each a status and no judgement: the
entrance takes no GET and no unsigned POST, and the Worker has no workers.dev
address (`workers_dev: false` in worker/wrangler.jsonc).

Run it by hand any time:  python .github/scripts/check-worker.py
"""

import json
import re
import sys
import time
from datetime import datetime
import urllib.error
import urllib.request

API = 'https://wvwrelink.com/api/'
GAME_MATCHES = 'https://api.guildwars2.com/v2/wvw/matches?ids=all'
WORKERS_DEV = 'https://wvwrelink-api.wvwgw2.workers.dev/api/saude'
ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 30
# The Worker's own STALE_KILLS_S and STALE_RELINK_S: kills ticks every 5
# minutes, relink every 15. Past these the reads already answer 503.
# Kills is the exception for the report: kills.gs pushes only when a match's
# score rose, and the GW2 API has served frozen data for up to ~60 min (seen
# 02-03/10/2026), so a silent kills source is reported only past 90 minutes.
# Between 20 and 90 the Worker's 503 is the honest answer and is not a failure.
STALE = {'kills': 90 * 60, 'relink': 45 * 60}
KILLS_WORKER_STALE = 20 * 60
MATCH_RE = re.compile(r'^[12]-[1-9]$')
# The readers deliver only when something is newer, so a frozen game API (~65
# min seen) silences them with no fault of ours: same 90 minutes as kills.
# agora-vercel-* do not exist yet (0 is normal), so they are not required.
AGORA_REQUIRED = ('agora-supa-us', 'agora-supa-eu')
AGORA_SOURCES = AGORA_REQUIRED + ('agora-vercel-eu', 'agora-vercel-us')
AGORA_STALE = 90 * 60
# The summary may lead a stale read of the game's API by at most 600 points a
# minute for the 70 minutes the API has been seen to lag; past it, a score the
# game never had, which only a stolen signing secret could send.
SCORE_LEAD_MAX = 600 * 70


def request(url, method='GET', body=None):
    """(status, body) - a 4xx or 5xx included - or (None, error)."""
    try:
        req = urllib.request.Request(
            url, data=body, method=method,
            headers={'User-Agent': 'wvwrelink-health-check'})
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
            return res.status, res.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as exc:
        return exc.code, ''
    except Exception as exc:
        return None, '%s: %s' % (type(exc).__name__, exc)


def get_json(url):
    """The parsed body of a 200, retried; or (None, why)."""
    why = None
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(PAUSE_SECONDS)
        status, body = request(url)
        if status == 200:
            try:
                return json.loads(body), None
            except ValueError:
                why = 'not JSON'
        else:
            why = 'HTTP %s' % status if status else body
    return None, '%s after %d attempts' % (why, ATTEMPTS)


def is_int(n):
    return isinstance(n, int) and not isinstance(n, bool) and n >= 0


kills_age = [None]


def check_feeds(problems, notes):
    data, why = get_json(API + 'saude')
    if why:
        problems.append('/api/saude: %s. The Worker or its database is down.' % why)
        return
    now = int(time.time())
    check_agora_feeds(data, now, problems, notes)
    kills_at = data.get('kills')
    if is_int(kills_at) and kills_at:
        kills_age[0] = now - kills_at
    for source, limit in sorted(STALE.items()):
        at = data.get(source)
        if not is_int(at) or at == 0:
            problems.append('/api/saude has never heard from %s.' % source)
            continue
        age = now - at
        if age > limit:
            problems.append(
                '%s last reported %d minutes ago (limit %d). Its Apps Script '
                'stopped pushing: the trigger, the entrada property, or the '
                'Worker secret ENTRADA_%s - .claude/docs/api.md.'
                % (source, age // 60, limit // 60, source.upper()))
        else:
            notes.append('%-34s %d min ago' % (source + ' last reported', age // 60))


def check_agora_feeds(data, now, problems, notes):
    for source in AGORA_REQUIRED:
        at = data.get(source)
        if not is_int(at) or at == 0:
            problems.append('/api/saude has never heard from %s. Check the '
                            'Supabase reader and its secret.' % source)
        elif now - at > AGORA_STALE:
            problems.append(
                '%s last delivered %d minutes ago (limit %d). Check the '
                'Supabase reader; a frozen game API passes on its own.'
                % (source, (now - at) // 60, AGORA_STALE // 60))
        else:
            notes.append('%-34s %d min ago' % (source + ' last delivered', (now - at) // 60))
    notes.append('agora-vercel-*: not required yet (%s)' % ', '.join(
        '%s=%s' % (k, data.get(k)) for k in AGORA_SOURCES[2:]))


def game_scores():
    """{start in ms: sum of the scores} from the game's API, or None."""
    data, why = get_json(GAME_MATCHES)
    if why or not isinstance(data, list):
        return None
    out = {}
    try:
        for m in data:
            start = int(datetime.fromisoformat(
                m['start_time'].replace('Z', '+00:00')).timestamp() * 1000)
            out[(m['id'], start)] = sum(m['scores'].values())
    except (KeyError, TypeError, ValueError, AttributeError):
        return None
    return out


def check_agora(problems, notes):
    data, why = get_json(API + 'agora/resumo')
    if why:
        problems.append('/api/agora/resumo: %s. The Supabase readers are not '
                        'reaching the summary.' % why)
        return
    if not isinstance(data, dict) or not data:
        problems.append('/api/agora/resumo answered without matches.')
        return
    now = int(time.time())
    bad = [k for k, v in data.items() if not (
        MATCH_RE.match(k) and isinstance(v, dict) and is_int(v.get('start'))
        and is_int(v.get('score')) and is_int(v.get('at'))
        and v.get('by') in AGORA_SOURCES)]
    if bad:
        problems.append('/api/agora/resumo: %d of %d matches are not {start, '
                        'score, at, by} from a known agora-* source, e.g. %s'
                        % (len(bad), len(data), json.dumps({bad[0]: data[bad[0]]})[:120]))
        return
    counts = {}
    for v in data.values():
        counts[v['by']] = counts.get(v['by'], 0) + 1
    notes.append('resumo: %d matches, %s' % (len(data), ', '.join(
        '%s %d' % kv for kv in sorted(counts.items()))))
    age = now - max(v['at'] for v in data.values())
    if age > AGORA_STALE:
        problems.append('/api/agora/resumo: newest match is %d minutes old '
                        '(limit %d). Check the Supabase readers.'
                        % (age // 60, AGORA_STALE // 60))
    game = game_scores()
    if game is None:
        notes.append('game API unreadable: the secret-theft alarm did not run')
        return
    ahead = [k for k, v in sorted(data.items())
             if (k, v['start']) in game
             and v['score'] > game[(k, v['start'])] + SCORE_LEAD_MAX]
    if ahead:
        problems.append(
            'the summary is ahead of the game by more than the API can lag: '
            'a signing secret may be stolen (%s). Rotate the ENTRADA_AGORA_* '
            'secrets.' % ', '.join(ahead))
    else:
        notes.append('%-34s %d matches compared' % ('summary vs game API', sum(
            1 for k, v in data.items() if (k, v['start']) in game)))


def check_reads(problems, notes):
    data, why = get_json(API + 'kills')
    rows = data.get('rows') if isinstance(data, dict) else None
    age = kills_age[0]
    if why and 'HTTP 503' in why and age is not None \
            and KILLS_WORKER_STALE < age <= STALE['kills']:
        notes.append('%-34s 503 stale, source quiet %d min (frozen API?)'
                     % ('/api/kills', age // 60))
    elif why:
        problems.append('/api/kills: %s. The page is reading the kills sheet.' % why)
    elif not isinstance(rows, list) or not rows:
        problems.append('/api/kills answered without rows.')
    else:
        bad = [r for r in rows if not (
            isinstance(r, list) and len(r) == 6 and is_int(r[0])
            and isinstance(r[1], str) and MATCH_RE.match(r[1])
            and all(is_int(n) for n in r[2:]))]
        if bad:
            problems.append('/api/kills: %d of %d rows are not '
                            '[at, match, center, red, blue, green], e.g. %s'
                            % (len(bad), len(rows), json.dumps(bad[0])[:120]))
        else:
            notes.append('%-34s %d rows' % ('/api/kills', len(rows)))

    data, why = get_json(API + 'relink')
    if why:
        problems.append('/api/relink: %s. The page is reading the relink sheet.' % why)
    elif not (isinstance(data, dict) and is_int(data.get('window'))
              and is_int(data.get('published'))):
        problems.append('/api/relink is not {window, published} as integers: %s'
                        % json.dumps(data)[:120])
    else:
        notes.append('%-34s %s:%s' % ('/api/relink', data['window'], data['published']))


def check_doors(problems, notes):
    for label, url, method, body, want in (
            ('GET on the entrance', API + 'entrada/kills', 'GET', None, 405),
            ('unsigned POST', API + 'entrada/kills', 'POST', b'{}', 401),
            ('unsigned POST agora-supa-us', API + 'entrada/agora-supa-us', 'POST', b'{}', 401),
            ('unsigned POST agora-supa-eu', API + 'entrada/agora-supa-eu', 'POST', b'{}', 401),
            ('workers.dev address', WORKERS_DEV, 'GET', None, 404)):
        status, _ = request(url, method, body)
        if status != want:
            problems.append('%s answered %s, expected %s: %s %s'
                            % (label, status, want, method, url))
        else:
            notes.append('%-34s HTTP %s' % (label, status))


def main():
    problems, notes = [], []
    check_feeds(problems, notes)
    check_reads(problems, notes)
    check_agora(problems, notes)
    check_doors(problems, notes)
    for n in notes:
        print(n)
    for p in problems:
        print('::error::' + p)
    if problems:
        print('\n%d problem(s).' % len(problems))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
