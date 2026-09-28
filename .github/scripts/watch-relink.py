#!/usr/bin/env python3
"""TEMPORARY. Delete this and relink-watch.yml after 03/10/2026.

One measurement, for one relink window, to answer one question: when does
ArenaNet publish the new team assignment?

It is known to happen before the relink rather than at it - Drevarr's
GW2-WVW-Teams history has a commit from 2025-11-05T22:24:32Z whose diff
shows alliances already on new teams while that month's relink was still two
days away. But that is somebody else's data from eleven months ago. Before
building a notice whose whole premise is that window, the window is worth
seeing once with our own eyes.

Deliberately stateless. It keeps no snapshot, writes no file, commits
nothing, and needs no token that can write. It prints a digest, and two runs
of it are compared by reading their logs. The reason is scope: a collector
that keeps state is a real piece of machinery with a real security surface,
and that decision belongs to the feature, not to a measurement.

Run it by hand any time:  python .github/scripts/watch-relink.py
"""

import hashlib
import json
import sys
import time
import urllib.error
import urllib.request

BASE = 'https://api.guildwars2.com/v2'
ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 60

# The day after the NA relink of 03/10/2026. Past this, the measurement is
# done and this file has no reason to exist - so it fails on purpose and says
# so. A temporary job that depends on somebody remembering to remove it is a
# cron still running six months later, and the timers cannot be used for this:
# teamAssignment rolls forward to next month the moment the relink lands.
EXPIRES = '2026-10-04T00:00:00Z'


def fetch(path):
    last = None
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(PAUSE_SECONDS)
        try:
            req = urllib.request.Request(
                BASE + path, headers={'User-Agent': 'wvwrelink-relink-watch'})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
                return json.load(res), None
        except urllib.error.HTTPError as exc:
            last = 'HTTP %s' % exc.code
        except Exception as exc:
            last = '%s: %s' % (type(exc).__name__, exc)
    return None, '%s after %d attempts' % (last, ATTEMPTS)


def digest(table):
    """A fingerprint of the whole guild-to-team table.

    Sorted by guild id and including the team, so it changes if any single
    guild moves - which makes "did anything change at all" one line to
    compare between two runs instead of 27 numbers to read.
    """
    payload = '\n'.join('%s=%s' % (guid, table[guid]) for guid in sorted(table))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()[:16]


def report_region(region):
    table, error = fetch('/wvw/guilds/' + region)
    if error:
        print('%s  FAILED: %s' % (region.upper(), error))
        return False

    if not isinstance(table, dict) or not table:
        print('%s  FAILED: came back %s' % (region.upper(), type(table).__name__))
        return False

    per_team = {}
    for team in table.values():
        per_team[str(team)] = per_team.get(str(team), 0) + 1

    print('%s  %d guilds  %d teams  digest %s'
          % (region.upper(), len(table), len(per_team), digest(table)))
    for team in sorted(per_team):
        print('      %s  %4d' % (team, per_team[team]))
    return True


def main():
    print('read at   %s' % time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))

    if time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()) > EXPIRES:
        print('::error::The relink window of 03/10/2026 is over, so this '
              'measurement is finished. Delete .github/workflows/'
              'relink-watch.yml and .github/scripts/watch-relink.py. This '
              'failure is the reminder - it is the only part of a temporary '
              'job that does not rely on somebody remembering.')
        return 1

    build, error = fetch('/build')
    print('build     %s' % (build.get('id') if not error else 'unavailable'))

    for timer in ('lockout', 'teamAssignment'):
        data, error = fetch('/wvw/timers/' + timer)
        if error:
            print('%-14s unavailable (%s)' % (timer, error))
        else:
            print('%-14s na=%s  eu=%s'
                  % (timer, data.get('na'), data.get('eu')))
    print('')

    ok = report_region('na')
    print('')
    ok = report_region('eu') and ok

    print('')
    print('Compare the digest against the previous run. Same digest means the '
          'assignment has not been republished yet; a different one means it '
          'has, and the per-team counts say how far it moved.')

    # A failed read is not a finding about the relink, but it should not pass
    # silently either - a run that read nothing must not look like a run that
    # found no change.
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
