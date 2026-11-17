#!/usr/bin/env python3
"""Is the D1 database still far from its daily write limit?

The Free plan allows 100,000 rows written a day, and past it D1 refuses every
write until 00:00 UTC: the push from the Apps Scripts and the readers stops
without a sound, and the page falls back to the sheets. Nothing outside the
account can read that number, so this asks Cloudflare's GraphQL Analytics for
`rowsWritten` of yesterday and of today (UTC) and fails when either passes
80,000. Cloudflare says these figures are not the billing ones.

Needs, from the environment and never printed:
  CLOUDFLARE_ANALYTICS_TOKEN   a token with Account Analytics: Read, nothing else
  CLOUDFLARE_ACCOUNT_ID        32 hex characters

The database ID is read from worker/wrangler.jsonc. A failure prints the
status or the error codes of the answer, never its body.

Yesterday with no rows at all fails too: the readers write tens of thousands
a day, so zero means the query reads the wrong database or an empty dataset,
and the alarm would stay green for ever. Today may still be empty just after
00:00 UTC.

Run it by hand any time (with both set):  python3 scripts/check-d1-writes.py
"""

import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
import urllib.error
import urllib.request

from workflow_text import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql'
LIMIT = 80000
TIMEOUT_SECONDS = 30
ACCOUNT_RE = re.compile(r'[0-9a-f]{32}')
DATABASE_RE = re.compile(
    r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
DATE_RE = re.compile(r'\d{4}-\d{2}-\d{2}')


def database_id():
    """The D1 database ID of worker/wrangler.jsonc, read and not copied."""
    with open(os.path.join(ROOT, 'worker', 'wrangler.jsonc'), encoding='utf-8') as fh:
        m = re.search(r'"database_id"\s*:\s*"([^"]*)"', fh.read())
    if not m or not DATABASE_RE.fullmatch(m.group(1)):
        print('::error::worker/wrangler.jsonc no longer has a "database_id" that is a '
              'UUID: update database_id in check-d1-writes.py.')
        raise SystemExit(1)
    return m.group(1)


def build_query(account, database, first, last):
    """The query with its values written in, each one checked first.

    No variables: nothing here depends on the declared type of one.
    """
    if not ACCOUNT_RE.fullmatch(account):
        raise ValueError('CLOUDFLARE_ACCOUNT_ID is not 32 hex characters.')
    for value in (first, last):
        if not DATE_RE.fullmatch(value):
            raise ValueError('Not a date: %r' % value)
    return (
        '{ viewer { accounts(filter: {accountTag: "%s"}) {'
        ' d1AnalyticsAdaptiveGroups(limit: 10, orderBy: [date_ASC],'
        ' filter: {databaseId: "%s", date_geq: "%s", date_leq: "%s"}) {'
        ' sum { rowsWritten } dimensions { date } } } } }'
        % (account, database, first, last))


def ask(token, query):
    """(parsed answer, None), or (None, why) with no part of the body in why."""
    req = urllib.request.Request(
        ENDPOINT, data=json.dumps({'query': query}).encode('utf-8'), method='POST',
        headers={'Authorization': 'Bearer ' + token,
                 'Content-Type': 'application/json',
                 'User-Agent': 'wvwrelink-health-check'})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
            return json.loads(res.read().decode('utf-8', 'replace')), None
    except urllib.error.HTTPError as exc:
        return None, 'HTTP %s' % exc.code
    except ValueError:
        return None, 'the answer is not JSON'
    except Exception as exc:
        return None, type(exc).__name__


def rows_by_date(answer):
    """({date: rowsWritten}, None), or (None, why): why names no part of the body."""
    if not isinstance(answer, dict):
        return None, 'the answer is not an object'
    errors = answer.get('errors')
    if errors:
        codes = []
        for e in errors if isinstance(errors, list) else []:
            ext = e.get('extensions') if isinstance(e, dict) else None
            code = ext.get('code') if isinstance(ext, dict) else None
            if isinstance(code, str) and re.fullmatch(r'^[\w-]{1,40}$', code):
                codes.append(code)
        return None, 'the API answered with %s error(s)%s' % (
            len(errors) if isinstance(errors, list) else 'some',
            ' (%s)' % ', '.join(sorted(set(codes))) if codes else '')
    try:
        accounts = answer['data']['viewer']['accounts']
        groups = accounts[0]['d1AnalyticsAdaptiveGroups']
        found = {}
        for g in groups:
            n = g['sum']['rowsWritten']
            if isinstance(n, bool) or not isinstance(n, int):
                raise TypeError
            found[g['dimensions']['date']] = found.get(g['dimensions']['date'], 0) + n
    except (KeyError, IndexError, TypeError):
        return None, ('the answer is not data.viewer.accounts[0]'
                      '.d1AnalyticsAdaptiveGroups of {sum.rowsWritten, dimensions.date}')
    return found, None


def judge(answer, first, last):
    """(line, problems) for the two days of an answer: nothing printed here."""
    found, why = rows_by_date(answer)
    if why:
        return None, ['D1 rows written: ' + why]
    counts = [(d, found.get(d, 0)) for d in (first, last)]
    line = 'D1 rows written (limit %d): %s' % (
        LIMIT, ', '.join('%s %d' % c for c in counts))
    problems = []
    if counts[0][1] == 0:
        problems.append('D1 rows written: none on %s, which the readers fill every '
                        'day: the query reads the wrong database or an empty dataset.'
                        % first)
    over = [d for d, n in counts if n > LIMIT]
    if over:
        problems.append(
            'D1 rows written passed %d on %s. At 100,000 the Free plan refuses every '
            'write until 00:00 UTC (developers.cloudflare.com/d1/platform/pricing/). '
            'The D1 page of the dashboard shows which tables and queries write; '
            'the figures here are not the billing ones '
            '(developers.cloudflare.com/d1/observability/metrics-analytics/).'
            % (LIMIT, ' and '.join(over)))
    return line, problems


def main():
    day = datetime.now(timezone.utc).date()
    first, last = (day - timedelta(days=1)).isoformat(), day.isoformat()
    token = os.environ.get('CLOUDFLARE_ANALYTICS_TOKEN', '')
    account = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
    missing = [n for n, v in (('CLOUDFLARE_ANALYTICS_TOKEN', token),
                              ('CLOUDFLARE_ACCOUNT_ID', account)) if not v]
    if missing:
        print('::error::%s not set: the job needs the repository secret(s).'
              % ' and '.join(missing))
        return 1
    try:
        query = build_query(account, database_id(), first, last)
    except ValueError as exc:
        print('::error::' + escape(exc))
        return 1
    answer, why = ask(token, query)
    if why:
        print('::error::' + escape('D1 rows written: ' + why))
        return 1
    line, problems = judge(answer, first, last)
    if line:
        print(line)
    for p in problems:
        print('::error::' + escape(p))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
