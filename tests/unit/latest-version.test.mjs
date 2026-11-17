// /api/latest?v= and the latest ingest's versions (worker/index.mjs): the copy kept
// under its version's key, the refusals that read no D1, and the clock guard.
// Run: node --test "tests/unit/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EU_WEEK, setup, SUPA, SUPA_ENV, sha, v2Body, pushV2, countQueries, quiet, withCache, fakeLive, VERSION_KEY, vname } from './worker-harness.mjs';

const VKEY_ENV = { ...SUPA_ENV, VERSION_KEY };

test('/api/latest?v=: a version the ingest did not mint is a short 404 that reads no D1 and no cache', async () => {
  const w = setup({ env: VKEY_ENV });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }, { id: '2-1', start: EU_WEEK }]), 200);
  const at = Math.floor(w.now / 1000);
  const good = vname(at).split('.')[1];
  await withCache(async (caches) => {
    const looked = [];
    const match = caches.default.match;
    caches.default.match = (k) => { looked.push(k); return match(k); };
    const n = countQueries(w);
    for (const v of [String(at), vname(at, 'another key'), (at + 1) + '.' + good, at + '.' + good.toUpperCase(), at + '.' + good.slice(1),
      at + '.' + good + '00', at + '.' + good.slice(0, 31) + (good[31] === '0' ? '1' : '0'),
      vname(at) + '&x=1', '0' + vname(at), 'abc', '']) {
      const r = await w.get('/api/latest?v=' + v);
      assert.equal(r.status, 404, v);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=5', v);
    }
    assert.equal(n.q, 0, 'no D1 statement for a version not minted');
    assert.deepEqual(looked, [], 'nor a look in the cache');
    assert.equal(caches.store.size, 0);
  });
  assert.equal((await w.get('/api/latest?v=' + vname(at), 'POST')).status, 405);
  const r = await w.get('/api/latest?v=' + vname(at));
  assert.equal(r.status, 200);
  assert.equal(r.body, (await w.get('/api/latest')).body);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60', 'final from its first read');
  // Any other query is the plain read, as before.
  assert.equal((await w.get('/api/latest?x=' + at)).headers.get('cache-control'), 'public, max-age=5');
  // Past STALE_LATEST_S: a 404, no D1.
  w.advance(11 * 60e3);
  const m = countQueries(w);
  assert.equal((await w.get('/api/latest?v=' + vname(at))).status, 404);
  assert.equal(m.q, 0);
});

test('/api/latest?v=: without VERSION_KEY none is minted, every v is a 404 with no D1, and the tabs are told no version', async () => {
  const live = fakeLive();
  const w = setup({ env: { ...SUPA_ENV, LIVE: live.ns } });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]), 200);
  const at = Math.floor(w.now / 1000);
  assert.equal((await live.requests[0].json()).version, undefined);
  const n = countQueries(w);
  assert.equal((await w.get('/api/latest?v=' + vname(at))).status, 404);
  assert.equal(n.q, 0);
});

test('/api/latest?v=: a VERSION_KEY under 64 characters is no key: no version minted, every v a 404 with no D1', async () => {
  const live = fakeLive();
  const short = VERSION_KEY.slice(0, 63);
  const w = setup({ env: { ...SUPA_ENV, VERSION_KEY: short, LIVE: live.ns } });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]), 200);
  const at = Math.floor(w.now / 1000);
  assert.equal((await live.requests[0].json()).version, undefined);
  const n = countQueries(w);
  assert.equal((await w.get('/api/latest?v=' + vname(at, short))).status, 404);
  assert.equal(n.q, 0);
});

test('/api/latest?v=: a minted version past LATEST_AHEAD_S ahead of the clock is a short 404, logged, with no D1 and no cache', async () => {
  const w = setup({ env: VKEY_ENV });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]), 200);
  const at = Math.floor(w.now / 1000);
  await withCache(async (caches) => {
    const looked = [];
    const match = caches.default.match;
    caches.default.match = (k) => { looked.push(k); return match(k); };
    const n = countQueries(w);
    const { r, lines } = await quiet(() => w.get('/api/latest?v=' + vname(at + 61)));
    assert.equal(r.status, 404);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=5');
    assert.equal(n.q, 0, 'no D1');
    assert.deepEqual(looked, [], 'no look in the cache');
    assert.deepEqual(lines, [{ read: 'latest version', refused: 'ahead', seconds: 61 }], 'the sign of a VERSION_KEY out of our hands');
    // At the ceiling it is read.
    assert.equal((await w.get('/api/latest?v=' + vname(at + 60))).status, 503);
  });
});

test('/api/latest?v=: D1 failing is a 503, logged, never a thrown request', async () => {
  const w = setup({ env: VKEY_ENV });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]), 200);
  const at = Math.floor(w.now / 1000);
  w.env.DB = { prepare: () => { throw new Error('d1 down'); } };
  const logged = [];
  const log = console.log;
  console.log = (line) => logged.push(line);
  try {
    const r = await w.get('/api/latest?v=' + vname(at));
    assert.equal(r.status, 503);
    assert.equal(r.body.trim(), 'unavailable');
  } finally {
    console.log = log;
  }
  assert.ok(logged.some((l) => l.includes('latest version') && l.includes('d1 down')));
});

test('/api/latest?v=: kept under its version\'s key from the first read, and a hit reads no copy', async () => {
  const w = setup({ env: VKEY_ENV });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]), 200);
  const at = Math.floor(w.now / 1000);
  await withCache(async (caches) => {
    const first = await w.get('/api/latest?v=' + vname(at));
    assert.equal(first.status, 200);
    assert.ok(caches.store.has('https://wvwrelink.com/api/latest?v=' + at), 'kept at the first read');
    const n = countQueries(w);
    const hit = await w.get('/api/latest?v=' + vname(at));
    assert.equal(hit.body, first.body);
    assert.equal(n.q, 0, 'the copy from the cache');
    // A newer ingest leaves the version's copy as it was in the cache.
    w.advance(30e3);
    assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', scores: [1000, 2000, 3100] }]), 200);
    assert.equal(await caches.store.get('https://wvwrelink.com/api/latest?v=' + at).clone().text(), first.body);
  });
});

test('/api/latest?v=: a minted version passed over is a 404 kept under its key, read from D1 once', async () => {
  const w = setup({ env: VKEY_ENV });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]), 200);
  const at = Math.floor(w.now / 1000);
  w.advance(30e3);
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', scores: [1000, 2000, 3100] }]), 200);
  await withCache(async (caches) => {
    const n = countQueries(w);
    for (let i = 0; i < 3; i++) {
      const r = await w.get('/api/latest?v=' + vname(at));
      assert.equal(r.status, 404);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=570', 'kept until it leaves STALE_LATEST_S');
    }
    assert.equal(n.q, 1, 'one copy read for three asks');
    assert.equal(caches.store.get('https://wvwrelink.com/api/latest?v=' + at).status, 404);
  });
});

test('/api/latest?v=: a passed-over version read across the end of STALE_LATEST_S never says a negative max-age', async () => {
  const w = setup({ env: VKEY_ENV });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]), 200);
  const at = Math.floor(w.now / 1000);
  w.advance(30e3);
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', scores: [1000, 2000, 3100] }]), 200);
  w.advance((at + 600) * 1000 - w.now);
  const realDb = w.env.DB;
  let release, reached;
  const gate = new Promise((r) => { release = r; });
  const atRead = new Promise((r) => { reached = r; });
  w.env.DB = {
    prepare(q) {
      const st = realDb.prepare(q);
      if (!q.includes('FROM latest')) return st;
      return { all: async () => { reached(); await gate; return st.all(); } };
    }
  };
  const read = w.get('/api/latest?v=' + vname(at));
  await atRead;
  w.advance(1500);
  release();
  const r = await read;
  assert.equal(r.status, 404);
  const age = Number(/max-age=(-?\d+)/.exec(r.headers.get('cache-control'))[1]);
  assert.ok(age >= 0, r.headers.get('cache-control'));
});

test('/api/latest?v=: two readers applying in the same second get two versions, each copy final', async () => {
  const live = fakeLive();
  const w = setup({ env: { ...VKEY_ENV, LIVE: live.ns } });
  const at = Math.floor(w.now / 1000);
  await withCache(async () => {
    assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }, { id: '1-2' }]), 200);
    assert.deepEqual(w.sql.prepare('SELECT DISTINCT at FROM latest').all().map((r) => r.at), [at], 'one version for the whole message');
    const first = await w.get('/api/latest?v=' + vname(at));
    assert.deepEqual(JSON.parse(first.body).matches.map((m) => m.id), ['1-1', '1-2']);
    assert.equal(await pushV2(w, 'latest-supa-eu', [{ id: '2-1', start: EU_WEEK }]), 200);
    assert.equal(w.sql.prepare("SELECT at FROM latest WHERE id = '2-1'").get().at, at + 1, 'the same second, the next version');
    const told = await live.requests[1].json();
    assert.deepEqual(told.matches.map((m) => m.at), [at + 1], 'the tabs are told that version');
    assert.equal(told.version, vname(at + 1));
    assert.equal((await w.get('/api/latest?v=' + vname(at))).body, first.body, 'the first copy does not change');
    const second = JSON.parse((await w.get('/api/latest?v=' + told.version)).body);
    assert.deepEqual(second.matches.map((m) => m.id), ['1-1', '1-2', '2-1'], 'the second reader\'s match is in its own');
    assert.equal(second.at, at + 1);
  });
  // A message that applies nothing takes no version.
  assert.equal(await pushV2(w, 'latest-supa-eu', [{ id: '2-1', start: EU_WEEK }]), 200);
  assert.equal(Math.max(...w.sql.prepare('SELECT at FROM latest').all().map((r) => r.at)), at + 1);
});

test('the latest ingest: rows written are known with or without RETURNING\'s results, and a message that applies nothing tells nobody', async () => {
  const live = fakeLive();
  const w = setup({ env: { ...VKEY_ENV, LIVE: live.ns } });
  const real = w.env.DB;
  w.env.DB = { prepare: (q) => {
    const st = real.prepare(q);
    if (!q.includes('RETURNING')) return st;
    return { bind: (...a) => { const b = st.bind(...a); return { all: async () => ({ ...(await b.all()), results: [] }) }; } };
  } };
  const post = (source, entries) => quiet(() => w.post(source, v2Body(entries), { key: SUPA[source] }));
  assert.equal((await post('latest-supa-us', [{ id: '1-1' }, { id: '1-2' }])).r, 200);
  const at = Math.floor(w.now / 1000);
  assert.deepEqual(w.sql.prepare('SELECT id, at FROM latest ORDER BY id').all().map((r) => [r.id, r.at]), [['1-1', at], ['1-2', at]]);
  assert.equal((await w.get('/api/latest?v=' + vname(at))).status, 200);
  const first = await live.requests[0].json();
  assert.deepEqual(first.matches.map((m) => [m.id, m.at]), [['1-1', at], ['1-2', at]], 'both told, at the version');
  assert.equal(first.version, vname(at));
  // The other reader in the same second, then again with nothing new 200 ms on: its row
  // before, ahead of the clock, is not taken for this message's.
  assert.equal((await post('latest-supa-eu', [{ id: '2-1', start: EU_WEEK }])).r, 200);
  assert.equal(live.requests.length, 2);
  w.advance(200);
  const again = await post('latest-supa-eu', [{ id: '2-1', start: EU_WEEK }]);
  assert.equal(again.r, 200);
  assert.equal(again.lines.find((l) => l.ok).applied, 0, 'nothing applied');
  assert.equal(live.requests.length, 2, 'nobody told');
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 3, 'no kills line for it');
  // And again with a new match: only that one is this message's, at its own version.
  w.advance(200);
  assert.equal((await post('latest-supa-eu', [{ id: '2-1', start: EU_WEEK }, { id: '2-2', start: EU_WEEK }])).r, 200);
  assert.deepEqual(await live.requests[2].json(), { matches: [{ id: '2-2', start: EU_WEEK, score: 6000, at: at + 2 }], version: vname(at + 2) });
});

test('the latest ingest: a message whose `at` would run over LATEST_AHEAD_S past the clock is not written', async () => {
  const w = setup({ env: SUPA_ENV });
  const at = Math.floor(w.now / 1000);
  w.sql.prepare("INSERT INTO latest (id, start, score, at, reader, gz, sha, raw) VALUES ('2-9', ?, 1, ?, 'x', '{}', 'x', 2)").run(EU_WEEK, at + 60);
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]), 200);
  assert.equal(w.sql.prepare("SELECT count(*) n FROM latest WHERE id = '1-1'").get().n, 0, 'at + 61 is past the ceiling');
  w.advance(1e3);
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]), 200);
  assert.equal(w.sql.prepare("SELECT at FROM latest WHERE id = '1-1'").get().at, at + 61, 'at the ceiling it is');
});
