// /api/kills (worker/index.mjs): the last window, the base for a frozen match,
// the move of kills that stood still, and the rebuild from the last body.
// Run: node --test "tests/unit/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.mjs';
import { fakeD1 } from './fake-d1.mjs';
import { KILLS_KEY, RELINK_KEY, NA_WEEK, EU_WEEK, setup, v2Body } from './worker-harness.mjs';
import { signHeaders } from './signed.mjs';

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

// A small seeded generator (mulberry32), so a sequence is the same on every run.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('/api/kills gives the last 30 minutes, one row of D1, as the page reads it', async () => {
  const w = setup();
  assert.equal((await w.get('/api/kills')).status, 503, 'nothing pushed yet');
  // Fourteen days in the table, a tick every five minutes, the kills rising on each.
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  // One start for all of a match's rows, as in one week of it.
  for (let i = 1; i < 14 * 288; i++) {
    for (const r of w.rows(w.now - i * 300e3)) ins.run(r[1], r[0], r[2] + 14 * 288 - i, r[3], r[4], r[5], r[6]);
  }
  assert.equal(await w.post('kills', { rows: w.rows(w.now).map((r) => [r[0], r[1], r[2] + 14 * 288, ...r.slice(3)]) }), 200);
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
  const week = NA_WEEK;
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
  assert.equal(await w.post('kills', { rows: [[w.now, '2-1', 9, 9, 9, 9, EU_WEEK, 1]] }), 200);
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
  const week = NA_WEEK;
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
  assert.equal(await w.post('kills', { rows: [[w.now, '2-1', 9, 9, 9, 9, EU_WEEK, 1]] }), 200);
  const got = JSON.parse((await w.get('/api/kills')).body).rows;
  const by = (m) => got.filter((r) => r[1] === m).map((r) => w.now - r[0]);
  assert.deepEqual(by('1-1'), [50 * min, 40 * min], 'the stop and a reading 10 minutes older');
  assert.deepEqual(by('1-2'), [50 * min, 41 * min, 40 * min], 'the newest one at least 10 minutes older, not 45 nor 52');
  assert.deepEqual(by('1-3'), [40 * min], 'last week is no pair');
  assert.deepEqual(by('1-4'), [35 * min, 25 * min, 15 * min, 5 * min]);
  assert.deepEqual(got.map((r) => r[0]), got.map((r) => r[0]).sort((a, b) => a - b));
});

// The score rises every minute, so kills.gs writes a row every minute, but the
// kills stood still: every row of the last 30 minutes has one total, and the
// page needs the move and a reading 10 minutes before it to count anything.
test('/api/kills carries the last move of kills that stood still, and a reading 10 minutes before it', async () => {
  const w = setup();
  const log = counting(w);
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  const min = 60e3;
  const week = NA_WEEK;
  const t0 = w.now;
  // 1-1: 3 kills a minute up to 40 minutes back, then none, a row every minute.
  for (let m = 1; m <= 70; m++) ins.run('1-1', w.now - m * min, 500 - 3 * Math.max(0, m - 40), 10, 10, 10, week);
  // 1-2: still for four hours, a row every five minutes.
  for (let m = 5; m <= 240; m += 5) ins.run('1-2', w.now - m * min, 700, 10, 10, 10, week);
  const tick = () => {
    const score = Math.floor((w.now - week) / 100);
    return w.post('kills', { rows: [[w.now, '1-1', 500, 10, 10, 10, week, score], [w.now, '1-2', 700, 10, 10, 10, week, score]] });
  };
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
  const week = NA_WEEK;
  // 1-1 frozen since an hour back; 2-1 ticking, so the body stays fresh.
  ins.run('1-1', w.now - 59 * min, 100, 0, 0, 0, week);
  assert.equal(await w.post('kills', { rows: [[w.now, '2-1', 1, 0, 0, 0, EU_WEEK, 1]] }), 200);
  w.advance(min);
  const t0 = w.now;
  const late = [[44, 110], [40, 120], [35, 120], [31, 120]].map(([m, k]) => [t0 - m * min, '1-1', k, 0, 0, 0, week, k]);
  assert.equal(await w.post('kills', { rows: [...late, [t0, '2-1', 2, 0, 0, 0, EU_WEEK, 2]] }), 200);
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
  const week = NA_WEEK;
  const t = (m) => w.now - m * min;
  for (const [m, k] of [[60, 100], [50, 110], [40, 110], [20, 110], [10, 110]]) ins.run('1-1', t(m), k, 0, 0, 0, week);
  // As the deploy before built it: the window and its base, no move.
  const old = [40, 20, 10].map((m) => [t(m), '1-1', 110, 0, 0, 0]);
  w.sql.prepare('INSERT INTO recent (id, at, rows) VALUES (1, ?, ?)').run(t(1), JSON.stringify(old));
  assert.equal(await w.post('kills', { rows: [[w.now, '2-1', 1, 0, 0, 0, EU_WEEK, 1]] }), 200);
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
  // The NA week began 36 minutes ago.
  const week = NA_WEEK + 7 * 86400e3;
  w.advance(week + 36 * min - w.now);
  ins.run('1-1', w.now - 35 * min, 100, 0, 0, 0, week);
  assert.equal(await w.post('kills', { rows: [[w.now, '2-1', 1, 0, 0, 0, EU_WEEK + 7 * 86400e3, 1]] }), 200);
  w.advance(min);
  const t0 = w.now;
  const late = [[29, 110], [21, 110]].map(([m, k]) => [t0 - m * min, '1-1', k, 0, 0, 0, week, k]);
  assert.equal(await w.post('kills', { rows: [...late, [t0, '2-1', 2, 0, 0, 0, EU_WEEK + 7 * 86400e3, 2]] }), 200);
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
  const steadyWalks = { n: 0, looked: 0 };
  const min = 60e3;
  // A Friday night: the EU week is 5 hours old, and the NA reset falls 3 hours into every sequence.
  const t0 = Date.parse('2026-10-02T23:00:00Z');
  const NA_NEW = Date.parse('2026-10-03T02:00:00Z');
  // A database whose statements are prepared once: the same SQL, faster. `stat` counts the walks and,
  // as `looked`, the lookups of a late move's base: the one read of a row at or before a time that a
  // rebuild makes ahead of its walk.
  const quick = (stat) => {
    const { sql } = fakeD1();
    const cache = new Map();
    const prep = (q) => cache.get(q) || cache.set(q, sql.prepare(q)).get(q);
    class Statement {
      constructor(q) { this.q = q; this.args = []; }
      bind(...args) { this.args = args; return this; }
      async run() { return { meta: { changes: Number(prep(this.q).run(...this.args).changes) } }; }
      async all() {
        if (stat && WALK.test(this.q)) { stat.n++; walked = true; }
        else if (stat && !walked && /^WITH a\(m, t, op\)/.test(this.q) && this.args[0].includes('"le"')) stat.looked++;
        return { results: prep(this.q).all(...this.args) };
      }
      // A rebuild begins by reading the last body.
      async first() { walked = false; return prep(this.q).get(...this.args) ?? null; }
    }
    let walked = false;
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
  for (const seed of seeds) {
    const rnd = mulberry32(seed);
    const pick = (a, b) => a + Math.floor(rnd() * (b - a + 1));
    const ids = rnd() < 0.5 ? ['1-1'] : ['1-1', '2-1'];
    const m = ids.map((id) => ({ id, start: id[0] === '1' ? NA_NEW - 7 * 86400e3 : EU_WEEK + 7 * 86400e3,
      k: [pick(0, 5000), pick(0, 3000), pick(0, 3000), pick(0, 3000)], score: pick(1000, 90000), still: 0, fight: 0, rose: false, reset: false }));
    // Rows kills.gs has not sent yet: it goes down for a while and sends them late.
    let backlog = [], gsDown = 0, gap = 0, now = t0, readers = {};
    const sends = new Map();
    const end = t0 + pick(4, 8) * 60 * min;
    while (now < end) {
      now += pick(1, 6) * min;
      for (const s of m) {
        if (s.id[0] === '1' && !s.reset && now >= NA_NEW) { s.reset = true; s.start = NA_NEW; s.k = [0, 0, 0, 0]; s.score = 0; seen.resets++; }
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
  console.log(JSON.stringify({ equivalence: { sequences: seeds.length, ticks, steadyWalks: steadyWalks.n, lookedUp: steadyWalks.looked, ...seen } }));
  if (seqs >= 50) for (const [what, n] of Object.entries(seen)) assert.ok(n > 0, `no sequence had ${what}`);
  // Rare (about one sequence in a hundred), so asked of the default seeds only.
  if (!process.env.EQUIV_SEED) assert.ok(steadyWalks.looked > 0, 'no sequence had a late move whose base is looked up');
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
  const reader = (rows) => v2Body(rows.map((r) => ({ id: r.id, start: r.start, scores: [r.score, 0, 0], kills: r.k })));

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
  const reader = (score) => v2Body([{ id: '1-1', start, scores: [score, 0, 0] }]);
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
  const msg = v2Body([{ id: '1-1', start, scores: [200, 0, 0] }]);
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
  const msg = (kills) => v2Body([{ id: '1-1', start, scores: [200, 0, 0], kills }]);
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

test('the rebuild reads kills by its key, never the whole table', async () => {
  const w = setup();
  const ins = w.sql.prepare('INSERT INTO kills (match, at, center, red, blue, green, start) VALUES (?,?,?,?,?,?,?)');
  const week = NA_WEEK;
  // Still for 40 minutes, so the first rebuild walks, the base and the move are looked up.
  for (let m = 1; m <= 70; m++) ins.run('1-1', w.now - m * 60e3, 500 - Math.max(0, m - 40), 1, 1, 1, week);
  await w.post('kills', { rows: w.rows(w.now).map((r) => (r[1] === '1-1' ? [r[0], '1-1', 500, 1, 1, 1, week, r[7]] : r)) });
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
  const start = NA_WEEK;
  for (let i = 1; i <= 14 * 288; i++) ins.run('1-1', w.now - i * 300e3, i, 0, 0, 0, start);
  ins.run('1-2', w.now - 2 * 3600e3, 99, 0, 0, 0, start);
  assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 1, 0, 0, 0, start, 1]] }), 200);
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
