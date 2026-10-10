// Answers the page's outside reads from the check-page's recording, by exact
// URL, as .github/scripts/check-page.mjs does in its replay: the GW2 API, the
// sheets on docs.google.com and this site's /api. A URL the recording does not
// hold is a problem that fails the test, naming the URL; nothing reaches the
// network. To refresh the recording: node .github/scripts/check-page.mjs --record
// (the same file, read here).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RECORDINGS = join(ROOT, '.github', 'scripts', 'check-page', 'recordings.json.gz');

// The /api routes the recording holds, each under its full recorded address.
const OWN_API = new Map([
  ['/api/kills', 'https://wvwrelink.com/api/kills'],
  ['/api/relink', 'https://wvwrelink.com/api/relink'],
]);
// /api routes the recording does not hold, answered as the check-page's walk
// answers them by default: /api/latest down (the Worker's 503 when its newest
// body is too old), its summary empty (what the Worker serves with nothing kept).
const OWN_FIXED = new Map([
  ['/api/latest', { status: 503, body: '{"error":"down"}' }],
  ['/api/latest/summary', { status: 200, body: '{}' }],
]);
const EXTERNAL = /^https:\/\/(api\.guildwars2\.com|docs\.google\.com)\//;
// Analytics: refused, as a blocker would, and their errors ignored.
export const BLOCKED = /goatcounter|cloudflareinsights/;
const IDS_URL = 'https://api.guildwars2.com/v2/wvw/matches?ids=';
const ALL_URL = IDS_URL + 'all';

// 1x1 transparent PNG: guild emblems and icons, which only need to decode.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let cache = null;
// { recordedAt, guilds, entries: Map url -> [status, content-type, body, base64?] }
export function recording() {
  if (!cache) {
    const data = JSON.parse(gunzipSync(readFileSync(RECORDINGS)).toString('utf8'));
    cache = { recordedAt: data.recordedAt, guilds: data.guilds || [], entries: new Map(Object.entries(data.entries)) };
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
// newest snapshot, as the check-page serves it: a real fight on the map.
function withFight(body) {
  try {
    const j = JSON.parse(body.toString('utf8'));
    const newest = Math.max(...j.rows.map(r => r[0]));
    for (const r of j.rows) if (r[0] < newest) r[2] = Math.max(0, r[2] - 200);
    return Buffer.from(JSON.stringify(j));
  } catch { return body; }
}

const fulfil = (route, status, type, body) => route.fulfill({
  status, body,
  headers: { 'Content-Type': type || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
});

// The page.route handler for every request of a page served at `base`.
// `problem(text)` records what fails the test.
export function answerFrom(base, problem) {
  const { entries } = recording();
  return async route => {
    const request = route.request();
    const url = request.url();
    try {
      if (url.startsWith(base + '/api/')) {
        const path = url.slice(base.length);
        const fixed = OWN_FIXED.get(path);
        if (fixed && request.method() !== 'OPTIONS') return await fulfil(route, fixed.status, 'application/json', Buffer.from(fixed.body));
        const key = OWN_API.get(path);
        if (!key) {
          problem(`unknown /api route, not fetched: ${url}`);
          return await route.abort('failed');
        }
        const hit = entries.get(key);
        if (!hit) {
          problem(`not recorded: ${key} - re-record with check-page.mjs --record`);
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
      if (EXTERNAL.test(url)) {
        const hit = entries.get(url);
        if (!hit) {
          problem(`not recorded: ${url} - re-record with check-page.mjs --record`);
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
