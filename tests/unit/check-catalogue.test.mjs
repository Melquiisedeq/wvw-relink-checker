// scripts/check-catalogue.py with the game's answers made up: no network. The check's own
// functions are loaded by Python and fed JSON on stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SCRIPT = new URL('../../scripts/check-catalogue.py', import.meta.url).pathname;
const STATIC = new URL('../../site/js/wvw-static.js', import.meta.url).pathname;

const PROGRAM = `
import importlib.util, json, os, sys
sys.path.insert(0, os.path.dirname(sys.argv[1]))
spec = importlib.util.spec_from_file_location('check_catalogue', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
static = mod.read_static(sys.argv[2])
live = json.load(sys.stdin)
print(json.dumps(mod.compare(static, live['objectives'], {int(k): v for k, v in live['sectors'].items()})))
`;

// main() with the game's answers made up, as the CI log would show it.
const MAIN = `
import importlib.util, io, json, os, sys, contextlib
sys.path.insert(0, os.path.dirname(sys.argv[1]))
spec = importlib.util.spec_from_file_location('check_catalogue', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
live = json.load(sys.stdin)
def fetch(url):
    if 'matches' in url:
        return live.get('matches') or [{'maps': [{'id': int(k)} for k in live['sectors']]}], None
    if 'objectives' in url:
        return live['objectives'], None
    return live['sectors'][url.split('/maps/')[1].split('/')[0]], None
mod.fetch = fetch
out = io.StringIO()
with contextlib.redirect_stdout(out):
    mod.main()
print(json.dumps(out.getvalue()))
`;

const copy = () => {
  const text = readFileSync(STATIC, 'utf8');
  return new Function(`${text}; return WVW_STATIC;`)();
};

// What the game would answer when it agrees with the copy, coordinates unrounded within 0.05.
function agreeing() {
  const c = copy();
  const nudge = v => (typeof v === 'number' ? v + 0.04 : v);
  const objectives = c.objectives.map(o => ({
    ...o,
    ...(o.coord && { coord: o.coord.map(nudge) }),
    ...(o.label_coord && { label_coord: o.label_coord.map(nudge) }),
    map_type: 'x',
  }));
  const sectors = {};
  for (const [id, list] of Object.entries(c.sectors)) {
    sectors[id] = list.map(s => ({ ...s, bounds: s.bounds.map(p => p.map(nudge)), coord: [0, 0, 0] }));
  }
  return { objectives, sectors };
}

const run = live => JSON.parse(execFileSync('python3', ['-I', '-c', PROGRAM, SCRIPT, STATIC], { input: JSON.stringify(live) }));

test('the game agrees with the copy: no problem', () => {
  assert.deepEqual(run(agreeing()), []);
});

// 0.03 on top of the nudge is 0.07 off the copy: just past the tolerance.
test('an objective that moved, was renamed or changed sector is named', () => {
  const live = agreeing();
  live.objectives[0].name = 'Somewhere Else';
  live.objectives[1].coord = live.objectives[1].coord.map(v => v + 0.03);
  live.objectives[2].sector_id += 1;
  const problems = run(live);
  assert.equal(problems.length, 3);
  assert.match(problems[0], new RegExp(`${live.objectives[0].id}.*differs in name`));
  assert.match(problems[1], /differs in coord/);
  assert.match(problems[2], /differs in sector_id/);
});

test('an objective added or removed is named', () => {
  const live = agreeing();
  const gone = live.objectives.pop();
  live.objectives.push({ ...gone, id: '38-999' });
  const problems = run(live);
  assert.equal(problems.length, 2);
  assert.ok(problems.some(p => p.includes('game has and the copy lacks') && p.includes('38-999')));
  assert.ok(problems.some(p => p.includes('copy has and the game no longer does') && p.includes(gone.id)));
});

test('a sector renamed, reshaped or added is named', () => {
  const live = agreeing();
  live.sectors['38'][0].name = 'Renamed';
  live.sectors['95'][0].bounds[0][0] += 0.03;
  live.sectors['96'].push({ id: 99999, name: 'New', bounds: [[0, 0]] });
  const problems = run(live);
  assert.equal(problems.length, 3);
  assert.ok(problems.some(p => /Map 38: sector .*differs in name/.test(p)));
  assert.ok(problems.some(p => /Map 95: sector .*differs in bounds/.test(p)));
  assert.ok(problems.some(p => /Map 96: sectors the game has and the copy lacks: 99999/.test(p)));
});

const main = live => JSON.parse(execFileSync('python3', ['-I', '-c', MAIN, SCRIPT], { input: JSON.stringify(live) }));

test('only the maps in play are compared; the copy of one out of play is named and left alone', () => {
  const live = agreeing();
  const out = live.sectors['96'][0];
  out.name = 'Renamed';
  live.objectives = live.objectives.filter(o => o.map_id !== 95);
  delete live.sectors['95'];
  live.matches = [{ maps: Object.keys(live.sectors).filter(k => k !== '96').map(k => ({ id: Number(k) })) }];
  const lines = main(live).split('\n');
  assert.ok(lines.includes('Not in play, not compared: 95, 96'));
  assert.equal(lines.filter(l => l.startsWith('::error::')).length, 0);
  assert.ok(lines.includes('The copy in js/wvw-static.js is what the game says.'));
});

test('a map in play the copy lacks fails', () => {
  const live = agreeing();
  live.sectors['4242'] = [{ id: 1, name: 'New', bounds: [[0, 0]] }];
  const lines = main(live).split('\n');
  assert.ok(lines.includes('::error::Maps in play the copy lacks: 4242.'));
});

test('a name from the game cannot start a workflow command in the log', () => {
  const live = agreeing();
  live.sectors['38'][0].name = 'Bad\n::error::injected::x\r100%';
  const out = JSON.parse(execFileSync('python3', ['-I', '-c', MAIN, SCRIPT], { input: JSON.stringify(live) }));
  const lines = out.split('\n');
  assert.equal(lines.filter(l => l.startsWith('::')).length, 1);
  assert.ok(lines.some(l => l.startsWith('::error::') && l.includes('Bad%0A::error::injected::x%0D100%25')));
});

test('a note that carries a guild name cannot start a workflow command either', () => {
  const program = `
import importlib.util, io, json, os, sys, contextlib
sys.path.insert(0, os.path.dirname(sys.argv[1]))
spec = importlib.util.spec_from_file_location('check_api', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.check_routes = mod.check_match_detail = lambda problems, notes: None
mod.check_guild_pipeline = lambda problems, notes: notes.append('guild "Bad\\n::error::injected::x"')
out = io.StringIO()
with contextlib.redirect_stdout(out):
    mod.main()
print(json.dumps(out.getvalue()))
`;
  const script = new URL('../../scripts/check-api.py', import.meta.url).pathname;
  const out = JSON.parse(execFileSync('python3', ['-I', '-c', program, script]));
  assert.equal(out.split('\n').filter(l => l.startsWith('::')).length, 0);
  assert.ok(out.includes('Bad%0A::error::injected::x'));
});
