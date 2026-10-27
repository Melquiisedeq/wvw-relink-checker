// Deletes the claude/... branches with no open pull request (as head or as
// base) whose commits are all in main, or whose last commit is over three days
// old. Nothing is deleted unless DRY_RUN is exactly "false".
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
const REF_PATTERN = /^refs\/heads\/claude\/[A-Za-z0-9._/-]+$/;

// The pattern alone lets "claude/../main" through; a segment must be a real name.
export function branchFromRef(ref) {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return null;
  const name = ref.slice('refs/heads/'.length);
  const segments = name.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return name;
}

// An open pull request always keeps the branch. A missing number keeps it too.
export function decide({ openPulls, aheadBy, lastCommitDate, now }) {
  if (!Number.isInteger(openPulls) || openPulls < 0) return { action: 'keep', reason: 'unknown-pulls' };
  if (openPulls > 0) return { action: 'keep', reason: 'open-pr' };
  if (aheadBy === 0) return { action: 'delete', reason: 'merged' };
  if (!Number.isInteger(aheadBy)) return { action: 'keep', reason: 'unknown-ahead' };
  const last = Date.parse(lastCommitDate);
  if (Number.isNaN(last)) return { action: 'keep', reason: 'unknown-date' };
  if (now - last > STALE_MS) return { action: 'delete', reason: 'stale' };
  return { action: 'keep', reason: 'recent' };
}

const encodePath = (name) => name.split('/').map(encodeURIComponent).join('/');

async function call(url, method = 'GET') {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const res = await fetch(url, { method, headers });
  if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}`);
  return res;
}

async function listRefs(repo) {
  const refs = [];
  let url = `${API}/repos/${repo}/git/matching-refs/heads/claude?per_page=100`;
  while (url) {
    const res = await call(url);
    refs.push(...(await res.json()));
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') || '');
    url = next && next[1].startsWith(`${API}/`) ? next[1] : null;
  }
  return refs;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || 'Melquiisedeq/wvw-relink-checker';
  const owner = repo.split('/')[0];
  const dryRun = process.env.DRY_RUN !== 'false';
  const now = Date.now();
  const lines = [];
  let deleted = 0;

  for (const ref of await listRefs(repo)) {
    const name = branchFromRef(ref.ref);
    if (!name) {
      const line = `keep  bad-name  ${JSON.stringify(ref.ref)}`;
      console.log(line);
      lines.push(line);
      continue;
    }
    const path = encodePath(name);
    const asHead = await (await call(`${API}/repos/${repo}/pulls?state=open&head=${encodeURIComponent(owner)}:${encodeURIComponent(name)}`)).json();
    const asBase = await (await call(`${API}/repos/${repo}/pulls?state=open&base=${encodeURIComponent(name)}`)).json();
    const compare = await (await call(`${API}/repos/${repo}/compare/main...${path}`)).json();
    const commit = await (await call(`${API}/repos/${repo}/commits/${encodeURIComponent(ref.object.sha)}`)).json();
    const verdict = decide({
      openPulls: Array.isArray(asHead) && Array.isArray(asBase) ? asHead.length + asBase.length : NaN,
      aheadBy: compare.ahead_by,
      lastCommitDate: commit.commit && commit.commit.committer && commit.commit.committer.date,
      now,
    });
    const line = `${verdict.action}  ${verdict.reason}  ${ref.object.sha}  ${name}`;
    console.log(line);
    lines.push(line);
    if (verdict.action === 'delete' && !dryRun) {
      await call(`${API}/repos/${repo}/git/refs/heads/${path}`, 'DELETE');
      deleted += 1;
    }
  }

  const toDelete = lines.filter((l) => l.startsWith('delete')).length;
  const summary = dryRun
    ? `dry run: ${toDelete} of ${lines.length} would be deleted`
    : `deleted ${deleted} of ${lines.length}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${[...lines, summary].join('\n')}\n\`\`\`\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`prune-branches: ${err.message}`);
    process.exit(1);
  });
}
