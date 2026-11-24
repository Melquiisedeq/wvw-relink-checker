// compare() is the floor's arithmetic: what counts as a fall, a rise, a file gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, TOLERANCE } from '../../e2e/support/coverage.mjs';

const at = (lines, branches = 100) => ({ 'site/js/a.js': { lines, branches } });

test('a fall is reported only when it passes the tolerance', () => {
  assert.equal(TOLERANCE, 0.5);
  assert.deepEqual(compare(at(89.5), at(90)), { fell: [], rose: [] });
  assert.deepEqual(compare(at(89.4), at(90)).fell, ['site/js/a.js: lines 90 % -> 89.4 %']);
  assert.deepEqual(compare(at(90, 99.4), at(90, 100)).fell, ['site/js/a.js: branches 100 % -> 99.4 %']);
});

test('a rise past the tolerance is listed to raise the floor, one inside it is not', () => {
  assert.deepEqual(compare(at(90.5), at(90)), { fell: [], rose: [] });
  assert.deepEqual(compare(at(90.6), at(90)).rose, ['site/js/a.js: lines 90 % -> 90.6 %']);
});

test('a file in the floor that is no longer measured falls, and a new file is a rise', () => {
  const was = at(90, 80);
  assert.deepEqual(compare({}, was).fell, ['site/js/a.js: no longer measured (was 90 % lines, 80 % branches)']);
  assert.deepEqual(compare({ ...was, 'site/js/b.js': { lines: 1, branches: 1 } }, was), { fell: [], rose: ['site/js/b.js: new file'] });
});
