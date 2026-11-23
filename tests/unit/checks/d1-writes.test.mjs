// scripts/check-d1-writes.py with the API made up: how it reads the rows of each day and what it
// fails on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('../../../scripts/check-d1-writes.py', import.meta.url).pathname;

function py(code, input = '') {
  return JSON.parse(execFileSync('python3', ['-I', '-c', `
import importlib.util, json, os, sys
sys.path.insert(0, os.path.dirname(sys.argv[1]))
spec = importlib.util.spec_from_file_location('check_d1_writes', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
arg = json.loads(sys.stdin.read() or 'null')
${code}
`, SCRIPT], { input: JSON.stringify(input), encoding: 'utf8' }));
}

const answer = (rows) => ({
  data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups:
    Object.entries(rows).map(([date, n]) => ({ sum: { rowsWritten: n }, dimensions: { date } })) }] } },
});
const judge = (a) => py(`print(json.dumps(mod.judge(arg, '2026-11-16', '2026-11-17')))`, a);

test('two days under 80,000 pass, and the line says both numbers', () => {
  const [line, problems] = judge(answer({ '2026-11-16': 52000, '2026-11-17': 31000 }));
  assert.equal(line, 'D1 rows written (limit 80000): 2026-11-16 52000, 2026-11-17 31000');
  assert.deepEqual(problems, []);
});

test('80,000 passes, 80,001 on either day fails naming the day', () => {
  assert.deepEqual(judge(answer({ '2026-11-16': 80000, '2026-11-17': 1 }))[1], []);
  const [, y] = judge(answer({ '2026-11-16': 80001, '2026-11-17': 1 }));
  assert.equal(y.length, 1);
  assert.match(y[0], /passed 80000 on 2026-11-16\./);
  const [, t] = judge(answer({ '2026-11-16': 5, '2026-11-17': 90000 }));
  assert.match(t[0], /on 2026-11-17\./);
});

test('an answer with errors fails and prints the codes, not the message', () => {
  const [line, problems] = judge({ data: null, errors: [
    { message: 'echo of the query secret-xyz', extensions: { code: 'authz' } }] });
  assert.equal(line, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1 error\(s\) \(authz\)/);
  assert.ok(!problems[0].includes('secret-xyz'));
});

test('an empty list fails on yesterday; today with no rows yet passes', () => {
  const [, none] = judge(answer({}));
  assert.equal(none.length, 1);
  assert.match(none[0], /none on 2026-11-16/);
  const [, ok] = judge(answer({ '2026-11-16': 50000 }));
  assert.deepEqual(ok, []);
});

test('an answer of another shape fails', () => {
  const [line, problems] = judge({ data: { viewer: { accounts: [] } } });
  assert.equal(line, null);
  assert.equal(problems.length, 1);
});

test('the query is built from checked values only', () => {
  const r = py(`
out = []
for account, day in (('a' * 32, '2026-11-16'), ('a' * 32 + '\\n', '2026-11-16'), ('a' * 32, '2026-11-16"')):
    try:
        mod.build_query(account, mod.database_id(), day, '2026-11-17')
        out.append('built')
    except ValueError:
        out.append('refused')
print(json.dumps(out))
`);
  assert.deepEqual(r, ['built', 'refused', 'refused']);
});
