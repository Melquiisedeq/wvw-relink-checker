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
// over several runs (`sweep --write`), a fall is only reported past TOLERANCE and a rise only past it too.
// CI is the referee: its Google Chrome measured api.js 2.2 points lower than a
// local Chromium, the same in two runs (16/10/2026), so CI's runs are among them.
//
//   npm run coverage            everything, locally (node, then the browser), prints the table
//   npm run coverage:write      the same, then rewrites coverage.json (a PR that raises it commits it)
//   node support/coverage.mjs node    node --test with V8 coverage kept in test-results/coverage-node
//                                     (after the browser's run: Playwright empties test-results when it starts)
//   node support/coverage.mjs check   join what the two runs left, table, compare (CI)
//   node support/coverage.mjs write   join and rewrite coverage.json
//   npm run coverage:sweep [-- N]     N runs (3), one at a time, kept in sweep-results/run-<i>, then the sweep report
//   node support/coverage.mjs save <dir>    join what the two runs left, keep istanbul.json and measured.json in <dir>
//   node support/coverage.mjs sweep <dir> [--write]   the lines and branches covered in some runs and not in others, and
//                                     those in none, over the runs saved under <dir> (one folder each); exit 1 if any
//                                     oscillates; --write rewrites coverage.json with the minimum per file and metric
//                                     (needs no node_modules: the CI sweep reads artifacts with it)
//
// The browser side only measures with E2E_COVERAGE=1: the page is slower under it.
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareRuns, minimumOf, sweepText } from './sweep.mjs';

// Loaded when needed: the sweep's report reads JSON only and runs without node_modules.
const monocart = async () => (await import('monocart-coverage-reports')).CoverageReport;

const E2E = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(E2E, '..', '..');
const OUT = join(E2E, 'test-results', 'coverage');
const NODE_DIR = join(E2E, 'test-results', 'coverage-node');
const COVERAGE_ON = !!process.env.E2E_COVERAGE;
export const TOLERANCE = 0.5;
const COMMITTED = join(E2E, 'coverage.json');
const SWEEP_DIR = join(E2E, 'sweep-results');

const options = () => ({
  name: 'wvwrelink',
  outputDir: OUT,
  reports: [['json-summary', { file: 'summary.json' }], ['json', { file: 'istanbul.json' }]],
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
  if (entries.length) await new (await monocart())(options()).add(entries);
}

// ---- the command line ----

const round = n => Math.round(n * 10) / 10;

async function measure() {
  const report = new (await monocart())(options());
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

// Each run's folder under dir: its istanbul report and its measured numbers.
function sweepRuns(dir) {
  const folders = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(dir, d.name, 'istanbul.json'))).map(d => join(dir, d.name)).sort();
  if (folders.length < 2) throw new Error(`coverage.mjs: ${folders.length} run(s) in ${dir}, a sweep needs at least 2`);
  return folders.map(f => ({ istanbul: JSON.parse(readFileSync(join(f, 'istanbul.json'), 'utf8')), measured: JSON.parse(readFileSync(join(f, 'measured.json'), 'utf8')) }));
}

// The source line of a file istanbul names (an absolute path, or relative to the repository).
const sourceLine = (file, line) => {
  const path = resolve(ROOT, file);
  try { return readFileSync(path, 'utf8').split('\n')[line - 1] || ''; } catch { return ''; }
};

async function sweep(dir, write) {
  const runs = sweepRuns(dir);
  const result = compareRuns(runs.map(r => r.istanbul), sourceLine);
  const lines = [sweepText(result), '', 'Lines are statements, by the line they start on; a branch is one arm of an if, ternary, `||`, `??` or default.'];
  const flaky = Object.values(result.files).reduce((n, f) => n + f.flaky.length, 0);
  const minimum = minimumOf(runs.map(r => r.measured));
  if (write) {
    writeFileSync(COMMITTED, text(minimum));
    lines.push('', `coverage.json rewritten with the minimum of ${runs.length} runs, ${Object.keys(minimum).length} files.`);
  }
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Coverage sweep\n\n' + lines.join('\n') + '\n');
  if (flaky) process.exitCode = 1;
}

async function main(command, ...args) {
  if (command === 'node') return nodeTests();
  if (command === 'sweep') return sweep(resolve(args.find(a => !a.startsWith('--')) || SWEEP_DIR), args.includes('--write'));
  if (command === 'save') {
    const dir = resolve(args[0] || '');
    if (!args[0]) throw new Error('coverage.mjs: save needs a folder');
    const measured = await measure();
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(OUT, 'istanbul.json'), join(dir, 'istanbul.json'));
    writeFileSync(join(dir, 'measured.json'), text(measured));
    return;
  }
  if (command === 'sweep-run') {
    const n = Number(args[0] || 3);
    if (!Number.isInteger(n) || n < 2) throw new Error('coverage.mjs: sweep-run wants a number of runs, 2 or more');
    rmSync(SWEEP_DIR, { recursive: true, force: true });
    for (let i = 1; i <= n; i++) {
      console.log(`sweep: run ${i} of ${n}`);
      execFileSync('npx', ['playwright', 'test', '--reporter=dot'], { cwd: E2E, stdio: 'inherit', env: { ...process.env, E2E_COVERAGE: '1' } });
      nodeTests();
      await main('save', join(SWEEP_DIR, `run-${i}`));
    }
    return sweep(SWEEP_DIR, false);
  }
  if (command === 'run' || command === 'run-write') {
    // Playwright empties test-results when it starts, so the browser's run goes first.
    execFileSync('npx', ['playwright', 'test'], { cwd: E2E, stdio: 'inherit', env: { ...process.env, E2E_COVERAGE: '1' } });
    nodeTests();
    command = command === 'run' ? 'check' : 'write';
  }
  if (command !== 'check' && command !== 'write') throw new Error(`coverage.mjs: '${command}', wanted node, run, run-write, check, write, save, sweep or sweep-run`);
  const measured = await measure();
  if (command === 'write') {
    writeFileSync(COMMITTED, text(measured));
    console.log(`coverage: ${COMMITTED} written, ${Object.keys(measured).length} files`);
    return;
  }
  const committed = JSON.parse(readFileSync(COMMITTED, 'utf8'));
  const { fell, rose } = compare(measured, committed);
  const lines = [table(measured, committed)];
  if (fell.length) lines.push('', `**Coverage fell by more than ${TOLERANCE} points:**`, ...fell.map(l => `- ${l}`),
    '', 'Two causes, and this check cannot tell which (it does not see the diff):',
    '- The pull request added code no test runs: write the test.',
    '- The file is not one the pull request touched: it is oscillation. Run the sweep (Actions > Coverage sweep), then cover what it lists with a test. The committed number never goes down.');
  if (rose.length && !fell.length) lines.push('', 'Coverage rose: run `npm run coverage:write` in `.github/e2e` and commit `coverage.json`.', ...rose.map(l => `- ${l}`));
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Coverage\n\n' + lines.join('\n') + '\n');
  if (fell.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(...process.argv.slice(2)).catch(e => { console.error(e.stack || e); process.exitCode = 1; });
}
