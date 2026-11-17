// A Worker (worker/index.mjs) with its database and a clock the test moves:
// Date.now reads that clock only while a request is being handled.
import worker from '../../worker/index.mjs';
import { fakeD1 } from './fake-d1.mjs';
import { createHash, createHmac } from 'node:crypto';
import { signHeaders } from './signed.mjs';

// start: the clock's first instant (ms); secrets: the env keys the Worker
// reads; env: overrides; ctx: the default execution context of a call; d1: options of fakeD1.
export function workerHarness({ start, secrets = {}, env: extra, ctx: defaultCtx, d1 } = {}) {
  const { sql, ran, DB } = fakeD1(d1);
  const env = { DB, ...secrets, ...extra };
  let clock = start;
  const call = async (req, ctx = defaultCtx) => {
    const real = Date.now;
    Date.now = () => clock;
    try {
      return await worker.fetch(req, env, ctx);
    } finally {
      Date.now = real;
    }
  };
  return {
    sql,
    ran,
    env,
    call,
    get now() { return clock; },
    advance(ms) { clock += ms; }
  };
}

export const KILLS_KEY = 'k'.repeat(128);

export const RELINK_KEY = 'r'.repeat(128);

export const MATCHES = ['1-1', '1-2', '1-3', '1-4', '1-5', '2-1', '2-2', '2-3', '2-4'];

// The weeks running at setup()'s clock (Wednesday 12:00Z): NA 106 hours in, skirmish 54 running; EU 114.
export const NA_WEEK = Date.parse('2026-09-26T02:00:00Z');

export const EU_WEEK = Date.parse('2026-09-25T18:00:00Z');

export const weekOf = (match) => (match[0] === '1' ? NA_WEEK : EU_WEEK);

// A Worker with its database, a clock the test moves, and the Apps Scripts'
// way of signing. Every message is signed at a later second than the one
// before it, as the replay guard requires of real ones.
export function setup(opts = {}) {
  const h = workerHarness({
    start: Date.parse('2026-09-30T12:00:00Z'),
    secrets: { INGEST_KILLS: KILLS_KEY, INGEST_RELINK: RELINK_KEY },
    env: opts.env,
    ctx: opts.ctx,
    d1: opts
  });
  const call = h.call;
  let lastSigned = 0;
  const w = Object.assign(h, {
    fetch: call,
    signed(path, body, { key = KILLS_KEY, t, sigPath = path } = {}) {
      if (t === undefined) {
        t = Math.max(Math.floor(h.now / 1000), lastSigned + 1);
        lastSigned = t;
      }
      return signHeaders(key, t, sigPath, body);
    },
    async post(source, obj, o = {}) {
      const path = '/api/ingest/' + source;
      const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
      const key = o.key || (source === 'relink' ? RELINK_KEY : KILLS_KEY);
      const headers = o.headers || w.signed(path, body, { key, ...o });
      return (await call(new Request('https://wvwrelink.com' + path, { method: 'POST', body, headers }))).status;
    },
    async get(path, method = 'GET') {
      const r = await call(new Request('https://wvwrelink.com' + path, { method }));
      return { status: r.status, body: await r.text(), headers: r.headers };
    },
    // As kills.gs sends them: the match's week, and a score that rises with the row's time, under the week's ceiling.
    rows(at) { return MATCHES.map((m, i) => [at, m, 1000 + i, 2000, 3000, 4000, weekOf(m), Math.floor((at - weekOf(m)) / 100)]); },
    relink(extra = {}) {
      return { beat: Math.floor(h.now / 1000), window: 1790992800, published: 0, fails: 0, ...extra };
    }
  });
  return w;
}

export const SUPA = { 'latest-supa-us': 'a'.repeat(128), 'latest-supa-eu': 'b'.repeat(128) };

export const SUPA_ENV = { INGEST_LATEST_SUPA_US: SUPA['latest-supa-us'], INGEST_LATEST_SUPA_EU: SUPA['latest-supa-eu'] };

export const sha = (b) => createHash('sha256').update(b).digest('hex');

// setup()'s clock, Wednesday 12:00Z: 53 skirmishes of the NA week have finished, 57 of the EU's.
export const NA_DONE = 53;

export const skirmishList = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, scores: { red: i, blue: 1, green: 2 } }));

export const liveOf = (id, start = NA_WEEK, scores = [1000, 2000, 3000]) => ({
  id, start_time: new Date(start).toISOString().replace('.000Z', 'Z'),
  scores: { red: scores[0], blue: scores[1], green: scores[2] }, maps: [], skirmishes: [{ id: 54 }]
});

// Each entry: {id, start?, scores?, kills?, board?, live? (object, or a string/Buffer sent as it is), hist? {n, body}, sha? (wrong on purpose)}.
export function v2Body(entries) {
  const bytes = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)));
  const parts = [];
  const matches = entries.map((e) => {
    const start = e.start ?? NA_WEEK;
    const scores = e.scores || [1000, 2000, 3000];
    const live = bytes(e.live ?? liveOf(e.id, start, scores));
    const out = { id: e.id, start, scores, kills: e.kills || [1, 2, 3, 4], live: { bytes: live.length, sha256: e.sha || sha(live) }, ...e.board };
    parts.push(live);
    if (e.hist) {
      const h = bytes(e.hist.body ?? skirmishList(e.hist.n));
      out.hist = { n: e.hist.n, bytes: h.length, sha256: sha(h) };
      parts.push(h);
    }
    return out;
  });
  return Buffer.concat([Buffer.from(JSON.stringify({ v: 2, matches }) + '\n'), ...parts]);
}

export const pushV2 = (w, source, entries) => w.post(source, v2Body(entries), { key: SUPA[source] });

// Counts every statement the Worker prepares, reads and writes alike.
export function countQueries(w) {
  const real = w.env.DB;
  const n = { q: 0 };
  w.env.DB = { prepare: (q) => { n.q++; return real.prepare(q); } };
  return n;
}

export function quiet(fn) {
  const log = console.log;
  const lines = [];
  console.log = (x) => lines.push(JSON.parse(String(x)));
  return Promise.resolve().then(fn).then((r) => ({ r, lines }), (e) => { throw e; }).finally(() => { console.log = log; });
}

export function fakeCache() {
  const store = new Map();
  return {
    store,
    // A hit comes back with another max-age than the one stored.
    default: {
      match: async (k) => {
        if (!store.has(k)) return undefined;
        const hit = store.get(k).clone();
        hit.headers.set('cache-control', 'public, max-age=14400');
        return hit;
      },
      put: async (k, r) => { store.set(k, r); }
    }
  };
}

export async function withCache(fn) {
  const real = globalThis.caches;
  globalThis.caches = fakeCache();
  try {
    return await fn(globalThis.caches);
  } finally {
    globalThis.caches = real;
  }
}

// The push. A namespace whose one object is a stub the test writes, counting each time it is reached.
export function fakeLive(fetch = async () => new Response('ok')) {
  const live = { got: 0, requests: [], names: [] };
  live.ns = {
    idFromName: (name) => { live.names.push(name); return name; },
    get: () => {
      live.got++;
      return { fetch: async (url, init) => { const r = new Request(url, init); live.requests.push(r); return fetch(r); } };
    }
  };
  return live;
}

// The version name the ingest mints: <at>.<first 128 bits of HMAC-SHA-256('latest-version:' + at) under VERSION_KEY>.
export const VERSION_KEY = 'test-version-key-'.repeat(4);

export const vname = (at, key = VERSION_KEY) => at + '.' + createHmac('sha256', key).update('latest-version:' + at).digest('hex').slice(0, 32);
