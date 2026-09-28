#!/usr/bin/env python3
"""Are the two spreadsheets the page reads still shaped the way it reads them?

Two very different sources, so two very different checks.

The community sheet is maintained by the NA WvW Discord - other people, who
can rename a column at any time and have every right to. js/sheet.js resolves
its columns by header name, and falls back to a fixed index when the name is
not found. That fallback is the danger: nothing errors, the page just reads
the wrong column and places guilds on teams the sheet never put them on. So a
missing header is a failure here.

The kills sheet is filled by an Apps Script trigger every five minutes, and it
is the project's own. Here freshness *is* the signal: if the newest row is old,
the trigger stopped and the crossed swords quietly stop marking the busiest
map. Free Apps Script accounts have a daily trigger ceiling, so this is a real
way for it to die.

Neither check asserts how many rows or columns there are. Both sheets grow and
shrink as people maintain them, and a check that pinned those numbers would
fail on somebody doing their job.

Run it by hand any time:  python .github/scripts/check-sheets.py
"""

import csv
import io
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

COMMUNITY_SHEET_ID = '1Txjpcet-9FDVek6uJ0N3OciwgbpE0cfWozUK7ATfWx4'
KILLS_SHEET_ID = '1Lh6dGhlYVvvKlXT_tofEUKZhYGW71Jij1IstbdPF2fg'

ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 30

# Six missed runs of a five-minute trigger. Loose enough that one skipped run
# is not news, tight enough that a stopped trigger is.
KILLS_STALE_MINUTES = 30

# The columns js/sheet.js looks for, in the order it looks for them, and the
# name of the constant it falls back to. Alliances is asked for 'World ID'
# first and 'World' second, which matters: that tab has no 'World' column at
# all, so a check demanding both would fail on a sheet that is perfectly fine.
COMMUNITY_COLUMNS = {
    'SoloGuilds': [
        (['World'], 'SOLO_WORLD_FALLBACK'),
        (['API Mismatch'], 'SOLO_MISMATCH_FALLBACK'),
    ],
    'Alliances': [
        (['World ID', 'World'], 'ALLIANCE_WORLD_FALLBACK'),
        (['Guilds'], 'ALLIANCE_MEMBERS_FALLBACK'),
    ],
}


def csv_url(sheet_id, tab):
    return ('https://docs.google.com/spreadsheets/d/%s/gviz/tq?tqx=out:csv'
            '&sheet=%s' % (sheet_id, urllib.parse.quote(tab)))


def fetch_rows(url):
    """GET a gviz CSV export and parse it. Returns (rows, error)."""
    last = None
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(PAUSE_SECONDS)
        try:
            req = urllib.request.Request(
                url, headers={'User-Agent': 'wvwrelink-health-check'})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
                body = res.read().decode('utf-8', 'replace')
            return list(csv.reader(io.StringIO(body))), None
        except urllib.error.HTTPError as exc:
            last = 'HTTP %s' % exc.code
        except Exception as exc:
            last = '%s: %s' % (type(exc).__name__, exc)
    return None, '%s after %d attempts' % (last, ATTEMPTS)


def fallbacks_in_code():
    """The fallback indices, read out of js/sheet.js rather than copied here.

    Copying them would mean this file and the code drifting apart in silence,
    which is the exact failure the check is about.
    """
    body = io.open(os.path.join(ROOT, 'js', 'sheet.js'), encoding='utf-8').read()
    return {m.group(1): int(m.group(2)) for m in
            re.finditer(r'const (\w+_FALLBACK)\s*=\s*(\d+)', body)}


def check_community(problems, notes):
    fallbacks = fallbacks_in_code()

    for tab, wanted in COMMUNITY_COLUMNS.items():
        rows, error = fetch_rows(csv_url(COMMUNITY_SHEET_ID, tab))
        if error:
            problems.append('The %s tab of the community sheet did not answer '
                            '(%s). The shield icon reads that tab.'
                            % (tab, error))
            continue
        if not rows:
            problems.append('The %s tab of the community sheet came back with '
                            'nothing at all - not even a header row.' % tab)
            continue
        if len(rows) < 2:
            problems.append('The %s tab of the community sheet has a header '
                            'and no data under it.' % tab)
            continue

        header = [cell.strip() for cell in rows[0]]
        notes.append('%-22s %d rows, %d columns' % (tab, len(rows), len(header)))

        for names, constant in wanted:
            index = next((header.index(n) for n in names if n in header), None)
            if index is None:
                problems.append(
                    'The %s tab no longer has a %s column. js/sheet.js falls '
                    'back to index %s, so nothing will error - the page will '
                    'read whatever sits in that position and place guilds on '
                    'teams the sheet does not put them on.'
                    % (tab, ' or '.join('"%s"' % n for n in names),
                       fallbacks.get(constant, '?')))
                continue

            expected = fallbacks.get(constant)
            if expected is None:
                notes.append('  %-30s column %d (%s not found in js/sheet.js)'
                             % (names[0], index, constant))
            elif index == expected:
                notes.append('  %-30s column %d, %s agrees'
                             % (names[0], index, constant))
            else:
                # Not a failure: the page finds the column by name, so it is
                # correct today. Worth saying, because the safety net in the
                # code now points somewhere else.
                notes.append('  %-30s column %d, but %s says %d - the fallback '
                             'is stale, harmless while the header is there'
                             % (names[0], index, constant, expected))


def check_kills(problems, notes):
    rows, error = fetch_rows(csv_url(KILLS_SHEET_ID, 'kills'))
    if error:
        problems.append('The kills sheet did not answer (%s). This is what '
                        'puts the crossed swords on the busiest map.' % error)
        return

    # No header on this one: the rows are written by the Apps Script as
    # timestamp, match id, then one kill count per map.
    stamped = [r for r in rows if r and r[0].strip().isdigit()]
    if not stamped:
        problems.append('The kills sheet has no rows with a timestamp in them. '
                        'Either the Apps Script stopped writing or the column '
                        'order changed.')
        return

    narrow = [r for r in stamped if len(r) < 6]
    if narrow:
        problems.append('%d row(s) in the kills sheet have fewer than 6 '
                        'columns. js/maps.js skips those, so the swords go '
                        'quiet without any error.' % len(narrow))

    newest = max(int(r[0].strip()) for r in stamped)
    age_minutes = (time.time() * 1000 - newest) / 60000.0
    matches = len({r[1].strip() for r in stamped if len(r) > 1 and r[1].strip()})

    notes.append('%-22s %d rows, %d matches, newest %.1f min old'
                 % ('kills', len(stamped), matches, age_minutes))

    if age_minutes > KILLS_STALE_MINUTES:
        problems.append('The newest row in the kills sheet is %.0f minutes old. '
                        'The Apps Script trigger writes every five minutes, so '
                        'it has stopped - and the crossed swords stop with it, '
                        'silently.' % age_minutes)


def main():
    problems, notes = [], []
    check_community(problems, notes)
    check_kills(problems, notes)

    for note in notes:
        print(note)
    print('')

    if problems:
        for problem in problems:
            print('::error::%s' % problem)
        print('')
        print('%d problem(s).' % len(problems))
        return 1

    print('Both sheets answer, and every column the page resolves by name is '
          'still there.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
