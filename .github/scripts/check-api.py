#!/usr/bin/env python3
"""Does the Guild Wars 2 API still answer in the shape this site reads?

The page has no backend. Every number on it comes from somebody else's API,
which can change shape without telling anyone - and when it does, the failure
is not an error message, it is a panel that renders empty or a countdown that
never appears. Nobody notices until somebody reports it.

The routes below were grepped out of js/, not guessed: these are the ones the
page actually calls. For each, only the fields the page relies on are checked.
Asserting more would mean breaking on changes that do not affect anything.

Every request gets three attempts, spaced out. The API genuinely flaps around
reset, and an alarm that fires on a blip is an alarm that gets ignored.

Run it by hand any time:  python .github/scripts/check-api.py
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://api.guildwars2.com/v2'
ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 30

# path, what breaks on the page if it goes, and the keys each item must carry.
# 'regions' means an object keyed by region rather than a list.
ROUTES = [
    ('/wvw/timers/lockout',
     'the lockout countdown in the banner', 'regions'),
    ('/wvw/timers/teamAssignment',
     'the relink countdown in the banner', 'regions'),
    ('/wvw/matches?ids=all',
     'standings, scores and every tier',
     ['all_worlds', 'end_time', 'id', 'maps', 'scores', 'skirmishes',
      'start_time', 'worlds']),
    ('/wvw/objectives?ids=all',
     'the objectives drawn on the maps',
     ['coord', 'id', 'map_id', 'map_type', 'name', 'type']),
    ('/wvw/upgrades?ids=all',
     'objective upgrade tiers', ['id', 'tiers']),
    ('/emblem/backgrounds?ids=all',
     'guild emblems on claimed objectives', ['id', 'layers']),
    ('/emblem/foregrounds?ids=all',
     'guild emblems on claimed objectives', ['id', 'layers']),
    ('/guild/upgrades?ids=38',
     'the name of a claimed objective upgrade', ['id', 'name', 'type']),
    ('/continents/2/floors/3/regions/7/maps/38/sectors?ids=all',
     'sector names on the maps', ['bounds', 'coord', 'id', 'name']),
]


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
            missing = [r for r in ('na', 'eu') if r not in data]
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

        missing = [k for k in expected if k not in data[0]]
        if missing:
            problems.append('%s items no longer carry %s. On the page this is '
                            '%s.' % (path, ', '.join(missing), purpose))
        else:
            notes.append('%-58s %d items' % (path, len(data)))


def check_match_detail(problems, notes):
    """The inner shapes behind the maps and the skirmish scores.

    These are nested, so a change here would pass the top-level check above and
    still empty out a panel.

    Every match, not a sample. There is no representative one: ArenaNet
    republishes the tiers one at a time and not always forwards - at the relink
    of 26/09 tier 4 was already on the new week while 1, 2 and 3 were on the
    old, and tier 2 published the new week and then went back. js/config.js
    carries matchIsLive for exactly that.

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
        for part, value, expected in (
                ('maps[0]', maps[0],
                 ['id', 'kills', 'deaths', 'objectives', 'scores', 'type']),
                ('skirmishes[0]', skirmishes[0],
                 ['id', 'map_scores', 'scores']),
                ('scores', match.get('scores') or {},
                 ['blue', 'green', 'red']),
                ('all_worlds', match.get('all_worlds') or {},
                 ['blue', 'green', 'red'])):
            missing = [k for k in expected if k not in value]
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
    # as numbers. The page does not care: matchTeamId and colorForTeam both put
    # String() around each side, and an object lookup coerces a key anyway. So
    # neither type is asserted here - only that the value still reads as a
    # 5-digit team id. Demanding a string would fail on a change that breaks
    # nothing, which is the definition of a false alarm.
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
    check_match_detail(problems, notes)
    check_guild_pipeline(problems, notes)

    for note in notes:
        print(note)
    print('')

    if problems:
        for problem in problems:
            print('::error::%s' % problem)
        print('')
        print('%d problem(s).' % len(problems))
        return 1

    print('Every route the page reads still answers in the shape it reads.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
