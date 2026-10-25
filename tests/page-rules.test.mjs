// The page's own rules, run in Node without a browser: the scripts of site/js
// load into a node:vm (tests/page-harness.mjs) and the rules are fed bodies
// from the e2e recording (.github/e2e/recordings.json.gz), mutated by a fixed-seed PRNG (a missing
// field, null, a garbage date, a frozen body, an older body in between).
// Each test names the file holding the rule it pins down.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadPage, loadRecording, prng } from './page-harness.mjs';

const { recordedAt, matches } = loadRecording();
const MIN = 60000;
const clone = (x) => JSON.parse(JSON.stringify(x));

function fresh() {
  const page = loadPage(recordedAt);
  const call = (name, ...args) => {
    page.ctx.__args = args;
    return page.run(`${name}(...__args)`);
  };
  const set = (code, value) => { page.ctx.__v = value; page.run(`${code} = __v`); };
  return { ...page, call, set };
}

// A match body of the recording, as it would be `k` steps further into the
// week: kills, deaths and scores only grow (the invariant matchIsBehind uses).
function state(base, k) {
  const m = clone(base);
  m.kills.red += 100 * k;
  m.deaths.red += 100 * k;
  m.scores.red += 50 * k;
  return m;
}
// The next week: a later start, every counter at zero.
function nextWeek(base) {
  const m = clone(base);
  const week = 7 * 24 * 60 * MIN;
  m.start_time = new Date(Date.parse(base.start_time) + week).toISOString();
  m.end_time = new Date(Date.parse(base.end_time) + week).toISOString();
  for (const f of ['kills', 'deaths', 'scores']) for (const c of Object.keys(m[f])) m[f][c] = 0;
  return m;
}
// A body with fields lost on the way: only ever drops information.
function damage(body, rnd) {
  const m = clone(body);
  switch (rnd.int(5)) {
    case 0: delete m.scores; break;
    case 1: m.scores = null; break;
    case 2: delete m.scores[rnd.pick(Object.keys(m.scores))]; break;
    case 3: m.kills = null; break;
    default: delete m.deaths; break;
  }
  return m;
}

test('matchIsBehind: a later start is never behind, an earlier one always is (js/api.js)', () => {
  const p = fresh();
  const rnd = prng(1);
  for (const base of matches) {
    const week = nextWeek(base);
    assert.equal(p.call('matchIsBehind', base, week), true);
    assert.equal(p.call('matchIsBehind', week, base), false);
    // Last week's counters, however high, lose to a new week at zero.
    assert.equal(p.call('matchIsBehind', state(base, 50), week), true);
    assert.equal(p.call('matchIsBehind', base, base), false);
    for (let i = 0; i < 20; i++) {
      const a = rnd.int(6);
      const b = rnd.int(6);
      const x = rnd() < 0.5 ? state(base, a) : damage(state(base, a), rnd);
      const y = state(base, b);
      assert.ok(!(p.call('matchIsBehind', x, y) && p.call('matchIsBehind', y, x)), 'both ways behind');
    }
  }
});

test('matchIsBehind: inside one week, fewer kills or lower scores are behind (js/api.js)', () => {
  const p = fresh();
  for (const base of matches) {
    for (let i = 0; i < 5; i++) {
      assert.equal(p.call('matchIsBehind', state(base, i), state(base, i + 1)), true);
      assert.equal(p.call('matchIsBehind', state(base, i + 1), state(base, i)), false);
    }
    const lower = clone(base);
    lower.scores.blue -= 1;
    assert.equal(p.call('matchIsBehind', lower, base), true, 'same kills, lower score');
    assert.equal(p.call('matchIsBehind', base, lower), false);
  }
});

test('matchIsBehind: an unreadable start_time is taken, never judged (js/api.js)', () => {
  const p = fresh();
  const base = matches[0];
  for (const bad of [undefined, null, 'garbage', '', NaN]) {
    const broken = clone(base);
    if (bad === undefined) delete broken.start_time; else broken.start_time = bad;
    assert.equal(p.call('matchIsBehind', broken, base), false);
    assert.equal(p.call('matchIsBehind', base, broken), false);
  }
});

test('keepNewestMatch: the kept body never walks backwards (js/api.js)', () => {
  const rnd = prng(2);
  for (const base of matches.slice(0, 4)) {
    const p = fresh();
    const bodies = [0, 1, 2, 3, 4, 5].map((k) => state(base, k));
    bodies.push(nextWeek(base));
    let top = -1;
    for (let step = 0; step < 40; step++) {
      p.clock.now += 20000;
      // The first offer is a real body; after that stale and damaged ones are interleaved.
      let idx = step === 0 ? 0 : rnd.int(bodies.length);
      if (idx === bodies.length - 1 && rnd() < 0.8) idx = rnd.int(bodies.length - 1);
      let offered = bodies[idx];
      if (idx < top && rnd() < 0.4) offered = damage(offered, rnd);
      top = Math.max(top, idx);
      assert.equal(p.call('keepNewestMatch', offered), bodies[top], `step ${step}: offered ${idx}, top ${top}`);
    }
  }
});

test('keepNewestMatch: what is not a match passes through; a frozen body keeps its time (js/api.js)', () => {
  const p = fresh();
  for (const junk of [null, undefined, 5, {}, { id: 7 }]) {
    assert.equal(p.call('keepNewestMatch', junk), junk);
  }
  const m = matches[0];
  p.call('keepNewestMatch', m);
  assert.equal(p.call('matchScoreRoseAt', m.id), recordedAt);
  p.clock.now += 10 * MIN;
  p.call('keepNewestMatch', m);
  assert.equal(p.call('matchScoreRoseAt', m.id), recordedAt, 'the same body again is not news');
  p.call('keepNewestMatch', state(m, 1));
  assert.equal(p.call('matchScoreRoseAt', m.id), p.clock.now, 'a higher score is');
});

test('keepNewestMatch: a rise after a gap is not watched, and its burst shares the gap (js/api.js)', () => {
  const p = fresh();
  const m = matches[0];
  const entry = () => p.run(`newestMatches.get(${JSON.stringify(m.id)})`);
  p.call('keepNewestMatch', m);
  p.clock.now += 30000;
  p.call('keepNewestMatch', state(m, 1));
  assert.equal(entry().rose, true, 'a rise after a normal poll is watched');
  const before = p.clock.now;
  p.clock.now += 30 * MIN;
  p.call('keepNewestMatch', state(m, 2));
  assert.equal(entry().rose, false, 'a rise after a gap is a first sight again, though one was watched before');
  assert.equal(entry().gapFrom, before);
  p.clock.now += 200;
  p.call('keepNewestMatch', state(m, 3));
  assert.equal(entry().rose, false, 'the next body of the same burst');
  assert.equal(entry().gapFrom, before, 'keeps the gap');
  p.clock.now += 30000;
  p.call('keepNewestMatch', state(m, 4));
  assert.equal(entry().rose, true, 'a rise after a normal poll is watched again');
  assert.equal(entry().gapFrom, undefined);
});

test('keepNewestMatch: an answer that does not move the data still ends the gap for the rise after it (js/api.js)', () => {
  // A read asked before a sleep can land after it, ahead of the game's new
  // answer (/api/latest, mergeLatest's late offer): seen under load in time.spec.mjs.
  for (const [what, late] of [['the same body', 1], ['an older body', 0]]) {
    const p = fresh();
    const m = matches[0];
    const entry = () => p.run(`newestMatches.get(${JSON.stringify(m.id)})`);
    p.call('keepNewestMatch', m);
    p.clock.now += 30000;
    p.call('keepNewestMatch', state(m, 1));
    const before = p.clock.now;
    p.clock.now += 30 * MIN;
    p.call('keepNewestMatch', state(m, late));
    p.clock.now += 117;
    p.call('keepNewestMatch', state(m, 2));
    assert.equal(entry().rose, false, `${what} first: the rise is still a first sight`);
    assert.equal(entry().gapFrom, before, `${what} first: the gap runs from the last answer before it`);
  }
});

// A live match whose four maps carry `perType` kills (all on the red side).
function liveWith(base, perType) {
  const m = clone(base);
  for (const map of m.maps) {
    map.kills = { red: perType[map.type] || 0, blue: 0, green: 0 };
  }
  return m;
}
const TYPES = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];
function sheetOf(p, id, rows) {
  p.set('killSheet', new Map([[id, rows]]));
}

test('ageBehindHistory: a body behind the history is dated by the oldest line ahead of it, not the newest (js/api.js)', () => {
  const p = loadPage(recordedAt);
  const m = matches[0];
  p.ctx.__m = m; p.run('keepNewestMatch(__m)');
  const now = p.clock.now;
  const t = p.run('fightTotals(__m)');
  const shift = (d) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v + d]));
  const datedBy = (lines) => {
    p.ctx.__by = new Map([[m.id, lines]]);
    p.run(`newestMatches.get(${JSON.stringify(m.id)}).at = ${now}`);
    p.run('ageBehindHistory(__by, fightTotals)');
    return (now - p.run(`newestMatches.get(${JSON.stringify(m.id)}).at`)) / MIN;
  };
  assert.equal(datedBy([{ at: now - 40 * MIN, n: shift(5) }, { at: now - 2 * MIN, n: shift(5) }]), 40);
  // A line equal to the body, or behind it, is no proof of anything.
  assert.equal(datedBy([{ at: now - 60 * MIN, n: shift(0) }, { at: now - 50 * MIN, n: shift(-3) },
    { at: now - 40 * MIN, n: shift(5) }, { at: now - 2 * MIN, n: shift(5) }]), 40);
  // A line of the week before, ahead of the body, is not of this week.
  assert.equal(datedBy([{ at: Date.parse(m.start_time) - 10 * MIN, n: shift(9) },
    { at: now - 40 * MIN, n: shift(5) }, { at: now - 2 * MIN, n: shift(5) }]), 40);
});

test('killView: a fight lights the swords; a stopped or silent body does not (js/maps.js)', () => {
  const p = fresh();
  const base = matches[0];
  const now = p.clock.now;
  const rows = [10, 5, 0].map((back) => ({
    at: now - back * MIN,
    n: { Center: 1000 - back * 12, RedHome: 10, BlueHome: 10, GreenHome: 10 },
  }));
  sheetOf(p, base.id, rows);
  const m = liveWith(base, { Center: 1000, RedHome: 10, BlueHome: 10, GreenHome: 10 });
  p.call('keepNewestMatch', m);
  const busy = p.call('killView', m, TYPES);
  assert.equal(busy.hot, 'Center');
  assert.equal(busy.frozen, false);
  assert.equal(busy.clock, now);
  // The same body, nothing offered for seven minutes: the score is frozen.
  p.clock.now += 7 * MIN;
  const frozen = p.call('killView', m, TYPES, p.clock.now);
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.hot, null);
  // A match that is over is neutral, whatever the history says.
  const over = clone(m);
  over.end_time = new Date(now - MIN).toISOString();
  const none = p.call('killView', over, TYPES, p.clock.now);
  assert.equal(none.hot, null);
  assert.equal(none.rates, null);
  assert.equal(none.clock, 0);
});

test('killView: alive only when this page saw the score rise within 3 minutes (js/maps.js)', () => {
  const p = fresh();
  const base = matches[0];
  const body = { Center: 1000, RedHome: 10, BlueHome: 10, GreenHome: 10 };
  sheetOf(p, base.id, [{ at: p.clock.now, n: body }]);
  const m = liveWith(base, body);
  p.call('keepNewestMatch', m);
  assert.equal(p.call('killView', m, TYPES, p.clock.now).alive, false, 'a first sight, no rise watched');
  p.clock.now += MIN;
  const up = clone(m);
  up.scores.red = (Number(up.scores.red) || 0) + 1;
  p.call('keepNewestMatch', up);
  assert.equal(p.call('killView', up, TYPES, p.clock.now).alive, true, 'the score just rose');
  assert.equal(p.call('killView', up, TYPES, p.clock.now + 2 * MIN).alive, true, 'rose 2 min ago');
  assert.equal(p.call('killView', up, TYPES, p.clock.now + 4 * MIN).alive, false, 'rose 4 min ago');
});

test('killView: a catch-up step after a long stall lights nothing (js/maps.js)', () => {
  const p = fresh();
  const base = matches[1];
  const now = p.clock.now;
  sheetOf(p, base.id, [
    { at: now - 60 * MIN, n: { Center: 100, RedHome: 0, BlueHome: 0, GreenHome: 0 } },
    { at: now - 59 * MIN, n: { Center: 100, RedHome: 0, BlueHome: 0, GreenHome: 0 } },
    { at: now, n: { Center: 900, RedHome: 0, BlueHome: 0, GreenHome: 0 } },
  ]);
  const m = liveWith(base, { Center: 900 });
  p.call('keepNewestMatch', m);
  assert.equal(p.call('killView', m, TYPES).hot, null);
});

test('matchIsLive: only a readable end_time in the future is live (js/config.js)', () => {
  const p = fresh();
  const now = p.clock.now;
  const live = (end) => p.call('matchIsLive', { end_time: end });
  assert.equal(live(new Date(now + MIN).toISOString()), true);
  assert.equal(live(new Date(now + 1).toISOString()), true);
  assert.equal(live(new Date(now).toISOString()), false, 'ending this very moment is over');
  assert.equal(live(new Date(now - MIN).toISOString()), false);
  for (const bad of ['garbage', '', null, undefined, 'NaN', {}, [], '2026-13-45T99:00:00Z']) {
    assert.equal(live(bad), false, `end_time ${JSON.stringify(bad)} is not live`);
  }
  for (const body of [null, undefined, {}, 'x', 5]) assert.equal(p.call('matchIsLive', body), false);
});

test('killView: a match whose end_time cannot be read is neutral, like one that is over (js/maps.js)', () => {
  const p = fresh();
  const base = matches[0];
  const now = p.clock.now;
  sheetOf(p, base.id, [10, 5, 0].map((back) => ({
    at: now - back * MIN, n: { Center: 1000 - back * 12, RedHome: 10, BlueHome: 10, GreenHome: 10 } })));
  for (const bad of ['garbage', null, undefined, '']) {
    const m = liveWith(base, { Center: 1000, RedHome: 10, BlueHome: 10, GreenHome: 10 });
    if (bad === undefined) delete m.end_time; else m.end_time = bad;
    p.call('keepNewestMatch', m);
    const v = p.call('killView', m, TYPES);
    assert.equal(v.hot, null, `end_time ${JSON.stringify(bad)} lit the swords`);
    assert.equal(v.rates, null);
    assert.equal(v.clock, 0);
  }
});

// The week memory, driven through weekStoreOffer: what it keeps of a tier is read back.
function weekBody(base, id, startAt, endAt) {
  const m = clone(base);
  m.id = id;
  m.start_time = new Date(startAt).toISOString();
  m.end_time = new Date(endAt).toISOString();
  return m;
}
const stored = (p, id) => {
  const v = p.run(`weekStoreRead().get(${JSON.stringify(id)})`);
  return v ? { s: v.s, e: v.e } : null;
};

test('weekStoreOffer: a body of an earlier week does not erase a later one for two hours from its start (js/api.js)', () => {
  const HOLD = 2 * 60 * MIN;
  const day = 24 * 60 * MIN;
  for (const [after, kept] of [[-30 * MIN, true], [0, true], [HOLD - 1, true], [HOLD, false], [HOLD + MIN, false]]) {
    const p = fresh();
    const newStart = p.clock.now - after;   // `after` past the later week's start (negative: not begun yet)
    const fresher = weekBody(matches[0], '1-1', newStart, newStart + 7 * day);
    const older = weekBody(matches[0], '1-1', newStart - 7 * day, newStart + 12 * 60 * MIN);
    p.call('weekStoreOffer', fresher);
    assert.equal(stored(p, '1-1').s, newStart, `the later week is written (${after} ms in)`);
    p.call('weekStoreOffer', older);
    const had = stored(p, '1-1');
    assert.equal(had.s, kept ? newStart : newStart - 7 * day,
      `${after} ms after the later week began: the older body ${kept ? 'must not overwrite' : 'is allowed to overwrite'} it`);
  }
});

test('weekStoreOffer: a later week always replaces an earlier one; an earlier body wins once the later week is old (js/api.js)', () => {
  const day = 24 * 60 * MIN;
  const p = fresh();
  const t = p.clock.now;
  const a = weekBody(matches[0], '1-2', t - 3 * day, t + 4 * day);
  const b = weekBody(matches[0], '1-2', t - day, t + 6 * day);
  p.call('weekStoreOffer', a);
  assert.equal(stored(p, '1-2').s, t - 3 * day);
  p.call('weekStoreOffer', b);
  assert.equal(stored(p, '1-2').s, t - day, 'a later start replaces, however long ago the earlier began');
  p.call('weekStoreOffer', a);
  assert.equal(stored(p, '1-2').s, t - 3 * day, 'the memory of a week begun a day ago no longer holds against an earlier body');
});

test('fightSamples: a reading older than three hours, or from before the match began, is no baseline (js/maps.js)', () => {
  const day = 24 * 60 * MIN;
  const row = (at) => ({ at, n: { Center: 100, RedHome: 0, BlueHome: 0, GreenHome: 0 } });
  const run = (rows, startBack = 6 * day) => {
    const p = fresh();
    const now = p.clock.now;
    const base = matches[2];
    const m = liveWith(base, { Center: 400 });
    m.start_time = new Date(now - startBack).toISOString();
    m.end_time = new Date(now + day).toISOString();
    sheetOf(p, base.id, rows.map((back) => row(now - back)));
    p.call('keepNewestMatch', m);
    return p.call('killView', m, TYPES);
  };
  // Only readings from three days back, and nothing recent: no window, no rates, no swords.
  const old = run([3 * day + 10 * MIN, 3 * day + 5 * MIN, 3 * day]);
  assert.equal(old.hot, null);
  assert.equal(old.rates, null, 'a rate was measured off readings three days old');
  assert.equal(old.noWindow, 'data');
  assert.equal(run([4 * 60 * MIN]).rates, null, 'a reading four hours old');
  assert.notEqual(run([3 * 60 * MIN - MIN]).rates, null, 'a reading just under three hours old is a baseline');
  assert.equal(run([3 * 60 * MIN + MIN]).rates, null, 'a reading just over three hours old is not');
  // Kills restart at the reset: a line from before this match began is last week's.
  assert.equal(run([2 * 60 * MIN], 60 * MIN).rates, null, 'a reading from before the match began');
  assert.notEqual(run([30 * MIN], 60 * MIN).rates, null, 'a reading after it began');
});

// A fight at `perMin` kills per minute on one map that stopped `stopped` ms ago, the score of the
// match still being offered every 30 s, so the body is not the frozen one.
function stoppedFight(perMin, stopped) {
  const p = fresh();
  const base = matches[1];
  const now = p.clock.now;
  const top = 1000;
  const rows = [];
  for (let back = stopped + 20 * MIN; back >= stopped; back -= 5 * MIN) {
    rows.push({ at: now - back, n: { Center: top - Math.round(perMin * (back - stopped) / MIN), RedHome: 0, BlueHome: 0, GreenHome: 0 } });
  }
  sheetOf(p, base.id, rows);
  const m = liveWith(base, { Center: top });
  const start = now - 30 * MIN;
  for (let t = start, i = 0; t <= now; t += 30000, i++) {
    p.clock.now = t;
    const step = clone(m);
    step.scores.red += i;
    p.call('keepNewestMatch', step);
  }
  p.clock.now = now;
  return p.call('killView', m, TYPES, now);
}

test('killView: a fight that stops puts the swords out between the 5.5-minute quiet and 10 minutes, whatever the score does (js/maps.js)', () => {
  // The silence the kills may keep is 5.5 min plus the time to make 15 kills at the fight's own pace.
  for (const pace of [5, 8, 12]) {
    const limit = 5.5 * MIN + (15 / pace) * MIN;
    const early = stoppedFight(pace, Math.floor(limit - 30000));
    assert.equal(early.frozen, false, 'the score was still offered');
    assert.equal(early.hot, 'Center', `pace ${pace}: swords must stay ${Math.round((limit - 30000) / 1000)} s into the silence`);
    const late = stoppedFight(pace, Math.ceil(limit + 30000));
    assert.equal(late.frozen, false);
    assert.equal(late.hot, null, `pace ${pace}: swords must be out ${Math.round((limit + 30000) / 1000)} s into the silence`);
  }
  for (const stopped of [10 * MIN + 1000, 12 * MIN, 14 * MIN, 15 * MIN]) {
    const v = stoppedFight(5, stopped);
    assert.equal(v.hot, null, `${stopped / MIN} min of silence`);
    assert.equal(v.frozen, false);
  }
});

// Kills flat at 100 for `prevRun`, then the body jumps by `jump` all at once on the one map.
function catchUp(prevRun, jump) {
  const p = fresh();
  const base = matches[3];
  const now = p.clock.now;
  const flat = { Center: 100, RedHome: 0, BlueHome: 0, GreenHome: 0 };
  const rows = [{ at: now - prevRun, n: flat }];
  if (prevRun > 10 * MIN) rows.push({ at: now - 10 * MIN, n: flat });
  sheetOf(p, base.id, rows);
  const m = liveWith(base, { Center: 100 + jump });
  p.call('keepNewestMatch', m);
  return p.call('killView', m, TYPES);
}

test('killView: a jump after a stall of 10-20 minutes counts spread over the stall; under 10 whole, over 20 not at all (js/maps.js)', () => {
  // Up to 10 min of still kills is no stall: the jump counts whole.
  assert.equal(catchUp(9 * MIN, 55).hot, 'Center');
  assert.equal(catchUp(10 * MIN, 55).hot, 'Center', 'exactly 10 min is not a catch-up');
  assert.equal(catchUp(9 * MIN, 40).hot, null, 'below the floor whole');
  // 10-20 min: the kills are spread over the stall, so a small jump falls below the floor...
  assert.equal(catchUp(15 * MIN, 60).hot, null, '60 kills over 15 min are 40 per 10');
  assert.equal(catchUp(11 * MIN, 54).hot, null, '54 over 11 min are 49 per 10');
  // ...and a big one still lights it.
  assert.equal(catchUp(15 * MIN, 80).hot, 'Center', '80 over 15 min are 53 per 10');
  assert.equal(catchUp(11 * MIN, 56).hot, 'Center', '56 over 11 min are 51 per 10');
  assert.equal(catchUp(20 * MIN, 100).hot, 'Center', 'exactly 20 min still counts');
  assert.equal(catchUp(20 * MIN, 90).hot, null, '90 over 20 min are 45 per 10');
  // Past 20 min the step is the source catching up, however big.
  assert.equal(catchUp(20 * MIN + 1000, 5000).hot, null);
  assert.equal(catchUp(60 * MIN, 5000).hot, null);
});

test('killView: invariants hold on mutated bodies and histories (js/maps.js)', () => {
  const rnd = prng(3);
  let hot = 0;
  let cold = 0;
  for (let i = 0; i < 120; i++) {
    const p = fresh();
    const base = matches[rnd.int(matches.length)];
    const now = recordedAt;
    // A history every five minutes, each map at its own pace, some stops.
    const per = Object.fromEntries(TYPES.map((t) => [t, rnd() < 0.3 ? 0 : rnd.int(40)]));
    const total = Object.fromEntries(TYPES.map((t) => [t, rnd.int(5000)]));
    const rows = [];
    const upto = rnd.int(4);
    for (let back = 60; back >= upto * 5; back -= 5) {
      rows.push({ at: now - back * MIN, n: { ...total } });
      for (const t of TYPES) total[t] += per[t] * 5 * (rnd() < 0.1 ? 0 : 1);
    }
    sheetOf(p, base.id, rows);
    const m = liveWith(base, total);
    // Mutations: a map with no kills, one with null, a start that is not a date.
    if (rnd() < 0.2) m.maps[rnd.int(m.maps.length)].kills = null;
    if (rnd() < 0.2) delete m.maps[rnd.int(m.maps.length)].kills;
    if (rnd() < 0.15) m.start_time = 'garbage';
    // The body was last offered a random time ago: fresh, or frozen.
    const offeredAgo = rnd.pick([0, 2, 5, 9, 30]) * MIN;
    p.clock.now = now - offeredAgo;
    p.call('keepNewestMatch', m);
    p.clock.now = now;
    const v = p.call('killView', m, undefined, now);
    assert.ok(v.silence >= 0 && Number.isFinite(v.silence));
    assert.ok(v.pace >= 0);
    assert.ok(v.clock <= now, 'the clock is never in the future');
    if (v.rates) assert.ok(v.rates.span >= 8 * MIN);
    if (v.hot !== null) {
      hot++;
      assert.ok(v.rates && !v.strange && !v.frozen && v.silence <= 10 * MIN);
      assert.ok(TYPES.includes(v.hot));
      assert.ok(v.rates.per.get(v.hot) >= 50, 'below the floor of a real fight');
    } else cold++;
    if (offeredAgo > 6 * MIN) assert.equal(v.frozen, true);
    if (v.frozen) assert.equal(v.hot, null);
  }
  assert.ok(hot > 5 && cold > 5, `the generator must reach both sides (hot ${hot}, cold ${cold})`);
});

// The match with `k` objectives flipped to another owner, and which ones.
function flipSome(base, rnd, k) {
  const after = clone(base);
  const all = after.maps.flatMap((map) => map.objectives.map((o) => ({ map, o })));
  const chosen = new Set();
  while (chosen.size < k) chosen.add(rnd.int(all.length));
  const flipped = [];
  for (const i of chosen) {
    const { map, o } = all[i];
    o.owner = rnd.pick(['Red', 'Blue', 'Green'].filter((c) => c !== o.owner));
    if (o.type !== 'Ruins' && o.type !== 'Spawn') flipped.push({ id: o.id, map: map.type, to: o.owner.toLowerCase() });
  }
  return { after, flipped };
}

test('missedOwnerChanges: lists exactly the objectives that changed hands (js/maps.js)', () => {
  const p = fresh();
  const rnd = prng(4);
  for (const base of matches) {
    assert.equal(p.call('missedOwnerChanges', base, clone(base)).length, 0);
    for (let i = 0; i < 6; i++) {
      const { after, flipped } = flipSome(base, rnd, 1 + rnd.int(12));
      const got = p.call('missedOwnerChanges', base, after);
      assert.deepEqual(Array.from(got, (c) => c.id).sort(), flipped.map((c) => c.id).sort());
      for (const c of got) {
        const want = flipped.find((f) => f.id === c.id);
        assert.equal(c.to, want.to);
        assert.equal(c.map, want.map);
        assert.notEqual(c.from, c.to);
      }
    }
  }
});

test('missedOwnerChanges: a lost field or a case change is no change, and nothing throws (js/maps.js)', () => {
  const p = fresh();
  const rnd = prng(5);
  const base = matches[0];
  const same = clone(base);
  for (const map of same.maps) for (const o of map.objectives) o.owner = String(o.owner).toUpperCase();
  assert.equal(p.call('missedOwnerChanges', base, same).length, 0);
  for (let i = 0; i < 40; i++) {
    const { after, flipped } = flipSome(base, rnd, 1 + rnd.int(8));
    const map = after.maps[rnd.int(after.maps.length)];
    switch (rnd.int(5)) {
      case 0: delete map.objectives; break;
      case 1: map.objectives = null; break;
      case 2: map.objectives[rnd.int(map.objectives.length)] = null; break;
      case 3: after.maps[rnd.int(after.maps.length)] = null; break;
      default: delete after.maps; break;
    }
    const got = p.call('missedOwnerChanges', base, after);
    const ids = new Set(flipped.map((f) => f.id));
    for (const c of got) assert.ok(ids.has(c.id), `${c.id} never flipped`);
  }
  assert.equal(p.call('missedOwnerChanges', null, undefined).length, 0);
});

test('missedPeriod: the period holds every listed flip (js/maps.js)', () => {
  const rnd = prng(6);
  let older = 0;
  for (let i = 0; i < 80; i++) {
    const p = fresh();
    const base = matches[rnd.int(matches.length)];
    const now = recordedAt;
    const since = now - (5 + rnd.int(40)) * MIN;
    const { after, flipped } = flipSome(base, rnd, 1 + rnd.int(6));
    // Times the game gave the flips: before the gap, inside it, after the body,
    // or not a date at all.
    const times = new Map();
    for (const map of after.maps) {
      for (const o of map.objectives) {
        if (!flipped.some((f) => f.id === o.id)) continue;
        const t = rnd.pick([-50, -20, -8, -3, 5]) * MIN;
        const text = rnd() < 0.1 ? 'garbage' : new Date(since + t).toISOString();
        o.last_flipped = text;
        times.set(o.id, Date.parse(text));
      }
    }
    // The kills of the body before are a history row of the shared sheet.
    const need = rnd.int(3000);
    const beforeBody = liveWith(base, { Center: need });
    const afterBody = liveWith(after, { Center: need + rnd.int(600) });
    afterBody.id = beforeBody.id;
    sheetOf(p, base.id, [-40, -30, -20, -10, 0].map((at, j) => ({
      at: since + at * MIN, n: { Center: need + j * 100, RedHome: 0, BlueHome: 0, GreenHome: 0 },
    })));
    const changes = p.call('missedOwnerChanges', base, after);
    const back = now;
    const period = p.call('missedPeriod', beforeBody, afterBody, since, back, changes);
    assert.ok(period.start <= since, 'never later than the page\'s own since');
    assert.ok(period.end <= back && period.start <= period.end);
    for (const c of changes) {
      if (!Number.isFinite(c.flipped) || c.flipped > back) continue;
      assert.ok(period.start <= c.flipped && c.flipped <= period.end,
        `flip ${c.id} at ${c.flipped} outside ${period.start}..${period.end}`);
      if (c.flipped < since - 10 * MIN) older++;
    }
  }
  assert.ok(older > 10, 'the generator must reach flips older than the gap');
});

test('skirmishProgress: block and fraction follow the clock, and stop at end_time (js/stat-popovers.js)', () => {
  const p = fresh();
  const rnd = prng(7);
  const base = matches[0];
  const start = Date.parse(base.start_time);
  const end = Date.parse(base.end_time);
  const at = (t, m = base) => { p.clock.now = t; return p.call('skirmishProgress', m); };
  assert.equal(at(start - 1), null, 'before the start');
  assert.deepEqual({ ...at(start) }, { index: 1, fraction: 0 });
  assert.deepEqual({ ...at(start + 3 * 3600000) }, { index: 2, fraction: 0.5 });
  let prev = -1;
  for (let i = 0; i < 300; i++) {
    const t = start + rnd.int(end - start);
    const r = at(t);
    const hours = (t - start) / 3600000;
    assert.ok(r.index >= 1 && r.fraction >= 0 && r.fraction < 1);
    assert.ok(Math.abs((r.index - 1) * 2 + r.fraction * 2 - hours) < 1e-9);
    const here = (r.index - 1) + r.fraction;
    const later = at(t + 1000);
    assert.ok((later.index - 1) + later.fraction >= here, 'the clock never runs backwards');
    prev = here;
  }
  assert.ok(prev >= 0);
  // A week over: the clock stops at end_time.
  const last = at(end);
  assert.deepEqual({ ...at(end + 5 * 24 * 3600000) }, { ...last });
  // An end that is not a date is ignored; a start that is not a date is no answer.
  const noEnd = clone(base);
  noEnd.end_time = 'garbage';
  assert.equal(at(start + 3600000, noEnd).index, 1);
  for (const bad of [undefined, null, 'garbage']) {
    const broken = clone(base);
    if (bad === undefined) delete broken.start_time; else broken.start_time = bad;
    assert.equal(at(start + 3600000, broken), null);
  }
});

test('runPeek: a show during the peek leaves one pending timer, not two (js/standings.js)', async () => {
  const page = fresh();
  const pending = new Set();
  let nextId = 1;
  page.ctx.setTimeout = () => { const id = nextId++; pending.add(id); return id; };
  page.ctx.clearTimeout = (id) => { pending.delete(id); };
  page.ctx.document = { visibilityState: 'visible' };
  let release;
  const gate = new Promise((r) => { release = r; });
  page.ctx.__gate = gate;
  page.run('peekLatest = () => __gate');
  const running = page.run('runPeek()');
  page.run('peekSoon()');   // what the visibilitychange to visible does
  release();
  await running;
  assert.equal(pending.size, 1);
});

test('emberField: stop then start in the same frame leaves one frame chain (js/boot.js)', () => {
  const src = fs.readFileSync(new URL('../site/js/boot.js', import.meta.url), 'utf8');
  const a = src.indexOf('const emberField = (function () {');
  const b = src.indexOf('\n})();', a);
  assert.ok(a >= 0 && b > a);
  const dummy = () => {
    const f = function () { return p; };
    const p = new Proxy(f, {
      get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : p),
      apply: () => p, construct: () => p, set: () => true,
    });
    return p;
  };
  const queue = new Map();
  let nextId = 1;
  const g = {
    console, Math, Date, performance: { now: () => 0 }, document: dummy(), window: dummy(),
    requestAnimationFrame: (cb) => { const id = nextId++; queue.set(id, cb); return id; },
    cancelAnimationFrame: (id) => { queue.delete(id); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class { observe() {} },
  };
  const ctx = vm.createContext(g);
  vm.runInContext(`${src.slice(a, b + 5)}\nglobalThis.__field = emberField;`, ctx);
  const field = ctx.__field;
  queue.clear();
  field.start();
  field.stop();
  field.start();
  const due = [...queue.values()];
  queue.clear();
  for (const cb of due) cb(1000);   // one frame: each live chain asks for the next
  assert.equal(queue.size, 1);
});

test('fetchTimers: a lockout date that does not parse is no lockout (js/relink.js)', async () => {
  const page = fresh();
  page.ctx.fetchJson = async () => [{ na: 'not a date', eu: 'also not' }];
  await page.run('fetchTimers()');
  assert.equal(page.run('lockoutTime'), null);
});

test('retryAfterMs: seconds, an HTTP date, the cap, and anything unusable (js/api.js)', () => {
  const page = fresh();
  const ms = (header) => page.call('retryAfterMs', header);
  const FALLBACK = 1500, CAP = 30000;
  assert.equal(ms('7'), 7000, 'seconds');
  assert.equal(ms('2.5'), 2500, 'fractions of a second');
  assert.equal(ms('30'), CAP, 'exactly the cap');
  assert.equal(ms('3600'), CAP, 'a delay nobody sits through');
  // An HTTP date has whole seconds: the delay is the date minus the page's clock.
  const whole = Math.floor(recordedAt / 1000) * 1000;
  const at = (offset) => new Date(whole + offset).toUTCString();
  assert.equal(ms(at(12000)), whole + 12000 - recordedAt, 'an HTTP date, against the page clock');
  assert.equal(ms(at(10 * 60000)), CAP, 'a date far ahead');
  assert.equal(ms(at(-5000)), FALLBACK, 'a date in the past');
  for (const bad of [null, undefined, '', ' ', '0', '-3', 'soon', 'Infinity', 'NaN', '1e999', 'Thu, 99 Foo 2026']) {
    assert.equal(ms(bad), FALLBACK, `${JSON.stringify(bad)} is no delay`);
  }
});

test('missedSpan: a suffix shared by both times is written once, different ones twice, none in 24 h (js/maps.js)', () => {
  const page = fresh();
  // The clock face is the test's: the time is the number of minutes, written
  // the way each locale writes it, so the machine's locale decides nothing.
  const face = (kind) => `Date.prototype.toLocaleTimeString = function () {
    const m = Math.floor(this.getTime() / 60000) % 1440, h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0');
    if (${JSON.stringify(kind)} === '24') return String(h).padStart(2, '0') + ':' + mm;
    return String(h % 12 || 12).padStart(2, '0') + ':' + mm + (h < 12 ? ' AM' : ' PM');
  }`;
  const at = (h, m) => (h * 60 + m) * MIN;
  const span = (a, b) => page.call('missedSpan', a, b);
  page.run(face('12'));
  assert.equal(span(at(17, 3), at(17, 33)), '05:03–05:33 PM', 'both PM');
  assert.equal(span(at(9, 3), at(9, 33)), '09:03–09:33 AM', 'both AM');
  assert.equal(span(at(11, 50), at(12, 10)), '11:50 AM–12:10 PM', 'AM to PM');
  assert.equal(span(at(23, 50), at(0, 10)), '11:50 PM–12:10 AM', 'PM to AM');
  page.run(face('24'));
  assert.equal(span(at(17, 3), at(17, 33)), '17:03–17:33', '24 h, no suffix');
});

test('missedShortName: the chip name of an objective (js/maps.js)', () => {
  const page = fresh();
  const named = (name) => {
    page.set('objectiveCatalogue', new Map([['1-1', { name }]]));
    return page.call('missedShortName', '1-1');
  };
  assert.equal(named('Stonemist Castle'), 'SM');
  assert.equal(named('Overgrown Fairground Bay'), 'Bay');
  assert.equal(named("Wildcreek Hills"), 'Hills');
  assert.equal(named('Garrison'), 'Garrison');
  assert.equal(named('Short Name'), 'Short Name', 'twelve characters or fewer stay whole');
  assert.equal(named('Temple of Lost Prayers'), 'Temple of', 'Temple keeps two words');
  assert.equal(named('The Godsword Fortress Keep'), 'The Godsword', 'The keeps two words');
  assert.equal(named('Rampart Bridgehead Outpost'), 'Rampart', 'otherwise the first word');
  page.set('objectiveCatalogue', new Map());
  assert.equal(page.call('missedShortName', '9-9'), '9-9', 'an id the catalogue lacks stands for itself');
});

test('hasWaypoint: a keep held by its spawn team has one at tier 0; any other needs the upgrade (js/maps.js)', () => {
  const p = fresh();
  const keep = (id, owner) => ({ id, type: 'Keep', owner });
  const built = { tier: 3, tiers: [{ upgrades: [] }, { upgrades: [{ name: 'Build Waypoint' }] }, { upgrades: [] }] };
  const bare = { tier: 0, tiers: [] };
  const has = (ob, info) => p.call('hasWaypoint', ob, info);
  assert.equal(has(keep('1099-106', 'Green'), bare), true);
  assert.equal(has(keep('95-33', 'Green'), bare), false);
  assert.equal(has(keep('95-32', 'Green'), bare), false);
  assert.equal(has(keep('95-37', 'Green'), bare), true);
  assert.equal(has(keep('96-33', 'Blue'), built), true);
  assert.equal(has(keep('96-33', 'Blue'), bare), false);
  assert.equal(has(keep('38-9', 'Red'), bare), false);
});

test('KEEP_SPAWN_TEAM: every borderland and EBG keep of the recording has an entry (js/maps.js)', () => {
  const p = fresh();
  const table = p.run('KEEP_SPAWN_TEAM');
  const missing = new Set();
  for (const m of matches) {
    for (const mp of m.maps) {
      for (const o of mp.objectives) {
        if (o.type === 'Keep' && !(o.id in table)) missing.add(o.id);
      }
    }
  }
  assert.deepEqual([...missing], []);
});
