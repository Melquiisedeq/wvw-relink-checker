// The page's rules in js/relink.js, run in Node without a browser: the scripts load into a node:vm and the rules are fed
// bodies from the e2e recording, mutated by a fixed-seed PRNG where a test says so (page/harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fresh } from './harness.mjs';

test('fetchTimers: a lockout date that does not parse is no lockout (js/relink.js)', async () => {
  const page = fresh();
  page.ctx.fetchJson = async () => [{ na: 'not a date', eu: 'also not' }];
  await page.run('fetchTimers()');
  assert.equal(page.run('lockoutTime'), null);
});
