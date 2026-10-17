// The rules of the coverage sweep (.github/e2e/support/sweep.mjs): what oscillates between runs,
// what no run covers, and the minimum per file. Reports made by hand, istanbul's shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addedLines, compareRuns, mdCode, minimumOf, sweepText, untestedLines, untestedText } from '../.github/e2e/support/sweep.mjs';

const at = line => ({ start: { line } });
// Statements on lines 1, 2, 3; one if on line 2 with two arms (lines 2 and 3).
const report = (s, b) => ({
  'a.js': {
    statementMap: { 0: { start: at(1).start }, 1: { start: at(2).start }, 2: { start: at(3).start } },
    s,
    branchMap: { 0: { type: 'if', loc: { start: at(2).start }, locations: [{ start: at(2).start }, { start: at(3).start }] } },
    b: { 0: b },
  },
});

test('a line or a branch covered in some runs only is flaky, with how many', () => {
  const runs = [report({ 0: 1, 1: 1, 2: 0 }, [1, 0]), report({ 0: 1, 1: 1, 2: 1 }, [1, 0]), report({ 0: 1, 1: 1, 2: 0 }, [1, 0])];
  const { files } = compareRuns(runs, (file, line) => `  code of ${file}:${line} `);
  assert.deepEqual(files['a.js'].flaky, [{ line: 3, kind: 'line', type: 'statement', text: 'code of a.js:3', hits: 1 }]);
  const flipped = compareRuns([report({ 0: 1, 1: 1, 2: 1 }, [1, 0]), report({ 0: 1, 1: 1, 2: 1 }, [1, 1])]);
  assert.deepEqual(flipped.files['a.js'].flaky, [{ line: 3, kind: 'branch', type: 'if', text: '', hits: 1 }]);
});

test('what no run covers is counted apart and is not flaky', () => {
  const { files } = compareRuns([report({ 0: 1, 1: 0, 2: 0 }, [1, 0]), report({ 0: 1, 1: 0, 2: 0 }, [1, 0])]);
  assert.deepEqual(files['a.js'].flaky, []);
  assert.deepEqual(files['a.js'].never, { lines: 2, branches: 1 });
});

test('a line with several statements is covered when any of them ran', () => {
  const two = s => ({ 'b.js': { statementMap: { 0: { start: at(5).start }, 1: { start: at(5).start } }, s, branchMap: {}, b: {} } });
  const { files } = compareRuns([two({ 0: 1, 1: 0 }), two({ 0: 0, 1: 0 })]);
  assert.equal(files['b.js'].flaky.length, 1);
  assert.equal(files['b.js'].flaky[0].hits, 1);
});

test('the minimum is taken per file and metric, from every run', () => {
  const min = minimumOf([
    { 'b.js': { lines: 90, branches: 80 }, 'a.js': { lines: 70.5, branches: 60 } },
    { 'b.js': { lines: 85, branches: 82 }, 'a.js': { lines: 72, branches: 55.5 } },
    { 'c.js': { lines: 100, branches: 100 } },
  ]);
  assert.deepEqual(min, { 'a.js': { lines: 70.5, branches: 55.5 }, 'b.js': { lines: 85, branches: 80 }, 'c.js': { lines: 100, branches: 100 } });
  assert.deepEqual(Object.keys(min), ['a.js', 'b.js', 'c.js']);
});

test('the text names the line, the kind, the count and the code', () => {
  const runs = [report({ 0: 1, 1: 1, 2: 1 }, [1, 0]), report({ 0: 1, 1: 1, 2: 0 }, [1, 0])];
  const out = sweepText(compareRuns(runs, () => 'if (a || b)'));
  assert.match(out, /\| 3 \| line \| 1 of 2 \| `if \(a \\\|\\\| b\)` \|/);
});

test('source text goes into a table cell with backslash and pipe escaped, no backtick, cut at 100', () => {
  assert.equal(mdCode('a\\|b `c`'), "a\\\\\\|b 'c'");
  assert.equal(mdCode('x'.repeat(150)).length, 100);
});

// ---- what a pull request added and no test ran ----

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
