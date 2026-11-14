#!/usr/bin/env python3
"""Does the Guild Wars 2 API still answer, in the shape this site reads?

Every number on the site comes from somebody else's API, which can change
shape without telling anyone - and when it does, the failure is not an error
message, it is a panel that renders empty or a countdown that never appears.

This check owns what check-contract.py does not: that each route answers at
all, the match lookups the page makes, and the guild search end to end. The
keys each item must carry are not listed here: they are the required keys of
gw2-contract.json (one list, what site/js/ reads), and every item is judged. The objectives and sectors are a fallback on the page (it draws
from the copy in js/wvw-static.js and asks the game only if the copy is
missing); check-catalogue.py compares them in depth.

Every request gets three attempts, spaced out. The API genuinely flaps around
reset, and an alarm that fires on a blip is an alarm that gets ignored.

Run it by hand any time:  python3 scripts/check-api.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from workflow_text import escape

BASE = 'https://api.guildwars2.com/v2'
ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 30

CONTRACT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             'gw2-contract.json')

# path, and what breaks on the page if it goes. The path is also the route's
# name in gw2-contract.json, which says the keys each item must carry.
# 'regions' means an object keyed by region rather than a list.
ROUTES = [
    ('/wvw/timers/lockout',
     'the lockout countdown in the banner', 'regions'),
    ('/wvw/timers/teamAssignment',
     'the relink countdown in the banner', 'regions'),
    ('/wvw/matches', 'the list of match ids the standings start from', None),
    ('/wvw/matches?ids=all',
     'standings, scores and every tier', 'contract'),
    ('/wvw/objectives?ids=all',
     'the fallback for the objectives drawn on the maps', 'contract'),
    ('/wvw/upgrades?ids=all',
     'objective upgrade tiers', 'contract'),
    ('/emblem/backgrounds?ids=all',
     'guild emblems on claimed objectives', 'contract'),
    ('/emblem/foregrounds?ids=all',
     'guild emblems on claimed objectives', 'contract'),
    ('/guild/upgrades?ids=222',
     'the name of a claimed objective upgrade', 'contract'),
    ('/continents/2/floors/3/regions/7/maps/38/sectors?ids=all',
     'the fallback for the sector names on the maps', 'contract'),
]

# Objectives that carry a label_coord but no coord: where a team starts, and
# the mercenary camps.
POINTLESS_TYPES = ('Spawn', 'Mercenary')


def contract_keys(path):
    """The keys every item of this route must carry, from the contract."""
    with open(CONTRACT_FILE) as f:
        contract = json.load(f)
    for route in contract['routes']:
        if route['route'] == path:
            shape = route['shape']
            while isinstance(shape, str) and shape.startswith('$'):
                shape = contract['defs'][shape[1:]]
            item = shape[0] if isinstance(shape, list) else shape
            while isinstance(item, str) and item.startswith('$'):
                item = contract['defs'][item[1:]]
            return [k for k in item if not k.endswith('?')]
    raise KeyError(path)


def fetch(path):
    """GET and parse, retrying before giving up. Returns (data, error)."""
    last = None
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(PAUSE_SECONDS)
        try:
            req = urllib.request.Request(
                BASE + path, headers={'User-Agent': 'wvwrelink-health-check'})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
                return json.load(res), None
        except urllib.error.HTTPError as exc:
            last = 'HTTP %s' % exc.code
        except Exception as exc:  # timeout, DNS, truncated body, bad JSON
            last = '%s: %s' % (type(exc).__name__, exc)
    return None, '%s after %d attempts' % (last, ATTEMPTS)


def check_routes(problems, notes):
    for path, purpose, expected in ROUTES:
        data, error = fetch(path)
        if error:
            problems.append('%s did not answer (%s). On the page this is %s.'
                            % (path, error, purpose))
            continue

        if expected == 'regions':
            missing = [r for r in contract_keys(path) if r not in data]
            if missing:
                problems.append('%s no longer carries %s. On the page this is '
                                '%s.' % (path, ' and '.join(missing), purpose))
            else:
                notes.append('%-58s na=%s' % (path, data['na']))
            continue

        if not isinstance(data, list) or not data:
            problems.append('%s came back %s rather than a list with items in '
                            'it. On the page this is %s.'
                            % (path, 'empty' if isinstance(data, list)
                               else type(data).__name__, purpose))
            continue

        keys = contract_keys(path) if expected == 'contract' else []
        bare = [i for i in data if not isinstance(i, dict)] if keys else []
        short = {}
        for item in data:
            for k in keys:
                if isinstance(item, dict) and k not in item:
                    short[k] = short.get(k, 0) + 1
        if bare or short:
            problems.append('%s items no longer carry %s. On the page this is '
                            '%s.' % (path, ', '.join(
                                '%s (%d of %d)' % (k, n, len(data))
                                for k, n in sorted(short.items()))
                                or 'objects', purpose))
        else:
            notes.append('%-58s %d items' % (path, len(data)))


def positionless(objectives, matches):
    """Ids of objectives on the maps in play that carry no coord or label_coord."""
    in_play = {m['id'] for match in matches if isinstance(match, dict)
               for m in (match.get('maps') or [])
               if isinstance(m, dict) and isinstance(m.get('id'), int)}
    return sorted(str(o.get('id')) for o in objectives
                  if isinstance(o, dict) and o.get('map_id') in in_play
                  and o.get('type') not in POINTLESS_TYPES
                  and not (o.get('coord') or o.get('label_coord')))


def check_objective_positions(problems, notes):
    """Every objective on the maps in play can be placed."""
    matches, error = fetch('/wvw/matches?ids=all')
    objectives, error2 = fetch('/wvw/objectives?ids=all')
    if error or error2 or not isinstance(matches, list) \
            or not isinstance(objectives, list):
        return  # the routes above already say which one did not answer
    lost = positionless(objectives, matches)
    if lost:
        problems.append('/wvw/objectives?ids=all: %d objective(s) on the maps '
                        'in play carry no coord (%s). On the page this is the '
                        'fallback for placing them.'
                        % (len(lost), ', '.join(lost[:5])))
    else:
        notes.append('%-58s all have a coord or label_coord' % 'objectives in play')


def check_match_detail(problems, notes):
    """The inner shapes behind the maps and the skirmish scores.

    These are nested, so a change here would pass the top-level check above and
    still empty out a panel.

    Every match, not a sample. There is no representative one: ArenaNet
    republishes the tiers one at a time and not always forwards, so tiers can
    sit on different weeks. js/config.js carries matchIsLive for that.

    And nothing here asks whether a match is fresh. Freshness is the page's
    problem and the page already handles it. A check that wanted every tier on
    the current week would fail for an hour every reset - on purpose, by
    ArenaNet, over something already dealt with.
    """
    data, error = fetch('/wvw/matches?ids=all')
    if error:
        problems.append('Could not read match detail (%s).' % error)
        return

    total_team_ids = 0
    for match in data:
        where = 'match %s' % match.get('id', '?')
        maps = match.get('maps') or [{}]
        skirmishes = match.get('skirmishes') or [{}]
        lists = (('maps', maps, ['id', 'kills', 'deaths', 'objectives',
                                 'scores', 'type']),
                 ('skirmishes', skirmishes, ['id', 'map_scores', 'scores']))
        for kind, items, expected in lists:
            for key in expected:
                gone = [i for i, v in enumerate(items) if key not in v]
                if gone:
                    problems.append(
                        '/wvw/matches %s %s no longer carry %s (%d of %d, '
                        'from %s[%d]).' % (where, kind, key, len(gone),
                                           len(items), kind, gone[0]))
        for part, value in (('scores', match.get('scores') or {}),
                            ('all_worlds', match.get('all_worlds') or {})):
            missing = [k for k in ('blue', 'green', 'red') if k not in value]
            if missing:
                problems.append('/wvw/matches %s %s no longer carries %s.'
                                % (where, part, ', '.join(missing)))

        # all_worlds mixes legacy world ids with 5-digit team ids, and those
        # team ids are what every lookup on the page turns on.
        found = [w for side in (match.get('all_worlds') or {}).values()
                 for w in side if str(w).isdigit() and int(w) >= 10000]
        if not found:
            problems.append('/wvw/matches %s has no 5-digit team ids in '
                            'all_worlds. Every team lookup reads those.'
                            % where)
        total_team_ids += len(found)

    notes.append('%-58s %d matches, %d team ids'
                 % ('/wvw/matches detail', len(data), total_team_ids))

    teams = [w for match in data for side in
             (match.get('all_worlds') or {}).values() for w in side
             if str(w).isdigit() and int(w) >= 10000]
    if teams:
        one, error = fetch('/wvw/matches?world=%s' % teams[0])
        if error:
            problems.append('/wvw/matches?world=%s did not answer (%s). This '
                            'is how a team finds its own match.'
                            % (teams[0], error))
        elif not isinstance(one, dict) or 'id' not in one:
            problems.append('/wvw/matches?world=%s no longer returns a match '
                            'with an id.' % teams[0])


def check_guild_pipeline(problems, notes):
    """The whole guild lookup, end to end, with nothing hard-coded.

    A guild is taken from the team table, resolved to its name, and that name
    searched back. Naming a guild here instead would mean the check breaks the
    day that guild disbands - a false alarm about somebody else's decision.
    """
    table, error = fetch('/wvw/guilds/na')
    if error:
        problems.append('/wvw/guilds/na did not answer (%s). This is the table '
                        'that says which team a guild landed on - the reason '
                        'the site exists.' % error)
        return

    if not isinstance(table, dict) or not table:
        problems.append('/wvw/guilds/na came back %s rather than an object of '
                        'guilds. This is the table the whole site turns on.'
                        % type(table).__name__)
        return

    # The table gives team ids as strings ("11009") while all_worlds gives them
    # as numbers. The page (matchTeamId, colorForTeam) puts String() around each side, so neither type is
    # asserted here - only that the value still reads as a 5-digit team id.
    guid = sorted(table)[0]
    team = table[guid]
    if not str(team).isdigit() or int(team) < 10000:
        problems.append('/wvw/guilds/na maps %s to %r, which is not a 5-digit '
                        'team id. Every guild on the page is placed by that '
                        'number.' % (guid, team))
        return
    notes.append('%-58s %d guilds' % ('/wvw/guilds/na', len(table)))

    guild, error = fetch('/guild/' + urllib.parse.quote(guid))
    if error:
        problems.append('/guild/:id did not answer for %s (%s). This is what '
                        'turns a guild id into a name and tag.' % (guid, error))
        return
    missing = [k for k in ('id', 'name', 'tag') if k not in guild]
    if missing:
        problems.append('/guild/:id no longer carries %s.' % ', '.join(missing))
        return

    found, error = fetch('/guild/search?name=' +
                         urllib.parse.quote(guild['name']))
    if error:
        problems.append('/guild/search did not answer (%s). This is the lookup '
                        'the site is for: it is how a pasted name becomes a '
                        'team.' % error)
        return
    if not isinstance(found, list) or guid not in found:
        problems.append('/guild/search for "%s" did not return %s - it '
                        'returned %r. The exact-name search is how every '
                        'lookup on the site starts.'
                        % (guild['name'], guid, found))
        return
    notes.append('%-58s %s -> "%s" -> found again'
                 % ('guild pipeline', guild['tag'], guild['name']))

    eu, error = fetch('/wvw/guilds/eu')
    if error:
        problems.append('/wvw/guilds/eu did not answer (%s).' % error)
    elif not isinstance(eu, dict) or not eu:
        problems.append('/wvw/guilds/eu came back empty.')
    else:
        notes.append('%-58s %d guilds' % ('/wvw/guilds/eu', len(eu)))


def main():
    problems, notes = [], []
    check_routes(problems, notes)
    check_objective_positions(problems, notes)
    check_match_detail(problems, notes)
    check_guild_pipeline(problems, notes)

    for note in notes:
        print(escape(note))
    print('')

    if problems:
        for problem in problems:
            print('::error::%s' % escape(problem))
        print('')
        print('%d problem(s).' % len(problems))
        return 1

    print('Every route the page reads still answers in the shape it reads.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
