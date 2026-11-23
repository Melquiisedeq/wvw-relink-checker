// scripts/check-catalogue.mjs with the game's answers made up: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, compare, near, listed, inPlay, readStatic, ROOT, BASE } from '../../../scripts/check-catalogue.mjs';
import { fakeFetch, fakeSleep, lines, errors } from './fake-http.mjs';

const copy = readStatic();

// What the game would answer when it agrees with the copy, coordinates unrounded within 0.05.
function agreeing() {
  const nudge = (v) => (typeof v === 'number' ? v + 0.04 : v);
  const objectives = copy.objectives.map((o) => ({
    ...o,
    ...(o.coord && { coord: o.coord.map(nudge) }),
    ...(o.label_coord && { label_coord: o.label_coord.map(nudge) }),
    map_type: 'x',
  }));
  const sectors = {};
  for (const [id, list] of Object.entries(copy.sectors)) {
    sectors[id] = list.map((s) => ({ ...s, bounds: s.bounds.map((p) => p.map(nudge)), coord: [0, 0, 0] }));
  }
  return { objectives, sectors };
}

const compareLive = (live) => compare(copy, live.objectives, new Map(Object.entries(live.sectors).map(([k, v]) => [Number(k), v])));

test('the game agrees with the copy: no problem', () => {
  assert.deepEqual(compareLive(agreeing()), []);
});

// 0.03 on top of the nudge is 0.07 off the copy: just past the tolerance.
test('an objective that moved, was renamed or changed sector is named', () => {
  const live = agreeing();
  live.objectives[0].name = 'Somewhere Else';
  live.objectives[1].coord = live.objectives[1].coord.map((v) => v + 0.03);
  live.objectives[2].sector_id += 1;
  const problems = compareLive(live);
  assert.equal(problems.length, 3);
  assert.match(problems[0], new RegExp(`${live.objectives[0].id}.*differs in name`));
  assert.match(problems[1], /differs in coord/);
  assert.match(problems[2], /differs in sector_id/);
});

test('every compared field of an objective is named when it differs', () => {
  for (const [field, value] of [['type', 'Tower'], ['map_id', 38], ['upgrade_id', 99999], ['label_coord', [1, 2, 3]]]) {
    const live = agreeing();
    const o = live.objectives.find((x) => x.map_id !== 38 && x.coord && x.label_coord !== undefined) || live.objectives[3];
    o[field] = field === 'map_id' ? (o.map_id === 38 ? 1651 : 38) : value;
    const problems = compareLive(live);
    assert.ok(problems.some((p) => p.includes(`Objective ${o.id} (${o.name}) differs in`) && p.includes(field)), `${field}: ${problems}`);
  }
});

test('a point the game does not give is absent in the copy too; one only the copy has is named', () => {
  const live = agreeing();
  const spawn = live.objectives.find((o) => !o.coord);
  assert.ok(spawn, 'the copy has an objective without coord');
  assert.deepEqual(compareLive(live), []);
  spawn.coord = [1, 2, 3];
  assert.match(compareLive(live)[0], /differs in coord/);
});

test('an objective added or removed is named', () => {
  const live = agreeing();
  const gone = live.objectives.pop();
  live.objectives.push({ ...gone, id: '38-999' });
  const problems = compareLive(live);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes('game has and the copy lacks') && p.includes('38-999')));
  assert.ok(problems.some((p) => p.includes('copy has and the game no longer does') && p.includes(gone.id)));
});

test('a sector renamed, reshaped or added is named', () => {
  const live = agreeing();
  live.sectors['38'][0].name = 'Renamed';
  live.sectors['1651'][0].bounds[0][0] += 0.03;
  live.sectors['1652'].push({ id: 99999, name: 'New', bounds: [[0, 0]] });
  const problems = compareLive(live);
  assert.equal(problems.length, 3);
  assert.ok(problems.some((p) => /Map 38: sector .*differs in name/.test(p)));
  assert.ok(problems.some((p) => /Map 1651: sector .*differs in bounds/.test(p)));
  assert.ok(problems.some((p) => /Map 1652: sectors the game has and the copy lacks: 99999/.test(p)));
});

test('a sector the game dropped, or gave without bounds, is named as gone', () => {
  const live = agreeing();
  const dropped = live.sectors['38'].shift();
  const unbounded = live.sectors['1651'][0];
  delete unbounded.bounds;
  const problems = compareLive(live);
  assert.ok(problems.some((p) => p.startsWith('Map 38: sectors the copy has and the game no longer does:') && p.includes(String(dropped.id))));
  assert.ok(problems.some((p) => p.startsWith('Map 1651: sectors the copy has and the game no longer does:') && p.includes(String(unbounded.id))));
});

test('the tolerance is about 0.06 and the lists are of equal length', () => {
  assert.equal(near([1, [2, 3]], [1.05, [2, 3]]), true);
  assert.equal(near([1, [2, 3]], [1.07, [2, 3]]), false);
  assert.equal(near([0], [0.06]), true, 'the tolerance itself is within');
  assert.equal(near([1], [1, 2]), false);
  assert.equal(near([1], 'a'), false);
  assert.equal(near(['a'], ['a']), false);
  assert.equal(near([[1]], [1]), false);
});

test('a long list of ids is cut after eight, in text order', () => {
  assert.equal(listed([3, 1, 2]), '1, 2, 3');
  assert.equal(listed([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), '1, 10, 2, 3, 4, 5, 6, 7 and 2 more');
});

test('what the copy has and the game does not give for a point is named; null for absent is no difference', () => {
  const live = agreeing();
  delete live.objectives.find((o) => o.coord).coord;
  assert.match(compareLive(live)[0], /differs in coord\.$/);
  const fresh = agreeing();
  const bare = fresh.objectives.find((o) => o.upgrade_id === undefined);
  assert.ok(bare, 'the copy has an objective without upgrade_id');
  bare.upgrade_id = null;
  assert.deepEqual(compareLive(fresh), []);
});

test('the problems come in the order of the ids as text, maps in numeric order', () => {
  const o = (id) => ({ id, name: 'a', map_id: 1 });
  const theirs = [o(10), o(9), o(100)].map((x) => ({ ...x, name: 'b' }));
  const named = compare({ objectives: [o(100), o(9), o(10)], sectors: {} }, theirs, new Map([[1, []]])).map((p) => /^Objective (\S+) /.exec(p)[1]);
  assert.deepEqual(named, ['10', '100', '9']);
  const sec = (id) => ({ id, name: 'a', bounds: [[0, 0]] });
  const game = [sec(10), sec(9)].map((x) => ({ ...x, name: 'b' }));
  const inSectors = compare({ objectives: [], sectors: { 1: [sec(9), sec(10)] } }, [], new Map([[1, game]])).map((p) => /sector (\S+) /.exec(p)[1]);
  assert.deepEqual(inSectors, ['10', '9']);
  const sectors = agreeing();
  sectors.sectors['95'][0].name = 'x';
  sectors.sectors['1651'][0].name = 'x';
  sectors.sectors['38'][0].name = 'x';
  assert.deepEqual(compareLive(sectors).map((p) => /^Map (\d+)/.exec(p)[1]), ['38', '95', '1651']);
});

test('a copy without objectives or sectors, or a game that gives none, is a plain difference', () => {
  const sectors = new Map([[38, null]]);
  assert.deepEqual(compare({ objectives: null, sectors: null }, [], sectors), []);
  const some = compare({ objectives: [], sectors: { 38: [{ id: 1, name: 'a', bounds: [] }] } }, [], sectors);
  assert.deepEqual(some, ['Map 38: sectors the copy has and the game no longer does: 1.']);
});

test('the literal is read to where it closes, strings with quotes and brackets in it included', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'static-')), 'wvw-static.js');
  fs.writeFileSync(file, 'const A = {"x": 1};\nconst WVW_STATIC = {"a": ["q\\"}]", {"b": "}"}], "c": 2};\nconst B = {"d": [1]};\n');
  assert.deepEqual(readStatic(file), { a: ['q"}]', { b: '}' }], c: 2 });
  fs.writeFileSync(file, 'const OTHER = {};');
  assert.throws(() => readStatic(file), /ValueError/);
  fs.writeFileSync(file, 'const WVW_STATIC = {"a": [1, 2');
  assert.throws(() => readStatic(file), /JSONDecodeError/);
});

test('the maps in play are the integer ids of the matches, sorted', () => {
  assert.deepEqual(inPlay([{ maps: [{ id: 38 }, { id: 7 }, { id: 'x' }, { id: 38.5 }, null, 5] }, { maps: [{ id: 7 }] }, { maps: null }, 'a', { maps: 'abc' }]), [7, 38]);
  assert.deepEqual(inPlay([{ maps: { a: 1 } }, { maps: [] }, { maps: 0 }]), []);
  assert.throws(() => inPlay([{ maps: 5 }]), /not iterable/);
  assert.throws(() => inPlay([{ maps: true }]), /not iterable/);
  assert.deepEqual(inPlay({ maps: [{ id: 1 }] }), []);
  assert.deepEqual(inPlay(null), []);
});

// The game as it answers today; `live` is what the copy is compared with.
function world(live, plan = {}) {
  return (url) => {
    const route = url.slice(BASE.length);
    if (plan.down?.[route]) return plan.down[route];
    if (route === '/wvw/matches?ids=all') return { body: live.matches ?? [{ maps: Object.keys(live.sectors).map((k) => ({ id: Number(k) })) }] };
    if (route === '/wvw/objectives?ids=all') return { body: live.objectives };
    const m = /^\/continents\/2\/floors\/3\/regions\/7\/maps\/(\d+)\/sectors\?ids=all$/.exec(route);
    return m && live.sectors[m[1]] ? { body: live.sectors[m[1]] } : { status: 404 };
  };
}
async function run(live, plan) {
  const fetchFn = fakeFetch(world(live, plan));
  const sleep = fakeSleep();
  const result = await main({ fetchFn, sleep, root: ROOT });
  return { ...result, log: lines(result), asked: fetchFn.asked, slept: sleep.slept };
}

test('the game as the copy says: green, with what was compared', async () => {
  const r = await run(agreeing());
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /^\d+ objectives and \d+ sectors compared, maps 38, /);
  assert.ok(r.out.includes('The copy in js/wvw-static.js is what the game says.'));
  assert.deepEqual(r.slept, []);
  assert.equal(r.asked.filter((a) => a.includes('/sectors')).length, Object.keys(copy.sectors).length);
  const sectorCount = Object.values(copy.sectors).reduce((n, l) => n + l.length, 0);
  assert.ok(r.out.includes(`${copy.objectives.length} objectives and ${sectorCount} sectors compared, maps ${Object.keys(copy.sectors).join(', ')}`), r.log);
});

test('only the maps in play are compared; the copy of one out of play is named and left alone', async () => {
  const live = agreeing();
  live.sectors['1651'][0].name = 'Renamed';
  live.objectives = live.objectives.filter((o) => o.map_id !== 38);
  delete live.sectors['38'];
  live.matches = [{ maps: Object.keys(live.sectors).filter((k) => k !== '1651').map((k) => ({ id: Number(k) })) }];
  const r = await run(live);
  assert.equal(r.code, 0, r.log);
  assert.ok(r.out.includes('Not in play, not compared: 38, 1651'), r.log);
  const kept = Object.keys(live.sectors).filter((k) => k !== '38' && k !== '1651');
  const objectives = copy.objectives.filter((o) => kept.includes(String(o.map_id))).length;
  const sectors = kept.reduce((n, k) => n + copy.sectors[k].length, 0);
  assert.ok(r.out.includes(`${objectives} objectives and ${sectors} sectors compared, maps ${kept.join(', ')}`), r.log);
  assert.equal(errors(r).length, 0);
  assert.ok(!r.asked.some((a) => a.includes('/maps/1651/')));
});

test('a map in play the copy lacks fails', async () => {
  const live = agreeing();
  live.sectors['4242'] = [{ id: 1, name: 'New', bounds: [[0, 0]] }];
  const r = await run(live);
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('::error::Maps in play the copy lacks: 4242.'));
  assert.ok(r.out.at(-1).startsWith('1 problem(s). The page draws its maps from the copy, so it draws the old ones. Rebuild the copy in site/js/wvw-static.js'));
  assert.ok(!r.asked.some((a) => a.includes('/objectives')), 'it stops before asking for the rest');
});

test('a mismatch fails and the count of problems closes the log', async () => {
  const live = agreeing();
  live.objectives[0].name = 'Somewhere Else';
  const r = await run(live);
  assert.equal(r.code, 1);
  assert.equal(errors(r).length, 1);
  assert.match(r.out.at(-1), /^1 problem\(s\)\./);
  assert.equal(r.out.at(-2), '');
});

test('a route that never answers fails after three attempts and stops asking for the rest', async () => {
  for (const [route, pattern, asking] of [
    ['/wvw/matches?ids=all', /^::error::\/wvw\/matches did not answer \(HTTP 500 after 3 attempts\)\.$/, 3],
    ['/wvw/objectives?ids=all', /^::error::\/wvw\/objectives did not answer \(HTTP 500 after 3 attempts\)\.$/, 4],
    ['/continents/2/floors/3/regions/7/maps/38/sectors?ids=all', /^::error::Sectors of map 38 did not answer \(HTTP 500 after 3 attempts\)\.$/, null],
  ]) {
    const r = await run(agreeing(), { down: { [route]: { status: 500 } } });
    assert.equal(r.code, 1, r.log);
    assert.equal(errors(r).length, 1, r.log);
    assert.match(errors(r)[0], pattern);
    assert.deepEqual(r.slept, [5, 5]);
    if (asking) assert.equal(r.asked.length, asking, r.asked.join('\n'));
  }
});

test('a matches answer that names no map fails; a body that is not JSON fails too', async () => {
  const none = await run({ ...agreeing(), matches: [{ maps: [] }] });
  assert.equal(none.code, 1);
  assert.ok(none.out.includes('::error::/wvw/matches named no map.'));
  assert.ok(!none.out.some((l) => l.startsWith('Not in play')), 'with no map in play there is nothing to call out of play');
  const bad = await run(agreeing(), { down: { '/wvw/objectives?ids=all': { body: 'not json' } } });
  assert.equal(bad.code, 1);
  assert.match(errors(bad)[0], /^::error::\/wvw\/objectives did not answer \(SyntaxError: .* after 3 attempts\)\.$/);
});

test('an answer that fails twice and then comes is read', async () => {
  const live = agreeing();
  const fetchFn = fakeFetch((url) => {
    const route = url.slice(BASE.length);
    if (route === '/wvw/objectives?ids=all' && fetchFn.asked.filter((a) => a.endsWith(route)).length < 3) return { status: 503 };
    return world(live)(url);
  });
  const sleep = fakeSleep();
  const r = await main({ fetchFn, sleep, root: ROOT });
  assert.equal(r.code, 0, lines(r));
  assert.deepEqual(sleep.slept, [5, 5]);
});

test('a copy with a sectors key that is not a map number stops the check', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-'));
  fs.mkdirSync(path.join(root, 'site', 'js'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site', 'js', 'wvw-static.js'), 'const WVW_STATIC = {"objectives": [], "sectors": {"abc": []}};');
  await assert.rejects(main({ fetchFn: fakeFetch(() => ({ body: [] })), sleep: fakeSleep(), root }), /ValueError: invalid literal for int\(\): abc/);
});

test('every request says who is asking', async () => {
  const agents = [];
  const fetchFn = fakeFetch((url, init) => { agents.push(init.headers['User-Agent']); return world(agreeing())(url); });
  await main({ fetchFn, sleep: fakeSleep(), root: ROOT });
  assert.ok(agents.length > 3);
  assert.deepEqual([...new Set(agents)], ['wvwrelink-health-check']);
});

test('a name from the game cannot start a workflow command in the log', async () => {
  const live = agreeing();
  live.sectors['38'][0].name = 'Bad\n::error::injected::x\r100%';
  const r = await run(live);
  assert.equal(r.out.join('\n').split('\n').filter((l) => l.startsWith('::')).length, 1);
  assert.ok(r.out.some((l) => l.startsWith('::error::') && l.includes('Bad%0A::error::injected::x%0D100%25')));
});
