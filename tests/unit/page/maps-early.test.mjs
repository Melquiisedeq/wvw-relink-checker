// The page's rules in js/maps-early.js, run in Node without a browser: the scripts load into a node:vm and the rules are fed
// bodies from the e2e recording, mutated by a fixed-seed PRNG where a test says so (page/harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedAt, matches, prng, MIN, clone, fresh, state, openMatch, OPEN_ID, stepOf, FLIP_TO, happened } from './harness.mjs';

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

test('killView: a fight lights the swords; a stopped or silent body does not (js/maps-early.js)', () => {
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

test('killView: alive only when this page saw the score rise within 3 minutes (js/maps-early.js)', () => {
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

test('killView: a catch-up step after a long stall lights nothing (js/maps-early.js)', () => {
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

test('killView: a match whose end_time cannot be read is neutral, like one that is over (js/maps-early.js)', () => {
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

test('fightSamples: a reading older than three hours, or from before the match began, is no baseline (js/maps-early.js)', () => {
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

test('killView: a fight that stops puts the swords out past one kill step plus 15 kills at its pace, or at 10 minutes (7 under 75 per 10), whichever comes first, whatever the score does (js/maps-early.js)', () => {
  // The silence the kills may keep: KILLS_STEP_MS plus the time to make KILLS_LATE_KILLS at the
  // fight's own pace (view.strange), cut at HOT_WANT_MS, or HOT_SMALL_WANT_MS under HOT_BIG.
  // At 30 a minute the first comes first.
  const p = fresh();
  const step = p.run('KILLS_STEP_MS'), kills = p.run('KILLS_LATE_KILLS'), want = p.run('HOT_WANT_MS');
  const small = p.run('HOT_SMALL_WANT_MS'), big = p.run('HOT_BIG');
  assert.equal(small, 7 * MIN);
  assert.equal(big, 75);
  for (const pace of [5, 7, 7.5, 8, 12, 30]) {
    const limit = Math.min(step + (kills / pace) * MIN, pace * 10 < big ? small : want);
    if (pace === 30) assert.ok(limit < want, 'at 30 a minute the late-kills rule, not the window, puts them out');
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

test('killView: a jump after a stall of 10-20 minutes counts spread over the stall; under 10 whole, over 20 not at all (js/maps-early.js)', () => {
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

// catchUp's jump, then `quiet` of still kills, the score of the match still offered every 30 s.
function quietCatchUp(prevRun, jump, quiet) {
  const p = fresh();
  const base = matches[3];
  const now = p.clock.now;
  const at = now - quiet;
  const flat = { Center: 100, RedHome: 0, BlueHome: 0, GreenHome: 0 };
  const rows = [{ at: at - prevRun, n: flat }];
  if (prevRun > 10 * MIN) rows.push({ at: at - 10 * MIN, n: flat });
  rows.push({ at, n: { ...flat, Center: 100 + jump } });
  sheetOf(p, base.id, rows);
  const m = liveWith(base, { Center: 100 + jump });
  for (let t = now - 30 * MIN, i = 0; t <= now; t += 30000, i++) {
    p.clock.now = t;
    const step = clone(m);
    step.scores.red += i;
    p.call('keepNewestMatch', step);
  }
  p.clock.now = now;
  return p.call('killView', m, TYPES, now);
}

test('killView: a jump spread under 75 per 10 keeps its swords 7 min of silence, and the stall is named only when it alone kept them off (js/maps-early.js)', () => {
  // 70 over a stall of 11 min are 64 per 10.
  assert.equal(quietCatchUp(11 * MIN, 70, 6 * MIN).hot, 'Center', '64 per 10 at 6 min of silence');
  const small = quietCatchUp(11 * MIN, 70, 8 * MIN);
  assert.equal(small.hot, null, '64 per 10 at 8 min of silence');
  assert.equal(small.frozen, false);
  assert.equal(small.jumpHeld, false, '70 whole would be out at 8 min too');
  // 80 over a stall of 15 min are 53 per 10; whole, 80 would hold them to 10 min.
  const held = quietCatchUp(15 * MIN, 80, 8 * MIN);
  assert.equal(held.hot, null, '53 per 10 at 8 min of silence');
  assert.equal(held.jumpHeld, true, '80 whole would still light them at 8 min');
});

test('killView: jumpHeld is set only when the stall, not the pace, kept the swords off (js/maps-early.js)', () => {
  const big = catchUp(25 * MIN, 155);
  assert.equal(big.long, false);
  assert.equal(big.hot, null);
  assert.equal(big.jumpHeld, true, 'a big jump after more than 20 min still');
  const on = catchUp(15 * MIN, 155);
  assert.equal(on.hot, 'Center');
  assert.equal(on.jumpHeld, false, 'the swords are on');
  assert.equal(catchUp(12 * MIN, 30).jumpHeld, false, '30 kills never light the swords');
  assert.equal(catchUp(9 * MIN, 155).jumpHeld, false, 'no stall');
  assert.equal(catchUp(15 * MIN, 60).jumpHeld, true, '60 whole, 40 per 10 spread over 15 min');
  assert.equal(catchUp(15 * MIN, 40).jumpHeld, false, '40 whole never reaches the floor');
  const p = fresh();
  const base = matches[3];
  sheetOf(p, base.id, [{ at: p.clock.now - 30 * MIN, n: { Center: 100, RedHome: 0, BlueHome: 0, GreenHome: 0 } }]);
  const m = liveWith(base, { Center: 5100 });
  p.call('keepNewestMatch', m);
  const wide = p.call('killView', m, TYPES);
  assert.equal(wide.long && !wide.longOk, true, 'a window past 20 min');
  assert.equal(wide.jumpHeld, false);
});

test('killView: invariants hold on mutated bodies and histories (js/maps-early.js)', () => {
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

test('missedOwnerChanges: lists exactly the objectives that changed hands (js/maps-early.js)', () => {
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

test('missedOwnerChanges: a lost field or a case change is no change, and nothing throws (js/maps-early.js)', () => {
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

test('missedPeriod: the period holds every listed flip (js/maps-early.js)', () => {
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

test('recordFightSamples: only a score this page watched rise is written to the fight log (js/maps-early.js)', () => {
  const p = fresh();
  const asked = p.clock.now;
  const log = () => p.call('readFightLog')[OPEN_ID] || [];
  p.call('keepNewestMatch', stepOf(1));
  p.call('recordFightSamples', [stepOf(1)], asked);
  assert.equal(log().length, 0, 'a first sight may be the lagging group\'s: no line');
  p.call('keepNewestMatch', stepOf(2));
  p.call('recordFightSamples', [stepOf(2)], asked);
  assert.equal(log().length, 1, 'the rise watched is written');
});

// A match gapNote: the body before the gap, the body after it, one map's kills at a time.
function gapNote(p, before, after) {
  p.call('missedMakeNote', before, after, p.clock.now - 20 * MIN, p.clock.now, 'pause');
  return p.run(`missedNotes.get('${OPEN_ID}')`);
}

const withKills = (m, perType) => {
  const x = clone(m);
  for (const map of x.maps) map.kills = { red: perType[map.type] || 0, blue: 0, green: 0 };
  return x;
};

test('missedView: a map the body says has fewer kills than before is not a negative count (js/maps-early.js)', () => {
  const p = fresh();
  const before = withKills(openMatch, { Center: 100, RedHome: 100 });
  const after = withKills(openMatch, { Center: 90, RedHome: 150 });
  const view = gapNote(p, before, after);
  assert.deepEqual(JSON.parse(JSON.stringify(view.perMap.map((m) => [m.type, m.n]))), [['RedHome', 50]]);
  assert.equal(view.kills, 50);
});

test('missedView: the kills count from the newest body kept, not from a lagging one the summary was made on (js/maps-early.js)', () => {
  const p = fresh();
  p.call('keepNewestMatch', withKills(openMatch, { Center: 100, RedHome: 300 }));
  const view = gapNote(p, withKills(openMatch, { Center: 100, RedHome: 100 }), withKills(openMatch, { Center: 100, RedHome: 150 }));
  assert.equal(view.kills, 200, 'what the page now holds, 300 less the 100 before');
});

test('ageByScoreSum: a first sight takes the time of the oldest line of its week with its score, never an earlier week\'s (js/maps-early.js)', () => {
  const p = fresh();
  const body = stepOf(1);
  p.call('keepNewestMatch', body);
  const sum = p.call('colorSum', body.scores);
  const week = Date.parse(body.start_time);
  const line = (at) => ({ at, n: {}, score: sum });
  p.call('ageByScoreSum', new Map([[OPEN_ID, [line(week - 60 * MIN), line(p.clock.now - 30 * MIN)]]]));
  assert.equal(p.run(`newestMatches.get('${OPEN_ID}').at`), p.clock.now - 30 * MIN);
});

test('ageByScoreSum: a score this page watched rise keeps its time (js/maps-early.js)', () => {
  const p = fresh();
  p.call('keepNewestMatch', stepOf(1));
  p.call('keepNewestMatch', stepOf(2));
  assert.equal(p.run(`newestMatches.get('${OPEN_ID}').rose`), true, 'control: the rise was watched');
  const sum = p.call('colorSum', stepOf(2).scores);
  p.call('ageByScoreSum', new Map([[OPEN_ID, [{ at: p.clock.now - 30 * MIN, n: {}, score: sum }]]]));
  assert.equal(p.run(`newestMatches.get('${OPEN_ID}').at`), p.clock.now);
});

const base24h = 24 * 60 * MIN;

test('missedMatchOffered: a summary only for a real gap, with its changes and kills (js/maps-early.js)', () => {
  const { after, offer } = happened();
  const a = after();
  const n = offer(a.m, 12 * MIN, 30000);
  assert.ok(n && n.kind === 'pause', 'a real gap raises a summary');
  assert.equal(n.changes.length, 2);
  assert.ok(a.taken.every((x) => Array.from(n.changes).some((c) => c.id === x)), 'the changes listed are the objectives taken');
  assert.equal(n.kills, 50, 'the kills other than after minus before');
  const edge = after();
  assert.equal(offer(edge.m, base24h - 1000, 30000).kind, 'pause', '1 s under 24 h still raises one');
});

test('missedMatchOffered: never for the same body, a body behind, a new week, a laptop asleep, a 7-minute stop, a gap with no read, or over 24 h (js/maps-early.js)', () => {
  const { after, offer, M0 } = happened();
  assert.equal(offer(clone(M0), 12 * MIN, 30000), null, 'the same body');
  assert.equal(offer(after().m, base24h + 1000, 30000), null, 'a pause over 24 h');
  const behind = clone(M0); behind.scores.red -= 50; behind.maps[0].kills.red += 5;
  assert.equal(offer(behind, 12 * MIN, 30000), null, 'a body behind');
  const week = after().m; week.start_time = new Date(Date.parse(M0.start_time) + 7 * 86400000).toISOString();
  assert.equal(offer(week, 12 * MIN, 30000), null, 'a new week');
  assert.equal(offer(after().m, 20 * MIN, 5 * MIN), null, 'a laptop asleep');
  assert.equal(offer(after().m, 7 * MIN, 30000), null, 'a 7-minute stop');
  assert.equal(offer(after().m, 12 * MIN, 13 * MIN), null, 'a gap with no read in it');
});

test('missedMatchOffered: a stop of exactly 10 min raises none, 10 min and 1 s does (js/maps-early.js)', () => {
  const { after, offer } = happened();
  assert.equal(offer(after().m, 10 * MIN, 30000), null);
  assert.equal(offer(after().m, 10 * MIN + 1000, 30000).kind, 'pause');
});

test('missedOnVisibility: a tab hidden exactly 10 min is not away, 10 min and 1 s is (js/maps-early.js)', () => {
  const { p, id, now, reset } = happened();
  const back = (ms) => {
    reset();
    p.ctx.__bodies = new Map([[id, clone(openMatch)]]);
    p.run(`missedHidden = { at: ${now - ms}, bodies: __bodies }`);
    p.run('missedOnVisibility()');
    return p.run('missedReturn');
  };
  assert.equal(back(10 * MIN), null);
  assert.ok(back(10 * MIN + 1000));
});

test('missedMatchOffered: a return to the tab raises one when something changed, follows a newer body, none when nothing changed (js/maps-early.js)', () => {
  const { p, id, now, reset, after } = happened();
  const arm = () => {
    reset();
    p.ctx.__bodies = new Map([[id, clone(openMatch)]]);
    p.run(`missedReturn = { since: ${now - 5 * MIN}, back: ${now}, bodies: __bodies }`);
  };
  const offerNow = (body) => { p.ctx.__kept = { match: body, at: now }; p.call('missedMatchOffered', body, p.ctx.__kept); return p.run(`missedNotes.get('${id}')`); };
  arm();
  const r = after();
  let n = offerNow(r.m);
  assert.ok(n && n.kind === 'return' && n.kills === 50);
  n.open = true; n.wideOpen = false;
  const newer = clone(r.m); newer.maps[0].kills.red += 9; newer.scores.red += 20;
  n = offerNow(newer);
  assert.equal(n.kills, 59, 'the summary follows the newer body');
  assert.equal(Array.from(n.perMap).reduce((t, m) => t + m.n, 0), 59);
  assert.equal(n.open, true, 'what the reader had opened stays');
  assert.equal(n.wideOpen, false);
  arm();
  p.ctx.__kept = { match: clone(openMatch), at: now };
  p.call('missedMatchOffered', clone(openMatch), p.ctx.__kept);
  assert.equal(p.run(`missedNotes.get('${id}')`), undefined, 'nothing changed, no summary');
});

test('missedPeriod: the period is the data\'s: the history says when the total before first appeared (js/maps-early.js)', () => {
  const { p, id, now, reset, after, sample, history, lastOffer, M0 } = happened();
  const stalled = clone(M0); stalled.maps[0].kills.red += 200;
  const longer = after(stalled);
  longer.m.maps[1].kills.green += 7;
  for (const map of longer.m.maps) for (const o of map.objectives) if (longer.taken.includes(o.id)) o.last_flipped = new Date(now - 3 * MIN).toISOString();
  const pause = (kept, at) => { p.ctx.__kept = { match: kept, at: now - at }; p.call('missedMatchOffered', longer.m, p.ctx.__kept); return p.run(`missedNotes.get('${id}')`); };
  history(sample(now - 40 * MIN, M0), sample(now - 36 * MIN, stalled));
  reset(); lastOffer(30000);
  let n = pause(stalled, 12 * MIN);
  assert.equal(n.since, now - 36 * MIN, 'a body stopped 36 min does not start the period at the stop');
  assert.equal(n.sure, true);
  assert.ok(n.end >= n.since && n.end <= now + 1000, 'the period ended before the page read the new body');
  const diff = p.call('missedKillTotal', longer.m) - p.call('missedKillTotal', stalled);
  assert.equal(n.kills, diff);
  assert.equal(Array.from(n.perMap).reduce((t, m) => t + m.n, 0), diff);
  assert.equal(n.perMap.length, 2, 'only the maps that moved are listed');
  assert.ok(Array.from(n.perMap).some((m) => m.type === stalled.maps[0].type && m.n === 50));
  assert.ok(Array.from(n.perMap).some((m) => m.type === stalled.maps[1].type && m.n === 7));
  // The new body already in the history: the period ends where it first showed.
  history(sample(now - 40 * MIN, M0), sample(now - 36 * MIN, stalled), sample(now - 2 * MIN, longer.m));
  reset(); lastOffer(30000);
  n = pause(stalled, 12 * MIN);
  assert.ok(n.sure);
  assert.equal(n.end, now - 2 * MIN);
  // A return: the body before is older than the tab's hiding.
  history(sample(now - 50 * MIN, M0), sample(now - 30 * MIN, stalled));
  reset();
  p.ctx.__bodies = new Map([[id, clone(stalled)]]);
  p.run(`missedReturn = { since: ${now - 5 * MIN}, back: ${now}, bodies: __bodies }`);
  p.ctx.__kept = { match: longer.m, at: now };
  p.call('missedMatchOffered', longer.m, p.ctx.__kept);
  n = p.run(`missedNotes.get('${id}')`);
  assert.equal(n.kind, 'return');
  assert.equal(n.since, now - 30 * MIN, 'a return starts at the hiding, not where the body before began');
  assert.equal(n.sure, true);
  // A normal return: a row a minute, none with the total of the body before.
  const lower = clone(M0); lower.maps[0].kills.red += 190;
  const upper = clone(M0); upper.maps[0].kills.red += 210;
  history(sample(now - 14 * MIN, lower), sample(now - 13 * MIN, lower), sample(now - 12 * MIN + 30000, upper), sample(now - 11 * MIN, upper));
  reset(); lastOffer(30000);
  n = pause(stalled, 12 * MIN);
  assert.equal(n.sure, true, 'a normal return between rows is sure');
  assert.equal(n.since, now - 12 * MIN);
  // The oldest reading there is only bounds the start: not sure, never later.
  history(sample(now - 36 * MIN, stalled));
  reset(); lastOffer(30000);
  n = pause(stalled, 12 * MIN);
  assert.equal(n.sure, false, 'the oldest reading is not taken as the exact start');
  assert.equal(n.since, now - 36 * MIN);
  // No reading of that total at all: the page's own time, not sure.
  history();
  reset(); lastOffer(30000);
  n = pause(stalled, 12 * MIN);
  assert.equal(n.sure, false);
  assert.ok(n.since <= now - 12 * MIN);
});

test('missedMatchOffered: a listed flip older than the period starts it, a future one is skipped, a recent one is reached (js/maps-early.js)', () => {
  const { p, id, now, reset, after, sample, history, lastOffer, M0 } = happened();
  const old = after();
  const flips = (k) => [].concat(...old.m.maps.map((x) => x.objectives)).find((x) => x.id === old.taken[k]);
  flips(0).last_flipped = new Date(now - 120 * MIN).toISOString();
  flips(1).last_flipped = new Date(now + 60 * MIN).toISOString();
  history();
  reset();
  p.ctx.__bodies = new Map([[id, clone(M0)]]);
  p.run(`missedReturn = { since: ${now - 5 * MIN}, back: ${now}, bodies: __bodies }`);
  p.ctx.__kept = { match: old.m, at: now };
  p.call('missedMatchOffered', old.m, p.ctx.__kept);
  let n = p.run(`missedNotes.get('${id}')`);
  assert.equal(n.kind, 'return');
  assert.equal(n.since, now - 120 * MIN, 'a return with a flip 2 h old starts at the flip');
  assert.equal(n.sure, true);
  const pause = () => { reset(); lastOffer(30000); p.ctx.__kept = { match: clone(M0), at: now - 12 * MIN }; p.call('missedMatchOffered', old.m, p.ctx.__kept); return p.run(`missedNotes.get('${id}')`); };
  n = pause();
  assert.equal(n.kind, 'pause');
  assert.equal(n.since, now - 120 * MIN, 'a pause with a flip 2 h old starts at the flip');
  assert.equal(n.sure, true);
  flips(0).last_flipped = new Date(now - MIN).toISOString();
  history(sample(now - 40 * MIN, M0), sample(now - 5 * MIN, old.m));
  n = pause();
  assert.ok(n.end >= now - MIN, 'the period reaches a flip it lists');
});

test('missedMatchOffered: over 40 objectives taken, the newest 40 by their flip are listed (js/maps-early.js)', () => {
  const { now, offer, M0 } = happened();
  const m = clone(M0); const order = [];
  for (const map of m.maps) for (const o of map.objectives) if (['Camp', 'Tower', 'Keep'].includes(o.type)) { o.owner = FLIP_TO[o.owner] || 'Red'; order.push(o); }
  order.forEach((o, i) => { o.last_flipped = new Date(now - (order.length - i) * MIN).toISOString(); });
  m.maps[0].kills.red += 5;
  assert.ok(order.length > 40, 'the state: over 40 objectives to take');
  const n = offer(m, 12 * MIN, 30000);
  assert.deepEqual(Array.from(n.changes, (c) => c.id), order.slice(-40).map((o) => o.id));
});

test('missedMatchOffered: Ruins and Spawn never chips, kills never below 0, a summary gone after 10 min (js/maps-early.js)', () => {
  const { p, id, now, offer, after, M0 } = happened();
  const ruins = clone(M0);
  for (const map of ruins.maps) for (const o of map.objectives) if (o.type === 'Ruins' || o.type === 'Spawn') o.owner = FLIP_TO[o.owner] || 'Red';
  ruins.maps[0].kills.red += 5;
  assert.equal(offer(ruins, 12 * MIN, 30000).changes.length, 0, 'Ruins or Spawn became chips');
  const fewer = after().m; fewer.maps[0].kills.red -= 500;
  const low = offer(fewer, 12 * MIN, 30000);
  assert.ok(!low || low.kills >= 0, 'kills went below 0');
  const n = offer(after().m, 12 * MIN, 30000);
  assert.equal(p.run(`missedNoteFor('${id}') !== null`), true, 'control: the summary is up');
  n.until = now - 1;
  assert.equal(p.run(`missedNoteFor('${id}')`), null, 'a summary outlived its 10 minutes');
});

// ---- A body dated by the sheet's score sum, /api/kills down (js/maps-early.js) ----
function sheetDated(lines, bodyAge = 0) {
  const p = fresh();
  p.call('keepNewestMatch', stepOf(1));
  const sum = p.call('colorSum', stepOf(1).scores);
  const week = Date.parse(stepOf(1).start_time);
  p.run(`newestMatches.get('${OPEN_ID}').rose = false; newestMatches.get('${OPEN_ID}').at = ${p.clock.now - bodyAge * MIN}`);
  // The sheet as the Apps Script writes it: at, match, four maps, the week's start, the score sum.
  const csv = lines.map(([age, delta]) => [p.clock.now - age * MIN, OPEN_ID, 0, 0, 0, 0, week, sum + delta].join(',')).join('\n');
  p.ctx.AbortController = AbortController;
  p.ctx.fetch = async () => ({ ok: true, text: async () => csv });
  p.run('readOwnKills = async () => { throw new Error("down"); }');
  p.run('killSheet = null; killSheetAt = 0');
  return p.run('getKillSheet()').then(() => p.clock.now - p.run(`newestMatches.get('${OPEN_ID}').at`));
}

test('getKillSheet: with /api/kills down the body takes the time of the oldest sheet line with its score sum, not a newer equal one or one behind it (js/maps-early.js)', async () => {
  const age = await sheetDated([[30, -5], [20, 0], [10, 0], [1, 0]]);
  assert.equal(age, 20 * MIN);
});

test('getKillSheet: with /api/kills down no sheet line with the body\'s score sum leaves its time as it was (js/maps-early.js)', async () => {
  const age = await sheetDated([[30, -5], [20, -3], [1, -1]]);
  assert.equal(age, 0);
});

test('getKillSheet: with /api/kills down a body already dated before the equal sheet line does not move to it (js/maps-early.js)', async () => {
  const age = await sheetDated([[30, -5], [20, 0], [1, 0]], 25);
  assert.equal(age, 25 * MIN);
});
