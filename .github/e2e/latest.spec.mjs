// /api/latest, the second read of the matches: gzip + base64 bodies of the live
// matches. A newer one wins; one offered under another match's id, one under an
// id the game never gave, and garbage in any field the page checks change
// nothing and say nothing; a 503 or a hung answer costs nothing.
import { gzipSync } from 'node:zlib';
import { test, expect } from './support/fixtures.mjs';
import { fail } from './support/faults.mjs';
import { gw2 } from './support/gw2.mjs';
import { recordedJson } from './support/steps.mjs';
import { recording } from './support/recordings.mjs';
import { FOCUS, MIN } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const NA = '#standingsGridNA > .standing-match';
const LATEST = /\/api\/latest(\/summary)?$/;
const sum = m => ['red', 'blue', 'green'].reduce((n, c) => n + m.scores[c], 0);
const scoreOf = (page, id) => page.evaluate(i => { const m = matchDataCache.get(i); return m ? colorSum(m.scores) : -1; }, id);

async function opened(page, wvw) {
  await page.goto(wvw.url);
  await expect(page.locator(NA)).toHaveCount(wvw.tiers.NA);
  await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
  await wvw.settle();
}

// Answers /api/latest (and its summary, which is the same list without the bodies) with `body`.
async function serve(page, body) {
  const state = { reads: 0 };
  await page.route(LATEST, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const summary = route.request().url().endsWith('/summary');
    if (!summary) state.reads++;
    const out = summary
      ? Object.fromEntries(body.matches.filter(m => typeof m.id === 'string').map(m => [m.id, { start: m.start, score: m.score, at: m.at, by: m.by }]))
      : body;
    await route.fulfill({ status: 200, body: JSON.stringify(out),
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  });
  return state;
}

// The recording as the world: one match is made newer (score up), one is
// offered under another match's id, one under an id the game never gave.
test.describe('bodies offered by /api/latest', () => {
  const all = recordedJson('https://api.guildwars2.com/v2/wvw/matches?ids=all');
  const [a, b] = all.filter(m => Date.parse(m.end_time) > recording().recordedAt).slice(0, 2);
  const entry = (id, m, start = Date.parse(m.start_time)) => ({ id, start, score: sum(m), at: 0, by: 'check-page',
    gz: gzipSync(Buffer.from(JSON.stringify(m))).toString('base64') });
  const bump = (m, n) => ({ ...m, scores: { ...m.scores, red: m.scores.red + n } });

  test('only the newer body of a known id reaches the page', async ({ page, wvw }) => {
    const latest = await serve(page, { at: 0, matches: [
      entry(a.id, bump(a, 5000)),        // newer: must show
      entry(b.id, bump(a, 99999)),       // the body says another id: must not
      entry('1-9', bump(a, 99999)),      // an id the game never gave: must not
    ] });
    await opened(page, wvw);
    expect(latest.reads, 'reads of /api/latest').toBeGreaterThan(0);
    expect(await scoreOf(page, a.id), `${a.id}, the newer body`).toBe(sum(a) + 5000);
    expect(await scoreOf(page, b.id), `${b.id}, offered another match's body`).toBe(sum(b));
    expect(await page.evaluate(() => matchDataCache.has('1-9')), 'an id the game never gave').toBe(false);
  });

  test('garbage in every field the page checks changes nothing', async ({ page, wvw }) => {
    await serve(page, { at: 0, matches: [
      { id: a.id, start: Date.parse(a.start_time), gz: 'not base64 !' },
      { id: a.id, start: Date.parse(a.start_time), gz: gzipSync(Buffer.from('{not json')).toString('base64') },
      { id: a.id, start: Date.parse(a.start_time) + 1, gz: entry(a.id, bump(a, 5000)).gz },
      { id: a.id, start: Date.parse(a.start_time), gz: gzipSync(Buffer.alloc(300 * 1024, 32)).toString('base64') },
    ] });
    await opened(page, wvw);
    expect(await scoreOf(page, a.id), `${a.id} after bad entries`).toBe(sum(a));
  });
});

// The game's server group answers a minute-old body in the odd minutes, and
// /api/latest holds the newest: the page opens in minute 13 and shows the newest.
test.describe('a group behind the game', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(13).pageOpens().olderPool(10).advance(2) });

  test('/api/latest brings the newest body over the older one the game gave', async ({ page, wvw }) => {
    await opened(page, wvw);
    const t = 13 * MIN;
    const newest = sum(wvw.timeline.body(FOCUS, t)), older = sum(wvw.timeline.body(FOCUS, t - 10 * MIN));
    expect(newest, 'a timeline whose older body is behind').toBeGreaterThan(older);
    expect(await scoreOf(page, FOCUS)).toBe(newest);
  });
});

// Down or hung, the page is as it was without the read.
test.describe('/api/latest down', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().latestStatus(503) });

  test('a 503 leaves the numbers as the game gave them', async ({ page, wvw }) => {
    let asked = 0;
    page.on('request', r => { if (/\/api\/latest$/.test(r.url())) asked++; });
    await opened(page, wvw);
    expect(asked, 'reads of /api/latest').toBeGreaterThan(0);
    expect(await scoreOf(page, FOCUS)).toBe(sum(wvw.timeline.body(FOCUS, 12 * MIN)));
  });
});

test.describe('/api/latest hung', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().latestStatus('hang') });

  // Timed to the tiers, not to quiet: the page's own deadline closes the request later.
  test('the tiers come up about as fast as with a 503', async ({ page, wvw }) => {
    const toTiers = async () => {
      const t0 = Date.now();
      await page.goto(wvw.url);
      await expect(page.locator(NA)).toHaveCount(wvw.tiers.NA);
      await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
      return Date.now() - t0;
    };
    const down = await fail(page, wvw, LATEST, 503);
    const base = await toTiers();
    expect(down.reads, 'reads of /api/latest (503)').toBeGreaterThan(0);
    down.off();
    let asked = 0;
    page.on('request', r => { if (/\/api\/latest$/.test(r.url())) asked++; });
    const hung = await toTiers();
    expect(asked, 'reads of /api/latest (hung)').toBeGreaterThan(0);
    expect(hung, `tiers with /api/latest hung ${hung} ms, with a 503 ${base} ms`).toBeLessThanOrEqual(base + 2500);
    await wvw.settle(20000);
  });
});
