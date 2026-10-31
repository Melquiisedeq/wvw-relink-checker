// Answers the page's outside reads from the recording (recordings.json.gz, or
// $RECORDINGS), by exact URL: the GW2 API, the sheets on docs.google.com and
// this site's /api. A URL the recording does not hold is a problem that fails
// the test, naming the URL; nothing reaches the network. To refresh the
// recording: RECORD=1 npx playwright test (support/record.mjs), which answers
// from the real hosts instead, keeping what it fetched.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { RECORDING, RECORDING_ON, heldRecording, recordUrl } from './record.mjs';

// The /api routes the recording holds, each under its full recorded address.
const OWN_API = new Map([
  ['/api/kills', 'https://wvwrelink.com/api/kills'],
  ['/api/relink', 'https://wvwrelink.com/api/relink'],
]);
// /api routes the recording does not hold, answered by default: /api/latest down (the Worker's 503 when its newest
// body is too old), its summary empty (what the Worker serves with nothing kept).
const OWN_FIXED = new Map([
  ['/api/latest', { status: 503, body: '{"error":"down"}' }],
  ['/api/latest/summary', { status: 200, body: '{}' }],
]);
const EXTERNAL = /^https:\/\/(api\.guildwars2\.com|docs\.google\.com)\//;
// Analytics: refused, as a blocker would, and their errors ignored.
export const BLOCKED = /cloudflareinsights/;
const IDS_URL = 'https://api.guildwars2.com/v2/wvw/matches?ids=';
const ALL_URL = IDS_URL + 'all';
const LIST_URL = 'https://api.guildwars2.com/v2/wvw/matches';
// The guild tactics a map asks for are the ones its match holds that no map
// opened before it asked for, so the address depends on the order maps are
// opened in. A test opens maps in its own order: an unrecorded list of ids is
// answered from the tactics the recording holds, one by one, in the order asked.
const TACTICS_URL = 'https://api.guildwars2.com/v2/guild/upgrades?ids=';

// 1x1 transparent PNG: guild emblems and icons, which only need to decode.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let cache = null;
// { recordedAt, guilds, entries: Map url -> [status, content-type, body, base64?] }
export function recording() {
  if (!cache) {
    if (RECORDING_ON) cache = heldRecording();
    else {
      const data = JSON.parse(gunzipSync(readFileSync(RECORDING)).toString('utf8'));
      cache = { recordedAt: data.recordedAt, guilds: data.guilds || [], entries: new Map(Object.entries(data.entries)) };
    }
  }
  return cache;
}

const bodyOf = e => Buffer.from(e[2], e[3] ? 'base64' : 'utf8');

// How many tiers each region should show: the matches the recording holds.
export function expectedTiers() {
  const e = recording().entries.get(ALL_URL);
  const ids = JSON.parse(bodyOf(e).toString('utf8')).map(m => String(m.id));
  return { NA: ids.filter(i => i.startsWith('1-')).length, EU: ids.filter(i => i.startsWith('2-')).length };
}

// The hot-map floor is 50 kills in ten minutes and the recording may sit in a
// lull, so the kills history is served with 200 fewer EBG kills before its
// newest snapshot: a real fight on the map.
function withFight(body) {
  try {
    const j = JSON.parse(body.toString('utf8'));
    const newest = Math.max(...j.rows.map(r => r[0]));
    for (const r of j.rows) if (r[0] < newest) r[2] = Math.max(0, r[2] - 200);
    return Buffer.from(JSON.stringify(j));
  } catch { return body; }
}

// `date`: the servers' time (ms) for the Date header, whole seconds as HTTP has them.
const fulfil = (route, status, type, body, date) => route.fulfill({
  status, body,
  headers: { 'Content-Type': type || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store',
    ...(date === undefined ? {} : { Date: new Date(Math.floor(date / 1000) * 1000).toUTCString() }) },
});

// The page.route handler for every request of a page served at `base`.
// `problem(text)` records what fails the test. `own(url)`, when given, answers
// first (a timeline of support/gw2.mjs): null passes the URL on to the
// recording, 'hang' never answers, else { status, type, body }.
export function answerFrom(base, problem, own = null) {
  const { entries } = recording();
  return async route => {
    const request = route.request();
    const url = request.url();
    try {
      if (own && request.method() === 'GET' && (url.startsWith(base + '/api/') || !url.startsWith(base + '/'))) {
        const hit = await own(url);
        if (hit === 'hang') return;
        if (hit) return await fulfil(route, hit.status, hit.type, hit.body, hit.date);
      }
      if (url.startsWith(base + '/api/')) {
        const path = url.slice(base.length);
        const fixed = OWN_FIXED.get(path);
        if (fixed && request.method() !== 'OPTIONS') return await fulfil(route, fixed.status, 'application/json', Buffer.from(fixed.body));
        const key = OWN_API.get(path);
        if (!key) {
          problem(`unknown /api route, not fetched: ${url}`);
          return await route.abort('failed');
        }
        if (RECORDING_ON) await recordUrl(key, entries);
        const hit = entries.get(key);
        if (!hit) {
          problem(`not recorded: ${key} - re-record with RECORD=1`);
          return await route.abort('failed');
        }
        return await fulfil(route, hit[0], hit[1], key === OWN_API.get('/api/kills') ? withFight(bodyOf(hit)) : bodyOf(hit));
      }
      if (url.startsWith(base + '/')) return await route.continue();
      if (request.method() === 'OPTIONS') {
        return await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
      }
      if (BLOCKED.test(url)) return await route.abort('blockedbyclient');
      if (url.startsWith('https://render.guildwars2.com/')) return await fulfil(route, 200, 'image/png', PNG);
      // A list of matches by id (the page reads a tier again that way) is
      // answered, when not recorded, from ids=all filtered to the ids asked,
      // each checked against a fixed pattern.
      if (url.startsWith(IDS_URL) && url !== ALL_URL && !entries.has(url)) {
        const want = url.slice(IDS_URL.length).split(',');
        const all = entries.get(ALL_URL);
        if (!want.every(i => /^[12]-[1-9]$/.test(i)) || !all) {
          problem(`not answered: ${url} (${all ? 'ids outside 1-1..2-9' : 'ids=all not recorded'})`);
          return await route.abort('failed');
        }
        const list = JSON.parse(bodyOf(all).toString('utf8')).filter(m => want.includes(m.id));
        return await fulfil(route, 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(list)));
      }
      // The game's plain list of match ids, which the recording lacks: what the
      // fallback asks first.
      if (!RECORDING_ON && url === LIST_URL && !entries.has(url) && entries.has(ALL_URL)) {
        const ids = JSON.parse(bodyOf(entries.get(ALL_URL)).toString('utf8')).map(m => m.id);
        return await fulfil(route, 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(ids)));
      }
      if (!RECORDING_ON && url.startsWith(TACTICS_URL) && !entries.has(url)) {
        const want = url.slice(TACTICS_URL.length).split(',');
        const known = new Map();
        for (const [key, e] of entries) {
          if (!key.startsWith(TACTICS_URL)) continue;
          for (const t of JSON.parse(bodyOf(e).toString('utf8'))) known.set(String(t.id), t);
        }
        if (!want.every(i => /^\d{1,6}$/.test(i) && known.has(i))) {
          problem(`not answered: ${url} (a tactic the recording does not hold)`);
          return await route.abort('failed');
        }
        return await fulfil(route, 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(want.map(i => known.get(i)))));
      }
      if (EXTERNAL.test(url)) {
        if (RECORDING_ON) await recordUrl(url, entries);
        const hit = entries.get(url);
        if (!hit) {
          problem(`not recorded: ${url} - re-record with RECORD=1`);
          return await route.abort('failed');
        }
        return await fulfil(route, hit[0], hit[1], bodyOf(hit));
      }
      problem(`unexpected host, blocked: ${url}`);
      await route.abort('blockedbyclient');
    } catch (e) {
      // The page went away first (the test ended mid-request): nothing to answer.
      if (/closed|disposed|Route is already handled/i.test(e.message)) return;
      problem(`while answering ${url}: ${e.message.split('\n')[0]}`);
    }
  };
}
