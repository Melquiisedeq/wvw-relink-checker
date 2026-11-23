// scripts/check-worker.mjs with the network made up: what it reads out of worker/index.mjs, every source
// asked for its feed, the summary judged by its oldest match, the kills that must follow, and every door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  main, makeContext, readLimits, workerSeconds, workerReset, workerSources, weekStart, checkLatest, checkReads,
  checkKillsFollow, checkDoors, checkCopy, checkFeeds, gameApiDown, Refusal, API, GAME_MATCHES, WORKERS_DEV, ROOT,
} from '../../../scripts/check-worker.mjs';
import { fakeFetch, fakeSleep, lines, errors } from './fake-http.mjs';

const NOW_MS = Date.parse('2026-11-22T12:13:20Z'); // a Sunday
const NOW = NOW_MS / 1000;
const SOURCE = fs.readFileSync(path.join(ROOT, 'worker', 'index.mjs'), 'utf8');
const LIMITS = readLimits(SOURCE);
const START = (NOW - 30 * 3600) * 1000;
const sum = (extra = {}) => ({ start: START, score: 100, at: NOW - 60, by: 'latest-supa-us', ...extra });
const ago = (min) => NOW - min * 60;
const row = (at, match = '1-1') => [at * 1000, match, 1, 2, 3, 4];

// The Worker and the game as they answer today; `plan` changes it.
function world(plan = {}) {
  const api = {
    health: { kills: NOW - 120, relink: NOW - 60, 'latest-supa-us': NOW - 10, 'latest-supa-eu': NOW - 10, cleanup: NOW - 5 * 3600, ...plan.health },
    kills: { rows: plan.rows ?? [row(NOW - 60), row(NOW - 60, '2-1')] },
    relink: 'relink' in plan ? plan.relink : { window: 1794016800, published: 1793823875 },
    latest: { x: 1 },
    'latest/summary': plan.summary ?? { '1-1': sum(), '2-1': sum({ by: 'latest-supa-eu' }) },
  };
  const game = plan.game ?? [{ id: '1-1', start_time: new Date(START).toISOString(), scores: { red: 50, blue: 30, green: 20 } },
    { id: '2-1', start_time: new Date(START).toISOString(), scores: { red: 50, blue: 30, green: 20 } }];
  const asked = {};
  const answer = (url, init) => {
    asked[url] = (asked[url] || 0) + 1;
    if (plan.status?.[url]) return { status: plan.status[url], body: plan.statusBody?.[url] ?? '' };
    if (plan.throws?.[url]) throw plan.throws[url];
    if (url === GAME_MATCHES) return { body: game };
    if (url === WORKERS_DEV) return { status: plan.dev ?? 404 };
    const route = url.slice(API.length);
    if (route.startsWith('ingest/')) return plan.doors?.[`${init.method} ${route}`] ?? { status: init.method === 'GET' ? 405 : 401 };
    const hist = /^history\/(\d)\?v=(\d+)$/.exec(route);
    if (hist) return { body: plan.history?.[hist[1]] ?? { matches: [1] } };
    return route in api ? { body: api[route] } : { status: 404 };
  };
  answer.asked = asked;
  return answer;
}
async function run(plan, { root = ROOT } = {}) {
  const answer = world(plan);
  const fetchFn = fakeFetch(answer);
  const sleep = fakeSleep();
  const result = await main({ fetchFn, sleep, now: () => NOW_MS, root });
  return { ...result, log: lines(result), asked: fetchFn.asked, answer, slept: sleep.slept };
}
const red = async (plan, pattern, count = 1) => {
  const r = await run(plan);
  assert.equal(r.code, 1, r.log);
  assert.equal(errors(r).length, count, r.log);
  assert.match(r.log, pattern);
  return r;
};
const green = async (plan, pattern) => {
  const r = await run(plan);
  assert.equal(r.code, 0, r.log);
  if (pattern) assert.match(r.log, pattern);
  return r;
};
const ctxOf = (plan) => makeContext({ fetchFn: fakeFetch(world(plan)), sleep: fakeSleep(), now: () => NOW_MS, root: ROOT });

test('the deadlines follow worker/index.mjs: a changed number is read, not remembered', () => {
  const body = 'const STALE_KILLS_S = 7 * 60;\nconst SKIRMISH_MS = 3 * 3600e3;\nconst RESET = { 1: { day: 1, hour: 2 }, 2: { day: 3, hour: 4 } };';
  assert.equal(workerSeconds(body, 'STALE_KILLS_S'), 420);
  assert.equal(workerSeconds(body, 'SKIRMISH_MS'), 10800);
  assert.deepEqual(workerReset(body), { 1: [1, 2], 2: [3, 4] });
});

test('a deadline in milliseconds written as a product is read in seconds, and a guess is refused', () => {
  assert.equal(workerSeconds('const SKIRMISH_MS = 7200 * 1000;', 'SKIRMISH_MS'), 7200);
  assert.equal(workerSeconds('const STALE_X_MS = 2 * 3600e3;', 'STALE_X_MS'), 7200);
  assert.equal(workerSeconds('const X = 1.5 * 60;', 'X'), 90);
  assert.throws(() => workerSeconds('const SKIRMISH_MS = HOUR * 2;', 'SKIRMISH_MS'), (e) => e instanceof Refusal && /no longer has `const SKIRMISH_MS = a \* b;`/.test(e.message));
  assert.throws(() => workerSeconds('const A = 1e;', 'A'), Refusal);
  assert.throws(() => workerSeconds('', 'A'), Refusal);
});

test('RESET and SOURCES are read out of the Worker, and refused when they are not there', () => {
  assert.throws(() => workerReset('const RESET = {};'), /no longer has RESET as \{ n: \{ day, hour \} \}/);
  assert.deepEqual(workerSources("const SOURCES = {\n  kills: 'INGEST_KILLS', 'a-b': 'INGEST_AB' };"), ['kills', 'a-b']);
  assert.throws(() => workerSources('const SOURCES = {};'), /no longer has SOURCES/);
});

test('the deadline the check uses is the one in the Worker file, not a copy', () => {
  const body = SOURCE
    .replace('STALE_KILLS_S = 20 * 60', 'STALE_KILLS_S = 7 * 60')
    .replace('STALE_LATEST_S = 10 * 60', 'STALE_LATEST_S = 3 * 60')
    .replace('STALE_RELINK_S = 45 * 60', 'STALE_RELINK_S = 9 * 60')
    .replace('SKIRMISH_MS = 2 * 3600e3', 'SKIRMISH_MS = 3 * 3600e3')
    .replace('MAX_SKEW_S = 300', 'MAX_SKEW_S = 90');
  const limits = readLimits(body);
  assert.deepEqual([limits.killsWorkerStale, limits.latestWorkerStale, limits.stale.relink, limits.skirmishSeconds, limits.skewSeconds], [420, 180, 540, 10800, 90]);
  assert.equal(limits.stale.kills, 5400);
  const more = readLimits(SOURCE.replace("kills: 'INGEST_KILLS',", "kills: 'INGEST_KILLS', fresh: 'INGEST_FRESH',"));
  assert.deepEqual(more.sources, ['kills', 'fresh', 'relink', 'latest-supa-us', 'latest-supa-eu']);
  assert.deepEqual(limits.sources, ['kills', 'relink', 'latest-supa-us', 'latest-supa-eu']);
});

test('makeContext reads worker/index.mjs of the root it is given', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
  fs.mkdirSync(path.join(root, 'worker'));
  fs.writeFileSync(path.join(root, 'worker', 'index.mjs'), SOURCE.replace('STALE_RELINK_S = 45 * 60', 'STALE_RELINK_S = 9 * 60'));
  assert.equal(makeContext({ root }).limits.stale.relink, 540);
  fs.rmSync(root, { recursive: true });
});

test('every source of the Worker\'s entrance gets its unsigned POST', async () => {
  const r = await green({});
  for (const name of ['kills', 'relink', 'latest-supa-us', 'latest-supa-eu']) {
    assert.ok(r.asked.includes(`POST ${API}ingest/${name}`), name);
    assert.match(r.log, new RegExp(`^unsigned POST ${name} +HTTP 401$`, 'm'));
  }
  assert.match(r.log, /^GET on \/api\/ingest\/kills +HTTP 405$/m);
  assert.match(r.log, /^workers\.dev address +HTTP 404$/m);
});

test('the doors: each refusal that is not the expected status is red, with what was asked', async () => {
  await red({ doors: { 'GET ingest/kills': { status: 200 } } }, /GET on \/api\/ingest\/kills answered 200, expected 405: GET https:\/\/wvwrelink\.com\/api\/ingest\/kills/);
  await red({ doors: { 'POST ingest/relink': { status: 400 } } }, /unsigned POST relink answered 400, expected 401: POST /);
  await red({ dev: 200 }, /workers\.dev address answered 200, expected 404: GET https:\/\/wvwrelink-api\.wvwgw2\.workers\.dev/);
  await red({ throws: { [`${API}ingest/kills`]: new TypeError('fetch failed') } }, /answered None, expected/, 2);
});

test('the unsigned POST carries a body, as a form', async () => {
  let seen;
  const ctx = makeContext({ fetchFn: async (url, init) => { if (init.method === 'POST') seen = init; return new Response('', { status: 401 }); }, sleep: fakeSleep(), root: ROOT });
  await checkDoors(ctx, [], []);
  assert.equal(seen.body, '{}');
  assert.equal(seen.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('everything fed and shut: green, and nothing printed but the notes', async () => {
  const r = await green({});
  assert.ok(!r.log.includes('problem'));
  assert.match(r.log, /^kills last reported +2 min ago$/m);
  assert.match(r.log, /^latest-supa-us last delivered +0 min ago$/m);
  assert.match(r.log, /^cleanup last ran +5 h ago$/m);
  assert.match(r.log, /^\/api\/kills +2 rows$/m);
  assert.match(r.log, /^\/api\/relink +1794016800:1793823875$/m);
  assert.match(r.log, /^summary: 2 matches, latest-supa-eu 1, latest-supa-us 1$/m);
});

test('the health read: a failure, or an answer that is not JSON, is red and stops the feeds', async () => {
  await red({ status: { [`${API}health`]: 500 } }, /\/api\/health: HTTP 500 after 3 attempts\. The Worker or its database is down\./);
  const r = await run({ status: { [`${API}health`]: 500 } });
  assert.deepEqual(r.slept.slice(0, 2), [5, 5]);
});

test('a read that is 200 with a body that is not JSON says so', async () => {
  const ctx = makeContext({ fetchFn: fakeFetch(() => ({ body: 'nope' })), sleep: fakeSleep(), root: ROOT });
  assert.deepEqual(await ctx.getJson(`${API}health`), [null, 'not JSON after 3 attempts']);
  const ctx2 = makeContext({ fetchFn: fakeFetch(() => ({ status: 202 })), sleep: fakeSleep(), root: ROOT });
  assert.deepEqual(await ctx2.getJson(`${API}health`), [null, 'HTTP 202 after 3 attempts']);
  const ctx3 = makeContext({ fetchFn: async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); }, sleep: fakeSleep(), root: ROOT });
  assert.deepEqual(await ctx3.getJson(`${API}health`), [null, 'TypeError: fetch failed (ECONNRESET) after 3 attempts']);
});

test('a read that fails twice and then answers is green', async () => {
  const answer = world({});
  let n = 0;
  const fetchFn = fakeFetch((url, init) => (url === `${API}health` && ++n < 3 ? { status: 502 } : answer(url, init)));
  const r = await main({ fetchFn, sleep: fakeSleep(), now: () => NOW_MS, root: ROOT });
  assert.equal(r.code, 0, lines(r));
});

test('the kills source: never, 89 minutes (green), 91 minutes (red), the game API down (a different cause)', async () => {
  await red({ health: { kills: 0 } }, /\/api\/health has never heard from kills\./);
  await green({ health: { kills: ago(89) } }, /kills last reported +89 min ago/);
  await red({ health: { kills: ago(91) } }, /kills last reported 91 minutes ago \(limit 90\)\. Its Apps Script stopped pushing: the trigger, the ingest property, or the Worker secret INGEST_KILLS\./);
  await red({ health: { kills: ago(91) }, status: { [GAME_MATCHES]: 503 } }, /The game API is not answering, so kills\.gs has nothing to write; kills last reported 91 minutes ago\./);
});

test('a late source is told as the Apps Script\'s fault, whatever the game API does, except kills', async () => {
  await red({ health: { relink: ago(50) }, status: { [GAME_MATCHES]: 503 } }, /relink last reported 50 minutes ago \(limit 45\)\. Its Apps Script stopped pushing/);
});

test('two late sources are two problems, kills first', async () => {
  const r = await red({ health: { kills: ago(100), relink: ago(50) } }, /kills last reported 100 minutes ago/, 2);
  assert.ok(errors(r)[0].startsWith('::error::kills last reported'));
  assert.ok(errors(r)[1].startsWith('::error::relink last reported'));
});

test('the relink source: judged by the Worker\'s own deadline, 45 minutes', async () => {
  await green({ health: { relink: ago(44) } });
  await red({ health: { relink: ago(46) } }, /relink last reported 46 minutes ago \(limit 45\).*INGEST_RELINK/);
  await red({ health: { relink: 0 } }, /has never heard from relink\./);
});

test('a time in the future, a float or a string is not a time: never heard', async () => {
  await red({ health: { relink: 'x' } }, /has never heard from relink/);
  await red({ health: { relink: 1.5 } }, /has never heard from relink/);
  await red({ health: { 'latest-supa-us': 'x' } }, /has never heard from latest-supa-us/);
  await red({ health: { 'latest-supa-eu': 1.5 } }, /has never heard from latest-supa-eu/);
  await red({ health: { cleanup: 'x' } }, /has never heard from the daily cleanup/);
  await green({ health: { kills: NOW + 1000 } }, /kills last reported +-17 min ago/);
});

test('the Supabase readers: never, 91 minutes, and the game API down says why', async () => {
  await red({ health: { 'latest-supa-us': 0 } }, /\/api\/health has never heard from latest-supa-us\. Check the Supabase reader and its secret\./);
  await red({ health: { 'latest-supa-eu': ago(91) } }, /latest-supa-eu last delivered 91 minutes ago \(limit 90\)\. Check the Supabase reader; a frozen game API passes on its own\./);
  await red({ health: { 'latest-supa-eu': ago(91) }, status: { [GAME_MATCHES]: 503 } }, /last delivered 91 minutes ago \(limit 90\)\. The game API is not answering, so the Supabase readers have nothing to deliver\. This clears when the game API is back\./);
  await green({ health: { 'latest-supa-eu': ago(89) } });
  await green({ health: { 'latest-supa-eu': ago(90) } });
});

test('the game API is asked once however many sources are late', async () => {
  const r = await red({ health: { 'latest-supa-us': ago(100), 'latest-supa-eu': ago(100), kills: ago(100) } }, /last delivered/, 3);
  assert.equal(r.answer.asked[GAME_MATCHES], 2); // once for the lateness, once for the scores
});

test('the game API counts as down when it answers an error, not a list, or an empty one', async () => {
  for (const game of [{ a: 1 }, []]) {
    assert.equal(await gameApiDown(ctxOf({ game })), true);
  }
  assert.equal(await gameApiDown(ctxOf({ status: { [GAME_MATCHES]: 500 } })), true);
  assert.equal(await gameApiDown(ctxOf({ game: '"abc"' })), true);
  assert.equal(await gameApiDown(ctxOf({})), false);
});

test('the daily cleanup: never, 25 hours (green), 27 hours (red)', async () => {
  await red({ health: { cleanup: 0 } }, /has never heard from the daily cleanup\. Check its cron on the Worker wvwrelink-api\./);
  await green({ health: { cleanup: NOW - 25 * 3600 } }, /cleanup last ran +25 h ago/);
  await green({ health: { cleanup: NOW - 26 * 3600 } }, /cleanup last ran +26 h ago/);
  await red({ health: { cleanup: NOW - 27 * 3600 } }, /The daily cleanup last ran 27 hours ago \(limit 26\)\./);
});

test('/api/kills: an error is red, but a 503 while the kills source is quiet between 20 and 90 minutes is a note', async () => {
  const stale = (status) => ({ status: { [`${API}kills`]: status } });
  await red(stale(500), /\/api\/kills: HTTP 500 after 3 attempts\. The page is reading the kills sheet\./);
  await green({ ...stale(503), health: { kills: ago(30) } }, /\/api\/kills +503 stale, source quiet 30 min \(frozen API\?\)/);
  await red({ ...stale(503), health: { kills: ago(10) } }, /\/api\/kills: HTTP 503/);
  await red({ ...stale(503), health: { kills: ago(20) } }, /\/api\/kills: HTTP 503/);
  await red({ ...stale(500), health: { kills: ago(30) } }, /\/api\/kills: HTTP 500/);
  await red({ ...stale(503), health: { kills: ago(95) } }, /\/api\/kills: HTTP 503/, 2);
  await green({ ...stale(503), health: { kills: ago(90) } }, /503 stale, source quiet 90 min/);
  await red({ ...stale(503), health: { kills: 0 } }, /\/api\/kills: HTTP 503/, 2);
});

test('/api/kills: no rows, rows that are not the shape, each is red', async () => {
  await red({ rows: [] }, /\/api\/kills answered without rows\./);
  await red({ rows: 'abc' }, /\/api\/kills answered without rows\./);
  const bad = (r) => red({ rows: [row(NOW - 60), r] }, /\/api\/kills: 1 of 2 rows are not \[at, match, center, red, blue, green\], e\.g\. /);
  await bad([1, '1-1', 1]);
  await bad(['x', '1-1', 1, 2, 3, 4]);
  await bad([1, ['1-1'], 1, 2, 3, 4]);
  await bad([1, 'x1-1', 1, 2, 3, 4]);
  await bad([1, '1-0', 1, 2, 3, 4]);
  await bad([1, '3-1', 1, 2, 3, 4]);
  await bad([1, '1-1', 1, 'x', 3, 4]);
  await bad([1, '1-1', -1, 2, 3, 4]);
  await bad([1, 'é', 1, 2, 3, 4]);
  await bad('x');
});

test('the example of a bad row is json.dumps\'d and cut at 120 characters', async () => {
  const r = await red({ rows: [[1, '1-1', 'é', 'x'.repeat(200), 3, 4]] }, /e\.g\. \[1, "1-1", "\\u00e9", "x+$/m);
  const line = errors(r)[0];
  assert.equal(line.slice(line.indexOf('e.g. ') + 5).length, 120);
});

test('/api/relink: an error, or anything but integers window and published', async () => {
  await red({ status: { [`${API}relink`]: 500 } }, /\/api\/relink: HTTP 500 after 3 attempts\. The page is reading the relink sheet\./);
  await red({ relink: { window: 1 } }, /\/api\/relink is not \{window, published\} as integers: \{"window": 1\}/);
  await red({ relink: { window: '1', published: 2 } }, /is not \{window, published\} as integers/);
  await red({ relink: [1] }, /is not \{window, published\} as integers: \[1\]/);
  await red({ relink: null }, /is not \{window, published\} as integers: null/);
  const long = await red({ relink: { x: 'y'.repeat(200) } }, /is not \{window, published\} as integers: \{"x": "y+$/m);
  assert.equal(errors(long)[0].split('integers: ')[1].length, 120);
});

test('the summary: an error, nothing, a list, and a match that is not the shape', async () => {
  await red({ status: { [`${API}latest/summary`]: 500 } }, /\/api\/latest\/summary: HTTP 500 after 3 attempts\. The Supabase readers are not reaching the summary\./);
  await red({ summary: {} }, /\/api\/latest\/summary answered without matches\./);
  await red({ summary: [1] }, /answered without matches\./);
  const bad = (extra, what) => red({ summary: { '1-1': sum(), ...extra } }, /1 of 2 matches are not \{start, score, at, by\} from a known latest-\* source, e\.g\. /, 1);
  await bad({ '3-1': sum() });
  await bad({ '1-2': sum({ by: 'kills' }) });
  await bad({ '1-2': sum({ start: 'x' }) });
  await bad({ '1-2': sum({ score: 1.5 }) });
  await bad({ '1-2': sum({ at: -1 }) });
  await bad({ '1-2': 5 });
  await bad({ '1-2': null });
  await bad({ 'x1-1': sum() });
  await bad({ '1-0': sum() });
  const long = await red({ summary: { '1-1': sum(), ['3-' + 'k'.repeat(200)]: sum() } }, /e\.g\. \{"3-k+$/m);
  assert.equal(errors(long)[0].split('e.g. ')[1].length, 120);
});

test('the summary\'s bad match is quoted as json.dumps wrote it', async () => {
  const r = await red({ summary: { '1-1': sum(), 'é"\n': sum() } }, /e\.g\. \{"\\u00e9\\"\\n": \{"start": \d+, "score": 100, "at": \d+, "by": "latest-supa-us"\}\}/);
  assert.ok(!errors(r)[0].includes('\n'));
});

test('one stale match among fresh ones fails the summary', async () => {
  await red({ summary: { '1-1': sum(), '1-2': sum({ at: NOW - 3 * 3600 }) } }, /oldest match is 180 minutes old \(limit 90\)\. Check the Supabase readers\./);
  await green({ summary: { '1-1': sum(), '1-2': sum({ at: ago(89) }) } });
  await green({ summary: { '1-1': sum(), '1-2': sum({ at: ago(90) }) } });
  const copy = await run({ summary: { '1-1': sum(), '1-2': sum({ at: ago(89) }) } });
  assert.ok(copy.asked.includes(`GET ${API}latest`), 'the copy is asked while the newest match is fresh');
});

test('the stale match with the game API down: the cause is the game API', async () => {
  await red({ summary: { '1-1': sum(), '1-2': sum({ at: NOW - 3 * 3600 }) }, status: { [GAME_MATCHES]: 503 } }, /oldest match is 180 minutes old \(limit 90\)\. The game API is not answering/);
});

test('a tier left from last week, still in the summary, is not judged', async () => {
  const old = sum({ start: START - 8 * 86400e3, at: ago(100) });
  await green({ summary: { '1-1': sum(), '1-2': old } });
  await green({ summary: { '1-1': sum(), '2-2': old } });
});

test('the copy is asked only while the summary is fresh: 10 minutes yes, 601 seconds no', async () => {
  const all = (at) => ({ summary: { '1-1': sum({ at }), '2-1': sum({ at, by: 'latest-supa-eu' }) } });
  const fresh = await green(all(NOW - 600), /\/api\/latest +HTTP 200/);
  assert.ok(fresh.asked.includes(`GET ${API}latest`));
  const stale = await run(all(NOW - 601));
  assert.ok(!stale.asked.includes(`GET ${API}latest`));
  assert.ok(!stale.log.includes('/api/history'));
});

test('/api/latest failing while the summary is fresh: red', async () => {
  await red({ status: { [`${API}latest`]: 500 } }, /\/api\/latest: HTTP 500 after 3 attempts while the summary is fresh\. The page is reading the game alone\./);
});

test('the history of each region: the version of the week, the ceiling when it differs, one below', async () => {
  const r = await green({});
  assert.match(r.log, /^\/api\/history\/1 +v=17, 1 matches$/m);
  assert.match(r.log, /^\/api\/history\/2 +v=21, 1 matches$/m);
  assert.ok(r.asked.includes(`GET ${API}history/1?v=17`));
});

test('the history: the next version is tried first at the end of a block (the skew), then the one below', async () => {
  const body = SOURCE.replace('MAX_SKEW_S = 300', 'MAX_SKEW_S = 7000');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
  fs.mkdirSync(path.join(root, 'worker'));
  fs.writeFileSync(path.join(root, 'worker', 'index.mjs'), body);
  const status = (v) => ({ [`${API}history/1?v=${v}`]: 500 });
  const r = await run({ status: { ...status(17) } }, { root });
  assert.match(r.log, /^\/api\/history\/1 +v=18, 1 matches$/m);
  const r2 = await run({ status: { ...status(17), ...status(18) } }, { root });
  assert.match(r2.log, /^\/api\/history\/1 +v=16, 1 matches$/m);
  fs.rmSync(root, { recursive: true });
});

test('the history failure names every version tried, in order, once each (two, then three)', async () => {
  const status = (region, versions) => Object.fromEntries(versions.map((v) => [`${API}history/${region}?v=${v}`, 500]));
  await red({ status: status(1, [17, 16]) }, /\/api\/history\/1: HTTP 500 after 3 attempts for v=17 and v=16 while the summary is fresh\. The readers are not sending the histories\./);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
  fs.mkdirSync(path.join(root, 'worker'));
  fs.writeFileSync(path.join(root, 'worker', 'index.mjs'), SOURCE.replace('MAX_SKEW_S = 300', 'MAX_SKEW_S = 7000'));
  const r = await run({ status: status(1, [16, 17, 18]) }, { root });
  assert.match(r.log, /\/api\/history\/1: HTTP 500 after 3 attempts for v=17, v=18 and v=16 while the summary is fresh\./);
  assert.deepEqual(r.asked.filter((a) => a.includes('history/1')).map((a) => a.slice(-2)), ['17', '17', '17', '18', '18', '18', '16', '16', '16']);
  fs.rmSync(root, { recursive: true });
});

test('a history without matches says so, whatever the empty thing is', async () => {
  for (const hist of [{ matches: [] }, [1], { matches: '' }, { matches: {} }]) {
    await red({ history: { 1: hist } }, /\/api\/history\/1: no matches for v=17 and v=16 while the summary is fresh/);
  }
  await green({ history: { 1: { matches: 'abc' } } }, /v=17, 3 matches/);
  await green({ history: { 1: { matches: { a: 1 } } } }, /v=17, 1 matches/);
});

test('the week just begun: no history asked, a note says so', async () => {
  const reset = { 1: [0, 12], 2: [0, 12] };
  const ctx = ctxOf({});
  ctx.limits = { ...ctx.limits, reset };
  const notes = [];
  const asked = [];
  ctx.getJson = async (url) => { asked.push(url); return [{}, null]; };
  await checkCopy(ctx, 0, NOW, [], notes);
  assert.deepEqual(asked, [`${API}latest`]);
  assert.deepEqual(notes, ['/api/latest                        HTTP 200', '/api/history/1                     skipped, week just begun', '/api/history/2                     skipped, week just begun']);
});

test('two blocks in, the history is asked: 2 is the first version worth asking for', async () => {
  const ctx = ctxOf({});
  ctx.limits = { ...ctx.limits, reset: { 1: [0, 8] } };
  const asked = [];
  ctx.getJson = async (url) => { asked.push(url); return [{ matches: [1] }, null]; };
  await checkCopy(ctx, 0, NOW, [], []);
  assert.deepEqual(asked, [`${API}latest`, `${API}history/1?v=2`]);
});

test('the start of a week: a Saturday 02:00 reset seen on a Sunday, a Sunday reset still to come, and the day itself', () => {
  const reset = { 1: [6, 2], 2: [0, 13], 3: [0, 12], 4: [1, 0], 5: [3, 5] };
  const at = (region) => new Date(weekStart(reset, region, NOW) * 1000).toISOString();
  assert.equal(at(1), '2026-11-21T02:00:00.000Z');
  assert.equal(at(2), '2026-11-15T13:00:00.000Z');
  assert.equal(at(3), '2026-11-22T12:00:00.000Z');
  assert.equal(at(4), '2026-11-16T00:00:00.000Z');
  assert.equal(at(5), '2026-11-18T05:00:00.000Z');
});

test('the summary against the game: ahead by more than the API can lag is the stolen-secret alarm', async () => {
  await red({ summary: { '1-1': sum({ score: 100 + 42001 }), '2-1': sum({ by: 'latest-supa-eu' }) } }, /the summary is ahead of the game by more than the API can lag: a signing secret may be stolen \(1-1\)\. Rotate the INGEST_LATEST_\* secrets\./);
  await green({ summary: { '1-1': sum({ score: 100 + 42000 }), '2-1': sum({ by: 'latest-supa-eu' }) } }, /^summary vs game API +2 matches compared$/m);
  await red({ summary: { '1-1': sum({ score: 99999 }), '2-1': sum({ score: 99999, by: 'latest-supa-eu' }) } }, /\(1-1, 2-1\)/);
});

test('a match the game does not know, or at another start, is not compared', async () => {
  const game = (id, start) => [{ id, start_time: new Date(start).toISOString(), scores: { red: 1 } }];
  await green({ game: game('1-1', START), summary: { '1-1': sum(), '2-1': sum({ score: 99999, by: 'latest-supa-eu' }) } }, /^summary vs game API +1 matches compared$/m);
  await green({ game: game('1-1', START + 1000), summary: { '1-1': sum({ score: 99999 }) } }, /^summary vs game API +0 matches compared$/m);
});

test('a game API that cannot be read says the alarm did not run, for each way it cannot', async () => {
  const note = /^game API unreadable: the secret-theft alarm did not run$/m;
  await green({ status: { [GAME_MATCHES]: 503 } }, note);
  await green({ game: { a: 1 } }, note);
  await green({ game: [{ id: '1-1', scores: { red: 1 } }] }, note);
  await green({ game: [{ id: '1-1', start_time: 'soon', scores: { red: 1 } }] }, note);
  await green({ game: [{ id: '1-1', start_time: new Date(START).toISOString(), scores: { red: 'a' } }] }, note);
  await green({ game: [{ id: '1-1', start_time: new Date(START).toISOString() }] }, note);
});

// The kills the page draws come from rows a stolen secret can hold back while every answer is 200.
const follow = (summaryAge, lag) => {
  const at = NOW - summaryAge;
  return run({ summary: { '1-1': sum({ at, score: 5 }) }, rows: lag === null ? [row(NOW, '1-2')] : [row(at - lag, '1-1')], health: { kills: NOW } });
};

test('a match whose newest kills line is 31 minutes behind its fresh summary is reported', async () => {
  const r = await follow(60, 31 * 60);
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /live matches whose kills have stopped following the score: 1-1: newest kills line \(at \d{13}\) is 31 minutes behind its summary \(limit 30\)\. .*INGEST_KILLS/);
});

test('a kills line 30 minutes behind the summary is not reported, 29 neither', async () => {
  assert.equal((await follow(60, 30 * 60)).code, 0);
  const r = await follow(60, 29 * 60);
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /^kills vs summary +1 live matches follow$/m);
});

test('a match with an old summary is not judged, however far its kills lag: 5 minutes is the edge', async () => {
  assert.equal((await follow(6 * 60, 31 * 60)).code, 0);
  assert.equal((await follow(5 * 60, 31 * 60)).code, 0);
  assert.equal((await follow(5 * 60 - 1, 31 * 60)).code, 1);
});

test('a match begun long ago with a fresh summary and no kills line is reported', async () => {
  const r = await follow(60, null);
  assert.equal(r.code, 1, r.log);
  assert.match(r.log, /1-1: no kills line in \/api\/kills, the line holding it is older than what it shows and is found in D1/);
});

test('no kills line is fine for a score of 0 or a match that began a moment ago', async () => {
  const row2 = [row(NOW, '1-2')];
  await green({ summary: { '1-1': sum({ score: 0 }) }, rows: row2 }, /kills vs summary +0 live matches follow/);
  await green({ summary: { '1-1': sum({ start: (NOW - 20 * 60) * 1000 }) }, rows: row2 });
  await green({ summary: { '1-1': sum({ start: (NOW - 30 * 60) * 1000 }) }, rows: row2 });
});

test('the newest line of a match is the one judged, however the rows come', async () => {
  const r = await green({ rows: [row(NOW - 3 * 3600), row(NOW - 61), row(NOW - 2 * 3600), row(NOW - 60, '2-1')] });
  assert.match(r.log, /kills vs summary +2 live matches follow/);
});

test('two late matches are one problem, joined, in the order of the matches', async () => {
  const r = await red({ rows: [row(NOW - 3600, '1-1'), row(NOW - 3600, '2-1')] }, /1-1: newest kills line .*; 2-1: newest kills line/);
  assert.equal(errors(r).length, 1);
});

test('the kills comparison says so when /api/kills was not read', async () => {
  const notes = [];
  checkKillsFollow({}, null, 0, [], notes);
  assert.deepEqual(notes, ['kills vs summary                   not judged, /api/kills unread']);
  const r = await run({ status: { [`${API}kills`]: 500 } });
  assert.match(r.log, /^kills vs summary +not judged, \/api\/kills unread$/m);
  const r2 = await run({ rows: [row(1), [1]] });
  assert.match(r2.log, /^kills vs summary +not judged, \/api\/kills unread$/m);
});

test('the log: notes, then every problem, then a blank line and the count; green prints no count', async () => {
  const r = await run({ health: { relink: 0, cleanup: 0 } });
  assert.equal(r.out.at(-1), '2 problem(s).');
  assert.equal(r.out.at(-2), '');
  assert.ok(r.out.at(-3).startsWith('::error::'));
  assert.ok(!(await run({})).log.includes('problem'));
});

test('a problem that carries text from outside cannot start a workflow command', async () => {
  const r = await red({ summary: { '1-1': sum(), 'x\n::error::y': sum() } }, /x\\n::error::y/);
  assert.ok(!r.out.some((l) => l === '::error::y'));
});

test('checkFeeds remembers the kills age for /api/kills, and checkReads leaves the rows for the comparison', async () => {
  const ctx = ctxOf({ health: { kills: ago(30) } });
  await checkFeeds(ctx, [], []);
  assert.equal(ctx.killsAge, 30 * 60);
  await checkReads(ctx, [], []);
  assert.equal(ctx.killsRows.length, 2);
  for (const kills of [0, 1.5, 'x']) {
    const odd = ctxOf({ health: { kills } });
    await checkFeeds(odd, [], []);
    assert.equal(odd.killsAge, null, String(kills));
  }
  const none = ctxOf({ health: { kills: 0 } });
  await checkFeeds(none, [], []);
  assert.equal(none.killsAge, null);
});

test('checkLatest alone, as the summary and the game say it', async () => {
  const problems = [];
  await checkLatest(ctxOf({}), problems, []);
  assert.deepEqual(problems, []);
});

test('a read that fails with a message carrying a newline cannot start a workflow command', async () => {
  const r = await main({ fetchFn: async () => { throw new TypeError('x\n::error::y'); }, sleep: fakeSleep(), now: () => NOW_MS, root: ROOT });
  assert.equal(r.code, 1);
  assert.ok(r.out.some((l) => l.includes('x%0A::error::y')));
  assert.ok(!r.out.some((l) => l.startsWith('::error::y')));
});

test('run as a script: it prints the log and exits with the code; a Worker it cannot read stops it on stderr', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'worker'));
  for (const f of ['check-worker.mjs', 'workflow-text.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(root, 'scripts', f));
  fs.writeFileSync(path.join(root, 'worker', 'index.mjs'), 'const nothing = 1;');
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-worker.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /worker\/index\.mjs no longer has `const STALE_RELINK_S = a \* b;`/);
  assert.equal(r.stdout, '');
  fs.rmSync(root, { recursive: true });
});
