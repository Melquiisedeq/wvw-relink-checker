#!/usr/bin/env python3
"""Is wvwrelink.com/api still being fed, still answering, and still shut?

The two Apps Scripts push after every tick, and a push that stops is silent:
the sheets carry on, the page falls back to them, and the history in D1 just
thins out. /api/health says when each source last reported, which is the one
thing to ask from outside.

Then the reads the page tries first, in the shape it reads them - a read
that fails costs the page nothing, since it falls back to the sheets, which is
exactly why nobody would notice it failing. With the summary fresh, /api/latest
must answer 200 and each region's /api/history must hold matches: status and
shape only.

The Supabase readers (supabase/reader.mjs) deliver to /api every 20 s from
both sides: both must have delivered lately, the summary of the matches must be
fresh and made of known sources, and it must not run ahead of the game's own
API - which only a stolen signing secret can do.

And the doors that must stay shut, each a status and no judgement: the
entrance takes no GET and no unsigned POST, and the Worker has no workers.dev
address (`workers_dev: false` in worker/wrangler.jsonc).

Run it by hand any time:  python3 scripts/check-worker.py
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
import urllib.error
import urllib.request

from workflow_text import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def worker_source():
    with open(os.path.join(ROOT, 'worker', 'index.mjs'), encoding='utf-8') as fh:
        return fh.read()


def worker_seconds(body, name):
    """A duration const of worker/index.mjs, in seconds.

    A product of numbers (`20 * 60`, `2 * 3600e3`); a name ending in _MS is
    milliseconds, any other seconds. Anything else stops the check, since a
    guess at the unit would read a deadline as 0 or as a thousand times too much.

    Read, not copied, so a deadline changed there cannot leave this check
    asking /api/latest of a Worker that already answers 503 on purpose.
    """
    m = re.search(r'const %s\s*=\s*([\d.e]+(?:\s*\*\s*[\d.e]+)*)\s*;'
                  % re.escape(name), body)
    try:
        product = 1.0
        for factor in m.group(1).split('*'):
            product *= float(factor)
    except (AttributeError, ValueError):
        raise SystemExit('worker/index.mjs no longer has `const %s = a * b;`: '
                         'update worker_seconds in this file.' % name)
    return int(product / 1000 if name.endswith('_MS') else product)


def worker_reset(body):
    """RESET of worker/index.mjs as {region: (day, hour)}."""
    m = re.search(r'const RESET\s*=\s*\{(.*?)\};', body)
    found = re.findall(r'(\d+):\s*\{\s*day:\s*(\d+),\s*hour:\s*(\d+)\s*\}',
                       m.group(1)) if m else []
    if not found:
        raise SystemExit('worker/index.mjs no longer has RESET as '
                         '{ n: { day, hour } }: update worker_reset in this file.')
    return {int(r): (int(d), int(h)) for r, d, h in found}


def worker_sources(body):
    """The names the Worker's entrance accepts, from its SOURCES table."""
    m = re.search(r'const SOURCES\s*=\s*\{(.*?)\};', body, re.S)
    names = re.findall(r"'?([\w-]+)'?\s*:\s*'INGEST_", m.group(1)) if m else []
    if not names:
        raise SystemExit('worker/index.mjs no longer has SOURCES as '
                         '{ name: \'INGEST_...\' }: update worker_sources.')
    return names


WORKER = worker_source()

API = 'https://wvwrelink.com/api/'
GAME_MATCHES = 'https://api.guildwars2.com/v2/wvw/matches?ids=all'
WORKERS_DEV = 'https://wvwrelink-api.wvwgw2.workers.dev/api/health'
ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 30
# Kills and relink tick every 5 minutes; past the Worker's STALE_KILLS_S and
# STALE_RELINK_S the reads already answer 503.
# Kills is the exception for the report: kills.gs pushes only when a match's
# score rose, and the GW2 API can serve frozen data for about an hour, so a
# silent kills source is reported only past 90 minutes.
# Between 20 and 90 the Worker's 503 is the honest answer and is not a failure.
STALE = {'kills': 90 * 60,
         'relink': worker_seconds(WORKER, 'STALE_RELINK_S')}
KILLS_WORKER_STALE = worker_seconds(WORKER, 'STALE_KILLS_S')
MATCH_RE = re.compile(r'^[12]-[1-9]$')
# The readers deliver only when something is newer, so a frozen game API
# silences them with no fault of ours: same 90 minutes as kills.
LATEST_REQUIRED = ('latest-supa-us', 'latest-supa-eu')
LATEST_STALE = 90 * 60
# The cleanup runs daily (worker/wrangler.jsonc, crons); 2 h of slack.
CLEANUP_STALE = 26 * 3600
# The summary may lead a stale read of the game's API by at most 600 points a
# minute for the 70 minutes the API can lag; past it, a score the game never
# had, which only a stolen signing secret could send.
SCORE_LEAD_MAX = 600 * 70
# Past it /api/latest answers 503.
LATEST_WORKER_STALE = worker_seconds(WORKER, 'STALE_LATEST_S')
# When a region's week starts, UTC (day 0 = Sunday).
RESET = worker_reset(WORKER)
SKIRMISH_SECONDS = worker_seconds(WORKER, 'SKIRMISH_MS')


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


game_down = []


def game_api_down():
    """True when the game's own API does not answer (retried); asked only once
    a source is already late, since neither kills.gs nor the Supabase readers
    have anything to write without it."""
    if not game_down:
        data, why = get_json(GAME_MATCHES)
        game_down.append(why is not None or not isinstance(data, list) or not data)
    return game_down[0]


def supabase_late(what, otherwise):
    """`what` plus its cause: the game API when it is down, else `otherwise`."""
    if game_api_down():
        return (what + ' The game API is not answering, so the Supabase readers '
                'have nothing to deliver. This clears when the game API is back.')
    return what + ' ' + otherwise


def check_feeds(problems, notes):
    data, why = get_json(API + 'health')
    if why:
        problems.append('/api/health: %s. The Worker or its database is down.' % why)
        return
    now = int(time.time())
    check_latest_feeds(data, now, problems, notes)
    check_cleanup(data, now, problems, notes)
    kills_at = data.get('kills')
    if is_int(kills_at) and kills_at:
        kills_age[0] = now - kills_at
    for source, limit in sorted(STALE.items()):
        at = data.get(source)
        if not is_int(at) or at == 0:
            problems.append('/api/health has never heard from %s.' % source)
            continue
        age = now - at
        if age > limit:
            if source == 'kills' and game_api_down():
                problems.append(
                    "The game API is not answering, so kills.gs has nothing to "
                    "write; kills last reported %d minutes ago. This clears when "
                    "the game API is back." % (age // 60))
                continue
            problems.append(
                '%s last reported %d minutes ago (limit %d). Its Apps Script '
                'stopped pushing: the trigger, the ingest property, or the '
                'Worker secret INGEST_%s.'
                % (source, age // 60, limit // 60, source.upper()))
        else:
            notes.append('%-34s %d min ago' % (source + ' last reported', age // 60))


def check_latest_feeds(data, now, problems, notes):
    for source in LATEST_REQUIRED:
        at = data.get(source)
        if not is_int(at) or at == 0:
            problems.append('/api/health has never heard from %s. Check the '
                            'Supabase reader and its secret.' % source)
        elif now - at > LATEST_STALE:
            problems.append(supabase_late(
                '%s last delivered %d minutes ago (limit %d).'
                % (source, (now - at) // 60, LATEST_STALE // 60),
                'Check the Supabase reader; a frozen game API passes on its own.'))
        else:
            notes.append('%-34s %d min ago' % (source + ' last delivered', (now - at) // 60))


def check_cleanup(data, now, problems, notes):
    at = data.get('cleanup')
    if not is_int(at) or at == 0:
        problems.append('/api/health has never heard from the daily cleanup. '
                        'Check its cron on the Worker wvwrelink-api.')
    elif now - at > CLEANUP_STALE:
        problems.append(
            'The daily cleanup last ran %d hours ago (limit %d). Check its cron '
            'on the Worker wvwrelink-api.' % ((now - at) // 3600, CLEANUP_STALE // 3600))
    else:
        notes.append('%-34s %d h ago' % ('cleanup last ran', (now - at) // 3600))


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


def week_start(region, now):
    """The start of the region's week that holds `now`, epoch seconds."""
    day, hour = RESET[region]
    d = datetime.fromtimestamp(now, timezone.utc)
    start = int(d.replace(hour=hour, minute=0, second=0, microsecond=0).timestamp())
    start -= ((d.weekday() + 1 - day) % 7) * 86400
    return start - 7 * 86400 if start > now else start


def check_copy(age, now, problems, notes):
    """/api/latest and /api/history, asked only while the summary is fresh."""
    if age > LATEST_WORKER_STALE:
        return
    _, why = get_json(API + 'latest')
    if why:
        problems.append('/api/latest: %s while the summary is fresh. The page is '
                        'reading the game alone.' % why)
    else:
        notes.append('%-34s HTTP 200' % '/api/latest')
    for region in sorted(RESET):
        n = (now - week_start(region, now)) // SKIRMISH_SECONDS
        if n < 2:
            notes.append('%-34s skipped, week just begun' % ('/api/history/%d' % region))
            continue
        why = None
        for v in (n, n - 1):
            data, why = get_json('%shistory/%d?v=%d' % (API, region, v))
            if why is None and isinstance(data, dict) and data.get('matches'):
                notes.append('%-34s v=%d, %d matches' % (
                    '/api/history/%d' % region, v, len(data['matches'])))
                break
            if why is None:
                why = 'no matches'
        else:
            problems.append('/api/history/%d: %s for v=%d and v=%d while the summary '
                            'is fresh. The readers are not sending the histories.'
                            % (region, why, n, n - 1))


def check_latest(problems, notes):
    data, why = get_json(API + 'latest/summary')
    if why:
        problems.append('/api/latest/summary: %s. The Supabase readers are not '
                        'reaching the summary.' % why)
        return
    if not isinstance(data, dict) or not data:
        problems.append('/api/latest/summary answered without matches.')
        return
    now = int(time.time())
    bad = [k for k, v in data.items() if not (
        MATCH_RE.match(k) and isinstance(v, dict) and is_int(v.get('start'))
        and is_int(v.get('score')) and is_int(v.get('at'))
        and v.get('by') in LATEST_REQUIRED)]
    if bad:
        problems.append('/api/latest/summary: %d of %d matches are not {start, '
                        'score, at, by} from a known latest-* source, e.g. %s'
                        % (len(bad), len(data), json.dumps({bad[0]: data[bad[0]]})[:120]))
        return
    counts = {}
    for v in data.values():
        counts[v['by']] = counts.get(v['by'], 0) + 1
    notes.append('summary: %d matches, %s' % (len(data), ', '.join(
        '%s %d' % kv for kv in sorted(counts.items()))))
    # A tier that left at a relink stays in the summary for up to 2 hours
    # (LATEST_KEEP_S), so only this week's matches are judged.
    current = [v['at'] for k, v in data.items()
               if v['start'] // 1000 >= week_start(int(k[0]), now)]
    oldest = now - min(current) if current else 0
    if oldest > LATEST_STALE:
        problems.append(supabase_late(
            '/api/latest/summary: the oldest match is %d minutes old (limit %d).'
            % (oldest // 60, LATEST_STALE // 60),
            'Check the Supabase readers.'))
    check_copy(now - max(v['at'] for v in data.values()), now, problems, notes)
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
            'a signing secret may be stolen (%s). Rotate the INGEST_LATEST_* '
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
    doors = [('GET on the entrance', API + 'ingest/kills', 'GET', None, 405)]
    doors += [('unsigned POST %s' % name, API + 'ingest/' + name, 'POST', b'{}', 401)
              for name in worker_sources(WORKER)]
    for label, url, method, body, want in doors + [
            ('workers.dev address', WORKERS_DEV, 'GET', None, 404)]:
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
    check_latest(problems, notes)
    check_doors(problems, notes)
    for n in notes:
        print(n)
    for p in problems:
        print('::error::' + escape(p))
    if problems:
        print('\n%d problem(s).' % len(problems))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
