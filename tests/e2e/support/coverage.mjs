// Coverage per file, and a floor on the part that does not move. V8's own counts,
// from the browser (every spec, through the `wvw` fixture) and from `node --test`
// (the page's scripts in a node:vm, the /api Worker, the Supabase reader), joined by
// monocart-coverage-reports into lines and branches per file: site/js,
// worker/index.mjs and supabase/reader.mjs. The joined numbers are a report only.
// The floor is on node --test's numbers alone: data/coverage.json holds them, and a
// file that falls more than TOLERANCE points, in lines or branches, fails `check`.
// The browser's share stays out of it: two runs of one commit differ there (a page
// timer fires before a test ends or does not); node's are the same every run.
// There is no absolute target on purpose: a number to reach is met with a test that asserts nothing.
//
//   npm run coverage            everything, locally (the browser, then node), prints the table
//   npm run coverage:write      node --test, then rewrites data/coverage.json with its numbers (no browser run)
//   node support/coverage.mjs node    node --test with V8 coverage kept in test-results/coverage-node
//                                     (after the browser's run: Playwright empties test-results when it starts)
//   node support/coverage.mjs check   the table of the joined runs, and node's numbers compared with data/coverage.json
//   node support/coverage.mjs write   rewrite data/coverage.json from what `node` left
//   node support/coverage.mjs save <dir>    keep node --test's istanbul.json and its numbers (measured.json) in <dir>
//   node support/coverage.mjs untested <base>   after `check`: the lines `git diff <base> HEAD` added in site/js, worker and
//                                     supabase that no test ran, to the job summary; never fails (what a line asks is judgement)
//
// The browser side only measures with E2E_COVERAGE=1: the page is slower under it.
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { untestedLines, untestedText } from './untested.mjs';

const monocart = async () => (await import('monocart-coverage-reports')).CoverageReport;

const E2E = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(E2E, '..', '..');
const OUT = join(E2E, 'test-results', 'coverage');
const NODE_DIR = join(E2E, 'test-results', 'coverage-node');
// node's report alone: in OUT it would take in the browser's raw coverage too.
const NODE_OUT = join(E2E, 'test-results', 'coverage-node-report');
const COVERAGE_ON = !!process.env.E2E_COVERAGE;
export const TOLERANCE = 0.5;
const COMMITTED = join(E2E, 'data', 'coverage.json');

const options = (outputDir = OUT) => ({
  name: 'wvwrelink',
  outputDir,
  reports: [['json-summary', { file: 'summary.json' }], ['json', { file: 'istanbul.json' }]],
  // Only the page's scripts and the Worker; every other file the runs touched stays out.
  entryFilter: entry => /\/site\/js\/.+\.js$|\/(worker\/index|supabase\/reader)\.mjs$/.test(entry.url),
  sourceFilter: () => true,
  baseDir: ROOT,
  logging: 'error',
});

// What the browser calls a script: http://127.0.0.1:<port>/js/maps.js, or
// https://wvwrelink.com/js/maps.js under the fixture's `origin`. The port is
// the worker's, so the same file must answer to one name: the real file's.
const fileUrl = url => {
  const m = /^(?:https?:\/\/127\.0\.0\.1:\d+|https:\/\/wvwrelink\.com)\/(js\/[^?#]+\.js)(?:[?#].*)?$/.exec(url);
  return m && pathToFileURL(join(ROOT, 'site', m[1])).href;
};

// In a worker: start before the first navigation, stop at the end of the test.
export async function startCoverage(page) {
  if (!COVERAGE_ON) return null;
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  return page;
}

export async function addCoverage(started) {
  if (!started) return;
  // A script a test served changed (a spy appended) would be joined as another file and the real one's counts dropped.
  const entries = (await started.coverage.stopJSCoverage())
    .map(e => ({ ...e, url: fileUrl(e.url) }))
    .filter(e => e.url && e.source === readFileSync(fileURLToPath(e.url), 'utf8'));
  if (entries.length) await new (await monocart())(options()).add(entries);
}

// ---- the command line ----

const round = n => Math.round(n * 10) / 10;

async function measure(nodeOnly) {
  const report = new (await monocart())(options(nodeOnly ? NODE_OUT : OUT));
  if (existsSync(NODE_DIR)) await report.addFromDir(NODE_DIR);
  const results = await report.generate();
  const out = {};
  for (const f of results.files) {
    const name = f.sourcePath;
    out[name] = { lines: round(f.summary.lines.pct), branches: round(f.summary.branches.pct) };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const text = obj => JSON.stringify(obj, null, 2) + '\n';

function compare(measured, committed) {
  const fell = [], rose = [];
  for (const [file, was] of Object.entries(committed)) {
    const now = measured[file];
    if (!now) { fell.push(`${file}: no longer measured (was ${was.lines} % lines, ${was.branches} % branches)`); continue; }
    for (const k of ['lines', 'branches']) {
      if (Math.round((was[k] - now[k]) * 10) > TOLERANCE * 10) fell.push(`${file}: ${k} ${was[k]} % -> ${now[k]} %`);
      else if (Math.round((now[k] - was[k]) * 10) > TOLERANCE * 10) rose.push(`${file}: ${k} ${was[k]} % -> ${now[k]} %`);
    }
  }
  for (const file of Object.keys(measured)) if (!committed[file]) rose.push(`${file}: new file`);
  return { fell, rose };
}

function table(joined, node, committed) {
  const pair = v => (v ? `${v.lines} % / ${v.branches} %` : '-');
  const rows = ['| File | Lines | Branches | node --test (lines / branches) | Floor (lines / branches) |', '|---|---:|---:|---:|---:|'];
  for (const [file, now] of Object.entries(joined)) rows.push(`| ${file} | ${now.lines} % | ${now.branches} % | ${pair(node[file])} | ${pair(committed[file])} |`);
  return rows.join('\n');
}

function nodeTests() {
  rmSync(NODE_DIR, { recursive: true, force: true });
  execFileSync('node', ['--test', '--test-reporter=dot', 'tests/unit/*.test.mjs'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: NODE_DIR },
  });
}

// Not a check: whether a new line asks for a test is judgement (a guard against the impossible does not), so it only lists.
function untested(base) {
  let lines;
  if (!existsSync(join(OUT, 'istanbul.json'))) lines = 'No coverage report to read (the run before did not leave one).';
  else if (!base) lines = 'No base to compare with (not a pull request): skipped.';
  else {
    const diff = execFileSync('git', ['diff', '--unified=0', base, 'HEAD', '--', 'site/js', 'worker', 'supabase'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    lines = untestedText(untestedLines(diff, JSON.parse(readFileSync(join(OUT, 'istanbul.json'), 'utf8')), ROOT));
  }
  console.log(lines);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### New code no test runs\n\n' + lines + '\n');
}

async function main(command, ...args) {
  if (command === 'untested') return untested(args[0]);
  if (command === 'node') return nodeTests();
  if (command === 'save') {
    const dir = resolve(args[0] || '');
    if (!args[0]) throw new Error('coverage.mjs: save needs a folder');
    const node = await measure(true);
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(NODE_OUT, 'istanbul.json'), join(dir, 'istanbul.json'));
    writeFileSync(join(dir, 'measured.json'), text(node));
    return;
  }
  if (command === 'run') {
    // Playwright empties test-results when it starts, so the browser's run goes first.
    execFileSync('npx', ['playwright', 'test'], { cwd: E2E, stdio: 'inherit', env: { ...process.env, E2E_COVERAGE: '1' } });
    nodeTests();
    command = 'check';
  } else if (command === 'run-write') {
    nodeTests();
    command = 'write';
  }
  if (command !== 'check' && command !== 'write') throw new Error(`coverage.mjs: '${command}', wanted node, run, run-write, check, write, save or untested`);
  const node = await measure(true);
  if (command === 'write') {
    writeFileSync(COMMITTED, text(node));
    console.log(`coverage: ${COMMITTED} written, node --test's numbers, ${Object.keys(node).length} files`);
    return;
  }
  const joined = await measure(false);
  const committed = JSON.parse(readFileSync(COMMITTED, 'utf8'));
  const { fell, rose } = compare(node, committed);
  const lines = [table(joined, node, committed), '', 'Lines and Branches: every run joined, a report only. The floor is on node --test\'s numbers, which do not move between runs.'];
  if (fell.length) lines.push('', `**node --test coverage fell by more than ${TOLERANCE} points:**`, ...fell.map(l => `- ${l}`),
    '', 'A node test no longer runs what it ran, or the pull request added code to a file node measures and no node test runs it.',
    'Write the node test. If the new code is one only the browser can run, `npm run coverage:write` in tests/e2e lowers the floor, and the pull request says why.');
  if (rose.length && !fell.length) lines.push('', 'node --test coverage rose: run `npm run coverage:write` in tests/e2e and commit data/coverage.json.', ...rose.map(l => `- ${l}`));
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Coverage\n\n' + lines.join('\n') + '\n');
  if (fell.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(...process.argv.slice(2)).catch(e => { console.error(e.stack || e); process.exitCode = 1; });
}
