#!/usr/bin/env python3
"""Is the written-out copy of the objectives and sectors still what the game says?

js/wvw-static.js carries the objectives of the four WvW maps and the polygons of
their sectors, and the page draws a map from that copy without asking the game
for either list. So nothing on the page notices when ArenaNet moves an
objective, renames a sector or adds one: the map would keep drawing the old one.
This is what notices instead.

Only the fields the drawing code reads are compared (the ones the header of
js/wvw-static.js lists), coordinates within a rounding of one decimal, plus
objectives or sectors the copy has and the game does not, or the other way round.
A mismatch is an equality, not a judgement. To refresh the copy, rebuild it as
that header says.

Every request gets three attempts, spaced out, as in check-api.py.

Run it by hand any time:  python3 scripts/check-catalogue.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

from workflow_text import escape

BASE = 'https://api.guildwars2.com/v2'
STATIC_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           '..', 'site', 'js', 'wvw-static.js')
MAP_IDS = (38, 1099, 96, 95)
OBJECTIVE_FIELDS = ('name', 'type', 'map_id', 'sector_id', 'upgrade_id')
POINT_FIELDS = ('coord', 'label_coord')
# The copy is rounded to one decimal: it can sit 0.05 from the game's value.
TOLERANCE = 0.06
ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 30
REBUILD = ('Rebuild the copy in site/js/wvw-static.js as the comment at its top '
           'says.')
MAX_LISTED = 8


def read_static(path=STATIC_FILE):
    """The JSON literal after `const WVW_STATIC = `."""
    with open(path, encoding='utf-8') as handle:
        text = handle.read()
    marker = 'const WVW_STATIC = '
    start = text.index(marker) + len(marker)
    value, _ = json.JSONDecoder().raw_decode(text[start:])
    return value


def fetch(url):
    """GET and parse, retrying before giving up. Returns (data, error)."""
    last = None
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(PAUSE_SECONDS)
        try:
            req = urllib.request.Request(
                url, headers={'User-Agent': 'wvwrelink-health-check'})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
                return json.load(res), None
        except urllib.error.HTTPError as exc:
            last = 'HTTP %s' % exc.code
        except Exception as exc:  # timeout, DNS, truncated body, bad JSON
            last = '%s: %s' % (type(exc).__name__, exc)
    return None, '%s after %d attempts' % (last, ATTEMPTS)


def near(a, b):
    """Two lists of numbers, equal in length and within TOLERANCE."""
    if not isinstance(a, list) or not isinstance(b, list) or len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if isinstance(x, list) or isinstance(y, list):
            if not near(x, y):
                return False
        elif (not isinstance(x, (int, float)) or not isinstance(y, (int, float))
              or abs(x - y) > TOLERANCE):
            return False
    return True


def listed(items):
    items = sorted(items, key=str)
    text = ', '.join(str(i) for i in items[:MAX_LISTED])
    return text + (' and %d more' % (len(items) - MAX_LISTED)
                   if len(items) > MAX_LISTED else '')


def compare_objectives(copy, live):
    """Problems between the copy's objectives and the game's, on the four maps."""
    problems = []
    live = [o for o in live if o.get('map_id') in MAP_IDS]
    mine = {o['id']: o for o in copy}
    theirs = {o['id']: o for o in live}
    if set(theirs) - set(mine):
        problems.append('Objectives the game has and the copy lacks: %s.'
                        % listed(set(theirs) - set(mine)))
    if set(mine) - set(theirs):
        problems.append('Objectives the copy has and the game no longer does: '
                        '%s.' % listed(set(mine) - set(theirs)))
    for oid in sorted(set(mine) & set(theirs), key=str):
        a, b = mine[oid], theirs[oid]
        changed = [k for k in OBJECTIVE_FIELDS if a.get(k) != b.get(k)]
        # A point the game does not give (a spawn has no coord) is absent in the copy too.
        changed += [k for k in POINT_FIELDS
                    if (b.get(k) or a.get(k)) and not near(a.get(k), b.get(k))]
        if changed:
            problems.append('Objective %s (%s) differs in %s.'
                            % (oid, b.get('name'), ', '.join(changed)))
    return problems


def compare_sectors(map_id, copy, live):
    """Problems between the copy's sectors of one map and the game's."""
    problems = []
    live = [s for s in live if isinstance(s.get('bounds'), list)]
    mine = {s['id']: s for s in copy}
    theirs = {s['id']: s for s in live}
    if set(theirs) - set(mine):
        problems.append('Map %s: sectors the game has and the copy lacks: %s.'
                        % (map_id, listed(set(theirs) - set(mine))))
    if set(mine) - set(theirs):
        problems.append('Map %s: sectors the copy has and the game no longer '
                        'does: %s.' % (map_id, listed(set(mine) - set(theirs))))
    for sid in sorted(set(mine) & set(theirs), key=str):
        a, b = mine[sid], theirs[sid]
        changed = [k for k in ('name',) if a.get(k) != b.get(k)]
        if not near(a.get('bounds'), b.get('bounds')):
            changed.append('bounds')
        if changed:
            problems.append('Map %s: sector %s (%s) differs in %s.'
                            % (map_id, sid, b.get('name'), ', '.join(changed)))
    return problems


def compare(static, objectives, sectors):
    """sectors: {map id: the game's list}. Returns the problems, empty when equal."""
    problems = compare_objectives(static.get('objectives') or [], objectives)
    for map_id in MAP_IDS:
        problems += compare_sectors(
            map_id, (static.get('sectors') or {}).get(str(map_id)) or [],
            sectors.get(map_id) or [])
    return problems


def main():
    static = read_static()
    problems, notes = [], []
    objectives, error = fetch(BASE + '/wvw/objectives?ids=all')
    sectors = {}
    if error:
        problems.append('/wvw/objectives did not answer (%s).' % error)
    for map_id in MAP_IDS:
        if error:
            break
        url = ('%s/continents/2/floors/3/regions/7/maps/%d/sectors?ids=all'
               % (BASE, map_id))
        sectors[map_id], error = fetch(url)
        if error:
            problems.append('Sectors of map %d did not answer (%s).'
                            % (map_id, error))
    if not problems:
        problems = compare(static, objectives, sectors)
        notes.append('%d objectives and %d sectors compared'
                     % (len(static['objectives']),
                        sum(len(v) for v in static['sectors'].values())))

    for note in notes:
        print(note)
    if problems:
        for problem in problems:
            print('::error::%s' % escape(problem))
        print('')
        print('%d problem(s). The page draws its maps from the copy, so it '
              'draws the old ones. %s' % (len(problems), REBUILD))
        return 1
    print('The copy in js/wvw-static.js is what the game says.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
