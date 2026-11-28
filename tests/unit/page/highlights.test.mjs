// The highlights' rules in js/highlights.js, run in Node (page/harness.mjs): the skirmish victory point table
// against the e2e factory's, the table checked against a week, the Closest match's favourite and its tie, and
// the Hottest fight's line by the map corner's looks, and which metrics the Leaders have a value for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, MIN, clone, fresh, openMatch } from './harness.mjs';
import { WAR_VP } from '../../e2e/support/gw2.mjs';

test('the site\'s skirmish VP table is the factory\'s WAR_VP', () => {
  const p = fresh();
  assert.deepEqual(JSON.parse(JSON.stringify(p.run('SKIRMISH_VP'))), JSON.parse(JSON.stringify(WAR_VP)));
});

test('the table holds against the recorded weeks, and not with one VP more', () => {
  const p = fresh();
  for (const m of matches) {
    assert.equal(p.call('hlVpHolds', m), true, m.id);
    const off = clone(m);
    off.victory_points.red += 1;
    assert.equal(p.call('hlVpHolds', off), false, m.id);
  }
});

test('the Closest match: level if it ended now names no winner', () => {
  const p = fresh();
  const m = matches[0];
  const a = { color: 'red', name: 'Mosswood', vp: 1447 };
  const b = { color: 'blue', name: 'Lutgardis', vp: 1443 };
  const c = (next, vp) => ({ m, gap: 4, a, b, next, sk: { left: 69, vp, sc: { red: 1, blue: 2, green: 0 } } });
  const tied = c(0, { red: 14, blue: 18, green: 12 });
  assert.equal(p.call('hlFav', tied).tied, true);
  const said = p.call('hlClosestSaid', tied);
  assert.match(said, /, and the two would be tied\. 1 h 9 min left in this skirmish\./);
  assert.doesNotMatch(said, /stay ahead|would pass/);
  const ahead = c(1, { red: 15, blue: 18, green: 12 });
  assert.equal(p.call('hlFav', ahead).tied, false);
  assert.match(p.call('hlClosestSaid', ahead), /Mosswood would stay ahead, by 1\./);
  const passes = c(-2, { red: 12, blue: 18, green: 14 });
  assert.equal(p.call('hlFav', passes).x.name, 'Lutgardis');
  // No table to trust: the week's leader, nothing "if it ended now".
  const none = c(undefined, null);
  assert.equal(p.call('hlFav', none).tied, false);
  assert.match(p.call('hlClosestSaid', none), /Mosswood leads the week\./);
  // Level in the week with no table: no leader picked by the sort's order.
  const level = { m, gap: 0, a, b: { ...b, vp: a.vp }, sk: { left: 69, vp: null, sc: { red: 1, blue: 2, green: 0 } } };
  assert.equal(p.call('hlFav', level).tied, true);
  const saidLevel = p.call('hlClosestSaid', level);
  assert.match(saidLevel, /0 apart this week\. The two are tied this week\. 1 h 9 min left in this skirmish\./);
  assert.doesNotMatch(saidLevel, /leads the week/);
});

test('the Hottest fight with no rate: the spinner before the first read, the reset with no running match', () => {
  const p = fresh();
  p.set('killSheet', null);
  assert.equal(p.call('hlWaitText', undefined), null);
  p.set('killSheet', new Map());
  assert.equal(p.call('hlWaitText', undefined), 'Counting starts about 10 min after the reset');
  assert.equal(p.call('hlWaitText', { noWindow: 'reset' }), 'Counting starts about 10 min after the reset');
  assert.equal(p.call('hlWaitText', { noWindow: 'data' }), 'Not enough kill data to count 10 minutes');
});

test('the Hottest fight\'s line follows the map corner\'s looks', () => {
  const p = fresh();
  const now = p.clock.now;
  const m = matches[0];
  const view = (o) => ({ clock: now - o.silence, silence: o.silence, frozen: !!o.frozen, strange: false, alive: !!o.alive });
  const when = (calm, o) => ({ ...p.call('hlFightWhen', { m, calm, view: view(o) }) });
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // The score stopped rising past HUD_STALE_MS: paused, whatever the pace says.
  assert.deepEqual(when(true, { silence: 20 * MIN, frozen: true }), { text: `game data paused · ${hhmm(now - 20 * MIN)}`, still: true });
  assert.deepEqual(when(false, { silence: 2 * MIN, frozen: true }), { text: `game data paused · ${hhmm(now - 2 * MIN)}`, still: true });
  // Calm only on a body that rose lately; else only when the data is from.
  assert.deepEqual(when(true, { silence: 2 * MIN, alive: true }), { text: 'quiet now', still: true });
  assert.deepEqual(when(true, { silence: 2 * MIN }), { text: `data up to ${hhmm(now - 2 * MIN)}`, still: true });
  // Lit: now; silent past KILLS_QUIET_MS on a live body, the last kill's age; too soon to tell, when the data is from.
  assert.deepEqual(when(false, { silence: MIN, alive: true }), { text: 'now', still: false });
  assert.deepEqual(when(false, { silence: 10 * MIN, alive: true }), { text: 'last kill 10 min ago', still: false });
  assert.deepEqual(when(false, { silence: 7 * MIN, alive: true }), { text: `data up to ${hhmm(now - 7 * MIN)}`, still: true });
});

test('killLook: the map corner\'s looks, from the score\'s age and the kills\' silence (js/maps-early.js)', () => {
  const p = fresh();
  const look = (v, stale) => ({ ...p.call('killLook', { clock: 1, strange: false, alive: true, ...v }, stale) });
  assert.deepEqual(look({ silence: MIN }, false), { odd: false, old: false, unproven: false });
  assert.deepEqual(look({ silence: MIN }, true), { odd: true, old: true, unproven: false });
  assert.deepEqual(look({ silence: MIN, strange: true }, false), { odd: true, old: true, unproven: false });
  assert.deepEqual(look({ silence: 10 * MIN }, false), { odd: false, old: true, unproven: false });
  assert.deepEqual(look({ silence: 7 * MIN }, false), { odd: false, old: true, unproven: true });
  assert.deepEqual(look({ silence: 10 * MIN, alive: false }, false), { odd: false, old: true, unproven: true });
  assert.deepEqual(look({ silence: 10 * MIN, clock: 0 }, true), { odd: false, old: false, unproven: false });
});

// The region's kept bodies as js/api.js keeps them, the page's clock at `now`.
function keep(p, list) {
  p.ctx.__list = list;
  p.run('newestMatches.clear(); for (const m of __list) newestMatches.set(m.id, { match: m, at: Date.now(), rose: true })');
}
const na = () => matches.filter((m) => m.id.startsWith('1-')).map(clone);

test('the Busiest map counts the last 2 h\'s takes, else the week\'s newest, never the owners the reset hands out', () => {
  const p = fresh();
  const now = p.clock.now;
  const list = na();
  const iso = (t) => new Date(t).toISOString();
  for (const m of list) {
    m.start_time = iso(now - 5 * 60 * MIN);
    m.end_time = iso(now + 7 * 24 * 60 * MIN);
    for (const map of m.maps) for (const o of map.objectives) { o.owner = 'Red'; o.last_flipped = m.start_time; }
  }
  for (const ago of [30 * MIN, 5 * 60 * MIN]) {
    for (const m of list) {
      m.start_time = iso(now - ago);
      for (const map of m.maps) for (const o of map.objectives) o.last_flipped = m.start_time;
    }
    keep(p, list);
    assert.equal(p.call('hlFlips').length, 0, 'every objective stamped at the reset, none taken');
    assert.equal(p.run('hlNewest'), null, 'no take this week');
  }
  const tower = list[0].maps.find((x) => x.type === 'BlueHome').objectives.find((o) => o.type === 'Tower');
  tower.owner = 'Blue';
  tower.last_flipped = iso(now - 10 * MIN);
  const old = list[1].maps[0].objectives.find((o) => o.type === 'Camp');
  old.last_flipped = iso(now - 3 * 60 * MIN);
  old.owner = 'Green';
  tower.last_flipped = iso(now - 2.5 * 60 * MIN);
  keep(p, list);
  assert.equal(p.call('hlFlips').length, 0, 'none in 2 h');
  assert.equal(p.run('hlNewest.objective'), 'Tower', 'the newest take of the week');
  tower.last_flipped = iso(now - 10 * MIN);
  keep(p, list);
  const flips = p.call('hlFlips');
  assert.equal(flips.length, 1);
  assert.equal(flips[0].type, 'BlueHome');
  assert.equal(flips[0].n, 1);
  assert.deepEqual({ ...flips[0].by }, { red: 0, blue: 1, green: 0 });
  assert.equal(flips[0].last.type, 'Tower');
});

test('the Closest match: the fewest VP apart, a new week on 0 VP, the skirmish if it ended now', () => {
  const p = fresh();
  const list = na();
  keep(p, list);
  const c = p.call('hlClosest');
  const gaps = list.map((m) => { const v = Object.values(m.victory_points).sort((a, b) => b - a); return v[0] - v[1]; });
  assert.equal(c.gap, Math.min(...gaps));
  assert.ok(c.sk && c.sk.vp, 'the recorded week adds up: the skirmish has its points');
  assert.equal(c.next, (c.a.vp + c.sk.vp[c.a.color]) - (c.b.vp + c.sk.vp[c.b.color]));
  for (const m of list) m.victory_points = { red: 0, blue: 0, green: 0 };
  keep(p, list);
  assert.equal(p.call('hlClosest').fresh, true);
  keep(p, []);
  assert.equal(p.call('hlClosest'), null);
  assert.equal(p.call('hlLeft', 69), '1 h 9 min left');
  assert.equal(p.call('hlLeft', 5), '5 min left');
  assert.equal(p.call('hlLeft', 0), 'ending now');
  assert.equal(p.call('hlSpan', 75 * MIN), '1 h 15 min');
});

test('the map badges\' repaint of every tier repaints the highlights; of one tier, not', () => {
  const p = fresh();
  p.run('document = { querySelectorAll: () => [] }; globalThis.__painted = 0; paintHighlights = () => { __painted += 1; }');
  p.call('paintMapBadges', '1-1');
  assert.equal(p.run('__painted'), 0);
  p.call('paintMapBadges');
  assert.equal(p.run('__painted'), 1);
});

test('the Leaders: only a metric with a value, and K/D from 500 deaths', () => {
  const p = fresh();
  const shorts = (m) => {
    p.run('newestMatches.clear()');
    p.call('keepNewestMatch', m);
    return [...p.call('hlLeaders')].map((x) => x.short);
  };
  assert.deepEqual(shorts(clone(openMatch)), ['Kills', 'VP', 'Active', 'K/D']);
  // A week's first minutes: no kill, no VP, and the objectives not yet worth a tick: nothing to lead.
  const zero = clone(openMatch);
  for (const k of ['kills', 'deaths', 'victory_points']) for (const c of ['red', 'blue', 'green']) zero[k][c] = 0;
  for (const map of zero.maps) for (const o of map.objectives) o.points_tick = 0;
  assert.deepEqual(shorts(zero), []);
  // Kills and deaths are in, VP not: the two metrics that have a value, K/D under its floor.
  const some = clone(zero);
  some.kills.red = 5;
  some.deaths.red = 499;
  assert.deepEqual(shorts(some), ['Kills', 'Active']);
  some.deaths.red = 500;
  assert.deepEqual(shorts(some), ['Kills', 'Active', 'K/D']);
  // Every team over the floor but none with a kill: K/D 0 is no leader.
  some.kills.red = 0;
  assert.deepEqual(shorts(some), ['Active']);
});

test('the Leaders turn only with two metrics or more', () => {
  const p = fresh();
  p.run('hlRot.list = [{}]');
  assert.equal(p.call('hlHeld'), true);
  p.run('hlRot.list = [{}, {}]');
  assert.equal(p.call('hlHeld'), false);
});

// A copy's count as the Worker serves it (taken: {points, flips, maps}), kept by the body it came with.
const takenFor = (p, body, taken) => {
  p.ctx.__b = body;
  p.ctx.__t = taken;
  p.run('latestTaken.delete(__b); if (latestTakenOf(__t)) latestTaken.set(__b, latestTakenOf(__t))');
};
test('the Leaders count the copy\'s objective points, and the Busiest its takes; with no count, as before', () => {
  const p = fresh();
  const now = p.clock.now;
  const list = na();
  const iso = (t) => new Date(t).toISOString();
  for (const m of list) {
    m.start_time = iso(now - 5 * 60 * MIN);
    m.end_time = iso(now + 7 * 24 * 60 * MIN);
    for (const map of m.maps) for (const o of map.objectives) { o.owner = 'Red'; o.last_flipped = m.start_time; }
  }
  const shorts = () => p.call('hlLeaders').filter((x) => !x.wait).map((x) => x.short);
  // Nothing at all yet, kills and VP included: no box, no sentence alone in it.
  const quiet = clone(list);
  for (const m of quiet) for (const k of ['kills', 'deaths', 'victory_points']) for (const c of ['red', 'blue', 'green']) m[k][c] = 0;
  keep(p, quiet);
  assert.equal(p.call('hlLeaders').length, 0);
  keep(p, list);
  // The week's first minutes: the others have a value, no objective was taken; its slide says the week is new.
  assert.equal(p.call('hlLeaders').find((x) => x.short === 'Objectives').wait, true);
  assert.equal(shorts().includes('Objectives'), false, 'no count, no such metric');
  // A take the page sees in `last_flipped` with no count: the metric stays out, with no sentence either.
  const camp = list[0].maps[0].objectives.find((o) => o.type === 'Camp');
  camp.last_flipped = iso(now - 10 * MIN);
  keep(p, list);
  assert.equal(shorts().includes('Objectives'), false);
  assert.equal(p.call('hlLeaders').some((x) => x.short === 'Objectives'), false, 'no slide of any kind: the week is not new');
  camp.last_flipped = list[0].start_time;
  // A count (flips, no points yet) is no new week either, though the page sees no take: no metric, no sentence.
  list.forEach((m) => takenFor(p, m, { points: { red: 0, blue: 0, green: 0 }, flips: { red: 1, blue: 0, green: 0 }, maps: {} }));
  keep(p, list);
  assert.equal(p.call('hlLeaders').filter((x) => x.short === 'Objectives').length, 0);
  list.forEach((m) => takenFor(p, m, undefined));
  // The counts of three matches, the sum made apart: each team's points over the matches it is in, the best row.
  const counts = [{ red: 300, blue: 75, green: 125 }, { red: 10, blue: 900, green: 0 }, { red: 0, blue: 0, green: 40 }];
  list.slice(0, 3).forEach((m, i) => takenFor(p, m, { points: counts[i], flips: { red: 1, blue: 1, green: 1 }, maps: { [m.maps[0].id]: 4 + i, [m.maps[1].id]: 1 } }));
  const zero = { red: 0, blue: 0, green: 0 };
  list.slice(3).forEach((m) => takenFor(p, m, { points: zero, flips: zero, maps: {} }));
  keep(p, list);
  const best = Math.max(...counts.flatMap((c) => Object.values(c)));
  const top = p.call('hlLeaders').find((x) => x.short === 'Objectives');
  assert.equal(top.wait, undefined);
  assert.equal(top.val(top.r), best);
  assert.equal(top.r.m.id, list[1].id);
  assert.equal(top.r.color, 'blue');
  // The Busiest: the server's count, not the owners the page infers (none flipped here).
  const flips = p.call('hlFlips');
  assert.deepEqual(JSON.parse(JSON.stringify(flips.slice(0, 3).map((f) => [f.m.id, f.type, f.n]))), [[list[2].id, list[2].maps[0].type, 6], [list[1].id, list[1].maps[0].type, 5], [list[0].id, list[0].maps[0].type, 4]]);
  assert.equal(flips.length, 6, 'a map the count has no take on is not there');
  assert.equal(flips[0].held, false, 'the count alone: no owners to show');
  // A map with a take the page sees holds it; the count still gives the N.
  const seen = list[2].maps[0].objectives.find((o) => o.type === 'Camp');
  seen.last_flipped = iso(now - 10 * MIN);
  seen.owner = 'Green';
  assert.equal(p.call('hlFlips').find((f) => f.m === list[2] && f.type === list[2].maps[0].type).held, true);
  seen.last_flipped = list[2].start_time;
  seen.owner = 'Red';
  // A tier with no count among the others: the region's leader would be wrong, so no objective points at all.
  takenFor(p, list[0], undefined);
  assert.equal(p.call('hlLeaders').some((x) => x.short === 'Objectives'), false, 'a tier without a count leaves the metric out');
  takenFor(p, list[0], { points: counts[0], flips: { red: 1, blue: 1, green: 1 }, maps: { [list[0].maps[0].id]: 4, [list[0].maps[1].id]: 1 } });
  // Only the maps with a take, by a plain id.
  takenFor(p, list[2], { points: { red: 1, blue: 1, green: 1 }, flips: { red: 1, blue: 1, green: 1 }, maps: { abc: 2, 7: 0, 8: 3, '123456': 1 } });
  assert.deepEqual(JSON.parse(JSON.stringify(p.run('latestTaken.get(__b).maps'))), { 8: 3 });
  // An id that is a name on every object is no take.
  assert.equal(p.run('Object.hasOwn(latestTaken.get(__b).maps, "constructor")'), false);
  assert.equal(p.run('latestTaken.get(__b).maps.constructor'), undefined);
  // A count with the wrong shape is no count.
  takenFor(p, list[2], { points: { red: 1, blue: 1 }, flips: { red: 1, blue: 1, green: 1 }, maps: {} });
  assert.equal(p.run('latestTaken.has(__b)'), false);
  takenFor(p, list[2], { points: { red: 1, blue: -1, green: 1 }, flips: { red: 1, blue: 1, green: 1 }, maps: {} });
  assert.equal(p.run('latestTaken.has(__b)'), false);
});

test('the Leaders: a tie for first place leaves the metric out; on VP the skirmish under way breaks it', () => {
  const p = fresh();
  const read = (m) => {
    p.run('newestMatches.clear()');
    p.call('keepNewestMatch', m);
    return [...p.call('hlLeaders')];
  };
  const m = clone(openMatch);
  m.start_time = '2026-09-26T02:00:00Z';
  // Skirmish 1 ended with Red and Blue level on 43 VP (the first place's points to both), Green 21.
  m.skirmishes = [{ id: 1, scores: { red: 100, blue: 100, green: 50 } }, { id: 2, scores: { red: 10, blue: 5, green: 1 } }];
  m.victory_points = { red: 43, blue: 43, green: 21 };
  m.kills = { red: 7, blue: 7, green: 1 };
  const kills = (list) => list.map((x) => x.short);
  let list = read(m);
  assert.ok(!kills(list).includes('Kills'), 'a tie on kills: no leader');
  const vp = list.find((x) => x.short === 'VP');
  assert.ok(vp, 'a tie on VP is broken by the skirmish');
  assert.equal(vp.r.color, 'red');
  assert.equal(vp.r.ahead, 7, 'Red would take 31 VP, Blue 24');
  assert.match(p.call('hlLeadersSaid', list), /Tied on VP · 7 VP ahead this skirmish\./);
  // The same VP in a match with no table that holds: the tie cannot be broken across the two.
  const other = clone(m);
  other.id = '1-2';
  other.skirmishes = [];
  p.run('newestMatches.clear()');
  p.call('keepNewestMatch', m);
  p.call('keepNewestMatch', other);
  assert.ok(![...p.call('hlLeaders')].some((x) => x.short === 'VP'), 'a team with no count to break it with');
  // The skirmish level too: the tie stands, and the metric is out.
  m.skirmishes[1].scores = { red: 10, blue: 10, green: 1 };
  assert.ok(!kills(read(m)).includes('VP'));
  // A table that does not hold (VP the finished skirmishes do not add up to): nothing to break it with.
  m.skirmishes[1].scores = { red: 10, blue: 5, green: 1 };
  m.victory_points = { red: 44, blue: 44, green: 21 };
  assert.ok(!kills(read(m)).includes('VP'));
  // One ahead on kills: the leader again.
  m.kills.red = 8;
  assert.ok(kills(read(m)).includes('Kills'));
});

test('the Leaders ask the reduced-motion setting once, not on every frame', () => {
  const p = fresh();
  const before = p.run('__mediaQueries');
  p.run('hlReduced(); hlReduced(); hlReduced()');
  assert.equal(p.run('__mediaQueries'), before);
});
