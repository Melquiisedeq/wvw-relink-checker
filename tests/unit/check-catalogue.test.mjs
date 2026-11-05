// scripts/check-catalogue.py with the game's answers made up: no network. The check's own
// functions are loaded by Python and fed JSON on stdin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SCRIPT = new URL('../../scripts/check-catalogue.py', import.meta.url).pathname;
const STATIC = new URL('../../site/js/wvw-static.js', import.meta.url).pathname;

const PROGRAM = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('check_catalogue', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
static = mod.read_static(sys.argv[2])
live = json.load(sys.stdin)
print(json.dumps(mod.compare(static, live['objectives'], {int(k): v for k, v in live['sectors'].items()})))
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

test('an objective that moved or was renamed is named', () => {
  const live = agreeing();
  live.objectives[0].name = 'Somewhere Else';
  live.objectives[1].coord = live.objectives[1].coord.map(v => v + 1);
  const problems = run(live);
  assert.equal(problems.length, 2);
  assert.match(problems[0], new RegExp(`${live.objectives[0].id}.*differs in name`));
  assert.match(problems[1], /differs in coord/);
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
  live.sectors['95'][0].bounds[0][0] += 1;
  live.sectors['96'].push({ id: 99999, name: 'New', bounds: [[0, 0]] });
  const problems = run(live);
  assert.equal(problems.length, 3);
  assert.ok(problems.some(p => /Map 38: sector .*differs in name/.test(p)));
  assert.ok(problems.some(p => /Map 95: sector .*differs in bounds/.test(p)));
  assert.ok(problems.some(p => /Map 96: sectors the game has and the copy lacks: 99999/.test(p)));
});
