// The page's rules in js/config.js, run in Node without a browser: the scripts load into a node:vm and the rules are fed
// bodies from the e2e recording, mutated by a fixed-seed PRNG where a test says so (page/harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN, fresh } from './harness.mjs';

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
