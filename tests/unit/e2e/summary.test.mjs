// The run summary (tests/e2e/support/summary.mjs): a test that never started because the run
// stopped is counted apart from one skipped on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { slowest, sort } from '../../e2e/support/summary.mjs';

const fake = (outcome, results, expectedStatus = 'passed') => ({ outcome: () => outcome, results, expectedStatus });
const ran = [{ status: 'passed' }];

test('a skipped test with no result, or one that expected to pass, did not run; only one declared skipped was skipped on purpose', () => {
  const tests = [fake('skipped', []), fake('skipped', [{ status: 'interrupted' }]), fake('skipped', [{ status: 'skipped' }]), fake('skipped', [{ status: 'skipped' }], 'skipped')];
  const { notRun, skipped } = sort(tests);
  assert.equal(notRun.length, 3);
  assert.equal(skipped.length, 1);
});

test('failed, flaky and passed tests are never counted as not run', () => {
  const { failed, flaky, passed, notRun } = sort([fake('unexpected', ran), fake('flaky', ran), fake('expected', ran)]);
  assert.deepEqual([failed.length, flaky.length, passed, notRun.length], [1, 1, 1, 0]);
});

test('the slowest files are listed by the time summed over their results, cut at the maximum', () => {
  const at = (file, ...ms) => ({ location: { file }, results: ms.map(duration => ({ duration })) });
  const tests = [at('a', 10), at('b', 5, 5), at('b', 20), at('c', 1)];
  assert.deepEqual(slowest(tests, 2), [{ file: 'b', ms: 30, tests: 2 }, { file: 'a', ms: 10, tests: 1 }]);
  const many = Array.from({ length: 12 }, (_, i) => at(`f${i}`, i));
  assert.equal(slowest(many).length, 10);
  assert.equal(slowest(many)[0].file, 'f11');
});
