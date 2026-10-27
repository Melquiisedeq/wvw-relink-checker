import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, branchFromRef } from '../.github/scripts/prune-branches.mjs';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-27T12:00:00Z');
const ago = (ms) => new Date(now - ms).toISOString();
const base = { openPulls: 0, aheadBy: 2, lastCommitDate: ago(DAY), now };

test('an open pull request keeps the branch, even merged and old', () => {
  const v = decide({ ...base, openPulls: 1, aheadBy: 0, lastCommitDate: ago(30 * DAY) });
  assert.deepEqual(v, { action: 'keep', reason: 'open-pr' });
});

test('a pull request open only on the base side counts like one on the head', () => {
  // main() passes openPulls = open as head + open as base.
  const v = decide({ ...base, openPulls: 0 + 1, aheadBy: 0, lastCommitDate: ago(30 * DAY) });
  assert.deepEqual(v, { action: 'keep', reason: 'open-pr' });
});

test('no commit outside main and no pull request: merged', () => {
  assert.deepEqual(decide({ ...base, aheadBy: 0 }), { action: 'delete', reason: 'merged' });
});

test('more than three days old without a pull request: stale', () => {
  const v = decide({ ...base, lastCommitDate: ago(3 * DAY + 1000) });
  assert.deepEqual(v, { action: 'delete', reason: 'stale' });
});

test('new with commits outside main stays', () => {
  assert.equal(decide(base).action, 'keep');
});

test('exactly three days old stays', () => {
  assert.equal(decide({ ...base, lastCommitDate: ago(3 * DAY) }).action, 'keep');
});

test('missing or broken facts never delete', () => {
  assert.equal(decide({ ...base, openPulls: undefined, aheadBy: 0 }).action, 'keep');
  assert.equal(decide({ ...base, aheadBy: undefined, lastCommitDate: ago(30 * DAY) }).action, 'keep');
  assert.equal(decide({ ...base, lastCommitDate: 'nope' }).action, 'keep');
});

test('only refs/heads/claude/ names of safe characters pass', () => {
  assert.equal(branchFromRef('refs/heads/claude/cool-clarke-479yjo-1'), 'claude/cool-clarke-479yjo-1');
  assert.equal(branchFromRef('refs/heads/claude/a.b_c/d'), 'claude/a.b_c/d');
  for (const bad of [
    'refs/heads/main',
    'refs/heads/claude',
    'refs/heads/claude/',
    'refs/heads/claude/../main',
    'refs/heads/claude/a//b',
    'refs/heads/claude/a b',
    'refs/heads/claude/a$b',
    'refs/heads/claude/a;b',
    'refs/heads/claude/a`b`',
    'refs/heads/feature/x',
    'refs/tags/claude/x',
    'claude/x',
    'main',
    undefined,
  ]) {
    assert.equal(branchFromRef(bad), null, String(bad));
  }
});
