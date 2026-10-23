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
      const sig = createHmac('sha256', key).update(t + '\n' + sigPath + '\n' + body).digest('hex');
      return { 'x-wvw-time': String(t), 'x-wvw-sig': sig };
    },
    async post(source, obj, o = {}) {
      const path = '/api/ingest/' + source;
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
  w.sql.prepare('INSERT INTO recent (id, at, rows) VALUES (1, ?, ?)').run(Math.floor(t(1) / 1000), JSON.stringify(old));
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
    const sig = createHmac('sha256', KILLS_KEY).update(t + '\n/api/ingest/kills\n' + body).digest('hex');
    return worker.fetch(new Request('https://wvwrelink.com/api/ingest/kills',
      { method: 'POST', body, headers: { 'x-wvw-time': String(t), 'x-wvw-sig': sig } }), env);
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
  const { sql, DB } = fakeD1();
  const now = Date.now();
  for (const d of [0, 1, 13, 14.1, 20]) {
    const at = Math.floor(now - d * 86400e3);
    sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,1,1,1,1,?)').run('1-1', at, at - 1000);
  }
  await worker.scheduled({}, { DB });
  const left = sql.prepare('SELECT at FROM kills').all().map((r) => Math.round((now - r.at) / 86400e3));
  assert.deepEqual(left.sort((a, b) => a - b), [0, 1, 13]);
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
