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
import { FOCUS, MIN, hidden, playing, visible } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const NA = '#standingsGridNA > .standing-match';
const LATEST = /\/api\/latest(\/summary)?$/;
const sum = m => ['red', 'blue', 'green'].reduce((n, c) => n + m.scores[c], 0);
const scoreOf = (page, id) => page.evaluate(i => { const m = matchDataCache.get(i); return m ? colorSum(m.scores) : -1; }, id);
// The score of `id` once the page has painted what /api/latest gave. The page
// holds its paint LATEST_WAIT_MS (1.2 s, js/api.js) for the read; an answer that
// comes later is kept for the next paint (a machine under load got there: 1 run
// in 20). The rule under test is "the newest body wins", not the 1.2 s (the hung
// test times that), so a missed window asks the page for its next paint.
async function settledScore(page, id, want) {
  let score;
  for (let i = 0; i < 4; i++) {
    score = await scoreOf(page, id);
    if (score === want) break;
    await page.evaluate(() => loadStandings());
    await page.waitForTimeout(1500);
  }
  return score;
}

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
    expect(await settledScore(page, a.id, sum(a) + 5000), `${a.id}, the newer body`).toBe(sum(a) + 5000);
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
    expect(await settledScore(page, FOCUS, newest)).toBe(newest);
  });
});

// The page opened with /api/latest down, so its first ask got nothing. Five
// minutes on the game's server group answers a body 10 minutes behind (the page
// keeps the further-along one it has, and sees nothing rise) while /api/latest is
// back with the newest: asked again after 30 s of that, the score arrives by it.
test.describe('a game body that stands still while /api/latest is ahead', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().latestStatus(503).advance(5).latestStatus(null).olderPool(10) });

  test('the newer score arrives from /api/latest', async ({ page, wvw }) => {
    await opened(page, wvw);
    const t = 17 * MIN;
    const newest = sum(wvw.timeline.body(FOCUS, t)), shown = sum(wvw.timeline.body(FOCUS, 12 * MIN));
    expect(newest, 'a timeline whose newest body is ahead of the one on show').toBeGreaterThan(shown);
    expect(await scoreOf(page, FOCUS), 'the score the page opened with').toBe(shown);
    await wvw.skew(5 * MIN);
    expect(await settledScore(page, FOCUS, newest), 'the score after 5 min of a body that stood still').toBe(newest);
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

// The peek (a read of /api/latest/summary while the tab is shown: every 30 s
// until one has been read, then aligned to the minute the readers write)
// does not arm its next turn for a tab that went to the background while the
// read was out; the tab coming back arms it. The read is held here until the
// tab is hidden, so the state is reached every time, not when a timer happens
// to land there. What the tab leaves behind is watched at the source: no
// setTimeout of runPeek while it is hidden.
test.describe('the tab hides during a peek', () => {
  test.use({ timeline: playing(), clock: 'playwright' });

  test('no peek is scheduled while hidden; one comes when the tab is back', async ({ page, wvw }) => {
    let reads = 0, answered = 0, holding = false, release;
    const held = new Promise(r => { release = r; });
    await page.route(/\/api\/latest\/summary$/, async route => {
      reads++;
      if (holding) { holding = false; await held; }
      await route.fulfill({ status: 200, body: '{}',
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
      answered++;
    });
    await opened(page, wvw);
    await page.evaluate(() => {
      window.__armed = 0;
      const set = window.setTimeout;
      window.setTimeout = function (fn, ...rest) {
        if (typeof fn === 'function' && fn.name === 'runPeek') window.__armed++;
        return set.call(this, fn, ...rest);
      };
    });
    const armed = () => page.evaluate(() => window.__armed);
    const before = reads;   // the opening reads, if any, answered already
    holding = true;
    const peek = page.waitForRequest(r => /\/api\/latest\/summary$/.test(r.url()));
    await page.clock.fastForward(31 * 1000);
    await peek;
    await expect.poll(() => reads, 'the peek is out and held').toBe(before + 1);
    await hidden(page, wvw, 0);
    release();
    await expect.poll(() => answered, 'the held read answered').toBe(reads);
    await page.clock.fastForward(3 * MIN);
    expect(reads, 'peeks started while hidden').toBe(before + 1);
    expect(await armed(), 'peek timers armed while hidden').toBe(0);
    await visible(page);
    // A peek that finds a load in flight (the tab coming back brings one) reads
    // nothing and arms the next, so the clock goes on until one reads.
    await expect.poll(async () => { await page.clock.fastForward(31 * 1000); return reads; },
      'the peek after the tab came back').toBe(before + 2);
    expect(await armed(), 'peek timers armed after the tab came back').toBeGreaterThan(0);
  });
});

// A body newer than the one the list draws (the open map put it in newestMatches,
// or /api/latest answered after the paint's wait) reaches the list at the next
// peek, though the summary says nothing newer.
test.describe('a newer body in hand', () => {
  test.use({ timeline: playing(), clock: 'playwright' });

  test('the next peek reloads the list', async ({ page, wvw }) => {
    await page.route(/\/api\/latest\/summary$/, route => route.fulfill({ status: 200, body: '{}',
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }));
    await opened(page, wvw);
    const id = await page.evaluate(() => {
      const m = [...matchDataCache.values()].find(x => matchIsLive(x));
      keepNewestMatch({ ...m, scores: { ...m.scores, red: m.scores.red + 500 } });
      window.__peekLoads = 0;
      const load = loadStandings;
      loadStandings = function (...a) { if (a[0] === 'peek') window.__peekLoads++; return load.apply(this, a); };
      return m.id;
    });
    const drawn = await scoreOf(page, id);
    await expect.poll(async () => { await page.clock.fastForward(31 * 1000); return page.evaluate(() => window.__peekLoads); },
      'the peek reloaded the list').toBeGreaterThan(0);
    await expect.poll(() => scoreOf(page, id), 'the list draws the newer body').toBe(drawn + 500);
  });
});

// A tick that came while a popover was open was skipped; closing it reads the
// game at once, though /api/latest has nothing newer, and once (a tab return
// after it does not read again). A close with nothing skipped reads nothing but
// the peek. Swapping one popover for another is not a close: nothing is read
// under the new one.
test.describe('closing a popover after a skipped tick', () => {
  test.use({ timeline: playing(), clock: 'playwright' });

  async function setup(page, wvw) {
    const seen = { game: [], peeks: 0 };
    await page.route(/\/api\/latest\/summary$/, route => { seen.peeks++; return route.fulfill({ status: 200, body: '{}',
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }); });
    await opened(page, wvw);
    await page.locator('.icon-btn.activity-info-btn').first().click();
    await expect(page.locator('.info-popover')).toHaveCount(1);
    seen.peeks = 0;
    page.on('request', r => { if (/api\.guildwars2\.com\/v2\/wvw\/matches/.test(r.url())) seen.game.push(r.url()); });
    return seen;
  }
  // The scheduler's own tick, which finds the popover open and skips (its run is not counted).
  const tickUnderPopover = async page => {
    await page.clock.fastForward(5 * 60 * 1000 + 1000);
    await page.evaluate(() => { if (!standingsSkipped) throw new Error('the tick was not skipped'); });
  };
  const close = async page => {
    await page.locator('.info-popover .info-popover-close').click();
    await expect(page.locator('.info-popover')).toHaveCount(0);
    await page.clock.fastForward(31 * 1000);
  };

  test('reloads the list, once', async ({ page, wvw }) => {
    const seen = await setup(page, wvw);
    await tickUnderPopover(page);
    expect(seen.game, 'no game read while it is open').toEqual([]);
    await close(page);
    await expect.poll(() => seen.game.length, 'game reads after the close').toBeGreaterThan(0);
    await page.waitForFunction(() => !standingsInFlight);
    const n = seen.game.length;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.clock.fastForward(31 * 1000);
    expect(seen.game.length, 'a tab return right after reads the game again').toBe(n);
    await wvw.settle();
  });

  test('only peeks when nothing was skipped', async ({ page, wvw }) => {
    const seen = await setup(page, wvw);
    await close(page);
    await expect.poll(() => seen.peeks, 'peeks after the close').toBeGreaterThan(0);
    expect(seen.game, 'a close with nothing skipped reads no game').toEqual([]);
    await wvw.settle();
  });

  test('swapping popovers reads nothing under the new one', async ({ page, wvw }) => {
    const seen = await setup(page, wvw);
    await tickUnderPopover(page);
    await page.locator('.icon-btn.map-kd-btn').first().click();
    await expect(page.locator('.info-popover')).toHaveCount(1);
    await page.clock.fastForward(5 * 1000);
    expect(seen.game, 'no game read under the new popover').toEqual([]);
    await close(page);
    await expect.poll(() => seen.game.length, 'game reads after the close').toBeGreaterThan(0);
    await wvw.settle();
  });
});
