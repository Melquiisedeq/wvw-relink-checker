// The page's rules in js/boot.js, run in Node without a browser: the scripts load into a node:vm and the rules are fed
// bodies from the e2e recording, mutated by a fixed-seed PRNG where a test says so (page/harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { matches } from './harness.mjs';

test('emberField: stop then start in the same frame leaves one frame chain (js/boot.js)', () => {
  const src = fs.readFileSync(new URL('../../../site/js/boot.js', import.meta.url), 'utf8');
  const a = src.indexOf('const emberField = (function () {');
  const b = src.indexOf('\n})();', a);
  assert.ok(a >= 0 && b > a);
  const dummy = () => {
    const f = function () { return p; };
    const p = new Proxy(f, {
      get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : p),
      apply: () => p, construct: () => p, set: () => true,
    });
    return p;
  };
  const queue = new Map();
  let nextId = 1;
  const g = {
    console, Math, Date, performance: { now: () => 0 }, document: dummy(), window: dummy(),
    requestAnimationFrame: (cb) => { const id = nextId++; queue.set(id, cb); return id; },
    cancelAnimationFrame: (id) => { queue.delete(id); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class { observe() {} },
  };
  const ctx = vm.createContext(g);
  vm.runInContext(`${src.slice(a, b + 5)}\nglobalThis.__field = emberField;`, ctx);
  const field = ctx.__field;
  queue.clear();
  field.start();
  field.stop();
  field.start();
  const due = [...queue.values()];
  queue.clear();
  for (const cb of due) cb(1000);   // one frame: each live chain asks for the next
  assert.equal(queue.size, 1);
});
