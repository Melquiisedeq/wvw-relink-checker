// The latest entrance and its reads (worker/index.mjs) against a real SQLite:
// what the readers may push, which body is kept, and what GET /api/latest gives.
// Run: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import worker from '../worker/index.mjs';
import { fakeD1 } from './fake-d1.mjs';

const SOURCES = {
  'latest-supa-us': 'INGEST_LATEST_SUPA_US', 'latest-supa-eu': 'INGEST_LATEST_SUPA_EU',
  'latest-vercel-eu': 'INGEST_LATEST_VERCEL_EU', 'latest-vercel-us': 'INGEST_LATEST_VERCEL_US'
};
const KEYS = { kills: 'k'.repeat(128), 'latest-supa-us': 'a'.repeat(128), 'latest-supa-eu': 'b'.repeat(128),
  'latest-vercel-eu': 'c'.repeat(128), 'latest-vercel-us': 'd'.repeat(128) };
const US = 'latest-supa-us';
const EU = 'latest-supa-eu';
const MIN = 60e3;
// 2026-10-03 is a Saturday: the NA week began 02:00Z, 10 hours before this clock.
const NOW = Date.parse('2026-10-03T12:00:00Z');
const NA_START = Date.parse('2026-10-03T02:00:00Z');
const NA_PREV = Date.parse('2026-09-26T02:00:00Z');
const EU_START = Date.parse('2026-10-02T18:00:00Z');

// A summary entry and the gzip it describes.
function match(id = '1-1', o = {}) {
  const gz = o.gz || gzipSync(Buffer.from(JSON.stringify({ id, pad: o.pad ?? 'x'.repeat(200) })));
  const [a, b, c] = o.scores || [1000, 2000, 3000];
  return {
    entry: {
      id, start: id[0] === '2' ? EU_START : NA_START, scores: [a, b, c], kills: [1, 2, 3, 4],
      bytes: gz.length, raw: 220, sha256: createHash('sha256').update(gz).digest('hex'), ...o.entry
    },
    gz
  };
}
function body(ms, summaryOver = {}) {
  const sum = Buffer.from(JSON.stringify({ v: 1, matches: ms.map((m) => m.entry), ...summaryOver }) + '\n');
  return Buffer.concat([sum, ...ms.map((m) => m.gz)]);
}

function setup(opts = {}) {
  const { sql, ran, DB } = fakeD1();
  const env = { DB, INGEST_KILLS: KEYS.kills, ...Object.fromEntries(Object.entries(SOURCES).map(([s, e]) => [e, KEYS[s]])), ...opts.env };
  let clock = NOW;
  let last = 0;
  const call = async (req, ctx) => {
    const real = Date.now;
    Date.now = () => clock;
    try {
      return await worker.fetch(req, env, ctx);
    } finally {
      Date.now = real;
    }
  };
  const w = {
    sql, ran, env, call,
    get now() { return clock; },
    advance(ms) { clock += ms; },
    async post(source, buf, o = {}) {
      if (!Buffer.isBuffer(buf)) buf = Buffer.from(JSON.stringify(buf));
      const path = '/api/ingest/' + source;
      let t = o.t;
      if (t === undefined) t = last = Math.max(Math.floor(clock / 1000), last + 1);
      const sig = createHmac('sha256', o.key || KEYS[source] || 'z'.repeat(128))
        .update(t + '\n' + (o.sigPath || path) + '\n').update(buf).digest('hex');
      const headers = o.headers || { 'x-wvw-time': String(t), 'x-wvw-sig': sig, ...o.extra };
      const r = await call(new Request('https://wvwrelink.com' + path, { method: 'POST', body: buf, headers }));
      w.last = r;
      return r.status;
    },
    async get(path, method = 'GET', ctx) {
      const r = await call(new Request('https://wvwrelink.com' + path, { method }), ctx);
      return { status: r.status, body: await r.text(), headers: r.headers };
    },
    count: (t) => w.sql.prepare('SELECT count(*) n FROM ' + t).get().n,
    row: (id) => w.sql.prepare('SELECT * FROM latest WHERE id = ?').get(id)
  };
  return w;
}

// Pushes one match at the given score and returns the status and what applied.
async function push(w, source, id, scores, o = {}) {
  const status = await w.post(source, body([match(id, { scores, ...o })]));
  const applied = status === 200 ? JSON.parse(await w.last.text()).applied : null;
  return { status, applied };
}

test('each reader has its own door and its own replay clock', async () => {
  const w = setup();
  const t = Math.floor(w.now / 1000);
  for (const s of Object.keys(SOURCES)) {
    assert.equal(await w.post(s, body([match('1-1')]), { t: t - 1 }), 200, s);
  }
  assert.equal(w.count('source'), 6);
  assert.deepEqual({ ...w.sql.prepare("SELECT t FROM source WHERE name = 'latest-supa-eu'").get() }, { t: t - 1 });
});

test('the entrance refuses what is not a signed, fresh, small message', async (t) => {
  const w = setup();
  const good = body([match('1-1')]);
  const t0 = Math.floor(w.now / 1000);
  const cases = [
    ['no signature headers', () => w.post(US, good, { headers: {} }), 401],
    ['signed with another reader\'s secret', () => w.post(US, good, { key: KEYS[EU] }), 401],
    ['signed for another reader\'s path', () => w.post(US, good, { sigPath: '/api/ingest/' + EU }), 401],
    ['six minutes in the future', () => w.post(US, good, { t: t0 + 360 }), 401],
    ['six minutes old', () => w.post(US, good, { t: t0 - 360 }), 401],
    ['over 256 KB, declared', () => w.post(US, good, { extra: { 'content-length': String(257 * 1024) } }), 413],
    ['over 256 KB, streamed with no length', async () => {
      const big = new ReadableStream({
        start(c) { for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(65536)); c.close(); }
      });
      const req = new Request('https://wvwrelink.com/api/ingest/' + US, {
        method: 'POST', body: big, duplex: 'half',
        headers: { 'x-wvw-time': String(t0), 'x-wvw-sig': 'a'.repeat(64) }
      });
      return (await w.call(req)).status;
    }, 413],
    ['a reader with no secret', async () => (await setup({ env: { INGEST_LATEST_SUPA_US: undefined } }).post(US, good)), 404],
    ['a reader with a 63 character secret', async () => {
      const k = 'a'.repeat(63);
      return setup({ env: { INGEST_LATEST_SUPA_US: k } }).post(US, good, { key: k });
    }, 404],
    ['a reader that does not exist', () => w.post('latest-nope', good), 404],
    ['GET on the entrance', async () => (await w.get('/api/ingest/' + US)).status, 405]
  ];
  for (const [name, send, want] of cases) {
    await t.test(name, async () => assert.equal(await send(), want));
  }
  assert.equal(w.count('latest'), 0);
  assert.equal(w.sql.prepare("SELECT t FROM source WHERE name = ?").get(US).t, 0, 'no claim either');
});

test('replay: the same time twice, an earlier one; one reader does not block another', async () => {
  const w = setup();
  const t = Math.floor(w.now / 1000);
  const b = body([match('1-1')]);
  assert.equal(await w.post(US, b, { t }), 200);
  assert.equal(await w.post(US, b, { t }), 409);
  assert.equal(await w.post(US, b, { t: t - 1 }), 409);
  assert.equal(await w.post(EU, b, { t: t - 1 }), 200);
});

test('a bad summary refuses the whole message, and not even the claim is written', async (t) => {
  const w = setup();
  const m = (id, o) => match(id, o);
  const bad = (entry) => body([m('1-1', { entry })]);
  const good = m('1-2');
  const cases = [
    ['not JSON', () => Buffer.concat([Buffer.from('{nope\n'), good.gz]), 400],
    ['no newline', () => Buffer.from('{"v":1}'), 400],
    ['wrong version', () => body([good], { v: 2 }), 422],
    ['no matches', () => body([], {}), 422],
    ['id 9-9', () => bad({ id: '9-9' }), 422],
    ['markup as an id', () => bad({ id: '<b>' }), 422],
    ['a repeated id', () => body([m('1-1'), m('1-1')]), 422],
    ['19 matches', () => body(Array.from({ length: 19 }, (_, i) => m('1-' + (i % 9 + 1)))), 422],
    ['start off the reset hour', () => bad({ start: NA_START + MIN }), 422],
    ['an EU start on an NA id', () => bad({ start: EU_START }), 422],
    ['start in the future past 5 minutes', () => bad({ start: NA_START + 7 * 86400e3 }), 422],
    ['start two weeks back (past 8 days)', () => bad({ start: NA_START - 14 * 86400e3 }), 422],
    ['a new week with too high a score', () => body([m('1-1', { scores: [5e6, 0, 0] })]), 422],
    ['negative scores', () => bad({ scores: [-1, 2, 3] }), 422],
    ['fractional scores', () => bad({ scores: [1.5, 2, 3] }), 422],
    ['raw over 256 KB', () => bad({ raw: 256 * 1024 + 1 }), 422],
    ['a slice over 16 KB (a gzip bomb has to be small)', () => body([m('1-1', { gz: Buffer.alloc(16 * 1024 + 1) })]), 422],
    ['bytes below a gzip header', () => bad({ bytes: 17 }), 422],
    ['bytes that do not add up', () => bad({ bytes: good.entry.bytes + 1 }), 422],
    ['a sha256 that does not match: body swapped, summary kept', () => {
      const old = m('1-1');
      const other = gzipSync(Buffer.from('another body entirely, same size? no matter'));
      return Buffer.concat([Buffer.from(JSON.stringify({ v: 1, matches: [{ ...old.entry, bytes: other.length }] }) + '\n'), other]);
    }, 422]
  ];
  for (const [name, make, want = 422] of cases) {
    await t.test(name, async () => assert.equal(await w.post(US, make()), want));
  }
  assert.equal(w.count('latest'), 0);
  assert.equal(w.count('kills'), 0);
  assert.equal(w.sql.prepare('SELECT t FROM source WHERE name = ?').get(US).t, 0);
});

test('what is kept is the gzip as sent, as base64, with its reader', async () => {
  const w = setup();
  const m = match('1-1');
  assert.equal(await w.post(US, body([m])), 200);
  const r = w.row('1-1');
  assert.equal(r.gz, m.gz.toString('base64'));
  assert.equal(r.reader, US);
  assert.equal(r.score, 6000);
  assert.equal(r.at, Math.floor(w.now / 1000));
  assert.equal(r.sha, m.entry.sha256);
});

test('an older week after a newer one changes nothing', async () => {
  const w = setup();
  assert.deepEqual(await push(w, US, '1-1', [1, 1, 1]), { status: 200, applied: ['1-1'] });
  w.advance(5 * MIN);
  const old = await push(w, US, '1-1', [1, 1, 1], { entry: { start: NA_PREV } });
  assert.deepEqual(old, { status: 200, applied: [] });
  assert.equal(w.row('1-1').start, NA_START);
});

test('the same week: a lower or equal score is not applied; a higher one is', async () => {
  const w = setup();
  await push(w, US, '1-1', [1000, 1000, 1000]);
  w.advance(MIN);
  assert.deepEqual((await push(w, US, '1-1', [900, 1000, 1000])).applied, []);
  assert.deepEqual((await push(w, US, '1-1', [1000, 1000, 1000])).applied, []);
  assert.deepEqual((await push(w, US, '1-1', [1100, 1000, 1000])).applied, ['1-1']);
  assert.equal(w.row('1-1').score, 3100);
});

test('a score above what can have been earned since is not applied, and is logged', async () => {
  const w = setup();
  await push(w, US, '1-1', [1000, 1000, 1000]);
  w.advance(5 * MIN);
  const logs = [];
  const real = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    // 3000 stored + 1000 a minute for 5 minutes + 2000 slack = 10000.
    assert.deepEqual((await push(w, EU, '1-1', [3000, 3000, 4001])).applied, []);
    assert.deepEqual((await push(w, EU, '1-1', [3000, 3000, 4000])).applied, ['1-1']);
  } finally {
    console.log = real;
  }
  const jump = logs.map((l) => JSON.parse(l)).find((l) => l.jump);
  assert.ok(jump, 'a log line for the jump');
  assert.equal(jump.jump, '1-1');
  assert.equal(jump.score, 10001);
  assert.equal(logs.filter((l) => l.includes('"jump"')).length, 1, 'the accepted one is not a jump');
});

test('two readers: the higher score first, the lower after, keeps the higher', async () => {
  const w = setup();
  assert.deepEqual((await push(w, US, '1-1', [3000, 3000, 3000])).applied, ['1-1']);
  assert.deepEqual((await push(w, EU, '1-1', [2000, 3000, 3000])).applied, []);
  assert.equal(w.row('1-1').reader, US);
  assert.equal(w.row('1-1').score, 9000);
  w.advance(MIN);
  assert.deepEqual((await push(w, EU, '1-1', [4000, 3000, 3000])).applied, ['1-1']);
  assert.equal(w.row('1-1').reader, EU);
});

test('a new week after a high score of the old one is applied: the score starts over', async () => {
  const w = setup();
  w.advance(NA_PREV + 6 * 86400e3 - NOW);
  assert.deepEqual((await push(w, US, '1-1', [3e6, 1, 1], { entry: { start: NA_PREV } })).applied, ['1-1']);
  w.advance(NA_START + 10 * MIN - w.now);
  assert.deepEqual((await push(w, EU, '1-1', [10, 10, 10])).applied, ['1-1']);
  assert.equal(w.row('1-1').score, 30);
});

test('kills lines: enter when the score rose, not when the match did not win, not backwards', async (t) => {
  const w = setup();
  const lines = () => w.sql.prepare('SELECT at, center, red, blue, green, score FROM kills ORDER BY at').all().map((r) => ({ ...r }));
  await push(w, US, '1-1', [1000, 1000, 1000]);
  assert.equal(w.count('kills'), 1);
  w.advance(MIN);
  await push(w, EU, '1-1', [900, 1000, 1000]); // did not win
  assert.equal(w.count('kills'), 1, 'a match that did not win writes no line');
  await push(w, EU, '1-1', [1500, 1000, 1000]);
  assert.equal(w.count('kills'), 2);
  const newest = lines().at(-1);
  assert.equal(newest.score, 3500);
  assert.equal(newest.at, w.now, 'stamped by the Worker\'s clock');

  await t.test('a sheet line (7 fields) with smaller kills than the newest is refused', async () => {
    const before = w.count('kills');
    const at = w.now;
    assert.equal(await w.post('kills', { rows: [[at, '1-1', 0, 0, 0, 0, NA_START]] }), 200);
    assert.equal(w.count('kills'), before);
  });
  await t.test('a sheet line with at least the same kills enters', async () => {
    const before = w.count('kills');
    w.advance(MIN);
    assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 1, 2, 3, 4, NA_START]] }), 200);
    assert.equal(w.count('kills'), before + 1);
    assert.equal(w.sql.prepare('SELECT score FROM kills ORDER BY at DESC LIMIT 1').get().score, null);
  });
  await t.test('an 8-field line with a lower score is refused, a higher one enters', async () => {
    w.advance(MIN);
    await push(w, US, '1-1', [2000, 2000, 2000]); // newest line now has a score
    const before = w.count('kills');
    w.advance(MIN);
    assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 9, 9, 9, 9, NA_START, 5999]] }), 200);
    assert.equal(w.count('kills'), before);
    w.advance(MIN);
    assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 9, 9, 9, 9, NA_START, 6001]] }), 200);
    assert.equal(w.count('kills'), before + 1);
  });
  await t.test('an older start is refused, a newer one enters', async () => {
    const before = w.count('kills');
    w.advance(MIN);
    assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 99, 99, 99, 99, NA_START - MIN]] }), 200);
    assert.equal(w.count('kills'), before);
    w.advance(MIN);
    assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 0, 0, 0, 0, NA_START + MIN, 0]] }), 200);
    assert.equal(w.count('kills'), before + 1);
  });
  await t.test('a score that is not an integer, or 9 fields, is refused', async () => {
    assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 1, 1, 1, 1, NA_START, 1.5]] }), 422);
    assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 1, 1, 1, 1, NA_START, 1, 1]] }), 422);
  });
});

test('two lines of one match in one batch, both above the newest, both enter', async () => {
  const w = setup();
  const s = NA_START;
  assert.equal(await w.post('kills', { rows: [[w.now - 10 * MIN, '1-1', 1, 1, 1, 1, s]] }), 200);
  assert.equal(await w.post('kills', {
    rows: [[w.now - 5 * MIN, '1-1', 2, 2, 2, 2, s], [w.now, '1-1', 3, 3, 3, 3, s]]
  }), 200);
  assert.equal(w.count('kills'), 3);
});

test('a request with 18 matches stays far under 50 queries', async () => {
  const w = setup();
  const ms = [];
  for (const r of [1, 2]) for (let i = 1; i <= 9; i++) ms.push(match(r + '-' + i));
  const before = w.ran.length;
  assert.equal(await w.post(US, body(ms)), 200);
  assert.equal(JSON.parse(await w.last.text()).applied.length, 18);
  // ran holds bound statements only: claim, 18 upserts, kills, rebuild.
  assert.ok(w.ran.length - before < 50, String(w.ran.length - before));
  // The same again: every upsert loses, and the one extra read is for the log.
  assert.equal(await w.post(US, body(ms)), 200);
  assert.ok(w.ran.length - before < 50 + 21);
});

test('the newest line of a match is looked up by the table key', async () => {
  const w = setup();
  await push(w, US, '1-1', [1, 1, 1]);
  const q = w.ran.find((s) => /INSERT OR IGNORE INTO kills/.test(s.q));
  const plan = w.sql.prepare('EXPLAIN QUERY PLAN ' + q.q).all(...q.args).map((p) => p.detail).join('; ');
  assert.match(plan, /SEARCH \w+ USING PRIMARY KEY \(match=\?/);
  assert.doesNotMatch(plan, /SCAN (kills|o)\b/);
});

// Cloudflare's Cache API, as much as the Worker uses of it.
function fakeCaches() {
  const store = new Map();
  const puts = [];
  return {
    store, puts,
    default: {
      // As measured on the live Worker: a hit comes back with max-age=14400.
      match: async (k) => {
        if (!store.has(k)) return undefined;
        const hit = store.get(k).clone();
        hit.headers.set('cache-control', 'public, max-age=14400');
        return hit;
      },
      put: async (k, r) => { puts.push(k); store.set(k, r); }
    }
  };
}

test('GET /api/latest: 503 with no rows, 503 past 10 minutes, 200 at 9, nothing older than 2 h', async () => {
  const w = setup();
  assert.equal((await w.get('/api/latest')).status, 503);
  await push(w, US, '1-1', [1, 1, 1]);
  w.advance(9 * MIN);
  const r = await w.get('/api/latest');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.at, Math.floor((w.now - 9 * MIN) / 1000));
  assert.deepEqual(Object.keys(j.matches[0]), ['id', 'start', 'score', 'at', 'by', 'gz']);
  assert.equal(j.matches[0].by, US);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=30');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.ok(![...r.headers.keys()].some((k) => k.startsWith('access-control-')));
  w.advance(2 * MIN);
  assert.equal((await w.get('/api/latest')).status, 503, '11 minutes');

  // A match 3 hours old does not appear beside a fresh one.
  const w2 = setup();
  await push(w2, US, '1-1', [1, 1, 1]);
  w2.advance(3 * 3600e3);
  await push(w2, US, '1-2', [1, 1, 1]);
  const ids = JSON.parse((await w2.get('/api/latest')).body).matches.map((m) => m.id);
  assert.deepEqual(ids, ['1-2']);
});

test('GET /api/latest gives back the gzip that was sent', async () => {
  const w = setup();
  const m = match('2-3');
  await w.post(EU, body([m]));
  const j = JSON.parse((await w.get('/api/latest')).body);
  assert.equal(j.matches[0].gz, m.gz.toString('base64'));
  assert.equal(j.matches[0].id, '2-3');
});

test('GET /api/latest is cached under one key whatever the query, and a 503 is not', async () => {
  const w = setup();
  const real = globalThis.caches;
  globalThis.caches = fakeCaches();
  try {
    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    assert.equal((await w.get('/api/latest', 'GET', ctx)).status, 503);
    await Promise.all(waited);
    assert.equal(globalThis.caches.puts.length, 0, 'a 503 is not kept');
    await push(w, US, '1-1', [1, 1, 1]);
    assert.equal((await w.get('/api/latest?x=' + Math.random(), 'GET', ctx)).status, 200);
    await Promise.all(waited);
    assert.deepEqual(globalThis.caches.puts, ['https://wvwrelink.com/api/latest']);
    // The copy answers: the table is emptied and the answer stands.
    w.sql.exec('DELETE FROM latest');
    const again = await w.get('/api/latest?x=1', 'GET', ctx);
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('cache-control'), 'public, max-age=30', 'a hit keeps the route\'s max-age');
    assert.equal(globalThis.caches.puts.length, 1);
  } finally {
    globalThis.caches = real;
  }
});

test('GET /api/latest/summary: {} with no rows, then id: start, score, at, by', async () => {
  const w = setup();
  const r0 = await w.get('/api/latest/summary');
  assert.equal(r0.status, 200);
  assert.equal(r0.body, '{}');
  await push(w, US, '1-1', [1, 2, 3]);
  const r = await w.get('/api/latest/summary');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=15');
  assert.deepEqual(JSON.parse(r.body), { '1-1': { start: NA_START, score: 6, at: Math.floor(w.now / 1000), by: US } });
  w.advance(11 * MIN);
  assert.equal((await w.get('/api/latest/summary')).status, 200, 'the summary never says 503');
  w.advance(3 * 3600e3);
  assert.equal((await w.get('/api/latest/summary')).body, '{}');

  const real = globalThis.caches;
  globalThis.caches = fakeCaches();
  try {
    const kept = await w.get('/api/latest/summary?x=1', 'GET', { waitUntil() {} });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(globalThis.caches.puts, ['https://wvwrelink.com/api/latest/summary']);
    const hit = await w.get('/api/latest/summary?x=2', 'GET', { waitUntil() {} });
    assert.equal(hit.headers.get('cache-control'), 'public, max-age=15', 'a hit keeps the route\'s max-age');
    assert.equal(hit.body, kept.body);
  } finally {
    globalThis.caches = real;
  }
});

test('the reads take GET only', async () => {
  const w = setup();
  assert.equal((await w.get('/api/latest', 'POST')).status, 405);
  assert.equal((await w.get('/api/latest/summary', 'POST')).status, 405);
});
