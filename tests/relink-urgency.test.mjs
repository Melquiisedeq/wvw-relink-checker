// The hours that make a region's relink urgent (js/relink.js regionIsUrgent):
// the edges of each of its three ways in, which a browser test would have to
// wait out to the minute. What the bar shows for them is tests in
// .github/e2e/banners.spec.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './page-harness.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const { run } = loadPage(NOW);
const urgent = (relinkAt, resetAt, hasLive) => run(`regionIsUrgent(${relinkAt}, ${resetAt}, ${hasLive}, ${NOW})`);
const MORE = 7 * 24 * HOUR;

test('before: urgent inside the last two hours, and not beyond them', () => {
  assert.equal(urgent(NOW + 2 * HOUR, null, true), true);
  assert.equal(urgent(NOW + 2 * HOUR + 1, null, true), false);
  assert.equal(urgent(NOW + 1, null, true), true);
  assert.equal(urgent(NOW + 20 * HOUR, null, true), false);
});

test('during: urgent from the end of the old week until 30 minutes after, only with no tier on the new week', () => {
  assert.equal(urgent(NOW, null, false), true);
  assert.equal(urgent(NOW - 29 * MIN, null, false), true);
  assert.equal(urgent(NOW - 30 * MIN, null, false), false);
  assert.equal(urgent(NOW - 5 * MIN, null, true), false);
});

test('opening: urgent for the five minutes after the new week starts', () => {
  assert.equal(urgent(NOW + MORE, NOW, true), true);
  assert.equal(urgent(NOW + MORE, NOW - 5 * MIN + 1, true), true);
  assert.equal(urgent(NOW + MORE, NOW - 5 * MIN, true), false);
  assert.equal(urgent(NOW + MORE, NOW - 5 * HOUR, true), false);
  assert.equal(urgent(NOW + MORE, NOW + 1, true), false);
});

test('a region with no figures is not urgent', () => {
  assert.equal(urgent(null, null, false), false);
});

test('the instant of the relink itself, with a tier still on the old week, is not urgent', () => {
  assert.equal(urgent(NOW, null, true), false);
});
