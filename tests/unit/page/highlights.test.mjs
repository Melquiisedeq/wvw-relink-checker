// The highlights' rules in js/highlights.js, run in Node (page/harness.mjs): the skirmish victory point table
// against the e2e factory's, the table checked against a week, the Closest match's favourite and its tie, and
// the Hottest fight's line by the map corner's looks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, MIN, clone, fresh } from './harness.mjs';
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
