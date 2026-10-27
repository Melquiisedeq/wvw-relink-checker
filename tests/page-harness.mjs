// Loads the page's scripts into a node:vm, in the order of site/index.html,
// without a browser. The rules under test are plain functions in the scripts'
// shared global scope, so tests call them through `run`. boot.js (it starts
// the page) is left out. The clock is the
// harness's: Date.now() and new Date() inside the context answer clock.now.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = path.join(root, 'site');
const SKIPPED = new Set(['js/boot.js']);

// Any property read, call or construction on the page's DOM answers itself.
function dummy() {
  const f = function () { return p; };
  const p = new Proxy(f, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : p),
    apply: () => p,
    construct: () => p,
    set: () => true,
  });
  return p;
}

// Then the scripts one of them loads later by a quoted path (js/maps.js, by
// js/maps-early.js), as the page has them once the standings are drawn.
export function scriptFiles() {
  const html = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');
  const listed = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((s) => s.startsWith('js/') && !SKIPPED.has(s));
  const late = listed.flatMap((s) => [...fs.readFileSync(path.join(siteDir, s), 'utf8')
    .matchAll(/'(js\/[\w.-]+\.js)'/g)].map((m) => m[1]));
  return [...listed, ...new Set(late.filter((s) => !listed.includes(s)))];
}

export function loadPage(startAt = 0) {
  const clock = { now: startAt };
  class ClockDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  }
  const store = new Map();
  const g = {
    console, Date: ClockDate, document: dummy(),
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    navigator: { userAgent: 'test', language: 'en' },
    location: { search: '', href: 'http://localhost/', hash: '' },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: () => new Promise(() => {}),
    addEventListener() {}, requestAnimationFrame() {},
    IntersectionObserver: class { observe() {} }, ResizeObserver: class { observe() {} },
  };
  g.window = g;
  const ctx = vm.createContext(g);
  for (const f of scriptFiles()) {
    const file = path.join(siteDir, f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  }
  return { clock, run: (code) => vm.runInContext(code, ctx), ctx };
}

export function loadRecording() {
  const file = path.join(root, '.github/e2e/recordings.json.gz');
  const rec = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const all = JSON.parse(rec.entries['https://api.guildwars2.com/v2/wvw/matches?ids=all'][2]);
  return { recordedAt: rec.recordedAt, matches: all };
}

// Fixed-seed PRNG (mulberry32): the same mutations on every run.
export function prng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (a) => a[next.int(a.length)];
  return next;
}
