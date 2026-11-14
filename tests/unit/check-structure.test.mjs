// scripts/check-structure.py: check_readme with a fetched host the README table lacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('../../scripts/check-structure.py', import.meta.url).pathname;

const PROGRAM = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('check_structure', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.FETCHED['unlisted.example'] = ('https', 'a made-up host')
problems = []
mod.check_readme(problems)
print(json.dumps(problems))
`;

test('a fetched host missing from the README table is reported, not a crash', () => {
  const out = execFileSync('python3', ['-I', '-c', PROGRAM, SCRIPT], {
    cwd: new URL('../../', import.meta.url).pathname,
    encoding: 'utf8',
  });
  const problems = JSON.parse(out);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not list unlisted\.example.*a made-up host/);
});
