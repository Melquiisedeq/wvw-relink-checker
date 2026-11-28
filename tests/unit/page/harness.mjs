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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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
  const late = [...listed, ...SKIPPED].flatMap((s) => [...fs.readFileSync(path.join(siteDir, s), 'utf8')
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
    console, URL, Date: ClockDate, document: dummy(),
    setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
    },
    navigator: { userAgent: 'test', language: 'en' },
    location: { search: '', href: 'http://localhost/', hash: '' },
    __mediaQueries: 0,
    matchMedia: () => { g.__mediaQueries++; return { matches: false, addEventListener() {} }; },
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
  const file = path.join(root, 'tests/e2e/data/recordings.json.gz');
  const rec = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const all = JSON.parse(rec.entries['https://api.guildwars2.com/v2/wvw/matches?ids=all'][2]);
  return { recordedAt: rec.recordedAt, matches: all };
}

export { prng } from '../prng.mjs';

// The recording's matches, and the helpers more than one file of this folder uses.
export const { recordedAt, matches } = loadRecording();

export const MIN = 60000;

export const clone = (x) => JSON.parse(JSON.stringify(x));

export function fresh() {
  const page = loadPage(recordedAt);
  const call = (name, ...args) => {
    page.ctx.__args = args;
    return page.run(`${name}(...__args)`);
  };
  const set = (code, value) => { page.ctx.__v = value; page.run(`${code} = __v`); };
  return { ...page, call, set };
}

// A match body of the recording, as it would be `k` steps further into the
// week: kills, deaths and scores only grow (the invariant matchIsBehind uses).
export function state(base, k) {
  const m = clone(base);
  m.kills.red += 100 * k;
  m.deaths.red += 100 * k;
  m.scores.red += 50 * k;
  return m;
}

// The week memory, driven through weekStoreOffer: what it keeps of a tier is read back.
export function weekBody(base, id, startAt, endAt) {
  const m = clone(base);
  m.id = id;
  m.start_time = new Date(startAt).toISOString();
  m.end_time = new Date(endAt).toISOString();
  return m;
}

// Relink night: which team a guild is on and what line-up a tier shows. The NA tiers of the recording,
// each by its id, all live and on one week.
export const naTiers = () => ['1-1', '1-2', '1-3', '1-4'].map((id) => clone(matches.find((m) => m.id === id)));

export const teamsOf = (p, m) => ['red', 'blue', 'green'].map((c) => p.call('matchTeamId', m, c));

export const bodyAt = (m, startAt) => weekBody(m, m.id, startAt, startAt + 7 * 24 * 60 * MIN);

export const openMatch = matches.find((m) => Date.parse(m.end_time) > recordedAt && m.maps.some((x) => x.kills));

export const OPEN_ID = openMatch.id;

// The recorded open match match, `k` steps into its week: only ever more kills, deaths and score.
export function stepOf(k) {
  const m = clone(openMatch);
  m.kills.red += 100 * k;
  m.deaths.red += 100 * k;
  m.scores.red += 50 * k;
  for (const map of m.maps) map.kills.red = Number(map.kills.red || 0) + 40 * k;
  return m;
}

// ---- What happened while the data was away (js/maps-early.js) --------------
// The open match kept, then bodies offered to missedMatchOffered.
export const FLIP_TO = { Red: 'Blue', Blue: 'Green', Green: 'Red' };

export function happened() {
  const p = fresh();
  const id = OPEN_ID;
  p.call('keepNewestMatch', clone(openMatch));
  const now = p.clock.now;
  const reset = () => p.run('missedNotes.clear(); missedLastOffer.clear(); missedRings.clear(); missedReturn = null; missedHidden = null;');
  const after = (base) => {
    const m = clone(base || openMatch);
    const taken = [];
    for (const map of m.maps) {
      const o = map.objectives.find((x) => ['Camp', 'Tower', 'Keep'].includes(x.type));
      if (o && taken.length < 2) { o.owner = FLIP_TO[o.owner] || 'Red'; o.last_flipped = new Date(now).toISOString(); taken.push(o.id); }
    }
    m.maps[0].kills.red += 30; m.maps[0].kills.blue += 20; m.scores.red += 10;
    return { m, taken };
  };
  const offer = (body, keptAt, lastOfferAgo) => {
    reset();
    if (lastOfferAgo != null) p.run(`missedLastOffer.set('${id}', ${now - lastOfferAgo})`);
    p.ctx.__kept = { match: clone(openMatch), at: now - keptAt };
    p.call('missedMatchOffered', body, p.ctx.__kept);
    return p.run(`missedNotes.get('${id}') || null`);
  };
  const sample = (at, body) => ({ at, n: JSON.parse(JSON.stringify(p.call('fightTotals', body))) });
  const history = (...rows) => p.set('killSheet', new Map(rows.length ? [[id, rows]] : []));
  const lastOffer = (agoMs) => p.run(`missedLastOffer.set('${id}', ${now - agoMs})`);
  return { p, id, now, reset, after, offer, sample, history, lastOffer, M0: openMatch };
}
