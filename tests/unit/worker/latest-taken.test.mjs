// What each team took this week (worker/index.mjs, takenNext): counted by the Worker from the
// readers' bodies, carried in the latest row, served with the copy.
// Run: node --test "tests/unit/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { NA_WEEK, setup, SUPA_ENV, pushV2, quiet } from './harness.mjs';

// Match 1-1 as the game answered the tests' page (tests/e2e/data), cut to its live part as the
// reader sends it. Its week is NA_WEEK. Tower 38-20 is Red's at a capture value of 40, camp
// 38-10 Green's at 2, camp 1099-116 Red's (the test below says which).
const RECORDED = (() => {
  const rec = JSON.parse(gunzipSync(readFileSync(new URL('../../e2e/data/recordings.json.gz', import.meta.url))));
  const m = JSON.parse(rec.entries['https://api.guildwars2.com/v2/wvw/matches?ids=all'][2]).find((x) => x.id === '1-1');
  return { ...m, skirmishes: m.skirmishes.slice(-1) };
})();

const objective = (body, id) => body.maps.flatMap((m) => m.objectives).find((o) => o.id === id);

// A reading: the recorded body with each objective's fields changed as `edits` says, and the
// scores summing to 6000 + rise (each reading must rise for the copy to take it).
function reading(rise, edits = {}, start = NA_WEEK) {
  const body = structuredClone(RECORDED);
  body.start_time = new Date(start).toISOString().replace('.000Z', 'Z');
  body.scores = { red: 1000 + rise, blue: 2000, green: 3000 };
  for (const [id, change] of Object.entries(edits)) Object.assign(objective(body, id), change);
  return { id: '1-1', start, scores: [1000 + rise, 2000, 3000], live: body };
}

const push = (w, r, source = 'latest-supa-us') => pushV2(w, source, [r]);
const row = (w) => ({ ...w.sql.prepare("SELECT taken_red r, taken_blue b, taken_green g, flips_red fr, flips_blue fb, flips_green fg, flip_times t FROM latest WHERE id = '1-1'").get() });
const served = async (w) => JSON.parse((await w.get('/api/latest')).body).matches.find((m) => m.id === '1-1');

test('the recorded body holds what these tests flip', () => {
  assert.deepEqual([objective(RECORDED, '38-20').owner, objective(RECORDED, '38-20').points_capture], ['Red', 40]);
  assert.deepEqual([objective(RECORDED, '38-10').owner, objective(RECORDED, '38-10').points_capture], ['Green', 2]);
});

test('a flip gives the new owner a flip and the value it was taken at, not the lowest tier it shows after', async () => {
  const w = setup({ env: SUPA_ENV });
  assert.equal(await push(w, reading(0)), 200);
  assert.deepEqual(row(w), { r: 0, b: 0, g: 0, fr: 0, fb: 0, fg: 0, t: '{}' }, 'the first reading only starts the count');
  assert.equal((await served(w)).taken, undefined, 'nothing taken yet: no field');
  w.advance(10e3);
  assert.equal(await push(w, reading(10, { '38-20': { owner: 'Blue', points_capture: 4 } })), 200);
  const t = Math.floor(w.now / 1000);
  assert.deepEqual(row(w), { r: 0, b: 40, g: 0, fr: 0, fb: 1, fg: 0, t: '{"38":[' + t + ']}' });
  const m = await served(w);
  assert.deepEqual(m.taken, { points: { red: 0, blue: 40, green: 0 }, flips: { red: 0, blue: 1, green: 0 }, maps: { 38: 1 } });
  assert.deepEqual(Object.keys(m), ['id', 'start', 'score', 'at', 'by', 'v', 'taken', 'body']);
});

test('an upgrade without a flip adds nothing, and the value a flip pays is the upgraded one', async () => {
  const w = setup({ env: SUPA_ENV });
  await push(w, reading(0));
  w.advance(10e3);
  // The camp upgraded: same owner, a higher value.
  await push(w, reading(10, { '38-10': { points_capture: 5 } }));
  assert.deepEqual(row(w), { r: 0, b: 0, g: 0, fr: 0, fb: 0, fg: 0, t: '{}' });
  w.advance(10e3);
  await push(w, reading(20, { '38-10': { owner: 'Red', points_capture: 2 } }));
  assert.equal(row(w).r, 5, 'the value of the reading before the flip');
  assert.equal(row(w).fr, 1);
});

test('back at the lowest tier after a flip, the next readings add nothing until it flips again', async () => {
  const w = setup({ env: SUPA_ENV });
  await push(w, reading(0));
  w.advance(10e3);
  await push(w, reading(10, { '38-20': { owner: 'Blue', points_capture: 4 } }));
  w.advance(10e3);
  await push(w, reading(20, { '38-20': { owner: 'Blue', points_capture: 4 } }));
  w.advance(10e3);
  await push(w, reading(30, { '38-20': { owner: 'Blue', points_capture: 12 } }));
  assert.deepEqual([row(w).b, row(w).fb, row(w).r, row(w).fr], [40, 1, 0, 0]);
  w.advance(10e3);
  await push(w, reading(40, { '38-20': { owner: 'Red', points_capture: 4 } }));
  assert.deepEqual([row(w).b, row(w).fb, row(w).r, row(w).fr], [40, 1, 12, 1]);
});

test('a new week starts from nothing, whatever the owners did across the turn', async () => {
  const w = setup({ env: SUPA_ENV });
  await push(w, reading(0));
  w.advance(10e3);
  await push(w, reading(10, { '38-20': { owner: 'Blue', points_capture: 4 } }));
  assert.equal(row(w).b, 40);
  // The next reset, five minutes past it.
  const next = NA_WEEK + 7 * 86400e3;
  w.advance(next + 5 * 60e3 - w.now);
  await push(w, reading(-990, { '38-20': { owner: 'Green', points_capture: 4 } }, next));
  assert.deepEqual(row(w), { r: 0, b: 0, g: 0, fr: 0, fb: 0, fg: 0, t: '{}' });
  w.advance(10e3);
  await push(w, reading(-980, { '38-20': { owner: 'Red', points_capture: 4 } }, next));
  assert.deepEqual([row(w).r, row(w).fr, row(w).b, row(w).g], [4, 1, 0, 0]);
});

test('a reading that lost its race to another reader does not write counts made from the row it read', async () => {
  const w = setup({ env: SUPA_ENV });
  await push(w, reading(0));
  w.advance(10e3);
  // The US reader's message reads the row, then the EU reader's whole message goes in before
  // the US one writes. The EU reading shows the tower flipped; the US one, later and higher,
  // shows it Red again: written over the EU row it would erase the flip the EU one counted.
  const real = w.env.DB;
  let held = false;
  w.env.DB = {
    prepare(q) {
      const st = real.prepare(q);
      if (held || !q.startsWith('INSERT INTO latest') || !q.includes('taken_red')) return st;
      held = true;
      w.env.DB = real;
      const all = st.all.bind(st);
      st.all = async () => {
        assert.equal(await push(w, reading(10, { '38-20': { owner: 'Blue', points_capture: 4 } }), 'latest-supa-eu'), 200);
        return all();
      };
      return st;
    }
  };
  assert.equal(await push(w, reading(20)), 200);
  assert.ok(held);
  assert.deepEqual([row(w).b, row(w).fb, row(w).fr], [40, 1, 0]);
  assert.equal(w.sql.prepare("SELECT reader FROM latest WHERE id = '1-1'").get().reader, 'latest-supa-eu');
  // The next US reading goes in against the EU row, and counts the flip back.
  w.advance(10e3);
  await push(w, reading(30));
  assert.deepEqual([row(w).b, row(w).fb, row(w).r, row(w).fr], [40, 1, 4, 1]);
});

test('the busiest map: each map serves the flips of the two hours up to the row, and keeps no older', async () => {
  const w = setup({ env: SUPA_ENV });
  await push(w, reading(0));
  w.advance(10e3);
  await push(w, reading(10, { '38-20': { owner: 'Blue', points_capture: 4 }, '38-10': { owner: 'Red' } }));
  const first = Math.floor(w.now / 1000);
  w.advance(3600e3);
  await push(w, reading(20, { '38-20': { owner: 'Blue', points_capture: 4 }, '38-10': { owner: 'Red' }, '1099-116': { owner: 'Green' } }));
  const second = Math.floor(w.now / 1000);
  assert.deepEqual((await served(w)).taken.maps, { 38: 2, 1099: 1 });
  // Two hours after the first flips, one more reading: theirs leave the window and the row.
  w.advance(3600e3);
  await push(w, reading(30, { '38-20': { owner: 'Blue', points_capture: 4 }, '38-10': { owner: 'Red' }, '1099-116': { owner: 'Green' } }));
  assert.ok(Math.floor(w.now / 1000) - first >= 7200);
  assert.equal(row(w).t, '{"1099":[' + second + ']}');
  assert.deepEqual((await served(w)).taken.maps, { 1099: 1 });
  // The week's counts keep every flip.
  assert.equal(row(w).fr + row(w).fb + row(w).fg, 3);
});

test('a version is served the same whatever the clock: the window ends at the row, not at now', async () => {
  const w = setup({ env: SUPA_ENV });
  await push(w, reading(0));
  w.advance(10e3);
  await push(w, reading(10, { '38-20': { owner: 'Blue', points_capture: 4 } }));
  w.advance(115 * 60e3);
  await push(w, reading(20, { '38-20': { owner: 'Blue', points_capture: 4 } }));
  const before = (await served(w)).taken;
  assert.deepEqual(before.maps, { 38: 1 });
  // Past two hours since the flip by the clock, not by the row: the copy still says the same.
  w.advance(9 * 60e3);
  assert.deepEqual((await served(w)).taken, before);
});

test('what counts: only objectives a capture pays for, each at most a top-tier keep, and a flip to no team is none', async () => {
  const w = setup({ env: SUPA_ENV });
  const all = RECORDED.maps.flatMap((m) => m.objectives);
  const spawn = all.find((o) => o.type === 'Spawn');
  const ruins = all.find((o) => o.type === 'Ruins');
  assert.ok(spawn && ruins);
  await push(w, reading(0, { '38-10': { points_capture: 100000 } }));
  w.advance(10e3);
  await push(w, reading(10, {
    '38-10': { owner: 'Blue', points_capture: 2 },
    '38-20': { owner: 'Neutral' },
    [spawn.id]: { owner: spawn.owner === 'Red' ? 'Blue' : 'Red' },
    [ruins.id]: { owner: ruins.owner === 'Red' ? 'Blue' : 'Red' }
  }));
  assert.deepEqual(row(w), { r: 0, b: 500, g: 0, fr: 0, fb: 1, fg: 0, t: '{"38":[' + Math.floor(w.now / 1000) + ']}' });
});

test('without schema-008 the readings still go in and the copy is served, without the counts', async () => {
  const w = setup({ env: SUPA_ENV, skip: ['schema-008-taken.sql'] });
  w.sql.exec("UPDATE note_served SET version = '0123456789abcdef', wiki = 1790000000");
  const { lines } = await quiet(async () => {
    assert.equal(await push(w, reading(0)), 200);
    w.advance(10e3);
    assert.equal(await push(w, reading(10, { '38-20': { owner: 'Blue', points_capture: 4 } })), 200);
    const m = await served(w);
    assert.equal(m.score, 6010);
    assert.equal(m.taken, undefined);
    assert.deepEqual(JSON.parse((await w.get('/api/latest')).body).notes, { v: '0123456789abcdef', wiki: 1790000000 }, 'the notes stay');
  });
  assert.ok(lines.some((l) => l.taken === 'failed'));
});

test('a row stored before the owners column compares against its body', async () => {
  const w = setup({ env: SUPA_ENV });
  await push(w, reading(0));
  w.sql.exec("UPDATE latest SET owners = NULL, taken_red = NULL, flips_red = NULL, flip_times = NULL WHERE id = '1-1'");
  w.advance(10e3);
  await push(w, reading(10, { '38-20': { owner: 'Blue', points_capture: 4 } }));
  assert.deepEqual([row(w).b, row(w).fb, row(w).r, row(w).fr], [40, 1, 0, 0]);
  assert.ok(w.sql.prepare("SELECT owners FROM latest WHERE id = '1-1'").get().owners.includes('["38-20",1,4]'));
});
