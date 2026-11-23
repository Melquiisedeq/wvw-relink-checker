// The list of what a pull request added and no test ran (tests/e2e/support/untested.mjs).
// Reports made by hand, istanbul's shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addedLines, mdCode, untestedLines, untestedText } from '../../e2e/support/untested.mjs';

const at = line => ({ start: { line } });

test('source text goes into a table cell with backslash and pipe escaped, no backtick, cut at 100', () => {
  assert.equal(mdCode('a\\|b `c`'), "a\\\\\\|b 'c'");
  assert.equal(mdCode('x'.repeat(150)).length, 100);
});

const stmt = (line, ran) => ({ line, ran });
const file = (...ss) => ({
  statementMap: Object.fromEntries(ss.map((x, i) => [i, { start: at(x.line).start }])),
  s: Object.fromEntries(ss.map((x, i) => [i, x.ran ? 1 : 0])),
});
const istanbul = { '/repo/site/js/a.js': file(stmt(10, true), stmt(11, false), stmt(12, false), stmt(12, true)), '/repo/worker/index.mjs': file(stmt(3, false)) };
const diff = [
  'diff --git a/site/js/a.js b/site/js/a.js', '--- a/site/js/a.js', '+++ b/site/js/a.js',
  '@@ -9,0 +10,5 @@ function x', '+ran();', '+notRan(`a|b`);', '+// a comment', '+', '+}',
  '@@ -20,2 +25,0 @@', '-removed', '-removed too',
  '@@ -30 +12 @@', '-old', '+mixed();',
].join('\n');

test('the lines a diff adds are read with their numbers; removals and deleted files add none', () => {
  assert.deepEqual(addedLines(diff)['site/js/a.js'].map(l => l.line), [10, 11, 12, 13, 14, 12]);
  assert.deepEqual(addedLines('--- a/x.js\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b'), {});
});

test('an added line a statement starts on and no test ran is listed; one that ran, a comment, a blank and a brace are not', () => {
  const { files, notMeasured } = untestedLines(diff, istanbul, '/repo');
  // line 12 holds two statements, one ran: covered. Line 11 did not run.
  assert.deepEqual(files['site/js/a.js'].map(l => l.line), [11]);
  assert.deepEqual(notMeasured, []);
});

test('a file outside site/js, worker and supabase, or not a script, is ignored; a script nothing measures is named', () => {
  const other = ['+++ b/tests/t.mjs', '@@ -0,0 +1 @@', '+x();', '+++ b/worker/schema.sql', '@@ -0,0 +1 @@', '+select 1;',
    '+++ b/supabase/other.mjs', '@@ -0,0 +1 @@', '+y();', '+++ b/worker/index.mjs', '@@ -0,0 +3 @@', '+a', '+b', '+c'].join('\n');
  const r = untestedLines(other, istanbul, '/repo');
  assert.deepEqual(r.notMeasured, ['supabase/other.mjs']);
  assert.deepEqual(Object.keys(r.files), ['worker/index.mjs']);
  assert.deepEqual(r.files['worker/index.mjs'].map(l => l.line), [3]);
});

test('relative istanbul paths work, and an empty diff says nothing is new', () => {
  const rel = { 'site/js/a.js': istanbul['/repo/site/js/a.js'] };
  assert.deepEqual(untestedLines(diff, rel, '/repo').files['site/js/a.js'].map(l => l.line), [11]);
  assert.equal(untestedText(untestedLines('', istanbul, '/repo')), 'Nothing new without a test.');
  assert.match(untestedText(untestedLines(diff, istanbul, '/repo')), /\| 11 \| `notRan\('a\\\|b'\);` \|/);
});

test('an added line that looks like a file header is content; a file name cannot make a link or tags', () => {
  const tricky = ['--- a/site/js/a.js', '+++ b/site/js/a.js', '@@ -1 +1,2 @@', '-old', '+++ i;', '+x();', '+++ b/worker/index.mjs', '@@ -0,0 +4 @@', '+y();'].join('\n');
  assert.deepEqual(addedLines(tricky), { 'site/js/a.js': [{ line: 1, text: '++ i;' }, { line: 2, text: 'x();' }], 'worker/index.mjs': [{ line: 4, text: 'y();' }] });
  const name = 'site/js/[x](https://e.example)<b>.js';
  const out = untestedText({ files: {}, notMeasured: [name] });
  assert.ok(out.includes('- `site/js/[x](https://e.example)<b>.js`'));
  const listed = untestedText({ files: { [name]: [{ line: 1, text: 'z' }] }, notMeasured: [] });
  assert.ok(listed.startsWith('**`site/js/[x](https://e.example)<b>.js`**'));
});
