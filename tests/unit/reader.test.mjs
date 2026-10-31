// The Supabase reader (supabase/): its rules, then what it builds against the
// Worker's own entrance, and the function's gate with Deno and fetch stubbed.
// Run: node --test "tests/unit/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './fake-d1.mjs';
import { postSigned, signHeaders } from './signed.mjs';
import {
  REGIONS, regionFor, checkMatch, checkRead, checkSummaryBody, pickNewer, buildBody, sign, sameSecret, handle, boardOf
} from '../../supabase/reader.mjs';

// 2026-10-03 is a Saturday: the NA week began 02:00Z, 10 hours before this clock.
const NOW = Date.parse('2026-10-03T12:00:00Z');
const NA_START = '2026-10-03T02:00:00Z';
const EU_START = '2026-10-02T18:00:00Z';
const SECRET = { 'us-east-1': 'a'.repeat(128), 'eu-central-1': 'b'.repeat(128) };

// A match shaped like the game API's (04/10/2026), with room for overrides.
function apiMatch(id = '1-1', o = {}) {
  const eu = id[0] === '2';
  const w = eu ? [2001, 2002, 2003] : [1001, 1002, 1003];
  const trio = (a, b, c) => ({ red: a, blue: b, green: c });
  const map = (type, k) => ({
    id: 38, type, scores: trio(1, 2, 3), bonuses: [{ type: 'Bloodlust', owner: 'Red' }],
    objectives: [{ id: '38-6', owner: 'Green', last_flipped: '2026-10-03T11:00:00Z', claimed_by: 'ABCD-12-ef' }],
    deaths: trio(1, 1, 1), kills: trio(k, k, k)
  });
  return {
    id, start_time: eu ? EU_START : NA_START, end_time: '2026-10-10T01:58:00Z',
    scores: trio(...(o.scores || [1000, 2000, 3000])), worlds: trio(...w),
    all_worlds: { red: [w[0], w[0] + 10000], blue: [w[1]], green: [w[2]] },
    deaths: trio(5, 6, 7), kills: trio(8, 9, 10), victory_points: trio(1, 2, 3),
    skirmishes: [{ id: 1, scores: trio(1, 2, 3), map_scores: [{ type: 'Center', scores: trio(1, 2, 3) }] }],
    maps: [map('Center', 10), map('RedHome', 20), map('BlueHome', 30), map('GreenHome', 40)],
    ...o.over
  };
}

test('a match of the game API passes, with the sums the Worker wants', () => {
  const m = checkMatch(apiMatch('1-1'), NOW);
  assert.equal(m.score, 6000);
  assert.deepEqual(m.kills, [30, 60, 90, 120]);
  assert.equal(m.start, Date.parse(NA_START));
  assert.ok(checkMatch(apiMatch('2-3'), NOW));
});

test('a damaged or strange match is left out, the others go on', () => {
  const bad = {
    'not an object': 'x',
    'id out of range': apiMatch('1-1', { over: { id: '1-10' } }),
    'start not a reset': apiMatch('1-1', { over: { start_time: '2026-10-03T03:00:00Z' } }),
    'EU week on an NA match': apiMatch('1-1', { over: { start_time: EU_START } }),
    'start in the future': apiMatch('1-1', { over: { start_time: '2026-10-10T02:00:00Z' } }),
    'team id of the other side': apiMatch('1-1', { over: { worlds: { red: 2001, blue: 1002, green: 1003 } } }),
    'negative score': apiMatch('1-1', { scores: [-1, 2, 3] }),
    'fractional kills': apiMatch('1-1', { over: { kills: { red: 1.5, blue: 1, green: 1 } } }),
    'score a week cannot hold': apiMatch('1-1', { scores: [9e6, 0, 0] }),
    'free text in a string': apiMatch('1-1', { over: { extra: '<img src=x onerror=1>' } }),
    'text in a key': apiMatch('1-1', { over: { 'a b': 1 } }),
    'a map missing': apiMatch('1-1', { over: { maps: apiMatch('1-1').maps.slice(1) } })
  };
  for (const [what, m] of Object.entries(bad)) assert.equal(checkMatch(m, NOW), null, what);
  const r = checkRead([apiMatch('1-1'), bad['negative score'], apiMatch('1-1'), apiMatch('2-1')], NOW);
  assert.deepEqual(r.matches.map((m) => m.id), ['1-1', '2-1']);
  assert.equal(r.dropped, 2);
  for (const what of [null, {}, [], 'x', new Array(19).fill(apiMatch())]) assert.equal(checkRead(what, NOW), 'shape');
});

test('only what is newer than the Worker holds is sent', () => {
  const ms = ['1-1', '1-2', '1-3', '1-4'].map((id, i) => checkMatch(apiMatch(id, { scores: [1000 + i, 0, 0] }), NOW));
  const week = Date.parse(NA_START);
  const summary = checkSummaryBody({
    '1-1': { start: week, score: 1000, extra: 1 },  // same week, same score: nothing new
    '1-2': { start: week, score: 5000 },            // Worker ahead
    '1-3': { start: week + 7 * 86400e3, score: 1 }, // Worker on a later week: never goes back
    '1-4': { start: week - 7 * 86400e3, score: 9e6 } // a new week beats any old score
  });
  assert.deepEqual(pickNewer(ms, summary).map((m) => m.id), ['1-4']);
  assert.deepEqual(pickNewer(ms, {}).map((m) => m.id), ['1-1', '1-2', '1-3', '1-4']);
  assert.equal(pickNewer([checkMatch(apiMatch('1-1', { scores: [1001, 0, 0] }), NOW)], { '1-1': { start: week, score: 1000 } }).length, 1);
  for (const bad of [null, [], { 'x': { start: 1, score: 1 } }, { '1-1': { start: 'a', score: 1 } }, { '1-1': null }]) {
    assert.equal(checkSummaryBody(bad), null);
  }
});

// The Worker's door with the reader's secrets, clock held at NOW.
function door() {
  const { sql, DB } = fakeD1();
  const env = { DB, INGEST_LATEST_SUPA_US: SECRET['us-east-1'], INGEST_LATEST_SUPA_EU: SECRET['eu-central-1'] };
  return {
    sql,
    async push(region, body, t = Math.floor(NOW / 1000)) {
      const { source } = REGIONS[region];
      const path = '/api/ingest/' + source;
      const sig = await sign(SECRET[region], String(t), path, body);
      const r = await postSigned(env, NOW, path, body, { 'x-wvw-time': String(t), 'x-wvw-sig': sig });
      return { status: r.status, text: await r.text() };
    }
  };
}

test('what the reader builds is accepted by the Worker, each region at its own door', async () => {
  const w = door();
  const read = checkRead([apiMatch('1-1'), apiMatch('1-2'), apiMatch('2-1')], NOW);
  const built = await buildBody(read.matches);
  assert.equal(built.count, 3);
  const r = await w.push('us-east-1', built.body);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(JSON.parse(r.text).applied, ['1-1', '1-2', '2-1']);
  const row = w.sql.prepare("SELECT reader, score, raw FROM latest WHERE id = '1-1'").get();
  assert.equal(row.reader, 'latest-supa-us');
  assert.equal(row.score, 6000);
  assert.equal(row.raw, new TextEncoder().encode(read.matches[0].text).length);
  // Same read again: its own score is no longer newer, so nothing is built.
  const again = pickNewer(read.matches, { '1-1': { start: read.matches[0].start, score: 6000 } });
  assert.deepEqual(again.map((m) => m.id), ['1-2', '2-1']);
  const eu = await buildBody(again.filter((m) => m.id === '2-1'));
  const r2 = await w.push('eu-central-1', eu.body, Math.floor(NOW / 1000) + 1);
  assert.equal(r2.status, 200, r2.text);
  assert.equal(await buildBody([]), null);
});

test('a signature made with the other region\'s secret is refused', async () => {
  const w = door();
  const built = await buildBody(checkRead([apiMatch('1-1')], NOW).matches);
  const t = Math.floor(NOW / 1000);
  const path = '/api/ingest/' + REGIONS['us-east-1'].source;
  assert.equal(await sign(SECRET['us-east-1'], String(t), path, built.body),
    signHeaders(SECRET['us-east-1'], t, path, built.body)['x-wvw-sig']);
  const sig = await sign(SECRET['eu-central-1'], String(t), path, built.body);
  const { DB } = fakeD1();
  const r = await postSigned({ DB, INGEST_LATEST_SUPA_US: SECRET['us-east-1'] }, NOW, path, built.body,
    { 'x-wvw-time': String(t), 'x-wvw-sig': sig });
  assert.equal(r.status, 401);
  assert.ok(w);
});

test('the secret and the door come from where the function runs, and the call must agree', () => {
  assert.equal(regionFor('us-east-1', 'us-east-1'), REGIONS['us-east-1']);
  assert.equal(regionFor('eu-central-1', 'eu-central-1'), REGIONS['eu-central-1']);
  for (const [sb, x] of [['us-east-1', 'eu-central-1'], ['eu-central-1', null], [undefined, 'us-east-1'],
    ['ap-southeast-1', 'ap-southeast-1'], ['constructor', 'constructor'], ['', '']]) assert.equal(regionFor(sb, x), null);
});

test('the secret comparison tells equal from different, whatever the lengths', async () => {
  assert.equal(await sameSecret('abc', 'abc'), true);
  for (const [a, b] of [['abc', 'abd'], ['', 'abc'], ['abc', ''], ['a'.repeat(500), 'a'.repeat(128)]]) {
    assert.equal(await sameSecret(a, b), false);
  }
});

// The function itself, with Deno and the network stubbed.
// The function, called directly with an environment of its own.
function loadHandler(env) {
  env = { SB_REGION: 'eu-central-1', ...env };
  return (req) => handle(req, (k) => env[k]);
}

test('the function answers 404, empty, before it reads anything, unless the call is right', async () => {
  const LOCK = 'k'.repeat(128);
  const handler = loadHandler({ READER_KEY: LOCK, INGEST_LATEST_SUPA_US: SECRET['us-east-1'], INGEST_LATEST_SUPA_EU: SECRET['eu-central-1'] });
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const urls = [];
  let pushed = null;
  Date.now = () => NOW;
  globalThis.fetch = async (url, init = {}) => {
    urls.push(String(url));
    if (String(url).startsWith('https://api.guildwars2.com/')) return new Response(JSON.stringify([apiMatch('1-1'), apiMatch('2-1')]));
    if (String(url) === 'https://wvwrelink.com/api/latest/summary') {
      return new Response(JSON.stringify({ '1-1': { start: Date.parse(NA_START), score: 6000, at: 1, by: 'x' } }));
    }
    pushed = { url: String(url), headers: init.headers, body: init.body };
    return new Response('{"applied":["2-1"]}');
  };
  const call = (headers, method = 'POST') => handler(new Request('https://x.supabase.co/functions/v1/reader', { method, headers }));
  try {
    for (const [what, headers, method] of [
      ['no key', { 'x-region': 'us-east-1' }],
      ['wrong key', { 'x-wvw-key': 'z'.repeat(128), 'x-region': 'us-east-1' }],
      ['key in the wrong place', { 'x-region': 'us-east-1', authorization: 'Bearer ' + LOCK }],
      ['GET', { 'x-wvw-key': LOCK, 'x-region': 'us-east-1' }, 'GET'],
      ['unknown region', { 'x-wvw-key': LOCK, 'x-region': 'ap-southeast-1' }],
      ['no region', { 'x-wvw-key': LOCK }],
      ['called for the US, ran in the EU', { 'x-wvw-key': LOCK, 'x-region': 'us-east-1' }],
      ['inherited name as region', { 'x-wvw-key': LOCK, 'x-region': 'constructor' }]
    ]) {
      const r = await call(headers, method);
      assert.equal(r.status, 404, what);
      assert.equal(await r.text(), '', what);
    }
    assert.deepEqual(urls, []);

    const r = await call({ 'x-wvw-key': LOCK, 'x-region': 'eu-central-1' });
    assert.equal(r.status, 200);
    assert.deepEqual(urls, ['https://api.guildwars2.com/v2/wvw/matches?ids=all', 'https://wvwrelink.com/api/latest/summary',
      'https://wvwrelink.com/api/ingest/latest-supa-eu']);
    // Only 2-1 is newer than the Worker's copy, and the Worker takes it.
    const w = door();
    const t = Number(pushed.headers['x-wvw-time']);
    const check = await w.push('eu-central-1', pushed.body, t);
    assert.equal(check.status, 200);
    assert.deepEqual(JSON.parse(check.text).applied, ['2-1']);
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
});

test('the function fails with a generic answer when the game API is wrong', async () => {
  const LOCK = 'k'.repeat(128);
  const handler = loadHandler({ SB_REGION: 'us-east-1', READER_KEY: LOCK, INGEST_LATEST_SUPA_US: SECRET['us-east-1'] });
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response('<html>nope</html>'); };
  const log = console.log;
  const lines = [];
  console.log = (s) => lines.push(String(s));
  try {
    const r = await handler(new Request('https://x.supabase.co/', { method: 'POST', headers: { 'x-wvw-key': LOCK, 'x-region': 'us-east-1' } }));
    assert.equal(r.status, 500);
    assert.equal(await r.text(), '{"ok":false}\n');
    assert.deepEqual(seen, ['https://api.guildwars2.com/v2/wvw/matches?ids=all']);
    assert.ok(lines.every((l) => !l.includes(LOCK) && !l.includes('nope')));
  } finally {
    globalThis.fetch = realFetch;
    console.log = log;
  }
});

// ---- What the function does with each thing the outside can get wrong.
const MAP_TYPES = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];
const LOCK = 'k'.repeat(128);
const GAME = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';

// Runs one call of the function in the US region with the network stubbed:
// `answers` maps a URL start to a Response (or a function giving one, or an Error to throw).
async function callReader(answers, env = {}) {
  const handler = loadHandler({ SB_REGION: 'us-east-1', READER_KEY: LOCK, INGEST_LATEST_SUPA_US: SECRET['us-east-1'], ...env });
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const log = console.log;
  const asked = [];
  const lines = [];
  Date.now = () => NOW;
  console.log = (s) => lines.push(String(s));
  globalThis.fetch = async (url, init = {}) => {
    asked.push({ url: String(url), init });
    const key = Object.keys(answers).find((k) => String(url).startsWith(k));
    let a = key === undefined ? new Response('unexpected', { status: 500 }) : answers[key];
    if (typeof a === 'function') a = a(init);
    if (a instanceof Error) throw a;
    return a;
  };
  try {
    const r = await handler(new Request('https://x.supabase.co/', { method: 'POST', headers: { 'x-wvw-key': LOCK, 'x-region': 'us-east-1' } }));
    return { status: r.status, text: await r.text(), asked, lines };
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    console.log = log;
  }
}
const SUMMARY = 'https://wvwrelink.com/api/latest/summary';
const INGEST = 'https://wvwrelink.com/api/ingest/latest-supa-us';
const json = (x, init) => new Response(JSON.stringify(x), init);
const empty = () => json({});

test('the function: a game API that fails, lies or is too big gives a generic 502 and sends nothing', async () => {
  const ok = [apiMatch('1-1')];
  // A valid list padded with spaces to an exact size; a Response from a string carries no content-length.
  const padded = (bytes) => { const s = JSON.stringify(ok); return s + ' '.repeat(bytes - s.length); };
  const chunked = (bytes) => new Response(new ReadableStream({
    start(c) { const enc = new TextEncoder().encode(padded(bytes)); for (let i = 0; i < enc.length; i += 65536) c.enqueue(enc.subarray(i, i + 65536)); c.close(); }
  }));
  const cases = {
    'HTTP 503': [new Response('x', { status: 503 }), 502],
    'declared length past the cap': [new Response(JSON.stringify(ok), { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }), 502],
    'a stream one byte past the cap, no length': [chunked(4 * 1024 * 1024 + 1), 502],
    'a stream exactly at the cap is read': [chunked(4 * 1024 * 1024), 200],
    'JSON that is not a list': [json({ id: '1-1' }), 502],
    'an empty list': [json([]), 502],
    'nineteen entries': [json(new Array(19).fill(apiMatch('1-1'))), 502],
    'nothing the checks accept': [json([apiMatch('1-1', { scores: [-1, 0, 0] })]), 200]
  };
  for (const [what, [answer, want]] of Object.entries(cases)) {
    const r = await callReader({ [GAME]: answer, [SUMMARY]: empty, [INGEST]: () => json({ applied: [] }) });
    assert.equal(r.status, want, what);
    assert.equal(r.text, '{"ok":false}\n', what);
    if (want !== 200) assert.ok(!r.asked.some((a) => a.url === INGEST), what + ': nothing pushed');
  }
  const net = await callReader({ [GAME]: new Error('boom') });
  assert.equal(net.status, 500);
  assert.ok(net.lines.every((l) => !l.includes('boom')), 'the error text is not logged');
});

test('the function: ten matches with all 84 skirmishes, a body past 1 MiB, are read and sent', async () => {
  const trio = (a, b, c) => ({ red: a, blue: b, green: c });
  const r9 = () => Math.floor(Math.random() * 9000);
  const skirmishes = Array.from({ length: 84 }, (_, i) => ({
    id: i + 1, scores: trio(r9(), r9(), r9()),
    map_scores: MAP_TYPES.map((type) => ({ type, scores: trio(r9(), r9(), r9()) }))
  }));
  const objectives = Array.from({ length: 40 }, (_, j) => ({
    id: '38-' + j, type: 'Camp', owner: 'Green', last_flipped: '2026-10-03T11:00:00Z', claimed_by: 'ABCDEF01-1234-5678-9ABC-DEF012345678',
    claimed_at: '2026-10-03T11:00:00Z', points_tick: 5, points_capture: 10, yaks_delivered: j
  }));
  const maps = MAP_TYPES.map((type, k) => ({
    id: 38, type, scores: trio(r9(), r9(), r9()), bonuses: [{ type: 'Bloodlust', owner: 'Red' }], objectives,
    deaths: trio(1, 1, 1), kills: trio(k + 1, k + 1, k + 1)
  }));
  const ids = ['1-1', '1-2', '1-3', '1-4', '1-5', '2-1', '2-2', '2-3', '2-4', '2-5'];
  const list = ids.map((id) => apiMatch(id, { over: { skirmishes, maps } }));
  const big = JSON.stringify(list, null, 2);
  assert.ok(big.length > 1024 * 1024, 'the body is past the old cap: ' + big.length);
  const r = await callReader({ [GAME]: new Response(big), [SUMMARY]: empty, [INGEST]: () => json({ applied: [] }) });
  assert.equal(r.status, 200);
  const push = r.asked.find((a) => a.url === INGEST);
  assert.ok(push, 'pushed');
  const head = JSON.parse(new TextDecoder().decode(push.init.body).split('\n')[0]);
  assert.equal(head.matches.length, 10);
  assert.ok(push.init.body.length <= 256 * 1024, 'the send is within the Worker\'s limits');
  assert.ok(head.matches.every((m) => m.bytes <= 16 * 1024 && m.raw <= 256 * 1024), 'each slice is within the Worker\'s limits');
});

test('the function: the Worker\'s summary that fails, is too big or is the wrong shape gives 502 before any push', async () => {
  const game = json([apiMatch('1-1')]);
  const body = JSON.stringify({ '1-1': { start: 1, score: 1 } });
  const big = body + ' '.repeat(64 * 1024 + 1 - body.length);
  const cases = {
    'HTTP 500': new Response('x', { status: 500 }),
    'a summary over 64 KiB': new Response(big),
    'a summary that is a list': json([]),
    'an id that is no match': json({ 'x-1': { start: 1, score: 1 } }),
    'a score that is no integer': json({ '1-1': { start: 1, score: 'a' } }),
    'JSON null': new Response('null')
  };
  // Exactly 64 KiB of a valid summary is still read.
  const exact = await callReader({ [GAME]: () => game.clone(), [SUMMARY]: new Response(big.slice(0, -1)), [INGEST]: () => json({}) });
  assert.equal(exact.status, 200);
  for (const [what, answer] of Object.entries(cases)) {
    const r = await callReader({ [GAME]: () => game.clone(), [SUMMARY]: answer });
    assert.equal(r.status, 502, what);
    assert.ok(!r.asked.some((a) => a.url === INGEST), what);
  }
});

test('the function: nothing new is the normal quiet answer, 200 and no push, with the counts logged', async () => {
  const have = { '1-1': { start: Date.parse(NA_START), score: 6000 } };
  const r = await callReader({ [GAME]: json([apiMatch('1-1'), apiMatch('1-2', { scores: [-1, 0, 0] })]), [SUMMARY]: json(have) });
  assert.equal(r.status, 200);
  assert.ok(!r.asked.some((a) => a.url === INGEST));
  assert.deepEqual(JSON.parse(r.lines[0]), { region: 'us-east-1', sent: 0, dropped: 1 });
});

test('the function: the Worker refusing the push is a 502, accepting it a 200, and the push is signed for the reader\'s own door', async () => {
  const send = async (status) => {
    let pushed;
    const r = await callReader({
      [GAME]: json([apiMatch('1-1'), apiMatch('1-2')]), [SUMMARY]: empty,
      [INGEST]: (init) => { pushed = init; return new Response('{}', { status }); }
    });
    return { r, pushed };
  };
  for (const status of [400, 401, 409, 413, 422, 500]) assert.equal((await send(status)).r.status, 502, 'worker said ' + status);
  const good = await send(200);
  assert.equal(good.r.status, 200);
  assert.deepEqual(JSON.parse(good.r.lines.at(-1)), { region: 'us-east-1', sent: 2, dropped: 0, status: 200 });
  const t = good.pushed.headers['x-wvw-time'];
  assert.equal(good.pushed.headers['x-wvw-sig'], await sign(SECRET['us-east-1'], t, '/api/ingest/latest-supa-us', good.pushed.body));
  assert.ok(good.r.lines.every((l) => !l.includes(SECRET['us-east-1']) && !l.includes(LOCK)));
});

test('the function: a signing secret that is missing or short is a 500 before the game API is asked', async () => {
  for (const [what, secret] of [['missing', undefined], ['empty', ''], ['63 characters', 'a'.repeat(63)]]) {
    const r = await callReader({ [GAME]: json([apiMatch('1-1')]) }, { INGEST_LATEST_SUPA_US: secret });
    assert.equal(r.status, 500, what);
    assert.equal(r.text, '{"ok":false}\n', what);
    assert.deepEqual(r.asked, [], what);
  }
  // 64 is enough; the lock itself must be 64 too, or the function does not exist.
  assert.equal((await callReader({ [GAME]: json([]) }, { INGEST_LATEST_SUPA_US: 'a'.repeat(64) })).status, 502);
  const short = await callReader({ [GAME]: json([]) }, { READER_KEY: 'k'.repeat(63) });
  assert.equal(short.status, 404);
  assert.deepEqual(short.asked, []);
});

test('a match out of shape or too big is left out alone, the rest of the read goes on', async () => {
  const a = apiMatch('1-1');
  const edit = (f) => { const m = apiMatch('1-1'); f(m); return m; };
  // Values counted as the reader counts them: the match, every key's value, every array item.
  const count = (x) => (x !== null && typeof x === 'object' ? 1 + Object.values(x).reduce((n, v) => n + count(v), 0) : 1);
  const valuesTo20000 = 20000 - count({ ...a, pad: [] });
  const bad = {
    'world id as a string': edit((m) => { m.worlds.red = '1001'; }),
    'null where a count goes': edit((m) => { m.kills.red = null; }),
    'boolean where a count goes': edit((m) => { m.deaths.blue = true; }),
    'start_time with milliseconds': edit((m) => { m.start_time = '2026-10-03T02:00:00.000Z'; }),
    'start_time with minutes': edit((m) => { m.start_time = '2026-10-03T02:30:00Z'; }),
    'all_worlds missing': edit((m) => { delete m.all_worlds; }),
    'all_worlds with an empty side': edit((m) => { m.all_worlds.green = []; }),
    'all_worlds with five ids': edit((m) => { m.all_worlds.red = [1001, 1002, 1003, 1004, 1005]; }),
    'a map without kills': edit((m) => { delete m.maps[2].kills; }),
    'two maps of one type': edit((m) => { m.maps[1] = { ...m.maps[0] }; }),
    'nested 9 levels': edit((m) => { let o = m; for (let i = 0; i < 9; i++) o = o.n = {}; }),
    'one value past 20000': edit((m) => { m.pad = new Array(valuesTo20000 + 1).fill(1); }),
    'raw text past 256 KiB': edit((m) => { m.pad = Array.from({ length: 6000 }, (_, i) => 'a'.repeat(60) + i); })
  };
  for (const [what, m] of Object.entries(bad)) assert.equal(checkMatch(m, NOW), null, what);
  // The edges the other way: these still pass.
  const fine = {
    'nested 8 levels': edit((m) => { let o = m; for (let i = 0; i < 8; i++) o = o.n = {}; }),
    'four ids on a side': edit((m) => { m.all_worlds.red = [1001, 1002, 1003, 11001]; }),
    'exactly 20000 values': edit((m) => { m.pad = new Array(valuesTo20000).fill(1); })
  };
  for (const [what, m] of Object.entries(fine)) assert.ok(checkMatch(m, NOW), what);
  const r = checkRead([a, ...Object.values(bad).slice(0, 3), apiMatch('1-2')], NOW);
  assert.deepEqual(r.matches.map((m) => m.id), ['1-1', '1-2']);
  assert.equal(r.dropped, 3);
});

test('a match too big once gzipped is not sent, the others are', async () => {
  const noisy = apiMatch('1-2');
  let seed = 1;
  // About 18000 integers of nine digits: under the 20000 values and 256 KiB the checks allow, past the 16 KiB a slice may take.
  noisy.pad = Array.from({ length: 18000 }, () => (seed = (seed * 48271) % 2147483647) % 1e9);
  const read = checkRead([apiMatch('1-1'), noisy], NOW);
  assert.equal(read.matches.length, 2);
  const built = await buildBody(read.matches);
  assert.equal(built.count, 1);
  const head = JSON.parse(new TextDecoder().decode(built.body.subarray(0, built.body.indexOf(10))));
  assert.deepEqual(head.matches.map((m) => m.id), ['1-1']);
  assert.equal(await buildBody([read.matches[1]]), null);
});

// ---- board: the last finished skirmish, the running one and the VP, for the Worker's table.
const trio = (a, b, c) => ({ red: a, blue: b, green: c });
// NOW is 10 hours into the NA week: skirmish 6 runs.
const skirmishes = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, scores: trio(10 * i, 20 * i, 30 * i), map_scores: [] }));
const head = (built) => JSON.parse(new TextDecoder().decode(built.body.subarray(0, built.body.indexOf(10))));

test('the reader sends the last finished skirmish, the running one and the VP, and the Worker keeps the finished one', async () => {
  const m = apiMatch('1-1', { over: { skirmishes: skirmishes(6), victory_points: trio(130, 110, 90) } });
  const built = await buildBody(checkRead([m, apiMatch('1-2')], NOW).matches);
  const [one, two] = head(built).matches;
  assert.deepEqual(one.vp, [130, 110, 90]);
  assert.deepEqual(one.skirmishes, [[5, 40, 80, 120], [6, 50, 100, 150]]);
  assert.deepEqual(two.skirmishes, [[1, 1, 2, 3]], 'skirmish 1 running: nothing finished yet');
  const w = door();
  const r = await w.push('us-east-1', built.body);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual({ ...w.sql.prepare('SELECT match, skirmish, red, blue, green, vp_red, vp_blue, vp_green FROM board').get() },
    { match: '1-1', skirmish: 5, red: 40, blue: 80, green: 120, vp_red: 130, vp_blue: 110, vp_green: 90 });
  assert.equal(w.sql.prepare('SELECT count(*) n FROM board').get().n, 1);
});

test('skirmishes the Worker would refuse leave the match without them, and the match still goes', async () => {
  const edit = (f) => { const m = apiMatch('1-1', { over: { skirmishes: skirmishes(6) } }); f(m); return m; };
  const bad = {
    'no skirmishes': edit((m) => { delete m.skirmishes; }),
    'an empty list': edit((m) => { m.skirmishes = []; }),
    'a gap in the ids': edit((m) => { m.skirmishes.splice(4, 1); }),
    'an early skirmish missing': edit((m) => { m.skirmishes.splice(1, 1); }),
    'the last two out of order': edit((m) => { m.skirmishes.push(m.skirmishes.splice(4, 1)[0]); }),
    'a skirmish that has not begun': edit((m) => { m.skirmishes = skirmishes(7); }),
    'a skirmish without scores': edit((m) => { delete m.skirmishes[5].scores; }),
    'a score as text': edit((m) => { m.skirmishes[4].scores.red = '1'; }),
    'a skirmish past 1000 a minute': edit((m) => { m.skirmishes[4].scores = trio(122001, 0, 0); }),
    'a null skirmish': edit((m) => { m.skirmishes[5] = null; }),
    'a vp past 60 a skirmish': edit((m) => { m.victory_points = trio(361, 0, 0); })
  };
  for (const [what, m] of Object.entries(bad)) {
    const ok = checkMatch(m, NOW);
    assert.ok(ok, what);
    assert.equal(ok.board, null, what);
  }
  const built = await buildBody(checkRead(Object.values(bad).map((m, i) => ({ ...m, id: '1-' + (i + 1) })), NOW).matches);
  assert.ok(head(built).matches.every((e) => !('vp' in e) && !('skirmishes' in e)));
  const w = door();
  assert.equal((await w.push('us-east-1', built.body)).status, 200);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM board').get().n, 0);
  // The edges the other way: the largest skirmish score, and skirmish 7 five minutes before it begins.
  const big = edit((m) => { m.skirmishes[4].scores = trio(122000, 0, 0); });
  assert.deepEqual(checkMatch(big, NOW).board.skirmishes[0], [5, 122000, 0, 0]);
  assert.deepEqual(checkMatch(edit((m) => { m.victory_points = trio(360, 0, 0); }), NOW).board.vp, [360, 0, 0]);
  const start = Date.parse(NA_START);
  assert.equal(boardOf({ skirmishes: skirmishes(7), victory_points: trio(0, 0, 0) }, start, start + 12 * 3600e3 - 300e3 - 1), null);
  assert.ok(boardOf({ skirmishes: skirmishes(7), victory_points: trio(0, 0, 0) }, start, start + 12 * 3600e3 - 300e3));
});
