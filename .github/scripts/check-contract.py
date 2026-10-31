#!/usr/bin/env python3
"""Does the Guild Wars 2 API still carry the keys and types the page reads?

check-api.py asks whether each route answers and carries its top-level keys.
This goes further, in two ways:
  1. every key and type in gw2-contract.json (what site/js/ reads, nested),
     checked against a live answer;
  2. the live answer's keys and types against the recording the page tests
     run on (tests/e2e/data/recordings.json.gz): a field gone, new or of another
     type fails, so the recording is re-made when the game changes.

Guild routes use ids and names already in the recording; no new guild name is
looked up. Run it by hand:  python3 .github/scripts/check-contract.py
"""

import gzip
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = 'https://api.guildwars2.com/v2'
ATTEMPTS = 3
PAUSE_SECONDS = 5
TIMEOUT_SECONDS = 30
GUILD_SAMPLE = 5
GUID = re.compile(r'^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$')


def fetch(path):
    last = None
    for attempt in range(ATTEMPTS):
        if attempt:
            time.sleep(PAUSE_SECONDS)
        try:
            req = urllib.request.Request(
                BASE + path, headers={'User-Agent': 'wvwrelink-health-check'})
            with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
                return json.load(res), None
        except Exception as exc:
            last = '%s: %s' % (type(exc).__name__, exc)
    return None, '%s after %d attempts' % (last, ATTEMPTS)


def tname(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'bool'
    if isinstance(v, (int, float)):
        return 'num'
    if isinstance(v, str):
        return 'str'
    return 'list' if isinstance(v, list) else 'object'


# ---- 1. the contract -------------------------------------------------------

def resolve(shape, defs):
    if isinstance(shape, str) and shape.startswith('$'):
        return resolve(defs[shape[1:]], defs)
    if isinstance(shape, list):
        return [resolve(shape[0], defs)]
    if isinstance(shape, dict):
        return {k: resolve(v, defs) for k, v in shape.items()}
    return shape


def against(value, shape, where, out):
    if isinstance(shape, str):
        allowed = shape.split('|')
        if tname(value) not in allowed:
            out.append('%s is %s, the page reads %s' % (where, tname(value), shape))
    elif isinstance(shape, list):
        if not isinstance(value, list):
            out.append('%s is %s, the page reads a list' % (where, tname(value)))
            return
        for i, item in enumerate(value):
            before = len(out)
            against(item, shape[0], '%s[]' % where, out)
            if len(out) > before + 3:
                break
    else:
        if not isinstance(value, dict):
            out.append('%s is %s, the page reads an object' % (where, tname(value)))
            return
        if '*' in shape:
            for k, v in list(value.items())[:50]:
                against(v, shape['*'], '%s.*' % where, out)
            return
        for key, sub in shape.items():
            opt = key.endswith('?')
            name = key.rstrip('?')
            if name not in value:
                if not opt:
                    out.append('%s lacks key %s' % (where, name))
                continue
            if isinstance(sub, str) and opt and value[name] is None:
                continue
            against(value[name], sub, '%s.%s' % (where, name), out)


# ---- 2. the recording ------------------------------------------------------

def shape_of(v, into):
    """Union of key paths -> set of type names, over every item."""
    def walk(x, path):
        into.setdefault(path, set()).add(tname(x))
        if isinstance(x, dict):
            if len(x) > 50:  # keyed by arbitrary ids
                for val in x.values():
                    walk(val, path + '.*')
            else:
                for k, val in x.items():
                    walk(val, path + '.' + k)
        elif isinstance(x, list):
            for val in x:
                walk(val, path + '[]')
    walk(v, '')
    return into


def versus(live, rec):
    out = []
    for path, types in sorted(rec.items()):
        if path not in live:
            # an empty list on the live side carries no children to compare
            if any(p and path.startswith(p + '[]') and 'list' in live.get(p, ())
                   and (p + '[]') not in live for p in live):
                continue
            out.append('field gone from the live answer: %s (recorded %s)'
                       % (path or '(root)', '/'.join(sorted(types))))
        elif not live[path] <= types:
            out.append('type changed at %s: recorded %s, live %s'
                       % (path or '(root)', '/'.join(sorted(types)),
                          '/'.join(sorted(live[path]))))
    for path, types in sorted(live.items()):
        if path not in rec:
            parent = path
            while parent and parent not in rec:
                parent = re.sub(r'(\.[^.\[\]]+|\[\])$', '', parent)
            if parent in rec and rec[parent] == {'list'} and \
                    not any(p.startswith(parent + '[]') for p in rec):
                continue  # recorded list was empty: nothing to compare against
            out.append('new field in the live answer: %s (%s)'
                       % (path, '/'.join(sorted(types))))
    return out


def main():
    with open(HERE + '/gw2-contract.json') as f:
        contract = json.load(f)
    with gzip.open(HERE + '/../../tests/e2e/data/recordings.json.gz') as f:
        rec = json.load(f)
    entries = {}
    for url, e in rec['entries'].items():
        if url.startswith(BASE) and e[0] == 200:
            entries[url[len(BASE):]] = json.loads(e[2])
    defs = contract['defs']
    problems = []
    notes = []

    for spec in contract['routes']:
        route = spec['route']
        shape = resolve(spec['shape'], defs)
        todo = []  # (live path, recorded path)
        if '$guildId' in route:
            ids = sorted(p[len('/guild/'):] for p in entries
                         if p.startswith('/guild/') and GUID.match(p[len('/guild/'):]))
            todo = [('/guild/' + i, '/guild/' + i) for i in ids[:GUILD_SAMPLE]]
        elif '$guild' in route:
            todo = [(p, p) for p in sorted(entries)
                    if p.startswith('/guild/search?name=')]
        else:
            todo = [(route, spec.get('recorded', route))]
        if not todo:
            problems.append('%s: nothing in the recording to ask with' % route)
            continue
        live_all, rec_all = {}, {}
        for live_path, rec_path in todo:
            data, error = fetch(live_path)
            if error:
                problems.append('%s did not answer (%s)' % (live_path, error))
                continue
            found = []
            against(data, shape, live_path.split('?')[0], found)
            for m in found[:5]:
                problems.append('contract (%s): %s' % (spec['read_in'], m))
            if isinstance(data, list) and not data:
                problems.append('%s came back as an empty list' % live_path)
            shape_of(data, live_all)
            if rec_path in entries:
                shape_of(entries[rec_path], rec_all)
            else:
                notes.append('%s is not in the recording' % rec_path)
        if rec_all:
            for m in versus(live_all, rec_all)[:8]:
                problems.append('recording (%s): %s' % (route, m))
        notes.append('%-62s %d request(s)' % (route[:62], len(todo)))

    for n in notes:
        print(n)
    print('')
    if problems:
        for p in problems:
            print('error: ' + p)
        print('')
        print('%d problem(s).' % len(problems))
        return 1
    print('The live API matches the contract and the recording.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
