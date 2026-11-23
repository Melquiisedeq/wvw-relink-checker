// Format 2 of the latest entrance and /api/history (worker/index.mjs): plain JSON,
// the live part and the history apart (supabase/reader.mjs builds it).
// Run: node --test "tests/unit/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { NA_WEEK, EU_WEEK, setup, SUPA, SUPA_ENV, sha, NA_DONE, skirmishList, liveOf, v2Body, pushV2, countQueries, quiet, withCache } from './harness.mjs';

test('format 2: the live part goes where the copy lives, the history in its own table, and both are served', async () => {
  const w = setup({ env: SUPA_ENV });
  const hist = skirmishList(NA_DONE);
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', hist: { n: NA_DONE, body: hist } }, { id: '1-2' }]), 200);
  const latest = JSON.parse((await w.get('/api/latest')).body);
  assert.deepEqual(latest.matches.map((m) => Object.keys(m)), [
    ['id', 'start', 'score', 'at', 'by', 'v', 'body'], ['id', 'start', 'score', 'at', 'by', 'v', 'body']]);
  assert.deepEqual(latest.matches[0].body, liveOf('1-1'));
  assert.equal(latest.matches[0].v, 2);
  // The summary says which history the Worker holds, so the reader sends it only when it grows.
  const summary = JSON.parse((await w.get('/api/latest/summary')).body);
  assert.equal(summary['1-1'].hist, NA_DONE);
  assert.ok(!('hist' in summary['1-2']));
  const r = await w.get('/api/history/1?v=' + NA_DONE);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { v: NA_DONE, start: NA_WEEK, matches: { '1-1': hist } });
  assert.equal(r.headers.get('content-type'), 'application/json');
  // The kills line and the board go on as they always did.
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 2);
});

test('format 2: the history moves only forward, and a new week replaces it', async () => {
  const w = setup({ env: SUPA_ENV });
  const held = () => w.sql.prepare("SELECT start, n FROM history WHERE match = '1-1'").get();
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', hist: { n: NA_DONE } }]), 200);
  assert.equal(await pushV2(w, 'latest-supa-eu', [{ id: '1-1', scores: [1000, 2000, 3001], hist: { n: NA_DONE - 1 } }]), 200);
  assert.deepEqual({ ...held() }, { start: NA_WEEK, n: NA_DONE }, 'a reader behind does not take it back');
  w.advance(7 * 86400e3 - 106 * 3600e3 + 3 * 3600e3);
  const next = NA_WEEK + 7 * 86400e3;
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', start: next, scores: [10, 20, 30], hist: { n: 1 } }]), 200);
  assert.deepEqual({ ...held() }, { start: next, n: 1 });
});

test('format 2: a part that is not JSON or out of shape is left out alone; the others go in', async () => {
  const w = setup({ env: SUPA_ENV });
  const { r, lines } = await quiet(() => pushV2(w, 'latest-supa-us', [
    { id: '1-1', live: '{"id":"1-1",' },
    { id: '1-2', hist: { n: NA_DONE, body: skirmishList(NA_DONE - 1).concat([{ id: 99 }]) } },
    { id: '1-3', live: liveOf('1-4') },
    { id: '1-4', live: { ...liveOf('1-4'), scores: { red: 1, blue: 2, green: 3 } } },
    { id: '1-5', live: Buffer.from([0x7b, 0xff, 0x7d]) },
    { id: '1-6', live: liveOf('1-6', NA_WEEK - 7 * 86400e3) },
    { id: '1-7', sha: 'f'.repeat(64) },
    { id: '1-8', live: [] },
    { id: '1-9', hist: { n: 2, body: skirmishList(3) } },
    { id: '2-1', start: EU_WEEK, hist: { n: 57, body: '[{"id":1}' } }
  ]));
  assert.equal(r, 200);
  assert.deepEqual(w.sql.prepare('SELECT id FROM latest ORDER BY id').all().map((x) => x.id), ['1-2', '1-9', '2-1']);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM history').get().n, 0);
  assert.deepEqual(lines.find((l) => l.parts).why.map((s) => s.slice(0, 40)), [
    '1-1 live not JSON', '1-2 history ids', '1-3 live not this match', '1-4 live scores', '1-5 live not JSON',
    '1-6 live not this match', '1-7 live sha256', '1-8 live not an object', '1-9 history length', '2-1 history not JSON']);
  // Every part broken: nothing to keep, and not even the replay claim is written.
  const before = w.sql.prepare("SELECT t FROM source WHERE name = 'latest-supa-eu'").get().t;
  const all = await quiet(() => pushV2(w, 'latest-supa-eu', [{ id: '1-1', live: 'x' }]));
  assert.equal(all.r, 422);
  assert.equal(w.sql.prepare("SELECT t FROM source WHERE name = 'latest-supa-eu'").get().t, before);
});

test('format 2: a summary out of shape refuses the whole message, before any write', async (sub) => {
  const w = setup({ env: SUPA_ENV });
  const body = (over) => {
    const b = v2Body([{ id: '1-1', hist: { n: NA_DONE } }]);
    const nl = b.indexOf(10);
    const head = JSON.parse(b.subarray(0, nl));
    over(head.matches[0]);
    return Buffer.concat([Buffer.from(JSON.stringify(head) + '\n'), b.subarray(nl + 1)]);
  };
  const cases = {
    'neither live nor hist': (m) => { delete m.live; delete m.hist; },
    'a live part without counts': (m) => { delete m.scores; },
    'a sha256 that is no hash': (m) => { m.live.sha256 = 'x'; },
    'a history of 0': (m) => { m.hist.n = 0; },
    'a history of a skirmish still running': (m) => { m.hist.n = NA_DONE + 1; },
    'a history past 64 KiB': (m) => { m.hist.bytes = 64 * 1024 + 1; },
    'bytes that do not add up': (m) => { m.hist.bytes--; },
    'hist that is null': (m) => { m.hist = null; }
  };
  for (const [name, over] of Object.entries(cases)) {
    await sub.test(name, async () => {
      assert.equal(await w.post('latest-supa-us', body(over), { key: SUPA['latest-supa-us'] }), 422);
      assert.equal(w.sql.prepare('SELECT count(*) n FROM latest').get().n, 0);
    });
  }
  assert.equal(w.sql.prepare("SELECT t FROM source WHERE name = 'latest-supa-us'").get().t, 0);
  // A well-formed live part over 64 KiB, its hash right: only the cap refuses it.
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', live: { ...liveOf('1-1'), pad: 'x'.repeat(64 * 1024) } }]), 422);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM latest').get().n, 0);
  // The edge the other way: a history of the skirmish that ends within the signature's 5 minutes.
  w.advance(2 * 3600e3 - 5 * 60e3);
  const short = await quiet(() => w.post('latest-supa-us', body((m) => { m.hist.n = NA_DONE + 1; }), { key: SUPA['latest-supa-us'] }));
  assert.equal(short.r, 200, 'n is allowed; the part holds 53, so only it is left out');
  assert.deepEqual(short.lines.find((l) => l.parts).why, ['1-1 history length']);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM history').get().n, 0);
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', scores: [1000, 2000, 3001], hist: { n: NA_DONE + 1 } }]), 200);
  assert.equal(w.sql.prepare("SELECT n FROM history WHERE match = '1-1'").get().n, NA_DONE + 1);
});

test('the old format (v 1) is refused, with nothing written, and the claim is left free', async () => {
  const w = setup({ env: SUPA_ENV });
  // A complete message of the old shape: one gzip per match, its size, raw size and hash.
  const gz = gzipSync(Buffer.from(JSON.stringify(liveOf('1-1'))));
  const entry = { id: '1-1', start: NA_WEEK, scores: [1000, 2000, 3000], kills: [1, 2, 3, 4], bytes: gz.length, raw: 220, sha256: sha(gz) };
  const old = Buffer.concat([Buffer.from(JSON.stringify({ v: 1, matches: [entry] }) + '\n'), gz]);
  assert.equal(await w.post('latest-supa-us', old, { key: SUPA['latest-supa-us'] }), 422);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM latest').get().n, 0);
  assert.equal(w.sql.prepare("SELECT t FROM source WHERE name = 'latest-supa-us'").get().t, 0);
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]), 200);
  const { matches } = JSON.parse((await w.get('/api/latest')).body);
  assert.deepEqual(matches.map((m) => [m.id, m.v, typeof m.body]), [['1-1', 2, 'object']]);
});

test('format 2 without the history table: the live parts go in, the summary has no hist, the route says 503', async () => {
  const w = setup({ env: SUPA_ENV, skip: ['schema-006-history.sql'] });
  const { r, lines } = await quiet(() => pushV2(w, 'latest-supa-us', [{ id: '1-1', hist: { n: NA_DONE } }]));
  assert.equal(r, 200);
  assert.ok(lines.some((l) => l.history === 'failed'), JSON.stringify(lines));
  assert.equal(w.sql.prepare('SELECT count(*) n FROM latest').get().n, 1);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 1);
  const read = await quiet(() => w.get('/api/latest/summary'));
  assert.ok(read.lines.some((l) => l.read === '/api/latest/summary' && l.history === 'failed'), JSON.stringify(read.lines));
  const summary = read.r;
  assert.equal(summary.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(summary.body)['1-1']), ['start', 'score', 'at', 'by']);
  assert.equal((await quiet(() => w.get('/api/history/1?v=' + NA_DONE))).r.status, 503);
});

test('/api/history: a version outside the window is a short 404 that never reads D1', async () => {
  const w = setup({ env: SUPA_ENV });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', hist: { n: NA_DONE } }, { id: '2-1', start: EU_WEEK, hist: { n: 57 } }]), 200);
  const n = countQueries(w);
  for (const path of [
    '/api/history/1?v=' + (NA_DONE - 2), '/api/history/1?v=' + (NA_DONE + 1), '/api/history/1?v=0', '/api/history/1?v=053',
    '/api/history/1?v=-1', '/api/history/1?v=abc', '/api/history/1', '/api/history/1?v=53&x=1', '/api/history/1?x=1&v=53',
    '/api/history/3?v=53', '/api/history/0?v=53', '/api/history/1/?v=53', '/api/history/?v=53', '/api/history/constructor?v=53',
    '/api/history/2?v=' + NA_DONE
  ]) {
    const r = await w.get(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=10', path);
  }
  assert.equal(n.q, 0, 'no statement prepared');
  assert.equal((await w.get('/api/history/1?v=' + NA_DONE, 'POST')).status, 405);
  assert.equal(n.q, 0);
  // Valid: one read each. The version before is valid too, and the D1 does not hold it: a 200 with no matches.
  assert.equal((await w.get('/api/history/1?v=' + NA_DONE)).status, 200);
  assert.equal((await w.get('/api/history/2?v=57')).status, 200);
  const before = await w.get('/api/history/1?v=' + (NA_DONE - 1));
  assert.equal(before.status, 200);
  assert.deepEqual(JSON.parse(before.body), { v: NA_DONE - 1, start: NA_WEEK, matches: {} });
  assert.equal(before.headers.get('cache-control'), 'public, max-age=10');
  assert.equal(n.q, 3);
  // On the turn the clock moves the window: 54 is now current and 53 the one before.
  w.advance(2 * 3600e3);
  assert.equal((await w.get('/api/history/1?v=' + NA_DONE)).status, 200);
  assert.equal((await w.get('/api/history/1?v=' + (NA_DONE + 1))).status, 200);
  assert.equal((await w.get('/api/history/1?v=' + (NA_DONE + 2))).status, 404);
  assert.equal((await w.get('/api/history/1?v=' + (NA_DONE - 1))).status, 404);
  assert.equal(n.q, 5);
});

test('/api/history: the ceiling is the ingest one, MAX_SKEW_S before the hour', async () => {
  const w = setup({ env: SUPA_ENV });
  w.advance(2 * 3600e3 - 240e3);
  assert.equal((await w.get('/api/history/1?v=' + (NA_DONE + 1))).status, 200, '4 min before the hour');
  w.advance(-120e3);
  assert.equal((await w.get('/api/history/1?v=' + (NA_DONE + 1))).status, 404, '6 min before the hour');
});

test('/api/history: the version the game turns to before the hour is read, the others are not', async () => {
  const w = setup({ env: SUPA_ENV });
  w.advance(2 * 3600e3 - 50e3);
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', hist: { n: NA_DONE + 1 } }]), 200);
  const n = countQueries(w);
  const ahead = await w.get('/api/history/1?v=' + (NA_DONE + 1));
  assert.equal(ahead.status, 200, '50 s before the hour the history of the turned skirmish is there');
  assert.deepEqual(Object.keys(JSON.parse(ahead.body).matches), ['1-1']);
  assert.equal(ahead.headers.get('cache-control'), 'public, max-age=14400');
  assert.equal(n.q, 1);
  // A valid version not written yet: 200 with no matches and the miss time, never a 404.
  const unwritten = await w.get('/api/history/2?v=' + 58);
  assert.equal(unwritten.status, 200);
  assert.deepEqual(JSON.parse(unwritten.body), { v: 58, start: EU_WEEK, matches: {} });
  assert.equal(unwritten.headers.get('cache-control'), 'public, max-age=10');
  assert.equal(n.q, 2);
  // The attacks: each a 404 with no statement prepared.
  const top = Math.floor((w.now - NA_WEEK + 300e3) / (2 * 3600e3));
  assert.equal(top, NA_DONE + 1, 'the ceiling is the ingest one');
  for (const v of [top + 1, NA_DONE - 2, '0', '100', 'abc', '1e1', '-1', '%204', '+4', '4.0']) {
    const r = await w.get('/api/history/1?v=' + v);
    assert.equal(r.status, 404, 'v=' + v);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=10', 'v=' + v);
  }
  assert.equal((await w.get('/api/history/1?v= 4')).status, 404, 'v= 4');
  assert.equal(n.q, 2, 'none of them reached D1');
});

test('/api/history: a whole version is kept long under its own key; one with a match behind only a minute', async () => {
  const w = setup({ env: SUPA_ENV });
  const store = new Map();
  const real = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async (k) => (store.has(k) ? store.get(k).clone() : undefined),
      put: async (k, r) => { store.set(k, r); }
    }
  };
  try {
    assert.equal(await pushV2(w, 'latest-supa-us', [
      { id: '1-1', hist: { n: NA_DONE } }, { id: '1-2', hist: { n: NA_DONE - 1 } }]), 200);
    const n = countQueries(w);
    const part = await w.get('/api/history/1?v=' + NA_DONE);
    assert.equal(part.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(part.body).matches), ['1-1']);
    assert.equal(part.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(store.size, 1, 'a version with a match behind is kept, for its minute');
    store.clear();
    assert.equal(await pushV2(w, 'latest-supa-eu', [{ id: '1-2', scores: [1000, 2000, 3001], hist: { n: NA_DONE } }]), 200);
    const whole = await w.get('/api/history/1?v=' + NA_DONE);
    assert.equal(whole.headers.get('cache-control'), 'public, max-age=14400');
    assert.deepEqual(Object.keys(JSON.parse(whole.body).matches), ['1-1', '1-2']);
    assert.deepEqual([...store.keys()], ['https://wvwrelink.com/api/history/1?v=' + NA_DONE + '&start=' + NA_WEEK]);
    const reads = n.q;
    const hit = await w.get('/api/history/1?v=' + NA_DONE);
    assert.equal(hit.body, whole.body);
    assert.equal(hit.headers.get('cache-control'), 'public, max-age=14400');
    assert.equal(hit.headers.get('x-max-age'), null, 'the kept max-age stays inside');
    assert.equal(n.q, reads, 'a hit reads nothing');
  } finally {
    globalThis.caches = real;
  }
});

test('/api/history: a valid version not there yet, and one with a match behind, are kept too, for their short time', async () => {
  const w = setup({ env: SUPA_ENV });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', hist: { n: NA_DONE } }, { id: '1-2', hist: { n: NA_DONE - 1 } }]), 200);
  await withCache(async () => {
    const n = countQueries(w);
    const path = '/api/history/1?v=' + (NA_DONE - 1);
    for (let i = 0; i < 2; i++) {
      const r = await w.get('/api/history/1?v=' + NA_DONE);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=60', 'a version with a match behind');
    }
    assert.equal(n.q, 1, 'the second read of a partial version is the cache');
    const fresh = setup({ env: SUPA_ENV });
    assert.equal(await pushV2(fresh, 'latest-supa-us', [{ id: '1-1' }]), 200);
    const m = countQueries(fresh);
    for (let i = 0; i < 2; i++) {
      const r = await fresh.get(path);
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body).matches, {});
      assert.equal(r.headers.get('cache-control'), 'public, max-age=10');
    }
    assert.equal(m.q, 1, 'two reads of a version D1 does not hold yet: one query');
  });
});

test('/api/history: whole only when every match of the region in latest this week has the version', async () => {
  const w = setup({ env: SUPA_ENV });
  // 1-2 is in latest this week with no history at all (its part left out, or a new tier).
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', hist: { n: NA_DONE } }, { id: '1-2' }]), 200);
  const r = await w.get('/api/history/1?v=' + NA_DONE);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(r.body).matches), ['1-1']);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(await pushV2(w, 'latest-supa-eu', [{ id: '1-2', scores: [1000, 2000, 3001], hist: { n: NA_DONE } }]), 200);
  assert.equal((await w.get('/api/history/1?v=' + NA_DONE)).headers.get('cache-control'), 'public, max-age=14400');
});

test('format 2: a live part with anything before its "{" is left out', async () => {
  const w = setup({ env: SUPA_ENV });
  const { r, lines } = await quiet(() => pushV2(w, 'latest-supa-us', [
    { id: '1-1', live: ' ' + JSON.stringify(liveOf('1-1')) }, { id: '1-2' }]));
  assert.equal(r, 200);
  assert.deepEqual(lines.find((l) => l.parts).why, ['1-1 live not an object']);
  assert.deepEqual(w.sql.prepare('SELECT id FROM latest').all().map((x) => x.id), ['1-2']);
});

test('format 2: a live part with no maps is left out, and a summary that is no object or has another version is 422', async () => {
  const w = setup({ env: SUPA_ENV });
  const { r, lines } = await quiet(() => pushV2(w, 'latest-supa-us', [
    { id: '1-1', live: { ...liveOf('1-1'), maps: undefined } }, { id: '1-2' }]));
  assert.equal(r, 200);
  assert.deepEqual(lines.find((l) => l.parts).why, ['1-1 live maps']);
  assert.deepEqual(w.sql.prepare('SELECT id FROM latest').all().map((x) => x.id), ['1-2']);
  const refused = async (summary) => {
    const out = await quiet(() => w.post('latest-supa-us', Buffer.from(summary + '\n'), { key: SUPA['latest-supa-us'] }));
    assert.deepEqual(out.lines.map((l) => [l.refused, l.why]), [[422, 'version']], summary);
    return out.r;
  };
  for (const summary of ['null', '5', '{"v":3,"matches":[]}', '{"v":0,"matches":[]}', '{"matches":[]}']) {
    assert.equal(await refused(summary), 422);
  }
});

test('/api/history: the matches come in order of their id, whichever order D1 reads them in', async () => {
  const w = setup({ env: SUPA_ENV });
  const ids = ['1-1', '1-2', '1-3'];
  for (const id of ids) assert.equal(await pushV2(w, 'latest-supa-us', [{ id, hist: { n: NA_DONE } }]), 200);
  const real = w.env.DB;
  let turn = (rows) => rows;
  w.env.DB = {
    prepare: (q) => {
      const st = real.prepare(q);
      if (!q.includes('FROM latest l LEFT JOIN history')) return st;
      return { bind: (...a) => ({ all: async () => { const r = await st.bind(...a).all(); return { ...r, results: turn(r.results) }; } }) };
    }
  };
  for (const [name, order] of [['reversed', (rows) => [...rows].reverse()], ['rotated', (rows) => [...rows.slice(1), rows[0]]]]) {
    turn = order;
    const r = await w.get('/api/history/1?v=' + NA_DONE);
    assert.deepEqual(Object.keys(JSON.parse(r.body).matches), ids, name);
  }
});

test('/api/history: on the reset day before the reset hour the week is still the last one', async () => {
  const w = setup({ env: SUPA_ENV });
  w.advance(Date.parse('2026-10-03T01:00:00Z') - w.now);
  const done = Math.floor((w.now - NA_WEEK) / (2 * 3600e3));
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', hist: { n: done } }]), 200);
  const r = await w.get('/api/history/1?v=' + done);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).start, NA_WEEK);
  w.advance(3600e3);
  assert.equal((await w.get('/api/history/1?v=' + done)).status, 404, 'at the reset the week is a new one, and the old version is gone');
});
