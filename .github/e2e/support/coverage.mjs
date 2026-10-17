// Measured coverage that may not fall. V8's own counts, from the
// browser (every spec, through the `wvw` fixture) and from `node --test` (the
// page's scripts in a node:vm and the /api Worker), joined by monocart-coverage-
// reports into lines and branches per file: site/js, worker/index.mjs and supabase/reader.mjs.
// coverage.json holds the committed numbers; a file that falls more than
// TOLERANCE points, in lines or branches, fails the job. There is no absolute
// target on purpose: a number to reach is met with a test that asserts nothing.
// Two runs of one commit differ by up to 0.5 point in a few files (measured 16/10/2026;
// suspected, not verified: real timers in maps.js, standings.js and api.js racing
// stopJSCoverage at teardown), so the committed number is the minimum per file
// over several runs, a fall is only reported past TOLERANCE and a rise only past it too.
// CI is the referee: its Google Chrome measured api.js 2.2 points lower than a
// local Chromium, the same in two runs (16/10/2026), so CI's runs are among them.
//
//   npm run coverage            everything, locally (node, then the browser), prints the table
//   npm run coverage:write      the same, then rewrites coverage.json (a PR that raises it commits it)
//   node support/coverage.mjs node    node --test with V8 coverage kept in test-results/coverage-node
//                                     (after the browser's run: Playwright empties test-results when it starts)
//   node support/coverage.mjs check   join what the two runs left, table, compare (CI)
//   node support/coverage.mjs write   join and rewrite coverage.json
//
// The browser side only measures with E2E_COVERAGE=1: the page is slower under it.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CoverageReport } from 'monocart-coverage-reports';

const E2E = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(E2E, '..', '..');
const OUT = join(E2E, 'test-results', 'coverage');
const NODE_DIR = join(E2E, 'test-results', 'coverage-node');
const COVERAGE_ON = !!process.env.E2E_COVERAGE;
export const TOLERANCE = 0.5;
const COMMITTED = join(E2E, 'coverage.json');

const options = () => ({
  name: 'wvwrelink',
  outputDir: OUT,
  reports: [['json-summary', { file: 'summary.json' }]],
  // Only the page's scripts and the Worker; every other file the runs touched stays out.
  entryFilter: entry => /\/site\/js\/.+\.js$|\/(worker\/index|supabase\/reader)\.mjs$/.test(entry.url),
  sourceFilter: () => true,
  baseDir: ROOT,
  logging: 'error',
});

// What the browser calls a script: http://127.0.0.1:<port>/js/maps.js. The port is
// the worker's, so the same file must answer to one name: the real file's.
const fileUrl = url => {
  const m = /^https?:\/\/127\.0\.0\.1:\d+\/(js\/[^?#]+\.js)(?:[?#].*)?$/.exec(url);
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
  const entries = (await started.coverage.stopJSCoverage())
    .map(e => ({ ...e, url: fileUrl(e.url) }))
    .filter(e => e.url);
  if (entries.length) await new CoverageReport(options()).add(entries);
}

// ---- the command line ----

const round = n => Math.round(n * 10) / 10;

async function measure() {
  const report = new CoverageReport(options());
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

function table(measured, committed) {
  const rows = ['| File | Lines | Branches | Committed (lines / branches) |', '|---|---:|---:|---:|'];
  for (const [file, now] of Object.entries(measured)) {
    const was = committed[file];
    rows.push(`| ${file} | ${now.lines} % | ${now.branches} % | ${was ? `${was.lines} % / ${was.branches} %` : '-'} |`);
  }
  return rows.join('\n');
}

function nodeTests() {
  rmSync(NODE_DIR, { recursive: true, force: true });
  execFileSync('node', ['--test', '--test-reporter=dot', 'tests/*.test.mjs'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: NODE_DIR },
  });
}

async function main(command) {
  if (command === 'node') return nodeTests();
  if (command === 'run' || command === 'run-write') {
    // Playwright empties test-results when it starts, so the browser's run goes first.
    execFileSync('npx', ['playwright', 'test'], { cwd: E2E, stdio: 'inherit', env: { ...process.env, E2E_COVERAGE: '1' } });
    nodeTests();
    command = command === 'run' ? 'check' : 'write';
  }
  if (command !== 'check' && command !== 'write') throw new Error(`coverage.mjs: '${command}', wanted node, run, run-write, check or write`);
  const measured = await measure();
  if (command === 'write') {
    writeFileSync(COMMITTED, text(measured));
    console.log(`coverage: ${COMMITTED} written, ${Object.keys(measured).length} files`);
    return;
  }
  const committed = JSON.parse(readFileSync(COMMITTED, 'utf8'));
  const { fell, rose } = compare(measured, committed);
  const lines = [table(measured, committed)];
  if (fell.length) lines.push('', `**Coverage fell by more than ${TOLERANCE} points:**`, ...fell.map(l => `- ${l}`));
  if (rose.length && !fell.length) lines.push('', 'Coverage rose: run `npm run coverage:write` in `.github/e2e` and commit `coverage.json`.', ...rose.map(l => `- ${l}`));
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Coverage\n\n' + lines.join('\n') + '\n');
  if (fell.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch(e => { console.error(e.stack || e); process.exitCode = 1; });
}
