// scripts/check-api.py with the game's answers made up: no network. main() runs with fetch
// replaced, and the exit code and the CI log are what is asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('../../scripts/check-api.py', import.meta.url).pathname;

const PROGRAM = `
import importlib.util, io, json, os, sys, contextlib
sys.path.insert(0, os.path.dirname(sys.argv[1]))
spec = importlib.util.spec_from_file_location('check_api', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
live = json.load(sys.stdin)
GUID = '00000000-0000-0000-0000-000000000001'
COLORS = {'red': 1, 'blue': 1, 'green': 1}
MATCH = {'id': '1-1', 'scores': COLORS, 'start_time': 'x', 'end_time': 'x', 'worlds': {},
         'kills': COLORS, 'deaths': COLORS, 'victory_points': COLORS,
         'maps': [{'id': 7, 'kills': COLORS, 'deaths': COLORS, 'objectives': [],
                   'scores': COLORS, 'type': 'Center'}],
         'all_worlds': {'red': [11001], 'blue': [11002], 'green': [11003]},
         'skirmishes': [{'id': 1, 'map_scores': [], 'scores': COLORS}]}
MATCH.update(live.get('match') or {})
ITEM = {k: 1 for k in ('id', 'name', 'description', 'icon', 'tiers', 'layers', 'bounds', 'coord', 'type')}
def answer(path):
    if path.startswith('/wvw/timers'):
        return {'na': 'x', 'eu': 'x'}
    if path == '/wvw/matches':
        return ['1-1']
    if path == '/wvw/matches?ids=all':
        return [MATCH]
    if path.startswith('/wvw/matches?world='):
        return MATCH
    if path == '/wvw/objectives?ids=all':
        return live['objectives']
    if path.startswith('/wvw/guilds'):
        return {GUID: '11001'}
    if path.startswith('/guild/search'):
        return [GUID]
    if path.startswith('/guild/') and '?' not in path:
        return {'id': GUID, 'name': 'A', 'tag': 'A'}
    return [ITEM]
def fake(path):
    return answer(path), None
mod.fetch = fake
out = io.StringIO()
with contextlib.redirect_stdout(out):
    code = mod.main()
print(json.dumps({'code': code, 'log': out.getvalue()}))
`;

const obj = (id, extra) => ({ id, name: id, type: 'Camp', map_type: 'Center', map_id: 7, ...extra });
const spawn = { ...obj('7-1'), type: 'Spawn' };

function run(objectives, match) {
  return JSON.parse(execFileSync('python3', ['-I', '-c', PROGRAM, SCRIPT], {
    input: JSON.stringify({ objectives, match }), encoding: 'utf8',
  }));
}

test('a Spawn first in the list, every objective in play placed: green', () => {
  const r = run([spawn, obj('7-2', { coord: [1, 2, 3] }), obj('7-3', { label_coord: [1, 2, 3] })]);
  assert.equal(r.code, 0, r.log);
});

test('an objective in play with no coord, behind a placed first one: red', () => {
  const r = run([obj('7-2', { coord: [1, 2, 3] }), obj('7-3')]);
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /7-3/);
});

test('an objective with no coord on a map not in play is not the check\'s business', () => {
  const r = run([obj('7-2', { coord: [1, 2, 3] }), { ...obj('9-1'), map_id: 9 }]);
  assert.equal(r.code, 0, r.log);
});

test('a later objective missing a key the contract requires: red', () => {
  const r = run([obj('7-2', { coord: [1, 2, 3] }), { ...obj('7-3', { coord: [1, 2, 3] }), map_type: undefined }]);
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /map_type \(1 of 2\)/);
});

const COLORS = { red: 1, blue: 1, green: 1 };
const goodMap = { id: 7, kills: COLORS, deaths: COLORS, objectives: [], scores: COLORS, type: 'Center' };
const goodRound = { id: 1, map_scores: [], scores: COLORS };

test('the second map of a match lacking a key: red', () => {
  const { deaths, ...bad } = goodMap;
  const r = run([obj('7-2', { coord: [1, 2, 3] })], { maps: [goodMap, bad] });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /maps no longer carry deaths \(1 of 2, from maps\[1\]\)/);
});

test('the second skirmish of a match lacking a key: red', () => {
  const { scores, ...bad } = goodRound;
  const r = run([obj('7-2', { coord: [1, 2, 3] })], { skirmishes: [goodRound, bad] });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /skirmishes no longer carry scores \(1 of 2, from skirmishes\[1\]\)/);
});

test('a key missing from every skirmish is one line, not one per skirmish', () => {
  const { scores, ...bad } = goodRound;
  const r = run([obj('7-2', { coord: [1, 2, 3] })], { skirmishes: Array(50).fill(bad) });
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /\(50 of 50, from skirmishes\[0\]\)/);
  assert.equal(r.log.split('\n').filter((l) => l.startsWith('::error::')).length, 1, r.log);
});

test('a match with several whole maps and skirmishes: green', () => {
  const r = run([obj('7-2', { coord: [1, 2, 3] })], { maps: [goodMap, goodMap], skirmishes: [goodRound, goodRound] });
  assert.equal(r.code, 0, r.log);
});

test('the contract gives the required keys: no optional ones, and no coord for objectives', () => {
  const out = execFileSync('python3', ['-I', '-c', `
import importlib.util, json, os, sys
sys.path.insert(0, os.path.dirname(sys.argv[1]))
spec = importlib.util.spec_from_file_location('check_api', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps([mod.contract_keys('/wvw/objectives?ids=all'), mod.contract_keys('/wvw/timers/lockout')]))
`, SCRIPT], { encoding: 'utf8' });
  const [objectives, lockout] = JSON.parse(out);
  assert.deepEqual([...objectives].sort(), ['id', 'map_id', 'map_type', 'name', 'type']);
  assert.deepEqual(lockout, ['na']);
});
