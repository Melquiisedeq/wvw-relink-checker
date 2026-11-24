#!/usr/bin/env node
// Is wvwrelink.com/api still being fed, still answering, and still shut?
//
// The kills script pushes after a tick that moved a match, or one that still owes rows
// an earlier push did not land, the notice script after every tick, and a push that
// stops is silent: the sheets carry on, the page falls back to them, and the history
// in D1 just thins out. /api/health says when each source last reported, which is
// the one thing to ask from outside.
//
// Then the reads the page tries first, in the shape it reads them - a read
// that fails costs the page nothing, since it falls back to the sheets, which is
// exactly why nobody would notice it failing. With the summary fresh, /api/latest
// must answer 200 and each region's /api/history must hold matches: status and
// shape only.
//
// The Supabase readers (supabase/reader.mjs) deliver to /api every 20 s from
// both sides: both must have delivered lately, the summary of the matches must be
// fresh and made of known sources, and it must not run ahead of the game's own
// API - which only a stolen signing secret can do.
//
// The update notes: the wiki read by the notes script every 6 hours, the forum's RSS by the
// Worker's daily schedule; /api/notes says when each was last read well, and either older than
// NOTES_STALE is a problem (the Worker keeps serving the last good copy, so nothing else shows it).
//
// And the push routes (/api/ingest/*) that must stay shut, each a status and no
// judgement: they take no GET and no unsigned POST, and the Worker has no workers.dev
// address (`workers_dev: false` in worker/wrangler.jsonc).
//
// Run it by hand any time:  node scripts/check-worker.mjs
// main() takes the fetch, the sleep and the clock, so the unit test answers without a network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { escape, show, dumps, truthy, isObject, len, describe } from './workflow-text.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const API = 'https://wvwrelink.com/api/';
export const GAME_MATCHES = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
export const WORKERS_DEV = 'https://wvwrelink-api.wvwgw2.workers.dev/api/health';
const ATTEMPTS = 3;
const PAUSE_SECONDS = 5;
const TIMEOUT_SECONDS = 30;
const MATCH_RE = /^[12]-[1-9]$/;
// The readers deliver only when something is newer, so a frozen game API
// silences them with no fault of ours: same 90 minutes as kills.
const LATEST_REQUIRED = ['latest-supa-us', 'latest-supa-eu'];
const LATEST_STALE = 90 * 60;
// The cleanup runs daily (worker/wrangler.jsonc, crons); 2 h of slack.
const CLEANUP_STALE = 26 * 3600;
// Twelve missed runs of the notes script, three of the daily schedule.
const NOTES_STALE = 3 * 86400;
// The summary may lead a stale read of the game's API by at most 600 points a
// minute for the 70 minutes the API can lag; past it, a score the game never
// had, which only a stolen signing secret could send.
const SCORE_LEAD_MAX = 600 * 70;
// A match whose summary is newer than this is live, and its kills must follow.
const KILLS_LIVE_SUMMARY_S = 5 * 60;
// How far its newest kills line may trail the summary's `at` (seconds there,
// milliseconds in the kills rows).
const KILLS_LAG_MAX_S = 30 * 60;

// The check refuses to guess: what it cannot read out of the Worker it stops on.
export class Refusal extends Error {}

const label = (name) => name.padEnd(34);
const floor = Math.floor;
const isInt = (n) => Number.isInteger(n) && n >= 0;
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A duration const of worker/index.mjs, in seconds.
//
// A product of numbers (`20 * 60`, `2 * 3600e3`); a name ending in _MS is
// milliseconds, any other seconds. Anything else stops the check, since a
// guess at the unit would read a deadline as 0 or as a thousand times too much.
//
// Read, not copied, so a deadline changed there cannot leave this check
// asking /api/latest of a Worker that already answers 503 on purpose.
export function workerSeconds(body, name) {
  const m = new RegExp(`const ${escapeRe(name)}\\s*=\\s*([\\d.e]+(?:\\s*\\*\\s*[\\d.e]+)*)\\s*;`).exec(body);
  const factors = m ? m[1].split('*').map((f) => Number(f.trim())) : [NaN];
  if (factors.some(Number.isNaN)) {
    throw new Refusal(`worker/index.mjs no longer has \`const ${name} = a * b;\`: update workerSeconds in this file.`);
  }
  const product = factors.reduce((a, b) => a * b, 1);
  return Math.trunc(name.endsWith('_MS') ? product / 1000 : product);
}

// RESET of worker/index.mjs as {region: [day, hour]}.
export function workerReset(body) {
  const m = /const RESET\s*=\s*\{(.*?)\};/.exec(body);
  const found = m ? [...m[1].matchAll(/(\d+):\s*\{\s*day:\s*(\d+),\s*hour:\s*(\d+)\s*\}/g)] : [];
  if (!found.length) {
    throw new Refusal('worker/index.mjs no longer has RESET as { n: { day, hour } }: update workerReset in this file.');
  }
  return Object.fromEntries(found.map(([, r, d, h]) => [Number(r), [Number(d), Number(h)]]));
}

// The names the Worker's push routes accept, from its SOURCES table.
export function workerSources(body) {
  const m = /const SOURCES\s*=\s*\{(.*?)\};/s.exec(body);
  const names = m ? [...m[1].matchAll(/'?([\p{L}\p{N}_-]+)'?\s*:\s*'INGEST_/gu)].map((x) => x[1]) : [];
  if (!names.length) {
    throw new Refusal("worker/index.mjs no longer has SOURCES as { name: 'INGEST_...' }: update workerSources.");
  }
  return names;
}

// Every deadline this check judges by, read out of the Worker's source.
export function readLimits(body) {
  return {
    // Kills and relink tick every 5 minutes. Relink is reported past the Worker's
    // STALE_RELINK_S, where its reads already answer 503. Kills is the exception:
    // kills.gs pushes only when a match's score rose, and the GW2 API can serve
    // frozen data for about an hour, so a silent kills source is reported only past
    // 90 minutes. Between the Worker's STALE_KILLS_S (20) and 90 its 503 is the
    // honest answer and is not a failure.
    stale: { kills: 90 * 60, relink: workerSeconds(body, 'STALE_RELINK_S') },
    killsWorkerStale: workerSeconds(body, 'STALE_KILLS_S'),
    // Past it /api/latest answers 503.
    latestWorkerStale: workerSeconds(body, 'STALE_LATEST_S'),
    // When a region's week starts, UTC (day 0 = Sunday).
    reset: workerReset(body),
    skirmishSeconds: workerSeconds(body, 'SKIRMISH_MS'),
    // The history read takes versions up to the one the ingest takes this much early.
    skewSeconds: workerSeconds(body, 'MAX_SKEW_S'),
    sources: workerSources(body),
  };
}

// The context every check reads from: what it asks (request, getJson), the Worker's
// limits, the clock in whole seconds, and what one check leaves for a later one.
export function makeContext({ fetchFn = fetch, sleep = (s) => pause(s * 1000), now = Date.now, root = ROOT } = {}) {
  // (status, body) - a 4xx or 5xx included - or (null, error).
  async function request(url, method = 'GET', body = null) {
    try {
      const res = await fetchFn(url, {
        method,
        body,
        headers: { 'User-Agent': 'wvwrelink-health-check', ...(body === null ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
        signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return [res.status, ''];
      }
      return [res.status, await res.text()];
    } catch (error) {
      return [null, describe(error)];
    }
  }

  // The parsed body of a 200, retried; or [null, why].
  async function getJson(url) {
    let why = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt) await sleep(PAUSE_SECONDS);
      const [status, body] = await request(url);
      if (status === 200) {
        try {
          return [JSON.parse(body), null];
        } catch {
          why = 'not JSON';
        }
      } else {
        why = status ? `HTTP ${status}` : body;
      }
    }
    return [null, `${why} after ${ATTEMPTS} attempts`];
  }

  const limits = readLimits(fs.readFileSync(path.join(root, 'worker', 'index.mjs'), 'utf8'));
  return {
    request, getJson, limits,
    seconds: () => floor(now() / 1000),
    killsAge: null,
    killsRows: null,
    gameDown: null,
  };
}

// True when the game's own API does not answer (retried); asked only once
// a source is already late, since neither kills.gs nor the Supabase readers
// have anything to write without it.
export async function gameApiDown(ctx) {
  if (ctx.gameDown === null) {
    const [data, why] = await ctx.getJson(GAME_MATCHES);
    ctx.gameDown = why !== null || !Array.isArray(data) || !data.length;
  }
  return ctx.gameDown;
}

// `what` plus its cause: the game API when it is down, else `otherwise`.
export async function supabaseLate(ctx, what, otherwise) {
  if (await gameApiDown(ctx)) {
    return `${what} The game API is not answering, so the Supabase readers have nothing to deliver. This clears when the game API is back.`;
  }
  return `${what} ${otherwise}`;
}

export async function checkFeeds(ctx, problems, notes) {
  const [data, why] = await ctx.getJson(`${API}health`);
  if (why) {
    problems.push(`/api/health: ${why}. The Worker or its database is down.`);
    return;
  }
  const now = ctx.seconds();
  await checkLatestFeeds(ctx, data, now, problems, notes);
  checkCleanup(data, now, problems, notes);
  const killsAt = data.kills;
  if (isInt(killsAt) && killsAt) ctx.killsAge = now - killsAt;
  for (const [source, limit] of Object.entries(ctx.limits.stale).sort(byKey)) {
    const at = data[source];
    if (!isInt(at) || at === 0) {
      problems.push(`/api/health has never heard from ${source}.`);
      continue;
    }
    const age = now - at;
    if (age > limit) {
      if (source === 'kills' && await gameApiDown(ctx)) {
        problems.push(`The game API is not answering, so kills.gs has nothing to write; kills last reported ${floor(age / 60)} minutes ago. This clears when the game API is back.`);
        continue;
      }
      problems.push(`${source} last reported ${floor(age / 60)} minutes ago (limit ${floor(limit / 60)}). Its Apps Script stopped pushing: the trigger, the ingest property, or the Worker secret INGEST_${source.toUpperCase()}.`);
    } else {
      notes.push(`${label(`${source} last reported`)} ${floor(age / 60)} min ago`);
    }
  }
}

export async function checkLatestFeeds(ctx, data, now, problems, notes) {
  for (const source of LATEST_REQUIRED) {
    const at = data[source];
    if (!isInt(at) || at === 0) {
      problems.push(`/api/health has never heard from ${source}. Check the Supabase reader and its secret.`);
    } else if (now - at > LATEST_STALE) {
      problems.push(await supabaseLate(
        ctx,
        `${source} last delivered ${floor((now - at) / 60)} minutes ago (limit ${floor(LATEST_STALE / 60)}).`,
        'Check the Supabase reader; a frozen game API passes on its own.',
      ));
    } else {
      notes.push(`${label(`${source} last delivered`)} ${floor((now - at) / 60)} min ago`);
    }
  }
}

export function checkCleanup(data, now, problems, notes) {
  const at = data.cleanup;
  if (!isInt(at) || at === 0) {
    problems.push('/api/health has never heard from the daily cleanup. Check its cron on the Worker wvwrelink-api.');
  } else if (now - at > CLEANUP_STALE) {
    problems.push(`The daily cleanup last ran ${floor((now - at) / 3600)} hours ago (limit ${floor(CLEANUP_STALE / 3600)}). Check its cron on the Worker wvwrelink-api.`);
  } else {
    notes.push(`${label('cleanup last ran')} ${floor((now - at) / 3600)} h ago`);
  }
}

export async function checkNotes(ctx, problems, notes) {
  const [data, why] = await ctx.getJson(`${API}notes`);
  if (why) {
    problems.push(`/api/notes: ${why}.`);
    return;
  }
  const now = ctx.seconds();
  const what = {
    wiki: 'the wiki: the notes script, its 6-hour trigger, its ingest property, or the Worker secret INGEST_NOTES',
    rss: "the forum's RSS: the Worker's daily schedule, or the forum refusing it (Workers Logs, \"notes\")",
  };
  for (const source of ['wiki', 'rss']) {
    const at = data?.[source];
    if (!isInt(at) || at === 0) {
      problems.push(`/api/notes has never read ${what[source]}.`);
    } else if (now - at > NOTES_STALE) {
      problems.push(`/api/notes last read ${source} ${floor((now - at) / 3600)} hours ago (limit ${floor(NOTES_STALE / 3600)}). Check ${what[source]}.`);
    } else {
      notes.push(`${label(`notes: ${source} last read`)} ${floor((now - at) / 3600)} h ago`);
    }
  }
}

// {"id|start in ms": sum of the scores} from the game's API, or null.
export async function gameScores(ctx) {
  const [data, why] = await ctx.getJson(GAME_MATCHES);
  if (why || !Array.isArray(data)) return null;
  const out = new Map();
  try {
    for (const m of data) {
      const start = Date.parse(m.start_time);
      if (Number.isNaN(start)) return null;
      const scores = Object.values(m.scores);
      if (!scores.every((s) => typeof s === 'number')) return null;
      out.set(`${m.id}|${start}`, scores.reduce((a, b) => a + b, 0));
    }
  } catch {
    return null;
  }
  return out;
}

// The start of the region's week that holds `now`, epoch seconds.
export function weekStart(reset, region, now) {
  const [day, hour] = reset[region];
  const weekday = (new Date(now * 1000).getUTCDay() + 6) % 7; // Monday is 0
  const start = floor(now / 86400) * 86400 + hour * 3600 - ((((weekday + 1 - day) % 7) + 7) % 7) * 86400;
  return start > now ? start - 7 * 86400 : start;
}

const regionsOf = (reset) => Object.keys(reset).map(Number).sort((a, b) => a - b);

// /api/latest and /api/history, asked only while the summary is fresh.
export async function checkCopy(ctx, age, now, problems, notes) {
  const { reset, latestWorkerStale, skirmishSeconds, skewSeconds } = ctx.limits;
  if (age > latestWorkerStale) return;
  const [, whyLatest] = await ctx.getJson(`${API}latest`);
  if (whyLatest) {
    problems.push(`/api/latest: ${whyLatest} while the summary is fresh. The page is reading the game alone.`);
  } else {
    notes.push(`${label('/api/latest')} HTTP 200`);
  }
  for (const region of regionsOf(reset)) {
    const n = floor((now - weekStart(reset, region, now)) / skirmishSeconds);
    if (n < 2) {
      notes.push(`${label(`/api/history/${region}`)} skipped, week just begun`);
      continue;
    }
    let why = null;
    // The readers keep one history row per match: in the last skewSeconds of a block
    // it may already be the next version's.
    const ceiling = floor((now - weekStart(reset, region, now) + skewSeconds) / skirmishSeconds);
    const versions = [...new Set([n, ceiling, n - 1])];
    let found = false;
    for (const v of versions) {
      let data;
      [data, why] = await ctx.getJson(`${API}history/${region}?v=${v}`);
      if (why === null && isObject(data) && truthy(data.matches)) {
        notes.push(`${label(`/api/history/${region}`)} v=${v}, ${len(data.matches)} matches`);
        found = true;
        break;
      }
      if (why === null) why = 'no matches';
    }
    if (!found) {
      const tried = versions.map((v) => `v=${v}`);
      const list = tried.length > 1 ? `${tried.slice(0, -1).join(', ')} and ${tried.at(-1)}` : tried[0];
      problems.push(`/api/history/${region}: ${why} for ${list} while the summary is fresh. The readers are not sending the histories.`);
    }
  }
}

export async function checkLatest(ctx, problems, notes) {
  const { reset } = ctx.limits;
  const [data, why] = await ctx.getJson(`${API}latest/summary`);
  if (why) {
    problems.push(`/api/latest/summary: ${why}. The Supabase readers are not reaching the summary.`);
    return;
  }
  if (!isObject(data) || !Object.keys(data).length) {
    problems.push('/api/latest/summary answered without matches.');
    return;
  }
  const now = ctx.seconds();
  const entries = Object.entries(data);
  const bad = entries.filter(([k, v]) => !(
    MATCH_RE.test(k) && isObject(v) && isInt(v.start) && isInt(v.score) && isInt(v.at)
    && LATEST_REQUIRED.includes(v.by))).map(([k]) => k);
  if (bad.length) {
    problems.push(`/api/latest/summary: ${bad.length} of ${entries.length} matches are not {start, score, at, by} from a known latest-* source, e.g. ${dumps({ [bad[0]]: data[bad[0]] }).slice(0, 120)}`);
    return;
  }
  const counts = {};
  for (const [, v] of entries) counts[v.by] = (counts[v.by] || 0) + 1;
  notes.push(`summary: ${entries.length} matches, ${Object.entries(counts).sort(byKey).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  // A tier that left at a relink stays in the summary for up to 2 hours
  // (LATEST_KEEP_S), so only this week's matches are judged.
  const current = entries.filter(([k, v]) => floor(v.start / 1000) >= weekStart(reset, Number(k[0]), now)).map(([, v]) => v.at);
  const oldest = current.length ? now - Math.min(...current) : 0;
  if (oldest > LATEST_STALE) {
    problems.push(await supabaseLate(
      ctx,
      `/api/latest/summary: the oldest match is ${floor(oldest / 60)} minutes old (limit ${floor(LATEST_STALE / 60)}).`,
      'Check the Supabase readers.',
    ));
  }
  await checkCopy(ctx, now - Math.max(...entries.map(([, v]) => v.at)), now, problems, notes);
  checkKillsFollow(data, ctx.killsRows, now, problems, notes);
  const game = await gameScores(ctx);
  if (game === null) {
    notes.push('game API unreadable: the secret-theft alarm did not run');
    return;
  }
  const known = (k, v) => game.has(`${k}|${v.start}`);
  const ahead = entries.filter(([k, v]) => known(k, v) && v.score > game.get(`${k}|${v.start}`) + SCORE_LEAD_MAX)
    .map(([k]) => k).sort();
  if (ahead.length) {
    problems.push(`the summary is ahead of the game by more than the API can lag: a signing secret may be stolen (${ahead.join(', ')}). Rotate the INGEST_LATEST_* secrets.`);
  } else {
    notes.push(`${label('summary vs game API')} ${entries.filter(([k, v]) => known(k, v)).length} matches compared`);
  }
}

// A kills line ahead of the truth holds a match's kills with every answer 200.
export function checkKillsFollow(summary, rows, now, problems, notes) {
  if (rows === null) {
    notes.push(`${label('kills vs summary')} not judged, /api/kills unread`);
    return;
  }
  const newest = {};
  for (const row of rows) newest[row[1]] = Math.max(newest[row[1]] ?? 0, row[0]);
  let judged = 0;
  const late = [];
  for (const [k, v] of Object.entries(summary).sort(byKey)) {
    if (now - v.at >= KILLS_LIVE_SUMMARY_S) continue;
    if (!Object.hasOwn(newest, k)) {
      // A fresh `at` comes with the same reader's kills line, and the Worker
      // keeps each match's newest line RECENT_MS + BASE_MS back.
      if (v.score > 0 && now - floor(v.start / 1000) > KILLS_LAG_MAX_S) {
        late.push(`${k}: no kills line in /api/kills, the line holding it is older than what it shows and is found in D1`);
      }
      continue;
    }
    judged++;
    const lag = v.at - floor(newest[k] / 1000);
    if (lag > KILLS_LAG_MAX_S) {
      late.push(`${k}: newest kills line (at ${newest[k]}) is ${floor(lag / 60)} minutes behind its summary (limit ${floor(KILLS_LAG_MAX_S / 60)})`);
    }
  }
  if (late.length) {
    problems.push(`live matches whose kills have stopped following the score: ${late.join('; ')}. A kills line ahead of the truth may be holding the match. In the D1 console, delete that match's rows of the kills table from that \`at\` on (earlier if the hold began earlier), then every row of the recent table. If it comes back, a signing secret was stolen: rotate INGEST_KILLS and the INGEST_LATEST_* secrets.`);
  } else {
    notes.push(`${label('kills vs summary')} ${judged} live matches follow`);
  }
}

export async function checkReads(ctx, problems, notes) {
  let [data, why] = await ctx.getJson(`${API}kills`);
  const rows = isObject(data) ? data.rows : null;
  const age = ctx.killsAge;
  if (why && why.includes('HTTP 503') && age !== null
      && ctx.limits.killsWorkerStale < age && age <= ctx.limits.stale.kills) {
    notes.push(`${label('/api/kills')} 503 stale, source quiet ${floor(age / 60)} min (frozen API?)`);
  } else if (why) {
    problems.push(`/api/kills: ${why}. The page is reading the kills sheet.`);
  } else if (!Array.isArray(rows) || !rows.length) {
    problems.push('/api/kills answered without rows.');
  } else {
    const bad = rows.filter((r) => !(
      Array.isArray(r) && r.length === 6 && isInt(r[0])
      && typeof r[1] === 'string' && MATCH_RE.test(r[1])
      && r.slice(2).every(isInt)));
    if (bad.length) {
      problems.push(`/api/kills: ${bad.length} of ${rows.length} rows are not [at, match, center, red, blue, green], e.g. ${dumps(bad[0]).slice(0, 120)}`);
    } else {
      notes.push(`${label('/api/kills')} ${rows.length} rows`);
      ctx.killsRows = rows;
    }
  }

  [data, why] = await ctx.getJson(`${API}relink`);
  if (why) {
    problems.push(`/api/relink: ${why}. The page is reading the relink sheet.`);
  } else if (!(isObject(data) && isInt(data.window) && isInt(data.published))) {
    problems.push(`/api/relink is not {window, published} as integers: ${dumps(data).slice(0, 120)}`);
  } else {
    notes.push(`${label('/api/relink')} ${data.window}:${data.published}`);
  }
}

export async function checkDoors(ctx, problems, notes) {
  const doors = [['GET on /api/ingest/kills', `${API}ingest/kills`, 'GET', null, 405]];
  for (const name of ctx.limits.sources) {
    doors.push([`unsigned POST ${name}`, `${API}ingest/${name}`, 'POST', '{}', 401]);
  }
  doors.push(['workers.dev address', WORKERS_DEV, 'GET', null, 404]);
  for (const [name, url, method, body, want] of doors) {
    const [status] = await ctx.request(url, method, body);
    if (status !== want) {
      problems.push(`${name} answered ${show(status)}, expected ${want}: ${method} ${url}`);
    } else {
      notes.push(`${label(name)} HTTP ${status}`);
    }
  }
}

export async function main(deps = {}) {
  const ctx = makeContext(deps);
  const problems = [];
  const notes = [];
  await checkFeeds(ctx, problems, notes);
  await checkReads(ctx, problems, notes);
  await checkNotes(ctx, problems, notes);
  await checkLatest(ctx, problems, notes);
  await checkDoors(ctx, problems, notes);
  const out = [...notes, ...problems.map((p) => `::error::${escape(p)}`)];
  if (problems.length) {
    out.push('', `${problems.length} problem(s).`);
    return { code: 1, out };
  }
  return { code: 0, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const { out, code } = await main();
    for (const line of out) console.log(line);
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
