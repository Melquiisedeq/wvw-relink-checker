// The map's kills corner after a tab hidden for hours: the history out at the opening and back while the
// map stays open; the first reads of the return failing; a server group that moved hours behind and then
// caught up.
import { test, expect } from './support/fixtures.mjs';
import { abort } from './support/faults.mjs';
import { load, openMap, play } from './support/steps.mjs';
import { triesPerRead } from './support/page.mjs';
import { FOCUS, MIN, catchUpBehind, hidden, missed, stuckAway, visible } from './support/scenarios.mjs';

test.describe.configure({ timeout: 4 * 60 * 1000 });
test.use({ clock: 'playwright', viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });

const BUTTON = page => page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`);
const BIG = page => page.locator('.info-popover .wvw-plot-wrap .wvw-hud-l .wvw-hud-big');
const SHEET = /^https:\/\/docs\.google\.com\/spreadsheets\/.*sheet=kills/;
const GAME_MATCHES = /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches/;
const OUR_API = /^http:\/\/127\.0\.0\.1:\d+\/api\//;
const SUMMARY = page => page.locator('.info-popover .wvw-missed');
// The open map's own reads of its match, each try counted.
const mapReads = page => {
  const seen = { n: 0 };
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.hostname === 'api.guildwars2.com' && u.pathname === '/v2/wvw/matches' && u.searchParams.get('id') === FOCUS) seen.n++;
  });
  return seen;
};
// Plays on until the open map's first read has made all its tries; returns how many.
const firstReadFailed = async (page, reads) => {
  const tries = await triesPerRead(page);
  await expect.poll(async () => { await play(page, 500); return reads.n; }, { message: 'the state: the first read failed' }).toBe(tries);
  return tries;
};

// Back into a 30-min stall of the whole API: /api/kills answers 503, so the corner has nothing to count. The
// API comes back while the map stays open, and /api/kills with it.
test.describe('the kill history out at the opening', () => {
  test.use({ timeline: stuckAway(440, 30, 30) });
  test('the sheet out too: the corner counts again within two minutes of /api/kills answering', async ({ page, wvw }) => {
    await abort(page, wvw, SHEET);
    await load(page, wvw);
    await hidden(page, wvw, 465 * MIN);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    await expect(BIG(page), 'the state: nothing to count at the opening').toHaveText('–');
    const reads = [];
    page.on('request', r => { if (new URL(r.url()).pathname === '/api/kills') reads.push(r.url()); });
    await play(page, 4.5 * MIN);
    expect(reads.length, 'never more than one read of the history a minute').toBeLessThanOrEqual(5);
    await play(page, 2.5 * MIN);
    await expect(BIG(page), 'two minutes after the API came back').toHaveText(/^\d+$/);
    const counted = reads.length;
    await play(page, 2 * MIN);
    expect(reads.length, 'no read once the corner counts').toBe(counted);
  });
  // The sheet answers with nothing of the last 3 h: the read at the opening is a copy in hand, younger
  // than the cache's five minutes when the API comes back.
  test('the sheet answering nothing recent: the corner counts again within two minutes of /api/kills answering', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 468 * MIN);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    await expect(BIG(page), 'the state: nothing to count at the opening').toHaveText('–');
    await play(page, 4 * MIN);
    await expect(BIG(page), 'two minutes after the API came back').toHaveText(/^\d+$/);
  });
});

// Eight hours away; the game's reads and ours fail for the first 3 min after the return, with the map open.
test.describe('what you missed, the first reads of the return failing', () => {
  test.use({ timeline: missed(480, 20) });
  test('the summary comes with the first answer, however long the reads failed', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 470 * MIN);
    const game = await abort(page, wvw, GAME_MATCHES);
    const ours = await abort(page, wvw, OUR_API);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    await play(page, 3 * MIN);
    expect(game.reads, 'the state: the reads failed').toBeGreaterThan(0);
    await expect(SUMMARY(page), 'the state: no summary while nothing answers').toHaveCount(0);
    game.off();
    ours.off();
    await play(page, MIN);
    await expect(SUMMARY(page), 'the summary of the absence').toBeAttached();
  });

  // Our API stays out, so only the open map's own read of the game can bring the body.
  test('the first read failing once: the map asks again 5 s later, not at the poll', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 470 * MIN);
    const reads = mapReads(page);
    const game = await abort(page, wvw, GAME_MATCHES);
    await abort(page, wvw, OUR_API);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    await firstReadFailed(page, reads);
    await expect(SUMMARY(page), 'the state: no summary yet').toHaveCount(0);
    game.off();
    await play(page, 8000);
    await expect(SUMMARY(page), 'eight seconds on, the poll still further away').toBeAttached();
  });

  test('failing again: one retry, and nothing more until the poll', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 470 * MIN);
    const reads = mapReads(page);
    await abort(page, wvw, GAME_MATCHES);
    await abort(page, wvw, OUR_API);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    const first = await firstReadFailed(page, reads);
    await play(page, 20000);
    expect(reads.n, 'the first read and one retry, before the poll').toBe(2 * first);
  });

  test('the map closed before the retry: no read', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 470 * MIN);
    const reads = mapReads(page);
    await abort(page, wvw, GAME_MATCHES);
    await abort(page, wvw, OUR_API);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    const first = await firstReadFailed(page, reads);
    await page.keyboard.press('Escape');
    await expect(page.locator('.info-popover'), 'the state: the map closed').toHaveCount(0);
    await play(page, 12000);
    expect(reads.n, 'no read of the closed map').toBe(first);
  });

  test('the tab hidden before the retry: no read', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 470 * MIN);
    const reads = mapReads(page);
    await abort(page, wvw, GAME_MATCHES);
    await abort(page, wvw, OUR_API);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    const first = await firstReadFailed(page, reads);
    await hidden(page, wvw, 0);
    await play(page, 12000);
    expect(reads.n, 'no read while the tab is hidden').toBe(first);
  });

  test('a return whose first read answered: a later failure waits for the poll', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 470 * MIN);
    const reads = mapReads(page);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    await expect(SUMMARY(page), 'the state: the first read answered').toBeAttached();
    await abort(page, wvw, GAME_MATCHES);
    const before = reads.n;
    await play(page, 33000);
    const poll = reads.n - before;
    expect(poll, 'the state: the poll\'s read failed').toBeGreaterThan(0);
    await play(page, 9000);
    expect(reads.n - before, 'the poll\'s read alone, no retry 5 s after it').toBe(poll);
  });
});

// Our copy stuck at the body the page already keeps, the game's reads failing: the copy the failed read
// brings is no answer, and the retry still goes.
test.describe('the first read of the return failing, our copy stuck', () => {
  test.use({ timeline: stuckAway(440, 30, 30) });
  test('the copy no further along: the map still asks again 5 s later', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 445 * MIN);
    await visible(page);
    await wvw.settle();
    await hidden(page, wvw, 12 * MIN);
    const reads = mapReads(page);
    await abort(page, wvw, GAME_MATCHES);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    const first = await firstReadFailed(page, reads);
    await play(page, 8000);
    expect(reads.n, 'the retry, before the poll').toBe(2 * first);
  });
});

// Our readers stuck while the visitor's group runs 400 min behind and moves; back 12 min before it catches up,
// with the map open. One read then brings 400 minutes of kills.
test.describe('a group hours behind catching up', () => {
  test.use({ timeline: catchUpBehind(470, 400, 10) });
  test('no map wears swords and the corner never counts thousands in ten minutes', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 458 * MIN);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    await play(page, 12 * MIN);
    for (let i = 0; i < 8; i++) {
      await play(page, 30000);
      const big = await BIG(page).textContent();
      await expect(page.locator('.info-popover .wvw-tab.is-lit'), `${i * 30 + 30} s after the catch-up`).toHaveCount(0);
      expect(big === '–' || Number(big) < 1000, `the count ${big}, ${i * 30 + 30} s after the catch-up`).toBe(true);
    }
  });
});
