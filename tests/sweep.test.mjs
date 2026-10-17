// The rules of the coverage sweep (.github/e2e/support/sweep.mjs): what oscillates between runs,
// what no run covers, and the minimum per file. Reports made by hand, istanbul's shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRuns, mdCode, minimumOf, sweepText } from '../.github/e2e/support/sweep.mjs';

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
