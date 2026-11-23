// /api/relink, /api/health and the daily cleanup (worker/index.mjs).
// Run: node --test "tests/unit/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.mjs';
import { fakeD1 } from '../worker-fakes/fake-d1.mjs';
import { setup } from './worker-harness.mjs';

test('/api/relink gives A1 as two integers, and 503 when it cannot', async () => {
  const w = setup();
  assert.equal((await w.get('/api/relink')).status, 503, 'nothing pushed yet');
  await w.post('relink', w.relink({ published: 1790700000 }));
  const r = await w.get('/api/relink');
  assert.equal(r.body, '{"window":1790992800,"published":1790700000}');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  // A1 not parsing reaches D1 as nulls; the page refuses it from the sheet too.
  w.advance(1000);
  await w.post('relink', w.relink({ window: null, published: null }));
  assert.equal((await w.get('/api/relink')).status, 503);
  w.advance(1000);
  await w.post('relink', w.relink());
  w.advance(44 * 60e3);
  assert.equal((await w.get('/api/relink')).status, 200);
  w.advance(2 * 60e3);
  assert.equal((await w.get('/api/relink')).status, 503, 'no beat in 46 minutes');
});

test('/api/health says when each source last reported', async () => {
  const w = setup();
  await w.post('kills', { rows: w.rows(w.now) });
  const body = JSON.parse((await w.get('/api/health')).body);
  assert.equal(body.kills, Math.floor(w.now / 1000));
  assert.equal(body.relink, 0);
});

test('the daily cleanup deletes kills older than 14 days and nothing newer', async () => {
  const { sql, ran, DB } = fakeD1();
  const now = Date.now();
  // The first and last match of each region; 2-9 only in old rows.
  const ids = ['1-1', '1-9', '2-1', '2-9'];
  for (const m of ids) {
    for (const d of m === '2-9' ? [15, 20] : [0, 1, 13, 14.1, 20]) {
      const at = Math.floor(now - d * 86400e3);
      sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,1,1,1,1,?)').run(m, at, at - 1000);
    }
  }
  // A row exactly at the cutoff stays: the clock is held so the cutoff is known.
  sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,1,1,1,1,?)').run('1-5', now - 14 * 86400e3, 0);
  const real = Date.now;
  Date.now = () => now;
  try {
    await worker.scheduled({}, { DB });
  } finally {
    Date.now = real;
  }
  assert.equal(sql.prepare("SELECT count(*) n FROM kills WHERE match = '1-5'").get().n, 1);
  sql.prepare("DELETE FROM kills WHERE match = '1-5'").run();
  const left = sql.prepare('SELECT match, at FROM kills ORDER BY match, at DESC').all()
    .map((r) => r.match + ':' + Math.round((now - r.at) / 86400e3));
  assert.deepEqual(left, ['1-1:0', '1-1:1', '1-1:13', '1-9:0', '1-9:1', '1-9:13', '2-1:0', '2-1:1', '2-1:13']);
  // Read by the key, never the whole table, and within D1's 100 bound values.
  const del = ran.find((s) => /^DELETE FROM kills/.test(s.q));
  const plan = sql.prepare('EXPLAIN QUERY PLAN ' + del.q).all(...del.args).map((p) => p.detail).join('; ');
  assert.match(plan, /SEARCH kills USING PRIMARY KEY \(match=\? AND at<\?\)/, plan);
  assert.doesNotMatch(plan, /SCAN kills/, plan);
  assert.ok(del.args.length <= 100);
});

test('the daily cleanup leaves its mark in source, and /api/health shows it', async () => {
  const w = setup();
  const sql = w.sql;
  const day = Date.now() - 86400e3;
  const now = Date.now();
  const real = Date.now;
  try {
    Date.now = () => day;
    await worker.scheduled({}, { DB: w.env.DB });
    // The next day's run moves the mark, not only the first one.
    Date.now = () => now;
    await worker.scheduled({}, { DB: w.env.DB });
  } finally {
    Date.now = real;
  }
  const rows = sql.prepare("SELECT t, received FROM source WHERE name = 'cleanup'").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ t: 0, received: Math.floor(now / 1000) }]);
  const body = JSON.parse((await w.get('/api/health')).body);
  assert.equal(body.cleanup, Math.floor(now / 1000));
});
