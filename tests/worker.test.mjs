// The rules of wvwrelink.com/api (worker/index.mjs), against its real code and
// a real SQLite: what the entrance refuses, what it keeps, what the reads give
// and when they refuse to. Run: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import worker from '../worker/index.mjs';
import { fakeD1 } from './fake-d1.mjs';
import { signHeaders } from './signed.mjs';

const KILLS_KEY = 'k'.repeat(128);
const RELINK_KEY = 'r'.repeat(128);
const MATCHES = ['1-1', '1-2', '1-3', '1-4', '1-5', '2-1', '2-2', '2-3', '2-4'];

// A Worker with its database, a clock the test moves, and the Apps Scripts'
// way of signing. Every message is signed at a later second than the one
// before it, as the replay guard requires of real ones.
function setup(opts = {}) {
  const { sql, ran, DB } = fakeD1(opts);
  const env = { DB, INGEST_KILLS: KILLS_KEY, INGEST_RELINK: RELINK_KEY, ...opts.env };
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
      return signHeaders(key, t, sigPath, body);
    },
    async post(source, obj, o = {}) {
      const path = '/api/ingest/' + source;
      const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
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
    ['signed for the other path', () => w.post('relink', w.relink(), { sigPath: '/api/ingest/kills' }), 401],
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
  const req = new Request('https://wvwrelink.com/api/ingest/kills', {
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
  const none = setup({ env: { INGEST_KILLS: undefined } });
  assert.equal(await none.post('kills', { rows: none.rows(none.now) }), 404);
  const half = setup({ env: { INGEST_KILLS: 'k'.repeat(63) } });
  assert.equal(await half.post('kills', { rows: half.rows(half.now) }, { key: 'k'.repeat(63) }), 404);
});

test('only the three entrance paths and three reads exist', async () => {
  const w = setup();
  assert.equal((await w.get('/api/ingest/kills')).status, 405);
  assert.equal((await w.get('/api/kills', 'POST')).status, 405);
  // An unknown source is refused before its signature is even read.
  for (const p of ['/api/ingest/admin', '/api/ingest/constructor']) {
    assert.equal((await w.get(p, 'POST')).status, 404, p);
  }
  for (const p of ['/api/constructor', '/api/__proto__', '/api/kills/', '/api/', '/api/health/x']) {
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
  // Fourteen days in the table, a tick every five minutes, the kills rising on each.
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  // One start for all of them, as in one week of a match.
  const start = w.now - 86400e3;
  for (let i = 1; i < 14 * 288; i++) {
    for (const r of w.rows(w.now - i * 300e3)) ins.run(r[1], r[0], r[2] + 14 * 288 - i, r[3], r[4], r[5], start);
  }
  assert.equal(await w.post('kills', { rows: w.rows(w.now).map((r) => [r[0], r[1], r[2] + 14 * 288, ...r.slice(3, 6), start]) }), 200);
  const r = await w.get('/api/kills?at=0&match=1-1');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const rows = JSON.parse(r.body).rows;
  // Strictly newer than 30 minutes: the ticks at 0, 5 ... 25 minutes back,
  // and each match's base, the tick at 30 minutes back.
  assert.equal(rows.length, 9 * 6 + 9);
  assert.ok(rows.every((row) => row.length === 6 && w.now - row[0] <= 30 * 60e3));
  assert.equal(rows.filter((row) => w.now - row[0] === 30 * 60e3).length, 9);
  assert.deepEqual(rows.map((row) => row[0]), rows.map((row) => row[0]).sort((a, b) => a - b));
});

test('/api/kills keeps a base for a frozen match, and only a recent one of its week', async () => {
  const w = setup();
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  const min = 60e3;
  const week = w.now - 86400e3;
  const old = week - 7 * 86400e3;
  // 1-1 frozen: its last row 50 minutes back, nothing in the window.
  ins.run('1-1', w.now - 50 * min, 2, 2, 2, 2, week);
  ins.run('1-1', w.now - 70 * min, 1, 1, 1, 1, week);
  // 1-2 frozen too long: its newest row is 4 hours back, past the base reach.
  ins.run('1-2', w.now - 240 * min, 3, 3, 3, 3, week);
  // 1-3: a row in the window; the newest one before it is of last week, so
  // no base (the older this-week row is not taken in its place).
  ins.run('1-3', w.now - 5 * min, 4, 4, 4, 4, week);
  ins.run('1-3', w.now - 100 * min, 5, 5, 5, 5, week);
  ins.run('1-3', w.now - 60 * min, 6, 6, 6, 6, old);
  // 1-4: two rows before the window, the kills moving on the newer: the base
  // and the move, and the reading before the move.
  ins.run('1-4', w.now - 45 * min, 7, 7, 7, 7, week);
  ins.run('1-4', w.now - 40 * min, 8, 8, 8, 8, week);
  assert.equal(await w.post('kills', { rows: [[w.now, '2-1', 9, 9, 9, 9, week]] }), 200);
  const got = JSON.parse((await w.get('/api/kills')).body).rows;
  const by = (m) => got.filter((r) => r[1] === m).map((r) => r[2]);
  assert.deepEqual(by('1-1'), [1, 2], 'the stop, and the newest row 10 minutes older (the 70-minute one)');
  assert.deepEqual(by('1-2'), [], 'past 3 hours');
  assert.deepEqual(by('1-3'), [4], 'the newest older row is of last week: no base, and not the one before it');
  assert.deepEqual(by('1-4'), [7, 8]);
  assert.ok(got.every((r) => w.now - r[0] <= 3 * 3600e3));
  assert.deepEqual(got.map((r) => r[0]), got.map((r) => r[0]).sort((a, b) => a - b));
});

test('/api/kills adds a reading 10 minutes behind the newest of a match stopped over 30 minutes', async () => {
  const w = setup();
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  const min = 60e3;
  const week = w.now - 86400e3;
  // 1-1 stopped: rows 50 and 40 minutes back, nothing after.
  ins.run('1-1', w.now - 50 * min, 1, 1, 1, 1, week);
  ins.run('1-1', w.now - 40 * min, 2, 2, 2, 2, week);
  // 1-2 stopped: rows 52, 50, 45, 41 and 40 minutes back; the newest is 40,
  // so the reading 10 minutes older is the 50 one, not 45 nor 52, and 41 is
  // the reading before the move.
  for (const [m, k] of [[52, 2], [50, 3], [45, 4], [41, 4], [40, 5]]) ins.run('1-2', w.now - m * min, k, k, k, k, week);
  // 1-3: only a row of last week 50 minutes back: no pair.
  ins.run('1-3', w.now - 50 * min, 6, 6, 6, 6, week - 7 * 86400e3);
  ins.run('1-3', w.now - 40 * min, 7, 7, 7, 7, week);
  // 1-4 live: the window has rows, the base is the one before; no extra.
  for (const m of [5, 15, 25, 35, 45]) ins.run('1-4', w.now - m * min, 100 - m, 8, 8, 8, week);
  assert.equal(await w.post('kills', { rows: [[w.now, '2-1', 9, 9, 9, 9, week]] }), 200);
  const got = JSON.parse((await w.get('/api/kills')).body).rows;
  const by = (m) => got.filter((r) => r[1] === m).map((r) => w.now - r[0]);
  assert.deepEqual(by('1-1'), [50 * min, 40 * min], 'the stop and a reading 10 minutes older');
  assert.deepEqual(by('1-2'), [50 * min, 41 * min, 40 * min], 'the newest one at least 10 minutes older, not 45 nor 52');
  assert.deepEqual(by('1-3'), [40 * min], 'last week is no pair');
  assert.deepEqual(by('1-4'), [35 * min, 25 * min, 15 * min, 5 * min]);
  assert.deepEqual(got.map((r) => r[0]), got.map((r) => r[0]).sort((a, b) => a - b));
});

// What each statement of the Worker hands back, by statement: the rows each
// read hands back, our estimate of what D1 reads, since every read of kills is
// a search by its key (the plan test below).
function counting(w) {
  const log = [];
  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = (q) => {
    const st = prepare(q);
    const all = st.all.bind(st), first = st.first.bind(st);
    st.all = async () => { const r = await all(); log.push({ q, n: r.results.length }); return r; };
    st.first = async () => { const r = await first(); log.push({ q, n: r ? 1 : 0 }); return r; };
    return st;
  };
  return log;
}
const WALK = /center \+ red \+ blue \+ green </;

// The score rises every minute, so kills.gs writes a row every minute, but the
// kills stood still: every row of the last 30 minutes has one total, and the
// page needs the move and a reading 10 minutes before it to count anything.
test('/api/kills carries the last move of kills that stood still, and a reading 10 minutes before it', async () => {
  const w = setup();
  const log = counting(w);
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  const min = 60e3;
  const week = w.now - 86400e3;
  const t0 = w.now;
  // 1-1: 3 kills a minute up to 40 minutes back, then none, a row every minute.
  for (let m = 1; m <= 70; m++) ins.run('1-1', w.now - m * min, 500 - 3 * Math.max(0, m - 40), 10, 10, 10, week);
  // 1-2: still for four hours, a row every five minutes.
  for (let m = 5; m <= 240; m += 5) ins.run('1-2', w.now - m * min, 700, 10, 10, 10, week);
  const tick = () => w.post('kills', { rows: [[w.now, '1-1', 500, 10, 10, 10, week], [w.now, '1-2', 700, 10, 10, 10, week]] });
  const read = async () => {
    const got = JSON.parse((await w.get('/api/kills')).body).rows;
    assert.deepEqual(got.map((r) => r[0]), got.map((r) => r[0]).sort((a, b) => a - b));
    return (m) => got.filter((r) => r[1] === m).map((r) => (t0 - r[0]) / min);
  };
  assert.equal(await tick(), 200);
  let by = await read();
  const window = Array.from({ length: 30 }, (_, i) => 29 - i);
  assert.deepEqual(by('1-1'), [50, 41, 40, 30, ...window],
    'a reading 10 minutes before the move, the one before the move, the move, the base, the window');
  assert.deepEqual(by('1-2'), [145, 30, 25, 20, 15, 10, 5, 0],
    'still past 2.5 hours: the first row within them (the page drops a reading at 3 h), the base, the window');
  assert.ok(log.some((s) => WALK.test(s.q)), 'no body to carry from: the one walk back');

  // An hour of ticks a minute apart, the kills still: the move is carried
  // from body to body, and kills is never walked again.
  for (let i = 0; i < 60; i++) {
    w.advance(min);
    log.length = 0;
    assert.equal(await tick(), 200);
    assert.ok(!log.some((s) => WALK.test(s.q)), `tick ${i + 1}: the still stretch walked again`);
    const back = log.filter((s) => !/^INSERT|^UPDATE|FROM source/.test(s.q)).reduce((n, s) => n + s.n, 0);
    const inWindow = w.sql.prepare('SELECT count(*) n FROM kills WHERE at > ?').get(w.now - 30 * min).n;
    // Past the window's rows: the last body, a base for each match, and 1-2's
    // first row within 2.5 h; the moves come from the body.
    assert.ok(back - inWindow <= 1 + 2 + 1, `tick ${i + 1}: ${back} rows handed back, ${inWindow} of them the window`);
  }
  by = await read();
  assert.deepEqual(by('1-1').slice(0, 3), [50, 41, 40], 'the move an hour on, from the bodies alone');
  assert.ok(by('1-2')[0] <= 150 - 60 && by('1-2')[0] > 140 - 60, `1-2's first row within 2.5 h: ${by('1-2')[0]} min before the start`);
});

// kills.gs sends a backlog late, rows up to 45 minutes back, while the other
// readers keep the body fresh: rows older than the last body's window that it
// never held. The move among them is looked up, not taken from the newest.
test('/api/kills finds the move inside a late batch older than the last window', async () => {
  const w = setup();
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  const min = 60e3;
  const week = w.now - 86400e3;
  // 1-1 frozen since an hour back; 2-1 ticking, so the body stays fresh.
  ins.run('1-1', w.now - 59 * min, 100, 0, 0, 0, week);
  assert.equal(await w.post('kills', { rows: [[w.now, '2-1', 1, 0, 0, 0, week]] }), 200);
  w.advance(min);
  const t0 = w.now;
  const late = [[44, 110], [40, 120], [35, 120], [31, 120]].map(([m, k]) => [t0 - m * min, '1-1', k, 0, 0, 0, week]);
  assert.equal(await w.post('kills', { rows: [...late, [t0, '2-1', 2, 0, 0, 0, week]] }), 200);
  const got = JSON.parse((await w.get('/api/kills')).body).rows;
  assert.deepEqual(got.filter((r) => r[1] === '1-1').map((r) => (t0 - r[0]) / min), [60, 44, 40, 31],
    'the base, the row before the move, the move (40, not 31), the newest');
});

// The earlier rebuild is held at its write until the later one has written.
test('/api/kills keeps the rebuild that began later when two meet in one second', async () => {
  const w = setup();
  const realDb = w.env.DB;
  let release, reached;
  const gate = new Promise((r) => { release = r; });
  const atWrite = new Promise((r) => { reached = r; });
  let held = 0;
  w.env.DB = {
    prepare(q) {
      const st = realDb.prepare(q);
      if (!q.startsWith('INSERT INTO recent') || held++) return st;
      const hold = { bind: (...a) => { st.bind(...a); return hold; }, run: async () => { reached(); await gate; return st.run(); } };
      return hold;
    }
  };
  const early = w.post('kills', { rows: w.rows(w.now) });
  await atWrite;
  w.advance(500);
  const later = w.now;
  assert.equal(await w.post('kills', { rows: w.rows(later) }), 200);
  release();
  assert.equal(await early, 200);
  const got = JSON.parse((await w.get('/api/kills')).body).rows;
  assert.equal(Math.max(...got.map((r) => r[0])), later, 'the body is the later rebuild\'s');
});

// The body of the deploy before held no move: the first rebuild after it
// finds the move within 2.5 h is not the body's and walks to it.
test('/api/kills walks to the move once, from a body that held none', async () => {
  const w = setup();
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  const min = 60e3;
  const week = w.now - 86400e3;
  const t = (m) => w.now - m * min;
  for (const [m, k] of [[60, 100], [50, 110], [40, 110], [20, 110], [10, 110]]) ins.run('1-1', t(m), k, 0, 0, 0, week);
  // As the deploy before built it: the window and its base, no move.
  const old = [40, 20, 10].map((m) => [t(m), '1-1', 110, 0, 0, 0]);
  w.sql.prepare('INSERT INTO recent (id, at, rows) VALUES (1, ?, ?)').run(t(1), JSON.stringify(old));
  assert.equal(await w.post('kills', { rows: [[w.now, '2-1', 1, 0, 0, 0, week]] }), 200);
  const got = JSON.parse((await w.get('/api/kills')).body).rows;
  assert.deepEqual(got.filter((r) => r[1] === '1-1').map((r) => (w.now - r[0]) / min), [60, 50, 40, 20, 10],
    'the row before the move (and its base), the move, the window\'s base and rows');
});

// A late batch can bring a move whose base would lie before the week began:
// the lookup finds nothing, and the move is sent with no base rather than
// with a row of another week.
test('/api/kills sends a late move with no base when nothing lies 10 minutes before it', async () => {
  const w = setup();
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  const min = 60e3;
  const week = w.now - 36 * min;
  ins.run('1-1', w.now - 35 * min, 100, 0, 0, 0, week);
  assert.equal(await w.post('kills', { rows: [[w.now, '2-1', 1, 0, 0, 0, week]] }), 200);
  w.advance(min);
  const t0 = w.now;
  const late = [[29, 110], [21, 110]].map(([m, k]) => [t0 - m * min, '1-1', k, 0, 0, 0, week]);
  assert.equal(await w.post('kills', { rows: [...late, [t0, '2-1', 2, 0, 0, 0, week]] }), 200);
  const got = JSON.parse((await w.get('/api/kills')).body).rows;
  assert.deepEqual(got.filter((r) => r[1] === '1-1').map((r) => (t0 - r[0]) / min), [36, 29, 21],
    'the row before the move, the move, the newest: nothing of the week lies 10 minutes before the move');
});

// Carrying the move from body to body must give what a rebuild from scratch
// gives. Two databases take the same messages; before each, the second loses
// its body, so it walks. Seeded, so a difference names its seed and tick; the
// sequences share one clock. EQUIV_SEQUENCES runs more, EQUIV_SEED starts
// at another seed (EQUIV_SEED=n EQUIV_SEQUENCES=1 replays one).
test('carrying the move gives the body a rebuild from scratch gives', async () => {
  const seqs = Number(process.env.EQUIV_SEQUENCES) || 100;
  const seen = { resets: 0, longStops: 0, gaps: 0, lateRows: 0 };
  const steadyWalks = { n: 0 };
  const min = 60e3;
  const t0 = Date.parse('2026-09-30T12:00:00Z');
  // A database whose statements are prepared once: the same SQL, faster.
  const quick = (walks) => {
    const { sql } = fakeD1();
    const cache = new Map();
    const prep = (q) => cache.get(q) || cache.set(q, sql.prepare(q)).get(q);
    class Statement {
      constructor(q) { this.q = q; this.args = []; }
      bind(...args) { this.args = args; return this; }
      async run() { return { meta: { changes: Number(prep(this.q).run(...this.args).changes) } }; }
      async all() { if (walks && WALK.test(this.q)) walks.n++; return { results: prep(this.q).all(...this.args) }; }
      async first() { return prep(this.q).get(...this.args) ?? null; }
    }
    const body = sql.prepare('SELECT at, rows FROM recent');
    return { sql, body: () => { const r = body.get(); return r ? r.at + ' ' + r.rows : ''; },
      env: { DB: { prepare: (q) => new Statement(q) }, INGEST_KILLS: KILLS_KEY, INGEST_RELINK: RELINK_KEY } };
  };
  const send = (env, now, rows) => {
    const body = JSON.stringify({ rows });
    const t = Math.floor(now / 1000);
    return worker.fetch(new Request('https://wvwrelink.com/api/ingest/kills',
      { method: 'POST', body, headers: signHeaders(KILLS_KEY, t, '/api/ingest/kills', body) }), env);
  };

  // Each sequence: its messages by minute from t0, made up front.
  const plans = [];
  const from = Number(process.env.EQUIV_SEED) || 1;
  const seeds = Array.from({ length: seqs }, (_, i) => from + i);
  // Seed 1021 has a late move whose base must be looked up (lookBase in
  // rebuildRecent); no seed of 1-100 does, so the default run keeps it.
  if (!process.env.EQUIV_SEED) seeds.push(1021);
  for (const seed of seeds) {
    const rnd = mulberry32(seed);
    const pick = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const ids = rnd() < 0.5 ? ['1-1'] : ['1-1', '2-1'];
    const m = ids.map((id) => ({ id, start: t0 - pick(1, 6) * 86400e3, k: [pick(0, 5000), pick(0, 3000), pick(0, 3000), pick(0, 3000)],
      score: pick(1000, 90000), still: 0, fight: 0, rose: false }));
    // Rows kills.gs has not sent yet: it goes down for a while and sends them late.
    let backlog = [], gsDown = 0, gap = 0, now = t0, readers = {};
    const sends = new Map();
    const end = t0 + pick(4, 8) * 60 * min;
    while (now < end) {
      now += pick(1, 6) * min;
      for (const s of m) {
        if (rnd() < 0.004) { s.start = now; s.k = [0, 0, 0, 0]; s.score = 0; seen.resets++; }  // a reset or a relink
        if (!s.still && !s.fight) {
          if (rnd() < 0.5) s.fight = now + pick(3, 60) * min;
          else s.still = now + [pick(5, 40), pick(40, 150), pick(150, 270)][pick(0, 2)] * min;
          if (s.still - now >= 150 * min) seen.longStops++;
        }
        if (s.fight && now >= s.fight) s.fight = 0;
        if (s.still && now >= s.still) s.still = 0;
        // The score rises on most reads, the kills only in a fight.
        s.rose = rnd() < 0.8;
        if (s.rose) s.score += pick(1, 40);
        if (s.fight) for (let i = 0; i < 4; i++) if (rnd() < 0.4) s.k[i] += pick(1, 12);
      }
      const fresh = m.filter((s) => s.rose).map((s) => [now, s.id, ...s.k, s.start, s.score]);
      backlog.push(...fresh);
      // A message carries the rows since the last one, as kills.gs does; one
      // in three steps sends, so a tick here is a few minutes of rows.
      let rows = [];
      if (gap > now) continue;
      if (rnd() < 0.015) { gap = now + pick(31, 90) * min; seen.gaps++; }  // nothing arrives at all
      // kills.gs down; each region's reader up or not, so one region's rows can
      // keep the body fresh while the other's wait to come late.
      else if (gsDown > now) { if (rnd() < 0.8) rows = fresh.filter((r) => readers[r[1][0]]); }
      else if (rnd() < 0.05) { gsDown = now + pick(5, 44) * min; readers = { 1: rnd() < 0.5, 2: rnd() < 0.5 }; }
      else if (rnd() < 0.35) { rows = backlog.filter((r) => r[0] > now - 44 * min); backlog = []; }
      seen.lateRows += rows.filter((r) => r[0] <= now - 30 * min).length;
      if (rows.length) sends.set(now, rows);
    }
    plans.push({ seed, sends, steady: quick(steadyWalks), scratch: quick() });
  }

  const realNow = Date.now, realLog = console.log;
  console.log = () => {};
  let ticks = 0;
  try {
    for (let now = t0; now <= t0 + 8 * 60 * min + 6 * min; now += min) {
      const due = plans.filter((p) => p.sends.has(now));
      if (!due.length) continue;
      Date.now = () => now;
      for (const p of due) {
        const rows = p.sends.get(now);
        await send(p.steady.env, now, rows);
        p.scratch.sql.prepare('DELETE FROM recent').run();
        await send(p.scratch.env, now, rows);
        ticks++;
        const a = p.steady.body(), b = p.scratch.body();
        if (a !== b) assert.equal(a, b, `seed ${p.seed}, tick at ${new Date(now).toISOString()}`);
      }
    }
  } finally {
    Date.now = realNow;
    console.log = realLog;
  }
  console.log(JSON.stringify({ equivalence: { sequences: seeds.length, ticks, steadyWalks: steadyWalks.n, ...seen } }));
  if (seqs >= 50) for (const [what, n] of Object.entries(seen)) assert.ok(n > 0, `no sequence had ${what}`);
  // The steady side carries: it walks after a gap, a new week or a late batch, not on most ticks.
  assert.ok(steadyWalks.n < ticks / 4, `the steady side walked on ${steadyWalks.n} of ${ticks} ticks`);
});

test('the readers\' rebuild from the last body gives the body a rebuild from scratch gives', async () => {
  const seqs = Number(process.env.EQUIV_SEQUENCES) || 60;
  const min = 60e3;
  const t0 = Date.parse('2026-10-09T22:00:00Z');
  const NA_NEW = Date.parse('2026-10-10T02:00:00Z');
  const EU_START = Date.parse('2026-10-09T18:00:00Z');
  const keys = { kills: KILLS_KEY, 'latest-supa-us': 'a'.repeat(128), 'latest-supa-eu': 'b'.repeat(128) };
  const envKeys = { INGEST_KILLS: keys.kills, INGEST_LATEST_SUPA_US: keys['latest-supa-us'], INGEST_LATEST_SUPA_EU: keys['latest-supa-eu'] };
  const gz = gzipSync(Buffer.from('{"x":1}'));
  const sha = createHash('sha256').update(gz).digest('hex');
  const side = (stat) => {
    const { sql } = fakeD1();
    const cache = new Map();
    const prep = (q) => cache.get(q) || cache.set(q, sql.prepare(q)).get(q);
    class Statement {
      constructor(q) { this.q = q; this.args = []; }
      bind(...args) { this.args = args; return this; }
      async run() {
        if (stat && /^UPDATE recent/.test(this.q)) stat.updates++;
        return { meta: { changes: Number(prep(this.q).run(...this.args).changes) } };
      }
      async all() {
        const results = prep(this.q).all(...this.args);
        if (stat && /(FROM|JOIN) kills/.test(this.q)) stat.read += results.length;
        if (stat && /^WITH a\(m, t\)/.test(this.q)) stat.fresh += results.length;
        if (stat && /UNION ALL/.test(this.q)) stat.fullReads++;
        return { results };
      }
      async first() { return prep(this.q).get(...this.args) ?? null; }
    }
    const body = sql.prepare('SELECT at, rows FROM recent');
    return { sql, body: () => { const r = body.get(); return r ? r.at + ' ' + r.rows : ''; },
      env: { DB: { prepare: (q) => new Statement(q) }, ...envKeys } };
  };
  const post = (env, source, now, buf) => {
    const t = Math.floor(now / 1000);
    return worker.fetch(new Request('https://wvwrelink.com/api/ingest/' + source,
      { method: 'POST', body: buf, headers: signHeaders(keys[source], t, '/api/ingest/' + source, buf) }), env);
  };
  const reader = (rows) => {
    const entries = rows.map((r) => ({ id: r.id, start: r.start, scores: [r.score, 0, 0], kills: r.k, bytes: gz.length, raw: 10, sha256: sha }));
    return Buffer.concat([Buffer.from(JSON.stringify({ v: 1, matches: entries }) + '\n'), ...entries.map(() => gz)]);
  };

  const plans = [];
  const seen = { readerSends: 0, gsSends: 0, resets: 0, stops: 0, gaps: 0, freezes: 0 };
  for (let seed = 1; seed <= seqs; seed++) {
    const rnd = mulberry32(seed);
    const pick = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const ids = ['1-1', '2-1', '1-2'].slice(0, pick(1, 3));
    const m = ids.map((id) => ({ id, start: id[0] === '1' ? Date.parse('2026-10-03T02:00:00Z') : EU_START - 7 * 86400e3,
      k: [pick(0, 5000), pick(0, 3000), pick(0, 3000), pick(0, 3000)], score: pick(1000, 90000), still: 0, fight: 0, reset: false, frozen: 0 }));
    const sends = new Map();
    let now = t0, backlog = [], gsDown = 0, gap = 0;
    const end = t0 + pick(4, 8) * 60 * min;
    while (now < end) {
      now += pick(1, 6) * min;
      const fresh = [];
      for (const s of m) {
        if (s.id[0] === '1' && !s.reset && now >= NA_NEW) { s.reset = true; s.start = NA_NEW; s.k = [0, 0, 0, 0]; s.score = 0; seen.resets++; }
        if (!s.still && !s.fight) {
          if (rnd() < 0.5) s.fight = now + pick(3, 60) * min;
          else { s.still = now + [pick(5, 40), pick(40, 150), pick(150, 270)][pick(0, 2)] * min; seen.stops++; }
        }
        if (s.fight && now >= s.fight) s.fight = 0;
        if (s.still && now >= s.still) s.still = 0;
        // The game's API can stand still for hours: no line for the match at all.
        if (!s.frozen && rnd() < 0.02) { s.frozen = now + pick(30, 300) * min; seen.freezes++; }
        if (s.frozen && now >= s.frozen) s.frozen = 0;
        if (!s.frozen && rnd() < 0.8) {
          s.score += pick(1, 40);
          if (s.fight) for (let i = 0; i < 4; i++) if (rnd() < 0.4) s.k[i] += pick(1, 12);
          fresh.push({ id: s.id, start: s.start, k: s.k.slice(), score: s.score, at: now });
        }
      }
      backlog.push(...fresh);
      if (gap > now) continue;
      const roll = rnd();
      if (roll < 0.015) { gap = now + pick(31, 90) * min; seen.gaps++; continue; }
      if (roll < 0.05) gsDown = now + pick(5, 44) * min;
      // kills.gs sends what it has not yet, up to 44 minutes back; the readers send the current lines.
      if (gsDown <= now && rnd() < 0.3) {
        const rows = backlog.filter((r) => r.at > now - 44 * min).map((r) => [r.at, r.id, ...r.k, r.start, r.score]);
        backlog = [];
        if (rows.length) { sends.set(now, { source: 'kills', buf: Buffer.from(JSON.stringify({ rows })) }); seen.gsSends++; }
      } else if (rnd() < 0.75 && fresh.length) {
        sends.set(now, { source: rnd() < 0.5 ? 'latest-supa-us' : 'latest-supa-eu', buf: reader(fresh) });
        seen.readerSends++;
      }
    }
    const stat = { updates: 0, read: 0, fresh: 0, fullReads: 0 }, plain = { updates: 0, read: 0, fresh: 0, fullReads: 0 };
    plans.push({ seed, sends, stat, plain, steady: side(stat), scratch: side(plain) });
  }
  const realNow = Date.now, realLog = console.log;
  console.log = () => {};
  let ticks = 0;
  try {
    for (let now = t0; now <= t0 + 8 * 60 * min + 6 * min; now += min) {
      const due = plans.filter((p) => p.sends.has(now));
      if (!due.length) continue;
      Date.now = () => now;
      for (const p of due) {
        const { source, buf } = p.sends.get(now);
        await post(p.steady.env, source, now, buf);
        p.scratch.sql.prepare('DELETE FROM recent').run();
        await post(p.scratch.env, source, now, buf);
        ticks++;
        const a = p.steady.body(), b = p.scratch.body();
        if (a !== b) assert.equal(a, b, `seed ${p.seed}, ${source} at ${new Date(now).toISOString()}`);
      }
    }
  } finally {
    Date.now = realNow;
    console.log = realLog;
  }
  const updates = plans.reduce((n, p) => n + p.stat.updates, 0);
  const sum = (key, of) => plans.reduce((n, p) => n + p[of][key], 0);
  console.log(JSON.stringify({ readersEquivalence: { sequences: seqs, ticks, fromTheLastBody: updates,
    rowsReadSteady: sum('read', 'stat'), rowsReadScratch: sum('read', 'plain'), newLinesRead: sum('fresh', 'stat'), ...seen } }));
  if (seqs >= 30) for (const [what, n] of Object.entries(seen)) assert.ok(n > 0, `no sequence had ${what}`);
  // The point of going on from the last body: it does not read the window again.
  assert.ok(sum('read', 'stat') < sum('read', 'plain') * 0.6, 'the steady side read as many rows as the scratch side');
  // And what it does read is the lines since the body: a few per message, not the window.
  assert.ok(sum('fresh', 'stat') > 0 && sum('fresh', 'stat') <= 4 * updates, `${sum('fresh', 'stat')} new lines read`);
  assert.ok(updates > seen.readerSends / 3, `only ${updates} of ${seen.readerSends} reader messages went on from the last body`);
});

test('a reader\'s rebuild that another rebuild overtook is made again from the table', async () => {
  const key = 'a'.repeat(128);
  const w = setup({ env: { INGEST_LATEST_SUPA_US: key } });
  const start = Date.parse('2026-09-26T02:00:00Z');
  const gz = gzipSync(Buffer.from('{"x":1}'));
  const reader = (score) => {
    const entry = { id: '1-1', start, scores: [score, 0, 0], kills: [1, 2, 3, 4], bytes: gz.length, raw: 10, sha256: createHash('sha256').update(gz).digest('hex') };
    return Buffer.concat([Buffer.from(JSON.stringify({ v: 1, matches: [entry] }) + '\n'), gz]);
  };
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 1, 2, 3, 4, start, 100]] }), 200);
    w.advance(120e3);
    // Another rebuild writes between this one's read of the body and its write.
    const real = w.env.DB.prepare;
    let overtaken = false;
    w.env.DB = { prepare: (q) => {
      if (q.startsWith('UPDATE recent') && !overtaken) { overtaken = true; w.sql.prepare('UPDATE recent SET at = at + 1').run(); }
      return real(q);
    } };
    assert.equal(await w.post('latest-supa-us', reader(200), { key }), 200);
    assert.ok(overtaken);
  } finally {
    console.log = log;
  }
  const got = JSON.parse((await w.get('/api/kills')).body).rows;
  assert.equal(got.length, 2, 'the new line is in the body');
  assert.ok(w.ran.some((s) => s.q.startsWith('INSERT INTO recent') && s.args[0] >= w.now), 'made again');
});

test('a reader\'s rebuild sees a match the body does not hold, its rows put in by kills.gs without a rebuild', async () => {
  const key = 'a'.repeat(128);
  const w = setup({ env: { INGEST_LATEST_SUPA_US: key } });
  const start = Date.parse('2026-09-26T02:00:00Z');
  const gz = gzipSync(Buffer.from('{"x":1}'));
  const entry = { id: '1-1', start, scores: [200, 0, 0], kills: [1, 2, 3, 4], bytes: gz.length, raw: 10, sha256: createHash('sha256').update(gz).digest('hex') };
  const msg = Buffer.concat([Buffer.from(JSON.stringify({ v: 1, matches: [entry] }) + '\n'), gz]);
  const at0 = w.now;
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 1, 2, 3, 4, start, 100]] }), 200);
    const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
    for (const back of [100, 60, 20]) ins.run('1-2', w.now - back * 60e3, 5, 5, 5, 5, start);
    w.advance(120e3);
    assert.equal(await w.post('latest-supa-us', msg, { key }), 200);
  } finally {
    console.log = log;
  }
  const got = JSON.parse((await w.get('/api/kills')).body).rows.filter((r) => r[1] === '1-2');
  assert.deepEqual(got.map((r) => (at0 - r[0]) / 60e3), [100, 60, 20], 'the first line of the still stretch, the one before the window, the one in it');
});

test('a reader\'s rebuild that cannot go on from the last body is the full read, and says why', async () => {
  const key = 'a'.repeat(128);
  const start = Date.parse('2026-09-26T02:00:00Z');
  const gz = gzipSync(Buffer.from('{"x":1}'));
  const msg = (kills) => {
    const entry = { id: '1-1', start, scores: [200, 0, 0], kills, bytes: gz.length, raw: 10, sha256: createHash('sha256').update(gz).digest('hex') };
    return Buffer.concat([Buffer.from(JSON.stringify({ v: 1, matches: [entry] }) + '\n'), gz]);
  };
  const cases = {
    'no body': { prep: async () => {}, gap: 0, kills: [1, 2, 3, 4] },
    'body does not join up': { prep: async (w) => { await w.post('kills', { rows: [[w.now, '1-1', 1, 2, 3, 4, start, 100]] }); }, gap: 40 * 60e3, kills: [1, 2, 3, 4] },
    'new slot': { prep: async (w) => { await w.post('kills', { rows: [[w.now, '1-1', 1, 2, 3, 4, start, 100]] }); }, gap: 11 * 60e3, kills: [1, 2, 3, 4] },
    // The reader's second is the one before the body's own millisecond.
    'clock behind the body': { first: 900, prep: async (w) => { await w.post('kills', { rows: [[w.now, '1-1', 1, 2, 3, 4, start, 100]] }); }, gap: 50, kills: [2, 2, 3, 4] },
    // The line the body holds is gone from the table, so its week cannot be read.
    'line missing': { prep: async (w) => {
      w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)').run('1-1', w.now - 40 * 60e3, 1, 2, 3, 4, start);
      await w.post('kills', { rows: [[w.now, '1-1', 1, 2, 3, 4, start, 100]] });
      w.sql.prepare('DELETE FROM kills WHERE at = ?').run(w.now - 40 * 60e3);
    }, gap: 2 * 60e3, kills: [1, 2, 3, 4] }
  };
  const run = async (c, twin) => {
    const w = setup({ env: { INGEST_LATEST_SUPA_US: key } });
    const lines = [];
    const log = console.log;
    console.log = (x) => lines.push(x);
    try {
      if (c.first) w.advance(c.first);
      await c.prep(w);
      w.advance(c.gap);
      if (twin) w.sql.prepare('DELETE FROM recent').run();
      assert.equal(await w.post('latest-supa-us', msg(c.kills), { key }), 200);
    } finally {
      console.log = log;
    }
    const full = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l && l.recent === 'full');
    return { rows: w.sql.prepare('SELECT rows FROM recent').get().rows, full };
  };
  for (const [why, c] of Object.entries(cases)) {
    const got = await run(c, false), twin = await run(c, true);
    assert.deepEqual(got.full, [{ recent: 'full', why }], why);
    assert.equal(got.rows, twin.rows, why + ': the same body as the full read');
  }
});

// A small seeded generator (mulberry32), so a sequence is the same on every run.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the rebuild reads kills by its key, never the whole table', async () => {
  const w = setup();
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  const week = w.now - 86400e3;
  // Still for 40 minutes, so the first rebuild walks, the base and the move are looked up.
  for (let m = 1; m <= 70; m++) ins.run('1-1', w.now - m * 60e3, 500 - Math.max(0, m - 40), 1, 1, 1, week);
  await w.post('kills', { rows: w.rows(w.now).map((r) => (r[1] === '1-1' ? [r[0], '1-1', 500, 1, 1, 1, week] : r)) });
  const reads = w.ran.filter((s) => /\bkills\b/.test(s.q) && !/^INSERT|^DELETE/.test(s.q));
  assert.ok(reads.some((s) => WALK.test(s.q)) && reads.length >= 4, reads.map((s) => s.q).join('\n'));
  for (const s of reads) {
    const steps = w.sql.prepare('EXPLAIN QUERY PLAN ' + s.q).all(...s.args).map((p) => p.detail);
    const plan = steps.join('; ');
    assert.match(plan, /SEARCH (kills|k) USING PRIMARY KEY/, plan);
    assert.doesNotMatch(plan, /SCAN (kills|k)\b/, plan);
    // Every step over kills must bound `at` as well as the match: a search by
    // match alone walks every row of that match, 14 days of them.
    for (const d of steps.filter((x) => /^(SCAN|SEARCH) (kills|k)\b/.test(x))) {
      assert.match(d, /^SEARCH .* USING PRIMARY KEY \(match=\? AND at/, d);
    }
  }
});

test('the base is right with 14 days of one match in the table', async () => {
  const w = setup();
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  const start = w.now - 86400e3;
  for (let i = 1; i <= 14 * 288; i++) ins.run('1-1', w.now - i * 300e3, i, 0, 0, 0, start);
  ins.run('1-2', w.now - 2 * 3600e3, 99, 0, 0, 0, start);
  assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 1, 0, 0, 0, start]] }), 200);
  const got = JSON.parse((await w.get('/api/kills')).body).rows;
  const one = got.filter((r) => r[1] === '1-1');
  assert.equal(one.length, 1 + 5 + 1, 'now, five in the window, one base');
  assert.equal(one[0][2], 6, 'the base is the tick 30 minutes back');
  assert.deepEqual(got.filter((r) => r[1] === '1-2').map((r) => r[2]), [99]);
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

test('a signed message with a wrong shape is 422 and writes nothing, whatever the field', async (sub) => {
  const w = setup();
  const now = w.now;
  const t0 = { t: Math.floor(now / 1000) };
  const row = (over = {}) => {
    const r = [now, '1-1', 1, 2, 3, 4, now - 1e6];
    for (const [i, v] of Object.entries(over)) r[i] = v;
    return r;
  };
  const cases = [
    ['kills: JSON null', () => w.post('kills', 'null', t0), 422],
    ['kills: a list, not an object', () => w.post('kills', '[1]', t0), 422],
    ['kills: rows not a list', () => w.post('kills', { rows: 'x' }, t0), 422],
    ['kills: an empty list of rows', () => w.post('kills', { rows: [] }, t0), 422],
    ['kills: a null row', () => w.post('kills', { rows: [null] }, t0), 422],
    ['kills: a row of six', () => w.post('kills', { rows: [row().slice(0, 6)] }, t0), 422],
    ['kills: a row of nine', () => w.post('kills', { rows: [[...row(), 1, 2]] }, t0), 422],
    ['kills: start after the row\'s own time', () => w.post('kills', { rows: [row({ 6: now + 1 })] }, t0), 422],
    ['kills: start more than 8 days before', () => w.post('kills', { rows: [row({ 6: now - 8 * 86400e3 - 1 })] }, t0), 422],
    ['kills: a fractional count', () => w.post('kills', { rows: [row({ 3: 1.5 })] }, t0), 422],
    ['kills: a count past 1e7', () => w.post('kills', { rows: [row({ 4: 1e7 + 1 })] }, t0), 422],
    ['kills: a score past 3e7', () => w.post('kills', { rows: [[...row(), 3e7 + 1]] }, t0), 422],
    ['kills: a negative score', () => w.post('kills', { rows: [[...row(), -1]] }, t0), 422],
    ['kills: a row from the future', () => w.post('kills', { rows: [row({ 0: now + 61e3 })] }, t0), 422],
    ['relink: JSON null', () => w.post('relink', 'null', t0), 422],
    ['relink: a list', () => w.post('relink', '[]', t0), 422],
    ['relink: negative fails', () => w.post('relink', w.relink({ fails: -1 }), t0), 422],
    ['relink: fails past 1e6', () => w.post('relink', w.relink({ fails: 1e6 + 1 }), t0), 422],
    ['relink: fails as text', () => w.post('relink', w.relink({ fails: '0' }), t0), 422],
    ['relink: window below 1.7e9', () => w.post('relink', w.relink({ window: 1.7e9 - 1 }), t0), 422],
    ['relink: window above 4.1e9', () => w.post('relink', w.relink({ window: 4.1e9 + 1 }), t0), 422],
    ['relink: window with a fraction', () => w.post('relink', w.relink({ window: 1790992800.5 }), t0), 422],
    ['relink: published in the future', () => w.post('relink', w.relink({ published: Math.floor(now / 1000) + 61 }), t0), 422],
    ['relink: negative published', () => w.post('relink', w.relink({ published: -1 }), t0), 422],
    ['relink: window null, published not', () => w.post('relink', w.relink({ window: null, published: 5 }), t0), 422],
    ['relink: beat an hour and a second old', () => w.post('relink', w.relink({ beat: Math.floor(now / 1000) - 3601 }), t0), 422],
    ['relink: beat a minute and a second ahead', () => w.post('relink', w.relink({ beat: Math.floor(now / 1000) + 61 }), t0), 422]
  ];
  for (const [name, send, want] of cases) await sub.test(name, async () => assert.equal(await send(), want));
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 0);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM relink').get().n, 0);
});

test('the limits of a signed message are inclusive on the side they say, and a relink with no window is kept as none', async () => {
  const w = setup();
  const now = w.now;
  const sec = Math.floor(now / 1000);
  let k = 0;
  const at = () => ({ t: sec + ++k });
  for (const [window, fails] of [[1.7e9, 0], [4.1e9, 1e6]]) {
    assert.equal(await w.post('relink', w.relink({ window, fails }), at()), 200, `window ${window}`);
    assert.deepEqual({ ...w.sql.prepare('SELECT window_at, fails FROM relink').get() }, { window_at: window, fails });
  }
  const t1 = at();
  assert.equal(await w.post('relink', w.relink({ published: t1.t + 60, beat: t1.t - 3600 }), t1), 200, 'the oldest beat and the furthest published');
  assert.equal(await w.post('relink', w.relink({ window: null, published: null }), at()), 200);
  assert.deepEqual({ ...w.sql.prepare('SELECT window_at, published FROM relink').get() }, { window_at: null, published: null });
  assert.equal((await w.get('/api/relink')).status, 503, 'a sheet that did not parse is no answer');
  const t2 = at();
  const tms = t2.t * 1000;
  assert.equal(await w.post('kills', { rows: [[tms + 60e3, '1-1', 0, 0, 0, 0, tms - 8 * 86400e3 + 60e3]] }, t2), 200, 'the farthest ahead row, the oldest start');
  const t3 = at();
  const old = t3.t * 1000 - 45 * 60e3;
  assert.equal(await w.post('kills', { rows: [[old, '1-2', 1e7, 0, 0, 0, old, 3e7]] }, t3), 200, 'the oldest row, the biggest count and score');
});

test('a signed POST with no body at all is refused: 401 unsigned, 400 when the empty body is what was signed', async () => {
  const w = setup();
  const send = async (path, headers) => {
    const real = Date.now;
    Date.now = () => w.now;
    try { return (await worker.fetch(new Request('https://wvwrelink.com' + path, { method: 'POST', headers }), w.env)).status; }
    finally { Date.now = real; }
  };
  const t = String(Math.floor(w.now / 1000));
  assert.equal(await send('/api/ingest/kills', { 'x-wvw-time': t, 'x-wvw-sig': 'a'.repeat(64) }), 401);
  assert.equal(await send('/api/ingest/kills', {}), 401);
  assert.equal(await send('/api/ingest/relink', { 'x-wvw-time': t, 'x-wvw-sig': 'a'.repeat(64) }), 401);
  assert.equal(await send('/api/ingest/kills', w.signed('/api/ingest/kills', '', { t: Number(t) })), 400);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 0);
});

// ---- board: each match's skirmishes, from the readers' summaries.
const SUPA = { 'latest-supa-us': 'a'.repeat(128), 'latest-supa-eu': 'b'.repeat(128) };
const SUPA_ENV = { INGEST_LATEST_SUPA_US: SUPA['latest-supa-us'], INGEST_LATEST_SUPA_EU: SUPA['latest-supa-eu'] };
// The NA week of setup()'s clock (Wednesday 12:00Z): 106 hours in, skirmish 54 running.
const NA_WEEK = Date.parse('2026-09-26T02:00:00Z');

// A reader's message: the summary line, then the gzip of each body. An entry
// without vp and skirmishes is what a reader older than board sends.
function latestBody(entries) {
  const slices = entries.map((e) => gzipSync(Buffer.from(JSON.stringify({ id: e.id }))));
  const matches = entries.map((e, i) => ({
    id: e.id, start: e.start ?? NA_WEEK, scores: e.scores || [1000, 2000, 3000], kills: [1, 2, 3, 4],
    bytes: slices[i].length, raw: 20, sha256: createHash('sha256').update(slices[i]).digest('hex'), ...e.board
  }));
  return Buffer.concat([Buffer.from(JSON.stringify({ v: 1, matches }) + '\n'), ...slices]);
}
const pushLatest = (w, source, entries) => w.post(source, latestBody(entries), { key: SUPA[source] });
const latestScore = (w) => w.sql.prepare("SELECT score FROM latest WHERE id = '1-1'").get();
const boardRows = (w) => w.sql.prepare('SELECT match, skirmish, red, blue, green, vp_red, vp_blue, vp_green, at FROM board ORDER BY match, skirmish').all()
  .map((r) => ({ ...r }));

test('board: a skirmish is written once it has finished, once, whichever reader and however often', async () => {
  const w = setup({ env: SUPA_ENV });
  const board = (running, vp) => ({ vp, skirmishes: [[running - 1, 100, 200, 300], [running, 1, 2, 3]] });
  assert.equal(await pushLatest(w, 'latest-supa-us', [{ id: '1-1', scores: [1000, 2000, 3000], board: board(54, [500, 400, 300]) }]), 200);
  const first = boardRows(w);
  assert.deepEqual(first.map((r) => [r.match, r.skirmish, r.red, r.blue, r.green, r.vp_red]), [['1-1', 53, 100, 200, 300, 500]]);
  // The other reader, the same score, a minute later; then a higher score: no new row, nothing rewritten.
  w.advance(60e3);
  assert.equal(await pushLatest(w, 'latest-supa-eu', [{ id: '1-1', scores: [1000, 2000, 3000], board: board(54, [500, 400, 300]) }]), 200);
  w.advance(60e3);
  assert.equal(await pushLatest(w, 'latest-supa-us', [{ id: '1-1', scores: [1001, 2000, 3000], board: board(54, [500, 400, 300]) }]), 200);
  assert.deepEqual(boardRows(w), first);
  // The turn: 54 has finished, 55 runs.
  w.advance(2 * 3600e3);
  assert.equal(await pushLatest(w, 'latest-supa-eu', [{ id: '1-1', scores: [9000, 9000, 9000], board: board(55, [543, 432, 321]) }]), 200);
  assert.deepEqual(boardRows(w).map((r) => [r.skirmish, r.vp_red]), [[53, 500], [54, 543]]);
});

test('board: a VP that rises a read after the skirmish list is kept, a lower one never', async () => {
  const w = setup({ env: SUPA_ENV });
  const send = (score, vp) => pushLatest(w, 'latest-supa-us', [{ id: '1-2', scores: [score, 0, 0], board: { vp, skirmishes: [[53, 7, 8, 9], [54, 1, 1, 1]] } }]);
  assert.equal(await send(1000, [400, 300, 200]), 200);
  w.advance(60e3);
  assert.equal(await send(1100, [443, 332, 221]), 200);
  const risen = boardRows(w)[0];
  assert.deepEqual([risen.vp_red, risen.vp_blue, risen.vp_green, risen.at], [443, 332, 221, w.now]);
  w.advance(60e3);
  assert.equal(await send(1200, [400, 300, 200]), 200, 'a stale VP is no reason to refuse the message');
  assert.deepEqual(boardRows(w)[0], risen);
  // The other reader at the same score, which the latest table does not take, with the VP risen.
  w.advance(60e3);
  assert.equal(await pushLatest(w, 'latest-supa-eu', [{ id: '1-2', scores: [1100, 0, 0], board: { vp: [444, 332, 221], skirmishes: [[53, 7, 8, 9], [54, 1, 1, 1]] } }]), 200);
  assert.equal(boardRows(w)[0].vp_red, 444);
});

test('board: the week\'s last skirmish is kept while it runs, its score only rising', async () => {
  const w = setup({ env: SUPA_ENV });
  // Saturday 01:00Z: skirmish 84 of the NA week runs until the reset at 02:00.
  w.advance(Date.parse('2026-10-03T01:00:00Z') - w.now);
  const send = (score, last, vp = [900, 800, 700]) => pushLatest(w, 'latest-supa-us', [{
    id: '1-3', scores: [score, 0, 0], board: { vp, skirmishes: [[83, 5, 5, 5], [84, ...last]] }
  }]);
  assert.equal(await send(500000, [10, 20, 30]), 200);
  assert.deepEqual(boardRows(w).map((r) => [r.skirmish, r.red, r.blue, r.green]), [[83, 5, 5, 5], [84, 10, 20, 30]]);
  w.advance(60e3);
  assert.equal(await send(500100, [50, 20, 30]), 200);
  w.advance(60e3);
  assert.equal(await send(500200, [40, 20, 30]), 200);
  w.advance(60e3);
  assert.equal(await send(500300, [40, 20, 30], [999, 800, 700]), 200, 'a higher VP does not carry a lower score in');
  w.advance(60e3);
  assert.equal(await send(500400, [60, 20, 30], [900, 800, 600]), 200, 'nor a higher score a lower VP');
  assert.deepEqual(boardRows(w).map((r) => [r.skirmish, r.red, r.vp_red]), [[83, 5, 999], [84, 50, 900]]);
});

test('board: readers with and without the fields are taken at once; without, only board is left out', async () => {
  const w = setup({ env: SUPA_ENV });
  const vp = [3, 2, 1];
  assert.equal(await pushLatest(w, 'latest-supa-us', [
    { id: '1-1' }, { id: '1-2', board: { vp, skirmishes: [[53, 1, 2, 3], [54, 0, 0, 0]] } }
  ]), 200);
  assert.equal(await pushLatest(w, 'latest-supa-eu', [{ id: '1-3' }]), 200);
  assert.deepEqual(w.sql.prepare('SELECT id FROM latest ORDER BY id').all().map((r) => r.id), ['1-1', '1-2', '1-3']);
  assert.deepEqual(boardRows(w).map((r) => [r.match, r.skirmish]), [['1-2', 53]]);
  // Skirmish 1 running: nothing has finished yet.
  w.advance(Date.parse('2026-10-03T03:00:00Z') - w.now);
  const start = Date.parse('2026-10-03T02:00:00Z');
  assert.equal(await pushLatest(w, 'latest-supa-us', [{ id: '1-4', start, board: { vp: [0, 0, 0], skirmishes: [[1, 9, 9, 9]] } }]), 200);
  assert.equal(boardRows(w).length, 1);
});

test('board: fields out of shape leave the board out, the rest goes in', async (sub) => {
  const w = setup({ env: SUPA_ENV });
  const s = (a, b) => [[53, ...a], [54, ...b]];
  const cases = {
    'vp without skirmishes': { vp: [1, 2, 3] },
    'skirmishes without vp': { skirmishes: s([1, 1, 1], [1, 1, 1]) },
    'a negative vp': { vp: [-1, 2, 3], skirmishes: s([1, 1, 1], [1, 1, 1]) },
    'vp of two': { vp: [1, 2], skirmishes: s([1, 1, 1], [1, 1, 1]) },
    'a vp past 60 a skirmish': { vp: [60 * 54 + 1, 0, 0], skirmishes: s([1, 1, 1], [1, 1, 1]) },
    'a fractional score': { vp: [1, 2, 3], skirmishes: s([1.5, 1, 1], [1, 1, 1]) },
    'three skirmishes': { vp: [1, 2, 3], skirmishes: [[52, 1, 1, 1], ...s([1, 1, 1], [1, 1, 1])] },
    'no skirmish': { vp: [1, 2, 3], skirmishes: [] },
    'only the running one past the first': { vp: [1, 2, 3], skirmishes: [[54, 1, 1, 1]] },
    'a gap between the two': { vp: [1, 2, 3], skirmishes: [[52, 1, 1, 1], [54, 1, 1, 1]] },
    'skirmish 0': { vp: [1, 2, 3], skirmishes: [[0, 1, 1, 1]] },
    'skirmish 85': { vp: [1, 2, 3], skirmishes: [[84, 1, 1, 1], [85, 1, 1, 1]] },
    'a skirmish that has not begun': { vp: [1, 2, 3], skirmishes: [[54, 1, 1, 1], [55, 1, 1, 1]] },
    'a skirmish past 1000 a minute': { vp: [1, 2, 3], skirmishes: s([122001, 0, 0], [1, 1, 1]) }
  };
  let score = 1000;
  const log = console.log;
  const send = async (board) => {
    const lines = [];
    console.log = (x) => lines.push(String(x));
    try {
      const status = await pushLatest(w, 'latest-supa-us', [{ id: '1-1', scores: [++score, 2000, 3000], board }]);
      return { status, lines: lines.map((l) => JSON.parse(l)) };
    } finally {
      console.log = log;
    }
  };
  for (const [name, board] of Object.entries(cases)) {
    await sub.test(name, async () => {
      const r = await send(board);
      assert.equal(r.status, 200);
      assert.equal(latestScore(w).score, score + 5000, 'the latest body went in');
      assert.ok(r.lines.some((l) => l.board === 'left out' && /^1-1 /.test(l.why[0])), JSON.stringify(r.lines));
    });
  }
  assert.equal(boardRows(w).length, 0);
  // The edges the other way: the largest counts, and a skirmish 5 minutes before it begins (a reader's clock ahead).
  assert.equal((await send({ vp: [60 * 54, 0, 0], skirmishes: s([122000, 0, 0], [1, 1, 1]) })).status, 200);
  assert.deepEqual(boardRows(w).map((r) => [r.skirmish, r.red, r.vp_red]), [[53, 122000, 3240]]);
  const early = () => send({ vp: [60 * 55, 0, 0], skirmishes: [[54, 1, 1, 1], [55, 0, 0, 0]] });
  w.advance(2 * 3600e3 - 5 * 60e3 - 1000);
  await early();
  assert.equal(boardRows(w).length, 1);
  w.advance(1000);
  await early();
  assert.deepEqual(boardRows(w).map((r) => [r.skirmish, r.vp_red]), [[53, 3240], [54, 3300]]);
});

test('board: 18 matches are one statement, and without the table the message still goes in', async () => {
  const w = setup({ env: SUPA_ENV });
  const all = [];
  for (let i = 1; i <= 9; i++) all.push({ id: '1-' + i, board: { vp: [1, 1, 1], skirmishes: [[53, 1, 1, 1], [54, 1, 1, 1]] } });
  // The EU week began Friday 18:00Z, 114 hours before: skirmish 58 runs.
  const eu = Date.parse('2026-09-25T18:00:00Z');
  for (let i = 1; i <= 9; i++) all.push({ id: '2-' + i, start: eu, board: { vp: [1, 1, 1], skirmishes: [[57, 1, 1, 1], [58, 1, 1, 1]] } });
  assert.equal(await pushLatest(w, 'latest-supa-us', all), 200);
  assert.equal(w.ran.filter((x) => /^INSERT INTO board/.test(x.q)).length, 1);
  assert.equal(boardRows(w).length, 18);

  const bare = setup({ env: SUPA_ENV, skip: ['schema-005-board.sql'] });
  const log = console.log;
  const lines = [];
  console.log = (x) => lines.push(String(x));
  try {
    assert.equal(await pushLatest(bare, 'latest-supa-us', [all[0]]), 200);
  } finally {
    console.log = log;
  }
  assert.equal(bare.sql.prepare('SELECT count(*) n FROM latest').get().n, 1);
  assert.ok(lines.some((l) => JSON.parse(l).board === 'failed'), lines.join('\n'));
});
