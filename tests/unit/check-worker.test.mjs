// scripts/check-worker.py with the network made up: what it reads out of worker/index.mjs, and
// the summary judged by its oldest match, and every source of the entrance asked for its door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../../scripts/check-worker.py', import.meta.url).pathname;

function py(code, input = '', script = SCRIPT) {
  return JSON.parse(execFileSync('python3', ['-I', '-c', `
import importlib.util, json, os, sys, time
sys.path.insert(0, os.path.dirname(sys.argv[1]))
spec = importlib.util.spec_from_file_location('check_worker', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
arg = json.loads(sys.stdin.read() or 'null')
${code}
`, script], { input: JSON.stringify(input), encoding: 'utf8' }));
}

test('the deadlines follow worker/index.mjs: a changed number is read, not remembered', () => {
  const [a, b, reset] = py(`
body = 'const STALE_KILLS_S = 7 * 60;\\nconst SKIRMISH_MS = 3 * 3600e3;\\nconst RESET = { 1: { day: 1, hour: 2 }, 2: { day: 3, hour: 4 } };'
print(json.dumps([mod.worker_seconds(body, 'STALE_KILLS_S'), mod.worker_seconds(body, 'SKIRMISH_MS'),
                  mod.worker_reset(body)]))
`);
  assert.equal(a, 420);
  assert.equal(b, 10800);
  assert.deepEqual(reset, { 1: [1, 2], 2: [3, 4] });
});

test('every source of the Worker\'s entrance gets its unsigned POST', () => {
  const urls = py(`
asked = []
mod.request = lambda url, method='GET', body=None: (asked.append(method + ' ' + url) or (401, ''))
mod.check_doors([], [])
print(json.dumps(asked))
`);
  for (const name of ['kills', 'relink', 'latest-supa-us', 'latest-supa-eu']) {
    assert.ok(urls.includes('POST https://wvwrelink.com/api/ingest/' + name), name);
  }
});

test('one stale match among fresh ones fails the summary', () => {
  const log = py(`
now = int(time.time())
week = mod.week_start(1, now) * 1000
def get(url):
    if url.endswith('latest/summary'):
        return {'1-1': {'start': week, 'score': 1, 'at': now, 'by': 'latest-supa-us'},
                '1-2': {'start': week, 'score': 1, 'at': now - 3 * 3600, 'by': 'latest-supa-us'}}, None
    return [], None
mod.get_json = get
problems, notes = [], []
mod.check_latest(problems, notes)
print(json.dumps(problems))
`);
  assert.ok(log.some((p) => /oldest match is 180 minutes old/.test(p)), log.join('\n'));
});

test('a tier left from last week, still in the summary, is not judged', () => {
  const problems = py(`
now = int(time.time())
week = mod.week_start(1, now) * 1000
def get(url):
    if url.endswith('latest/summary'):
        return {'1-1': {'start': week, 'score': 1, 'at': now, 'by': 'latest-supa-us'},
                '1-2': {'start': week - 7 * 86400000, 'score': 1, 'at': now - 100 * 60, 'by': 'latest-supa-us'}}, None
    return [], None
mod.get_json = get
problems, notes = [], []
mod.check_latest(problems, notes)
print(json.dumps(problems))
`);
  assert.ok(!problems.some((p) => /oldest match/.test(p)), problems.join('\n'));
});

test('a deadline in milliseconds written as a product is read in seconds, and a guess is refused', () => {
  const r = py(`
out = [mod.worker_seconds('const SKIRMISH_MS = 7200 * 1000;', 'SKIRMISH_MS'),
       mod.worker_seconds('const STALE_X_MS = 2 * 3600e3;', 'STALE_X_MS')]
try:
    mod.worker_seconds('const SKIRMISH_MS = HOUR * 2;', 'SKIRMISH_MS')
    out.append('guessed')
except SystemExit:
    out.append('refused')
print(json.dumps(out))
`);
  assert.deepEqual(r, [7200, 7200, 'refused']);
});

test('the deadline the check uses is the one in the Worker file, not a copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cw-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'worker'));
  cpSync(SCRIPT, join(dir, 'scripts', 'check-worker.py'));
  cpSync(join(SCRIPT, '..', 'workflow_text.py'), join(dir, 'scripts', 'workflow_text.py'));
  const worker = readFileSync(new URL('../../worker/index.mjs', import.meta.url), 'utf8')
    .replace('STALE_KILLS_S = 20 * 60', 'STALE_KILLS_S = 7 * 60')
    .replace('STALE_LATEST_S = 10 * 60', 'STALE_LATEST_S = 3 * 60')
    .replace('STALE_RELINK_S = 45 * 60', 'STALE_RELINK_S = 9 * 60')
    .replace('SKIRMISH_MS = 2 * 3600e3', 'SKIRMISH_MS = 3 * 3600e3');
  writeFileSync(join(dir, 'worker', 'index.mjs'), worker);
  const r = py(`
print(json.dumps([mod.KILLS_WORKER_STALE, mod.LATEST_WORKER_STALE, mod.STALE['relink'], mod.SKIRMISH_SECONDS]))
`, '', join(dir, 'scripts', 'check-worker.py'));
  assert.deepEqual(r, [420, 180, 540, 10800]);
});
