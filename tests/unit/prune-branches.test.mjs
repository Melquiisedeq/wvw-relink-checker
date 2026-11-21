import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, branchFromRef, main } from '../../.github/scripts/prune-branches.mjs';

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

const API = 'https://api.github.com';
const REPO = 'owner/repo';
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

const ref = (name, sha) => ({ ref: `refs/heads/${name}`, object: { sha } });
const json = (body, headers = {}) => ({
  ok: true,
  status: 200,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

const BRANCHES = {
  'claude/old': { sha: 'a1', ahead: 4, days: 5 },
  'claude/merged': { sha: 'a2', ahead: 0, days: 0.1 },
  'claude/recent': { sha: 'a3', ahead: 2, days: 1 },
  'claude/has-head-pr': { sha: 'a4', ahead: 4, days: 9, head: 1 },
  'claude/has-base-pr': { sha: 'a5', ahead: 0, days: 9, base: 1 },
  'claude/dir/nested.old': { sha: 'a6', ahead: 3, days: 8 },
};
const PAGE1 = `${API}/repos/${REPO}/git/matching-refs/heads/claude?per_page=100`;
const PAGE2 = `${API}/repos/${REPO}/git/matching-refs/heads/claude?per_page=100&page=2`;
const OUTSIDE = 'https://evil.example/repos/x/matching-refs?page=3';

const realFetch = globalThis.fetch;
let calls;
let env;
let logs;

function fakeFetch({ failOn } = {}) {
  return async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, headers: opts.headers });
    if (failOn && failOn(method, url)) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    if (url === PAGE1) {
      return json(
        [
          ref('claude/old', 'a1'),
          ref('claude/merged', 'a2'),
          ref('claude/recent', 'a3'),
          ref('claude/has-head-pr', 'a4'),
          ref('claude/has-base-pr', 'a5'),
        ],
        { link: `<${PAGE2}>; rel="next", <${API}/last>; rel="last"` },
      );
    }
    if (url === PAGE2) {
      return json(
        [
          { ref: 'refs/heads/claude/../main', object: { sha: 'b1' } },
          { ref: 'refs/heads/main', object: { sha: 'b2' } },
          { ref: 'refs/heads/claudex/nope', object: { sha: 'b3' } },
          ref('claude/dir/nested.old', 'a6'),
        ],
        { link: `<${OUTSIDE}>; rel="next"` },
      );
    }
    const u = new URL(url);
    const name = (n) => BRANCHES[decodeURIComponent(n)];
    if (u.pathname === `/repos/${REPO}/pulls`) {
      const head = u.searchParams.get('head');
      const base = u.searchParams.get('base');
      if (head !== null && !head.startsWith('owner:')) throw new Error(`bad head ${head}`);
      const b = BRANCHES[head !== null ? head.slice('owner:'.length) : base];
      return json((head ? b.head : b.base) ? [{ number: 7 }] : []);
    }
    let m = u.pathname.match(new RegExp(`^/repos/${REPO}/compare/main\\.\\.\\.(.+)$`));
    if (m) return json({ ahead_by: name(m[1]).ahead });
    m = u.pathname.match(new RegExp(`^/repos/${REPO}/commits/(.+)$`));
    if (m) {
      const b = Object.values(BRANCHES).find((x) => x.sha === m[1]);
      return json({ commit: { committer: { date: iso(b.days) } } });
    }
    if (method === 'DELETE') return { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}) };
    throw new Error(`unexpected ${method} ${url}`);
  };
}

const deletes = () => calls.filter((c) => c.method === 'DELETE').map((c) => c.url.slice(API.length));
const summaryFile = () => env.GITHUB_STEP_SUMMARY;

beforeEach(() => {
  calls = [];
  logs = [];
  env = {
    GITHUB_REPOSITORY: REPO,
    GH_TOKEN: 'tok',
  };
  env.dir = mkdtempSync(join(tmpdir(), 'prune-'));
  env.GITHUB_STEP_SUMMARY = join(env.dir, 'summary.md');
  for (const k of ['GITHUB_REPOSITORY', 'GITHUB_STEP_SUMMARY', 'GH_TOKEN', 'DRY_RUN']) {
    env['_old_' + k] = process.env[k];
    delete process.env[k];
  }
  mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
});

afterEach(() => {
  mock.restoreAll();
  for (const k of ['GITHUB_REPOSITORY', 'GITHUB_STEP_SUMMARY', 'GH_TOKEN', 'DRY_RUN']) {
    if (env['_old_' + k] === undefined) delete process.env[k];
    else process.env[k] = env['_old_' + k];
  }
  globalThis.fetch = realFetch;
  rmSync(env.dir, { recursive: true, force: true });
});

function run(dryRun, opts) {
  process.env.GITHUB_REPOSITORY = env.GITHUB_REPOSITORY;
  process.env.GITHUB_STEP_SUMMARY = env.GITHUB_STEP_SUMMARY;
  process.env.GH_TOKEN = env.GH_TOKEN;
  if (dryRun === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = dryRun;
  globalThis.fetch = fakeFetch(opts);
  return main();
}

const EXPECTED_LINES = [
  'delete  stale  a1  claude/old',
  'delete  merged  a2  claude/merged',
  'keep  recent  a3  claude/recent',
  'keep  open-pr  a4  claude/has-head-pr',
  'keep  open-pr  a5  claude/has-base-pr',
  'keep  bad-name  "refs/heads/claude/../main"',
  'keep  bad-name  "refs/heads/main"',
  'keep  bad-name  "refs/heads/claudex/nope"',
  'delete  stale  a6  claude/dir/nested.old',
];

for (const dry of [undefined, 'true', 'TRUE', '', 'False']) {
  test(`DRY_RUN=${JSON.stringify(dry)}: nothing is deleted, the summary says what would be`, async () => {
    await run(dry);
    assert.deepEqual(deletes(), []);
    const summary = 'dry run: 3 of 9 would be deleted';
    assert.deepEqual(logs, [...EXPECTED_LINES, summary]);
    assert.equal(readFileSync(summaryFile(), 'utf8'), `\`\`\`\n${[...EXPECTED_LINES, summary].join('\n')}\n\`\`\`\n`);
  });
}

test('DRY_RUN=false: exactly the three verdicts "delete" are requested, under refs/heads/claude/', async () => {
  await run('false');
  assert.deepEqual(deletes(), [
    '/repos/owner/repo/git/refs/heads/claude/old',
    '/repos/owner/repo/git/refs/heads/claude/merged',
    '/repos/owner/repo/git/refs/heads/claude/dir/nested.old',
  ]);
  for (const d of deletes()) assert.match(d, /^\/repos\/owner\/repo\/git\/refs\/heads\/claude\/[^.]/);
  const summary = 'deleted 3 of 9';
  assert.deepEqual(logs, [...EXPECTED_LINES, summary]);
  assert.match(readFileSync(summaryFile(), 'utf8'), /deleted 3 of 9\n```\n$/);
});

test('pagination follows next inside api.github.com and never leaves it', async () => {
  await run('false');
  const gets = calls.filter((c) => c.method === 'GET').map((c) => c.url);
  assert.ok(gets.includes(PAGE1) && gets.includes(PAGE2));
  assert.ok(!calls.some((c) => c.url === OUTSIDE));
  for (const c of calls) {
    assert.ok(c.url.startsWith(`${API}/repos/${REPO}/`), c.url);
    assert.equal(c.headers.Authorization, 'Bearer tok');
  }
});

test('a branch with an open pull request as head or as base is never deleted', async () => {
  await run('false');
  assert.ok(!deletes().some((d) => d.includes('has-head-pr') || d.includes('has-base-pr')));
});

test('an HTTP error in the middle stops the run: no later DELETE, no summary file', async () => {
  await assert.rejects(
    run('false', { failOn: (m, u) => u.includes('/compare/main...claude/recent') }),
    /answered 500/,
  );
  assert.deepEqual(deletes(), [
    '/repos/owner/repo/git/refs/heads/claude/old',
    '/repos/owner/repo/git/refs/heads/claude/merged',
  ]);
  assert.equal(existsSync(summaryFile()), false);
});

test('a failing DELETE stops the run before any later request', async () => {
  await assert.rejects(run('false', { failOn: (m) => m === 'DELETE' }), /DELETE .* answered 500/);
  assert.equal(deletes().length, 1);
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(existsSync(summaryFile()), false);
});

test('without GITHUB_STEP_SUMMARY nothing is written and the run still ends', async () => {
  process.env.GITHUB_STEP_SUMMARY = '';
  env.GITHUB_STEP_SUMMARY = '';
  await run(undefined);
  assert.equal(logs.at(-1), 'dry run: 3 of 9 would be deleted');
});
