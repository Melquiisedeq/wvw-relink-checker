// /api/latest, the second read of the matches: bodies of the live matches as JSON with
// only the running skirmish, the finished ones at /api/history, read once per version.
// A newer one wins; a 503 or a hung answer costs nothing. (Which bodies pass the
// page's checks is tests/unit/page/api.test.mjs.)
import { test, expect } from './support/fixtures.mjs';
import { answer, fail } from './support/faults.mjs';
import { gw2 } from './support/gw2.mjs';
import { load } from './support/steps.mjs';
import { FOCUS, MIN, hidden, playing, visible } from './support/scenarios.mjs';
import { countPeekTimers, countRegionDraws, forgetSkippedTick, keepNewest, liveOnBoard, loadNow, loadSettled,
  nextPeekIn, scoreOf, tickSkipped } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const NA = '#standingsGridNA > .standing-match';
const LATEST = /\/api\/latest(\/summary)?$/;

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const sum = m => ['red', 'blue', 'green'].reduce((n, c) => n + m.scores[c], 0);
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
    await loadNow(page);
    await page.waitForTimeout(1500);
  }
  return score;
}

// The page opened with /api/latest down, so its first ask got nothing. Five
// minutes on the game's server group answers a body 10 minutes behind (the page
// keeps the further-along one it has, and sees nothing rise) while /api/latest is
// back with the newest: asked again after 30 s of that, the score arrives by it.
test.describe('a game body that stands still while /api/latest is ahead', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().latestStatus(503).advance(5).latestStatus(null).olderPool(10) });

  test('the newer score arrives from /api/latest', async ({ page, wvw }) => {
    await load(page, wvw);
    const t = 17 * MIN;
    const newest = sum(wvw.timeline.body(FOCUS, t)), shown = sum(wvw.timeline.body(FOCUS, 12 * MIN));
    expect(newest, 'a timeline whose newest body is ahead of the one on show').toBeGreaterThan(shown);
    expect(await scoreOf(page, FOCUS), 'the score the page opened with').toBe(shown);
    await wvw.skew(5 * MIN);
    expect(await settledScore(page, FOCUS, newest), 'the score after 5 min of a body that stood still').toBe(newest);
  });
});

// Hung, the page is as it was without the read.
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
// until one has been read, then aligned to the marks the readers write)
// does not arm its next turn for a tab that went to the background while the
// read was out; the tab coming back arms it. The read is held here until the
// tab is hidden, so the state is reached every time, not when a timer happens
// to land there. What the tab leaves behind is watched at the source: no
// peek timer set while it is hidden.
test.describe('the tab hides during a peek', () => {
  test.use({ timeline: playing(), clock: 'playwright' });

  test('no peek is scheduled while hidden; one comes when the tab is back', async ({ page, wvw }) => {
    let reads = 0, answered = 0, holding = false, release;
    const held = new Promise(r => { release = r; });
    await page.route(/\/api\/latest\/summary$/, async route => {
      reads++;
      if (holding) { holding = false; await held; }
      await route.fulfill({ status: 200, body: '{}', headers: JSON_HEADERS });
      answered++;
    });
    await load(page, wvw);
    const armed = await countPeekTimers(page);
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
// peek from what is in hand: with a summary that says nothing newer, /api/latest
// is not read; with one that says the match is further still and /api/latest
// down, the body in hand is drawn all the same; with nothing in hand and
// /api/latest down, the list is not touched.
test.describe('a newer body in hand', () => {
  test.use({ timeline: playing(), clock: 'playwright' });

  for (const copyDown of [false, true]) {
    test(copyDown ? 'the next peek reloads the list with /api/latest down' : 'the next peek reloads the list without reading /api/latest', async ({ page, wvw }) => {
      let summary = '{}';
      await answer(page, /\/api\/latest\/summary$/, () => summary, { contentType: 'application/json' });
      if (copyDown) await fail(page, wvw, /\/api\/latest$/, 503);
      await load(page, wvw);
      let copies = 0;
      page.on('request', r => { if (/\/api\/latest$/.test(r.url())) copies++; });
      const { id, start, body } = await liveOnBoard(page);
      await keepNewest(page, { ...body, scores: { ...body.scores, red: body.scores.red + 500 } });
      const drawn = await scoreOf(page, id);
      if (copyDown) summary = JSON.stringify({ [id]: { start, score: drawn + 1000, at: 0, by: 'a' } });
      // Three peeks' time, well inside the five minutes of the standings' own tick.
      for (let i = 0; i < 3 && await scoreOf(page, id) !== drawn + 500; i++) {
        await page.clock.fastForward(31 * 1000);
        await wvw.settle();
      }
      expect(await scoreOf(page, id), 'the peek reloaded the list, which draws the newer body').toBe(drawn + 500);
      if (copyDown) expect(copies, 'reads of /api/latest, the summary ahead').toBeGreaterThan(0);
      else expect(copies, 'reads of /api/latest, the summary saying nothing newer').toBe(0);
    });
  }

  test('a peek with the summary ahead, /api/latest down and nothing in hand leaves the list as it is', async ({ page, wvw }) => {
    let summary = '{}';
    await answer(page, /\/api\/latest\/summary$/, () => summary, { contentType: 'application/json' });
    await fail(page, wvw, /\/api\/latest$/, 503);
    await load(page, wvw);
    let copies = 0, game = 0;
    page.on('request', r => {
      if (/\/api\/latest$/.test(r.url())) copies++;
      if (/\/v2\/wvw\/matches/.test(r.url())) game++;
    });
    const { id, start } = await liveOnBoard(page);
    const shown = await countRegionDraws(page);
    const drawn = await scoreOf(page, id);
    summary = JSON.stringify({ [id]: { start, score: drawn + 1000, at: 0, by: 'a' } });
    // The reload the peek asks for reads the copy first: it is out once the copy is asked for.
    await expect.poll(async () => { await page.clock.fastForward(31 * 1000); return copies; },
      'the peek reloaded the list: the copy was asked for, and gave nothing').toBeGreaterThan(0);
    await loadSettled(page);
    await wvw.settle();
    expect(game, 'reads of the game: a peek with nothing to draw reads none').toBe(0);
    expect(await shown(), 'regions redrawn (and the Synced time restamped) by that peek').toBe(0);
    expect(await scoreOf(page, id), 'the score the list draws').toBe(drawn);
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
    await load(page, wvw);
    await page.locator('.icon-btn.activity-info-btn').first().click();
    await expect(page.locator('.info-popover')).toHaveCount(1);
    seen.peeks = 0;
    page.on('request', r => { if (/api\.guildwars2\.com\/v2\/wvw\/matches/.test(r.url())) seen.game.push(r.url()); });
    return seen;
  }
  // The scheduler's own tick, which finds the popover open and skips (its run is not counted).
  const tickUnderPopover = async page => {
    await page.clock.fastForward(5 * 60 * 1000 + 1000);
    expect(await tickSkipped(page), 'the state: the tick was skipped').toBe(true);
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
    await loadSettled(page);
    const n = seen.game.length;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.clock.fastForward(31 * 1000);
    expect(seen.game.length, 'a tab return right after reads the game again').toBe(n);
    await wvw.settle();
  });

  test('only peeks when nothing was skipped', async ({ page, wvw }) => {
    const seen = await setup(page, wvw);
    // The list is overdue by the clock but nothing is owed: a close that read for the clock alone would read the game.
    await tickUnderPopover(page);
    await forgetSkippedTick(page);
    // The next scheduled peek is 50 s off, past the 31 s the close waits (an open popover counts as use, so the page never waits longer): only the close can bring it in.
    await nextPeekIn(page, 50 * 1000);
    seen.peeks = 0;
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
