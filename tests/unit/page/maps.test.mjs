// The page's rules in js/maps.js, run in Node without a browser: the scripts load into a node:vm and the rules are fed
// bodies from the e2e recording, mutated by a fixed-seed PRNG where a test says so (page/harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, MIN, fresh } from './harness.mjs';

const SEC = 1000;

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

test('missedSpan: the start after "yesterday" keeps both suffixes, and within a day they merge (js/maps.js)', () => {
  const page = fresh();
  // The calendar is UTC and the clock face the test's, so the machine's zone and locale decide nothing.
  page.run(`Object.assign(Date.prototype, {
    getFullYear() { return this.getUTCFullYear(); }, getMonth() { return this.getUTCMonth(); }, getDate() { return this.getUTCDate(); },
    toLocaleTimeString() {
      const h = this.getUTCHours(), mm = String(this.getUTCMinutes()).padStart(2, '0');
      return String(h % 12 || 12).padStart(2, '0') + ':' + mm + (h < 12 ? ' AM' : ' PM');
    } })`);
  const span = (a, b) => page.call('missedSpan', Date.parse(a), Date.parse(b));
  assert.equal(span('2026-12-06T15:00:00Z', '2026-12-07T12:00:00Z'), '03:00 PM yesterday\u201312:00 PM');
  assert.equal(span('2026-12-06T11:00:00Z', '2026-12-06T14:00:00Z'), '11:00 AM\u201302:00 PM');
  assert.equal(span('2026-12-06T23:30:00Z', '2026-12-07T00:30:00Z'), '11:30 PM yesterday\u201312:30 AM');
  assert.equal(span('2026-12-06T15:00:00Z', '2026-12-06T17:30:00Z'), '03:00\u201305:30 PM');
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
  // Seared Borderlands: each map's garrison to its home team, the side keeps to the invaders.
  assert.equal(has(keep('1652-37', 'Red'), bare), true);
  assert.equal(has(keep('1652-33', 'Green'), bare), true);
  assert.equal(has(keep('1652-32', 'Blue'), bare), true);
  assert.equal(has(keep('1652-32', 'Green'), bare), false);
  assert.equal(has(keep('1654-37', 'Blue'), bare), true);
  assert.equal(has(keep('1654-33', 'Red'), bare), true);
  assert.equal(has(keep('1654-32', 'Green'), bare), true);
  assert.equal(has(keep('1651-37', 'Green'), bare), true);
  assert.equal(has(keep('1651-33', 'Blue'), bare), true);
  assert.equal(has(keep('1651-32', 'Red'), bare), true);
  assert.equal(has(keep('1651-32', 'Blue'), bare), false);
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

// The Captures list (js/maps.js) names "yesterday" and redraws when the day turns on the server's time, with the visitor's clock off by minutes.
for (const lead of [5 * MIN, -5 * MIN]) {
  const ahead = lead > 0;
  const captures = () => {
    const p = fresh();
    p.set('steadyClockLead', lead);
    const midnight = new Date(2026, 10, 10).getTime();
    const whens = [];
    p.set('missedEl', (tag, cls, text) => { if (tag === 'time') whens.push(text); return { dataset: {}, appendChild() {}, setAttribute() {}, addEventListener() {} }; });
    p.set('markerIcon', () => null);
    p.set('missedShortName', () => 'x');
    p.set('missedFullName', () => 'x');
    p.set('matchTeamId', () => 0);
    const view = { box: { dataset: {}, textContent: '', appendChild() {} }, match: {} };
    const paint = (server, items) => { p.clock.now = server + lead; p.call('paintCapturesNow', view, items); };
    return { p, view, whens, paint, midnight };
  };

  test(`clock ${ahead ? 'ahead' : 'behind'} by 5 min: the Captures list says "yesterday" by the server's day`, () => {
    // Ahead: server 30 s before midnight, the visitor already past it; behind: 30 s after, the visitor still before it.
    const c = captures();
    const server = c.midnight + (ahead ? -30 * SEC : 30 * SEC);
    c.paint(server, [{ id: 'o', map: 'Center', type: 'Camp', owner: 'red', at: server - 60 * SEC }]);
    const yesterday = /yesterday/.test(c.whens[0]);
    assert.equal(yesterday, !ahead, `"${c.whens[0]}"`);
  });

  test(`clock ${ahead ? 'ahead' : 'behind'} by 5 min: the Captures list redraws when the server's day turns`, () => {
    const c = captures();
    const items = [{ id: 'o', map: 'Center', type: 'Camp', owner: 'red', at: c.midnight - 3600000 }];
    c.paint(c.midnight - 30 * SEC, items);
    const before = c.view.box.dataset.key;
    c.paint(c.midnight + 30 * SEC, items);
    assert.notEqual(c.view.box.dataset.key, before);
  });
}
