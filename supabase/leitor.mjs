// @ts-nocheck
// Supabase Edge Function (Deno), one of the outside readers of the game API.
// Paste the whole file into the dashboard editor as index.ts of the function leitor:
// one file, no imports. Under Node (tests/leitor.test.mjs) it is imported as it is;
// only the last lines touch Deno.
// The scheduler (agendador.sql) calls it with x-region us-east-1 or eu-central-1;
// that header only routes the call to a region. What picks the secret that signs,
// and the door it pushes to, is SB_REGION, where the function really runs: a call
// the platform ran elsewhere is answered 404 and reads nothing.
//
// Flow: the call's secret first, before anything is read; read the game API;
// check the whole body; ask /api/agora/resumo what the Worker already has; push
// only the newer matches, gzipped and signed (worker/index.mjs, acceptAgora).
//
// Function secrets (Dashboard > Edge Functions > Secrets), never in the repository:
//   LEITOR_CHAVE            what the scheduler sends in x-wvw-chave (128 hex)
//   ENTRADA_AGORA_SUPA_US   the signing secret of agora-supa-us (128 hex)
//   ENTRADA_AGORA_SUPA_EU   the signing secret of agora-supa-eu (128 hex)
// Deploy with Verify JWT off: the key above is the lock, the publishable key is public.
// Nothing here logs a header, the environment or a body; only counts.

// ---- The rules, with nothing of Deno in them. Contract: worker/index.mjs
// (acceptAgora, checkSummary). The Worker's limits are repeated on purpose: a match
// it would refuse must not leave the reader, because it refuses the whole message
// for one bad entry.

export const API_URL = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
export const RESUMO_URL = 'https://wvwrelink.com/api/agora/resumo';
export const ENTRADA_URL = 'https://wvwrelink.com/api/entrada/';

// The region the function really runs in (SB_REGION, set by the platform) picks the
// reader's own door and its own secret (a function secret). The caller's x-region
// only routes the call there.
export const REGIONS = Object.freeze({
  'us-east-1': { source: 'agora-supa-us', secret: 'ENTRADA_AGORA_SUPA_US' },
  'eu-central-1': { source: 'agora-supa-eu', secret: 'ENTRADA_AGORA_SUPA_EU' }
});

// The entry for where the function runs, or null: an unknown SB_REGION, or a call
// that landed somewhere other than the one it asked for (platform fallback).
export function regionFor(sbRegion, xRegion) {
  if (typeof sbRegion !== 'string' || !Object.hasOwn(REGIONS, sbRegion) || xRegion !== sbRegion) return null;
  return REGIONS[sbRegion];
}

export const MAX_API_BYTES = 1024 * 1024; // the whole read is ~500 KB (04/10/2026)
const MAX_SLICE = 16 * 1024;
const MAX_RAW = 256 * 1024;
const MAX_SCORE_PER_MIN = 1000;
const SCORE_SLACK = 2000;
const MAPS = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];
const TEAMS = ['red', 'blue', 'green'];
const RESET = { 1: { day: 6, hour: 2 }, 2: { day: 5, hour: 18 } };

const isInt = (x) => Number.isInteger(x) && x >= 0 && x <= 1e7;

// Team ids seen in the API on 04/10/2026: NA 1001-1024 and 11001-11012, EU 2001-2301 and 12001-12015.
function isWorld(x, region) {
  if (!Number.isInteger(x)) return false;
  return region === '1' ? (x >= 1001 && x <= 1099) || (x >= 11001 && x <= 11099)
    : (x >= 2001 && x <= 2999) || (x >= 12001 && x <= 12099);
}

// No free text: every key and every string in a match has a plain, short form
// (ids, ISO times, guild UUIDs, enum words), whatever else the API adds.
function plain(x, depth, count) {
  if (++count.n > 20000 || depth > 8) return false;
  if (x === null || typeof x === 'boolean') return true;
  if (typeof x === 'number') return Number.isInteger(x) && Math.abs(x) <= 1e9;
  if (typeof x === 'string') return /^[A-Za-z0-9_:.-]{0,64}$/.test(x);
  if (Array.isArray(x)) return x.every((v) => plain(v, depth + 1, count));
  if (typeof x !== 'object') return false;
  return Object.keys(x).every((k) => /^[a-z_0-9]{1,32}$/.test(k) && plain(x[k], depth + 1, count));
}

// One match of the API, whole. Returns {id, start, scores, kills, text} or null.
export function checkMatch(m, nowMs) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (typeof m.id !== 'string' || !/^[12]-[1-9]$/.test(m.id)) return null;
  const region = m.id[0];
  if (typeof m.start_time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:00:00Z$/.test(m.start_time)) return null;
  const start = Date.parse(m.start_time);
  if (!Number.isFinite(start) || start > nowMs + 300e3 || start < nowMs - 8 * 86400e3) return null;
  const d = new Date(start);
  const r = RESET[region];
  if (d.getUTCDay() !== r.day || d.getUTCHours() !== r.hour) return null;
  for (const group of ['scores', 'deaths', 'kills', 'victory_points']) {
    const g = m[group];
    if (!g || typeof g !== 'object' || !TEAMS.every((t) => isInt(g[t]))) return null;
  }
  for (const group of ['worlds', 'all_worlds']) {
    const g = m[group];
    if (!g || typeof g !== 'object') return null;
    for (const t of TEAMS) {
      const ids = group === 'worlds' ? [g[t]] : g[t];
      if (!Array.isArray(ids) || !ids.length || ids.length > 4 || !ids.every((x) => isWorld(x, region))) return null;
    }
  }
  if (!Array.isArray(m.maps) || m.maps.length !== MAPS.length) return null;
  const kills = [];
  for (const type of MAPS) {
    const map = m.maps.find((x) => x && x.type === type);
    if (!map || !map.kills || !TEAMS.every((t) => isInt(map.kills[t]))) return null;
    kills.push(TEAMS.reduce((n, t) => n + map.kills[t], 0));
  }
  if (!plain(m, 0, { n: 0 })) return null;
  const scores = TEAMS.map((t) => m.scores[t]);
  const score = scores[0] + scores[1] + scores[2];
  if (score > MAX_SCORE_PER_MIN * Math.max(0, (nowMs - start) / 60e3) + SCORE_SLACK) return null;
  const text = JSON.stringify(m);
  if (new TextEncoder().encode(text).length > MAX_RAW) return null;
  return { id: m.id, start, scores, score, kills, text };
}

// The whole read or nothing: not a list of 1-18 is an error string; a match
// that fails its checks is left out and counted.
export function checkRead(data, nowMs) {
  if (!Array.isArray(data) || !data.length || data.length > 18) return 'shape';
  const seen = new Set();
  const matches = [];
  let dropped = 0;
  for (const m of data) {
    const ok = checkMatch(m, nowMs);
    if (!ok || seen.has(ok.id)) { dropped++; continue; }
    seen.add(ok.id);
    matches.push(ok);
  }
  return { matches, dropped };
}

// What /api/agora/resumo holds, checked as strangers' data too. Null if it is not that shape.
export function checkResumo(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  for (const [id, v] of Object.entries(r)) {
    if (!/^[12]-[1-9]$/.test(id) || !v || !Number.isSafeInteger(v.start) || !Number.isSafeInteger(v.score)) return null;
    out[id] = { start: v.start, score: v.score };
  }
  return out;
}

// Only what is newer than the Worker's copy: a newer week, or the same week and
// a higher score. Nothing for a match it has never seen is held back.
export function pickNewer(matches, resumo) {
  return matches.filter((m) => {
    if (!Object.hasOwn(resumo, m.id)) return true;
    const have = resumo[m.id];
    return m.start > have.start || (m.start === have.start && m.score > have.score);
  });
}

export async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// <summary JSON, one line> "\n" <gzip of each match, in the summary's order>.
// Returns null when nothing is left to send.
export async function buildBody(matches) {
  const enc = new TextEncoder();
  const entries = [];
  const slices = [];
  for (const m of matches) {
    const raw = enc.encode(m.text);
    const gz = await gzip(raw);
    if (gz.length > MAX_SLICE) continue;
    entries.push({
      id: m.id, start: m.start, scores: m.scores, kills: m.kills,
      bytes: gz.length, raw: raw.length, sha256: hex(await crypto.subtle.digest('SHA-256', gz))
    });
    slices.push(gz);
  }
  if (!entries.length) return null;
  const head = enc.encode(JSON.stringify({ v: 1, matches: entries }) + '\n');
  const body = new Uint8Array(head.length + slices.reduce((n, s) => n + s.length, 0));
  body.set(head, 0);
  let at = head.length;
  for (const s of slices) { body.set(s, at); at += s.length; }
  return { body, count: entries.length };
}

// Hex HMAC-SHA256 of  time + "\n" + path + "\n" + body, as the Worker checks it.
export async function sign(secret, t, path, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const head = enc.encode(t + '\n' + path + '\n');
  const signed = new Uint8Array(head.length + body.length);
  signed.set(head, 0);
  signed.set(body, head.length);
  return hex(await crypto.subtle.sign('HMAC', key, signed));
}

// Constant time whatever the lengths: both sides are hashed first.
export async function sameSecret(given, wanted) {
  const enc = new TextEncoder();
  const a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(given))));
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(wanted))));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---- The function.
const MIN_SECRET = 64;
const NOT_FOUND = () => new Response(null, { status: 404 });
const generic = (status) => new Response(JSON.stringify({ ok: false }) + '\n', {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});

export async function handle(req, env) {
  const lock = env('LEITOR_CHAVE') || '';
  if (req.method !== 'POST' || lock.length < MIN_SECRET) return NOT_FOUND();
  if (!await sameSecret(req.headers.get('x-wvw-chave') || '', lock)) return NOT_FOUND();
  const region = env('SB_REGION') || '';
  const found = regionFor(region, req.headers.get('x-region'));
  if (!found) return NOT_FOUND();
  const { source, secret: secretName } = found;
  const secret = env(secretName) || '';
  if (secret.length < MIN_SECRET) return generic(500);

  try {
    const api = await fetch(API_URL, { signal: AbortSignal.timeout(8000) });
    if (!api.ok) return generic(502);
    const text = await readCapped(api, MAX_API_BYTES);
    if (text === null) return generic(502);
    const now = Date.now();
    const read = checkRead(JSON.parse(text), now);
    if (typeof read === 'string') return generic(502);

    const res = await fetch(RESUMO_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return generic(502);
    const resumo = checkResumo(JSON.parse(await readCapped(res, 64 * 1024) ?? 'null'));
    if (!resumo) return generic(502);

    const built = await buildBody(pickNewer(read.matches, resumo));
    if (!built) {
      console.log(JSON.stringify({ region, sent: 0, dropped: read.dropped }));
      return generic(200);
    }
    const t = String(Math.floor(Date.now() / 1000));
    const path = new URL(ENTRADA_URL + source).pathname;
    const sig = await sign(secret, t, path, built.body);
    const push = await fetch(ENTRADA_URL + source, {
      method: 'POST', body: built.body, signal: AbortSignal.timeout(8000),
      headers: { 'x-wvw-time': t, 'x-wvw-sig': sig, 'content-type': 'application/octet-stream' }
    });
    console.log(JSON.stringify({ region, sent: built.count, dropped: read.dropped, status: push.status }));
    return generic(push.ok ? 200 : 502);
  } catch {
    // The reason is not written: an error's text can carry a URL or a header.
    console.log(JSON.stringify({ region, failed: true }));
    return generic(500);
  }
}

if (globalThis.Deno) Deno.serve((req) => handle(req, (k) => Deno.env.get(k)));

// The body as text, or null past the cap (a declared length first, then the stream).
async function readCapped(res, max) {
  if (Number(res.headers.get('content-length') || 0) > max) return null;
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return new TextDecoder().decode(all);
}
