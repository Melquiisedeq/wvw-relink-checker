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
