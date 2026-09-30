// The rules of wvwrelink.com/api (worker/index.mjs), against its real code and
// a real SQLite: what the entrance refuses, what it keeps, what the reads give
// and when they refuse to. Run: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.mjs';
import { fakeD1 } from './fake-d1.mjs';

const KILLS_KEY = 'k'.repeat(128);
const RELINK_KEY = 'r'.repeat(128);
const MATCHES = ['1-1', '1-2', '1-3', '1-4', '1-5', '2-1', '2-2', '2-3', '2-4'];

// A Worker with its database, a clock the test moves, and the Apps Scripts'
// way of signing. Every message is signed at a later second than the one
// before it, as the replay guard requires of real ones.
function setup(opts = {}) {
  const { sql, ran, DB } = fakeD1(opts);
  const env = { DB, ENTRADA_KILLS: KILLS_KEY, ENTRADA_RELINK: RELINK_KEY, ...opts.env };
  let clock = Date.parse('2026-09-30T12:00:00Z');
  let lastSigned = 0;
  const call = async (req) => {
    const real = Date.now;
    Date.now = () => clock;
    try {
      return await worker.fetch(req, env);
    } finally {
      Date.now = real;
    }
  };
  const w = {
    sql,
    ran,
    env,
    get now() { return clock; },
    advance(ms) { clock += ms; },
    signed(path, body, { key = KILLS_KEY, t, sigPath = path } = {}) {
      if (t === undefined) {
        t = Math.max(Math.floor(clock / 1000), lastSigned + 1);
        lastSigned = t;
      }
      const sig = createHmac('sha256', key).update(t + '\n' + sigPath + '\n' + body).digest('hex');
      return { 'x-wvw-time': String(t), 'x-wvw-sig': sig };
    },
    async post(source, obj, o = {}) {
      const path = '/api/entrada/' + source;
      const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
      const key = o.key || (source === 'relink' ? RELINK_KEY : KILLS_KEY);
      const headers = o.headers || w.signed(path, body, { key, ...o });
      return (await call(new Request('https://wvwrelink.com' + path, { method: 'POST', body, headers }))).status;
    },
    async get(path, method = 'GET') {
      const r = await call(new Request('https://wvwrelink.com' + path, { method }));
      return { status: r.status, body: await r.text(), headers: r.headers };
    },
    rows(at) { return MATCHES.map((m, i) => [at, m, 1000 + i, 2000, 3000, 4000, at - 86400e3]); },
    relink(extra = {}) {
      return { beat: Math.floor(clock / 1000), window: 1790992800, published: 0, fails: 0, ...extra };
    }
  };
  return w;
}

test('the entrance takes a signed message from each source', async () => {
  const w = setup();
  assert.equal(await w.post('kills', { rows: w.rows(w.now) }), 200);
  assert.equal(await w.post('relink', w.relink()), 200);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 9);
  assert.deepEqual({ ...w.sql.prepare('SELECT window_at, published FROM relink').get() },
    { window_at: 1790992800, published: 0 });
});

test('the entrance refuses what is not a signed, fresh, well-formed message', async (t) => {
  const w = setup();
  const good = JSON.stringify({ rows: w.rows(w.now) });
  const cases = [
    ['no signature headers', () => w.post('kills', good, { headers: {} }), 401],
    ['signed with the other source\'s secret', () => w.post('kills', good, { key: RELINK_KEY }), 401],
    // The right key and body, signed for the kills path: only the path in the
    // signature can refuse it.
    ['signed for the other path', () => w.post('relink', w.relink(), { sigPath: '/api/entrada/kills' }), 401],
    ['six minutes in the future', () => w.post('kills', good, { t: Math.floor(w.now / 1000) + 360 }), 401],
    ['six minutes old', () => w.post('kills', good, { t: Math.floor(w.now / 1000) - 360 }), 401],
    ['over 64 KB', () => w.post('kills', JSON.stringify({ rows: [], pad: 'x'.repeat(65 * 1024) })), 413],
    ['not JSON', () => w.post('kills', '{rows:'), 400],
    ['a match id that cannot exist', () => w.post('kills', { rows: [[w.now, '9-9', 1, 2, 3, 4, w.now - 1e6]] }), 422],
    ['markup as a match id', () => w.post('kills', { rows: [[w.now, '<b>', 1, 2, 3, 4, w.now - 1e6]] }), 422],
    ['negative kills', () => w.post('kills', { rows: [[w.now, '1-1', -5, 2, 3, 4, w.now - 1e6]] }), 422],
    ['a row from two hours ago', () => w.post('kills', { rows: w.rows(w.now - 2 * 3600e3) }), 422],
    ['301 rows', () => w.post('kills', { rows: Array(301).fill(w.rows(w.now)[0]) }), 422],
    ['a relink beat from yesterday', () => w.post('relink', w.relink({ beat: Math.floor(w.now / 1000) - 86400 })), 422],
    ['a relink window only half there', () => w.post('relink', w.relink({ published: null })), 422]
  ];
  for (const [name, send, want] of cases) {
    await t.test(name, async () => assert.equal(await send(), want));
  }
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 0, 'nothing refused was written');
});

test('a message signed at or before the last accepted one is a replay', async () => {
  const w = setup();
  const body = { rows: w.rows(w.now) };
  const t = Math.floor(w.now / 1000);
  assert.equal(await w.post('kills', body, { t }), 200);
  assert.equal(await w.post('kills', body, { t }), 409);
  assert.equal(await w.post('kills', body, { t: t - 1 }), 409);
});

test('a chunked body with no length is cut off, not held', async () => {
  const w = setup();
  const big = new ReadableStream({
    start(c) { for (let i = 0; i < 80; i++) c.enqueue(new Uint8Array(65536)); c.close(); }
  });
  const req = new Request('https://wvwrelink.com/api/entrada/kills', {
    method: 'POST', body: big, duplex: 'half',
    headers: { 'x-wvw-time': String(Math.floor(w.now / 1000)), 'x-wvw-sig': 'a'.repeat(64) }
  });
  const real = Date.now;
  Date.now = () => w.now;
  try {
    assert.equal((await worker.fetch(req, w.env)).status, 413);
  } finally {
    Date.now = real;
  }
});

test('a missing or short secret closes the source rather than weakening it', async () => {
  const none = setup({ env: { ENTRADA_KILLS: undefined } });
  assert.equal(await none.post('kills', { rows: none.rows(none.now) }), 404);
  const half = setup({ env: { ENTRADA_KILLS: 'k'.repeat(63) } });
  assert.equal(await half.post('kills', { rows: half.rows(half.now) }, { key: 'k'.repeat(63) }), 404);
});

test('only the three entrance paths and three reads exist', async () => {
  const w = setup();
  assert.equal((await w.get('/api/entrada/kills')).status, 405);
  assert.equal((await w.get('/api/kills', 'POST')).status, 405);
  // An unknown source is refused before its signature is even read.
  for (const p of ['/api/entrada/admin', '/api/entrada/constructor']) {
    assert.equal((await w.get(p, 'POST')).status, 404, p);
  }
  for (const p of ['/api/constructor', '/api/__proto__', '/api/kills/', '/api/', '/api/saude/x']) {
    assert.equal((await w.get(p)).status, 404, p);
  }
});

test('a backlog after an outage goes in as one statement', async () => {
  const w = setup();
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(...w.rows(w.now - i * 300e3));
  assert.equal(await w.post('kills', { rows }), 200);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 54);
  // Sent again with the next tick: INSERT OR IGNORE keeps one of each.
  w.advance(1000);
  assert.equal(await w.post('kills', { rows }), 200);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 54);
});

test('/api/kills gives the last 30 minutes, one row of D1, as the page reads it', async () => {
  const w = setup();
  assert.equal((await w.get('/api/kills')).status, 503, 'nothing pushed yet');
  // Fourteen days in the table, a tick every five minutes.
  const ins = w.sql.prepare('INSERT INTO kills VALUES (?,?,?,?,?,?,?)');
  for (let i = 1; i < 14 * 288; i++) {
    for (const r of w.rows(w.now - i * 300e3)) ins.run(r[1], r[0], r[2], r[3], r[4], r[5], r[6]);
  }
  assert.equal(await w.post('kills', { rows: w.rows(w.now) }), 200);
  const r = await w.get('/api/kills?at=0&match=1-1');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const rows = JSON.parse(r.body).rows;
  // Strictly newer than 30 minutes: the ticks at 0, 5 ... 25 minutes back.
  assert.equal(rows.length, 9 * 6);
  assert.ok(rows.every((row) => row.length === 6 && w.now - row[0] < 30 * 60e3));
});

test('the rebuild reads kills by its key, never the whole table', async () => {
  const w = setup();
  await w.post('kills', { rows: w.rows(w.now) });
  const rebuild = w.ran.find((s) => /INSERT INTO recent/.test(s.q));
  const plan = w.sql.prepare('EXPLAIN QUERY PLAN ' + rebuild.q).all(...rebuild.args)
    .map((p) => p.detail).join('; ');
  assert.match(plan, /SEARCH kills USING PRIMARY KEY/);
  assert.doesNotMatch(plan, /SCAN kills/);
});

test('/api/kills says 503 once kills stops arriving', async () => {
  const w = setup();
  await w.post('kills', { rows: w.rows(w.now) });
  w.advance(19 * 60e3);
  assert.equal((await w.get('/api/kills')).status, 200);
  w.advance(2 * 60e3);
  assert.equal((await w.get('/api/kills')).status, 503);
});

test('a failed rebuild keeps the rows and the read says 503', async () => {
  const w = setup({ skip: ['schema-002-recent.sql'] });
  assert.equal(await w.post('kills', { rows: w.rows(w.now) }), 200);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 9);
  assert.equal((await w.get('/api/kills')).status, 503);
});

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

test('/api/saude says when each source last reported', async () => {
  const w = setup();
  await w.post('kills', { rows: w.rows(w.now) });
  const body = JSON.parse((await w.get('/api/saude')).body);
  assert.equal(body.kills, Math.floor(w.now / 1000));
  assert.equal(body.relink, 0);
});

test('the daily cleanup deletes kills older than 14 days and nothing newer', async () => {
  const { sql, DB } = fakeD1();
  const now = Date.now();
  for (const d of [0, 1, 13, 14.1, 20]) {
    const at = Math.floor(now - d * 86400e3);
    sql.prepare('INSERT INTO kills VALUES (?,?,1,1,1,1,?)').run('1-1', at, at - 1000);
  }
  await worker.scheduled({}, { DB });
  const left = sql.prepare('SELECT at FROM kills').all().map((r) => Math.round((now - r.at) / 86400e3));
  assert.deepEqual(left.sort((a, b) => a - b), [0, 1, 13]);
});
