// The Supabase reader (supabase/): its rules, then what it builds against the
// Worker's own entrance, and the function's gate with Deno and fetch stubbed.
// Run: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/index.mjs';
import { fakeD1 } from './fake-d1.mjs';
import {
  REGIONS, regionFor, checkMatch, checkRead, checkResumo, pickNewer, buildBody, sign, sameSecret
} from '../supabase/leitor.mjs';
import { handle } from '../supabase/leitor.mjs';

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
  const resumo = checkResumo({
    '1-1': { start: week, score: 1000, extra: 1 },  // same week, same score: nothing new
    '1-2': { start: week, score: 5000 },            // Worker ahead
    '1-3': { start: week + 7 * 86400e3, score: 1 }, // Worker on a later week: never goes back
    '1-4': { start: week - 7 * 86400e3, score: 9e6 } // a new week beats any old score
  });
  assert.deepEqual(pickNewer(ms, resumo).map((m) => m.id), ['1-4']);
  assert.deepEqual(pickNewer(ms, {}).map((m) => m.id), ['1-1', '1-2', '1-3', '1-4']);
  assert.equal(pickNewer([checkMatch(apiMatch('1-1', { scores: [1001, 0, 0] }), NOW)], { '1-1': { start: week, score: 1000 } }).length, 1);
  for (const bad of [null, [], { 'x': { start: 1, score: 1 } }, { '1-1': { start: 'a', score: 1 } }, { '1-1': null }]) {
    assert.equal(checkResumo(bad), null);
  }
});

// The Worker's door with the reader's secrets, clock held at NOW.
function door() {
  const { sql, DB } = fakeD1();
  const env = { DB, ENTRADA_AGORA_SUPA_US: SECRET['us-east-1'], ENTRADA_AGORA_SUPA_EU: SECRET['eu-central-1'] };
  return {
    sql,
    async push(region, body, t = Math.floor(NOW / 1000)) {
      const { source } = REGIONS[region];
      const path = '/api/entrada/' + source;
      const sig = await sign(SECRET[region], String(t), path, body);
      const real = Date.now;
      Date.now = () => NOW;
      try {
        const r = await worker.fetch(new Request('https://wvwrelink.com' + path, {
          method: 'POST', body, headers: { 'x-wvw-time': String(t), 'x-wvw-sig': sig }
        }), env, {});
        return { status: r.status, text: await r.text() };
      } finally {
        Date.now = real;
      }
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
  const row = w.sql.prepare("SELECT leitor, score, raw FROM agora WHERE id = '1-1'").get();
  assert.equal(row.leitor, 'agora-supa-us');
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
  const path = '/api/entrada/' + REGIONS['us-east-1'].source;
  assert.equal(await sign(SECRET['us-east-1'], String(t), path, built.body),
    createHmac('sha256', SECRET['us-east-1']).update(t + '\n' + path + '\n').update(built.body).digest('hex'));
  const real = Date.now;
  Date.now = () => NOW;
  try {
    const sig = await sign(SECRET['eu-central-1'], String(t), path, built.body);
    const { DB } = fakeD1();
    const r = await worker.fetch(new Request('https://wvwrelink.com' + path, {
      method: 'POST', body: built.body, headers: { 'x-wvw-time': String(t), 'x-wvw-sig': sig }
    }), { DB, ENTRADA_AGORA_SUPA_US: SECRET['us-east-1'] }, {});
    assert.equal(r.status, 401);
  } finally {
    Date.now = real;
  }
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
  const handler = loadHandler({ LEITOR_CHAVE: LOCK, ENTRADA_AGORA_SUPA_US: SECRET['us-east-1'], ENTRADA_AGORA_SUPA_EU: SECRET['eu-central-1'] });
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const urls = [];
  let pushed = null;
  Date.now = () => NOW;
  globalThis.fetch = async (url, init = {}) => {
    urls.push(String(url));
    if (String(url).startsWith('https://api.guildwars2.com/')) return new Response(JSON.stringify([apiMatch('1-1'), apiMatch('2-1')]));
    if (String(url) === 'https://wvwrelink.com/api/agora/resumo') {
      return new Response(JSON.stringify({ '1-1': { start: Date.parse(NA_START), score: 6000, at: 1, by: 'x' } }));
    }
    pushed = { url: String(url), headers: init.headers, body: init.body };
    return new Response('{"applied":["2-1"]}');
  };
  const call = (headers, method = 'POST') => handler(new Request('https://x.supabase.co/functions/v1/leitor', { method, headers }));
  try {
    for (const [what, headers, method] of [
      ['no key', { 'x-region': 'us-east-1' }],
      ['wrong key', { 'x-wvw-chave': 'z'.repeat(128), 'x-region': 'us-east-1' }],
      ['key in the wrong place', { 'x-region': 'us-east-1', authorization: 'Bearer ' + LOCK }],
      ['GET', { 'x-wvw-chave': LOCK, 'x-region': 'us-east-1' }, 'GET'],
      ['unknown region', { 'x-wvw-chave': LOCK, 'x-region': 'ap-southeast-1' }],
      ['no region', { 'x-wvw-chave': LOCK }],
      ['called for the US, ran in the EU', { 'x-wvw-chave': LOCK, 'x-region': 'us-east-1' }],
      ['inherited name as region', { 'x-wvw-chave': LOCK, 'x-region': 'constructor' }]
    ]) {
      const r = await call(headers, method);
      assert.equal(r.status, 404, what);
      assert.equal(await r.text(), '', what);
    }
    assert.deepEqual(urls, []);

    const r = await call({ 'x-wvw-chave': LOCK, 'x-region': 'eu-central-1' });
    assert.equal(r.status, 200);
    assert.deepEqual(urls, ['https://api.guildwars2.com/v2/wvw/matches?ids=all', 'https://wvwrelink.com/api/agora/resumo',
      'https://wvwrelink.com/api/entrada/agora-supa-eu']);
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
  const handler = loadHandler({ SB_REGION: 'us-east-1', LEITOR_CHAVE: LOCK, ENTRADA_AGORA_SUPA_US: SECRET['us-east-1'] });
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response('<html>nope</html>'); };
  const log = console.log;
  const lines = [];
  console.log = (s) => lines.push(String(s));
  try {
    const r = await handler(new Request('https://x.supabase.co/', { method: 'POST', headers: { 'x-wvw-chave': LOCK, 'x-region': 'us-east-1' } }));
    assert.equal(r.status, 500);
    assert.equal(await r.text(), '{"ok":false}\n');
    assert.deepEqual(seen, ['https://api.guildwars2.com/v2/wvw/matches?ids=all']);
    assert.ok(lines.every((l) => !l.includes(LOCK) && !l.includes('nope')));
  } finally {
    globalThis.fetch = realFetch;
    console.log = log;
  }
});
