// The standings rules of js/panels.js, with cases written by hand: who is 1st,
// 2nd and 3rd, the arrow for the next reset, and the two number formats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './harness.mjs';

const page = loadPage(0);
const call = (name, ...args) => {
  page.ctx.__args = args;
  return page.run(`${name}(...__args)`);
};
const plain = (x) => JSON.parse(JSON.stringify(x));
const rank = (vp, scores) => plain(call('rankMatchByVictoryPoints', { victory_points: vp, scores }));

test('rank: more victory points ranks higher', () => {
  assert.deepEqual(rank({ red: 10, blue: 30, green: 20 }, { red: 9, blue: 1, green: 5 }), { blue: 1, green: 2, red: 3 });
});

test('rank: a tie on victory points goes to the higher war score', () => {
  assert.deepEqual(rank({ red: 20, blue: 20, green: 10 }, { red: 100, blue: 200, green: 900 }), { blue: 1, red: 2, green: 3 });
});

test('rank: a tie on both goes to the first of red, blue, green', () => {
  assert.deepEqual(rank({ red: 5, blue: 5, green: 5 }, { red: 7, blue: 7, green: 7 }), { red: 1, blue: 2, green: 3 });
  assert.deepEqual(rank({ red: 5, blue: 9, green: 9 }, { red: 7, blue: 7, green: 7 }), { blue: 1, green: 2, red: 3 });
});

test('rank: missing fields count as zero', () => {
  assert.deepEqual(plain(call('rankMatchByVictoryPoints', {})), { red: 1, blue: 2, green: 3 });
  assert.deepEqual(rank({ green: 1 }, undefined), { green: 1, red: 2, blue: 3 });
});

test('movement: 1st moves up, except in tier 1', () => {
  assert.equal(call('getRelinkMovement', 1, 3, 5).dir, 'up');
  assert.equal(call('getRelinkMovement', 1, '3', 5).dir, 'up');
  assert.equal(call('getRelinkMovement', 1, 1, 5).dir, 'stay');
  assert.equal(call('getRelinkMovement', 1, 1, null).dir, 'stay');
});

test('movement: 2nd stays, wherever the tier is', () => {
  for (const [tier, max] of [[1, 5], [3, 5], [5, 5], [3, null]]) {
    assert.equal(call('getRelinkMovement', 2, tier, max).dir, 'stay');
  }
});

test('movement: 3rd moves down, except in the last tier; unknown last tier gives no mark', () => {
  assert.equal(call('getRelinkMovement', 3, 3, 5).dir, 'down');
  assert.equal(call('getRelinkMovement', 3, 5, 5).dir, 'stay');
  assert.equal(call('getRelinkMovement', 3, '5', 5).dir, 'stay');
  const unknown = plain(call('getRelinkMovement', 3, 5, null));
  assert.deepEqual(unknown, { dir: 'unknown', label: '' });
  assert.equal(call('getRelinkMovement', 3, 5, undefined).dir, 'unknown');
});

test('movement: labels', () => {
  assert.equal(call('getRelinkMovement', 1, 2, 5).label, 'Moves up next reset');
  assert.equal(call('getRelinkMovement', 1, 1, 5).label, 'Already the top tier');
  assert.equal(call('getRelinkMovement', 2, 2, 5).label, 'Stays in this tier next reset');
  assert.equal(call('getRelinkMovement', 3, 2, 5).label, 'Moves down next reset');
  assert.equal(call('getRelinkMovement', 3, 5, 5).label, 'Already the bottom tier');
});

test('formatKd: two decimals, a dash with no deaths', () => {
  assert.equal(call('formatKd', 10, 4), '2.50');
  assert.equal(call('formatKd', 1, 3), '0.33');
  assert.equal(call('formatKd', 0, 5), '0.00');
  assert.equal(call('formatKd', 7, 0), '–');
  assert.equal(call('formatKd', 0, 0), '–');
});

test('formatCompact: thousands as k from 1,000, the plain number below', () => {
  assert.equal(call('formatCompact', 0), '0');
  assert.equal(call('formatCompact', 999), '999');
  assert.equal(call('formatCompact', 1000), '1.0k');
  assert.equal(call('formatCompact', 11434), '11.4k');
  assert.equal(call('formatCompact', 1234567), '1234.6k');
});
