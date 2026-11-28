// What the Worker does when its stored or served data is not what it wrote: the objective counts
// (worker/index.mjs, takenNext, objectivesOf), the notes read, the kills rebuild after a reader's
// message, and the cached answers.
// Run: node --test "tests/unit/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NA_WEEK, setup, workerHarness, SUPA_ENV, v2Body, pushV2, quiet, withCache, liveOf } from './harness.mjs';

const latestRow = (w) => ({ ...w.sql.prepare("SELECT taken_red r, taken_blue b, taken_green g, flips_red fr, flips_blue fb, flips_green fg, flip_times t, owners o FROM latest WHERE id = '1-1'").get() });
const read = (rise, maps = []) => ({ id: '1-1', kills: [1, 2, 3, 4 + rise], start: NA_WEEK, scores: [1000 + rise, 2000, 3000], live: { ...liveOf('1-1', NA_WEEK, [1000 + rise, 2000, 3000]), maps } });
const camp = (id, owner, extra = {}) => ({ id, type: 'Camp', owner, points_capture: 2, ...extra });

test('a body with maps and objectives out of shape, counts what is in shape and writes the reading', async () => {
  const w = setup({ env: SUPA_ENV });
  assert.equal(await pushV2(w, 'latest-supa-us', [read(0)]), 200);
  assert.equal(latestRow(w).o, '[]', 'no objectives');
  w.advance(10e3);
  assert.equal(await pushV2(w, 'latest-supa-us', [read(5, 'not a list')]), 422, 'maps that are not a list never reach the count');
  w.advance(10e3);
  const maps = [
    null,
    { id: 'x', objectives: [camp('1-1', 'Red')] },
    { id: 7, objectives: 'none' },
    { id: 38, objectives: [camp('38-1', 'Red', { points_capture: 'lots' }), camp('38-2', 'Blue', { points_capture: -5 }), camp('38-3', 'Green', { points_capture: 0 })] }
  ];
  assert.equal(await pushV2(w, 'latest-supa-us', [read(10, maps)]), 200);
  assert.equal(w.sql.prepare("SELECT score FROM latest WHERE id = '1-1'").get().score, 6010);
  assert.equal(latestRow(w).o, '[["38-1",0,0],["38-2",1,0],["38-3",2,0]]', 'an objective with no usable capture value is kept at 0 points');
  w.advance(10e3);
  assert.equal(await pushV2(w, 'latest-supa-us', [read(20, [{ id: 38, objectives: [camp('38-1', 'Blue', { points_capture: 'lots' }), camp('38-2', 'Blue', { points_capture: -5 }), camp('38-3', 'Green', { points_capture: 0 })] }])]), 200);
  const r = latestRow(w);
  assert.deepEqual([r.r, r.b, r.fb], [0, 0, 1], 'the flip is counted, worth nothing');
});

test('stored owners that are JSON but not a list, flips that are not lists of integers, and a missing flip text, count nothing and never stop the write', async () => {
  for (const [col, value, why] of [['owners', '{"38-20":1}', 'owners an object'], ['owners', 'null', 'owners null'], ['flip_times', '{"38":"x"}', 'flips not a list'], ['flip_times', '{"38":[1.5]}', 'flips not integers'], ['flip_times', null, 'no flip text']]) {
    const w = setup({ env: SUPA_ENV });
    const maps = (owner) => [{ id: 38, objectives: [camp('38-1', owner)] }];
    assert.equal(await pushV2(w, 'latest-supa-us', [read(0, maps('Red'))]), 200);
    w.sql.prepare(`UPDATE latest SET ${col} = ?1 WHERE id = '1-1'`).run(value);
    w.advance(10e3);
    // Owners unchanged leaves the stored flip text as it is, or '{}' when it is missing; changed, compares with the stored owners.
    const same = col === 'flip_times';
    assert.equal(await pushV2(w, 'latest-supa-us', [read(10, maps(same ? 'Red' : 'Blue'))]), 200, why);
    assert.equal(w.sql.prepare("SELECT score FROM latest WHERE id = '1-1'").get().score, 6010, why);
    const r = latestRow(w);
    if (!same) assert.deepEqual([r.fb, r.t], [0, '{}'], why + ': nothing to compare with');
    else assert.equal(r.t, value === null ? '{}' : value, why);
    if (same) {
      w.advance(10e3);
      assert.equal(await pushV2(w, 'latest-supa-us', [read(20, maps('Blue'))]), 200, why);
      const after = latestRow(w);
      assert.equal(after.fb, 1, why + ': the next flip counts');
      assert.equal(after.t, '{"38":[' + Math.floor(w.now / 1000) + ']}', why + ': the bad flips start over');
    }
  }
});

test('GET /api/notes: a database that fails is a logged 503, never a thrown request', async () => {
  const w = workerHarness({ start: Date.parse('2026-11-24T12:00:00Z') });
  w.env.DB = { prepare: () => { throw new Error('d1 down'); } };
  const { r, lines } = await quiet(() => w.call(new Request('https://wvwrelink.com/api/notes')));
  assert.equal(r.status, 503);
  assert.equal((await r.text()).trim(), 'unavailable');
  assert.ok(lines.some((l) => l.read === 'notes' && l.failed.includes('d1 down')), 'logged');
});

test('a reader\'s message whose kills rebuild fails is still taken in, the failure logged', async () => {
  const w = setup({ env: SUPA_ENV });
  assert.equal(await pushV2(w, 'latest-supa-us', [read(0)]), 200);
  w.advance(10e3);
  const real = w.env.DB.prepare;
  w.env.DB = { prepare: (q) => { if (q.startsWith('SELECT at, rows FROM recent')) throw new Error('recent down'); return real(q); } };
  const before = w.sql.prepare('SELECT COUNT(*) n FROM kills').get().n;
  const { r, lines } = await quiet(() => pushV2(w, 'latest-supa-us', [read(10)]));
  assert.equal(r, 200);
  assert.equal(w.sql.prepare("SELECT score FROM latest WHERE id = '1-1'").get().score, 6010);
  assert.ok(w.sql.prepare('SELECT COUNT(*) n FROM kills').get().n > before, 'the kills line is in');
  assert.ok(lines.some((l) => l.recent === 'failed' && l.why.includes('recent down')), 'logged');
});

test('a cached answer without its own max-age is served at 5 seconds, and with no execution context the copy is still kept', async () => {
  const w = workerHarness({ start: Date.parse('2026-11-24T12:00:00Z'), ctx: null });
  await withCache(async (caches) => {
    const first = await w.call(new Request('https://wvwrelink.com/api/notes'));
    assert.equal(first.status, 200);
    assert.equal(caches.store.size, 1, 'kept with no context to wait on');
    const [key] = [...caches.store.keys()];
    caches.store.set(key, new Response('{"wiki":0,"notes":[]}', { headers: { 'content-type': 'application/json' } }));
    const hit = await w.call(new Request('https://wvwrelink.com/api/notes'));
    assert.equal(hit.headers.get('cache-control'), 'public, max-age=5');
    assert.equal(hit.headers.get('x-max-age'), null);
  });
});
