// A page that is used before it is ready, and one whose lines fail: a visitor
// acting before the last scripts have loaded, a failed load that tries again,
// and /api down so that the page falls back to the sheets. Then the game's API
// and ours failing in each way a player can meet: what is on screen in each.
import { test, expect } from './support/fixtures.mjs';
import { abort, answer, fail, hold } from './support/faults.mjs';
import { firstTier, load, openMap, recordedJson } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const TIERS = '#standingsGridNA > .standing-match';

// Scripts run in order and the page is usable before the last one: with one
// held, Escape, a resize, the Check button, Ctrl+Enter and a click must raise
// nothing (the fixture fails the test on an exception), and the page must work
// once it is let go.
for (const script of ['maps.js', 'trebuchet.js', 'boot.js']) {
  test(`early actions with ${script} held`, async ({ page, wvw }) => {
    const release = await hold(page, wvw.url + 'js/' + script);
    await page.goto(wvw.url, { waitUntil: 'commit' });
    await expect.poll(() => release.reads > 0, { message: 'the request being held' }).toBe(true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
      if (window.visualViewport) window.visualViewport.dispatchEvent(new Event('resize'));
      document.getElementById('guildInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX: 50, clientY: 50 }));
    });
    await page.locator('#runBtn').click();
    await page.waitForTimeout(200);   // a throw is reported late
    release();
    await page.waitForLoadState('load');
    await expect(page.locator(TIERS)).toHaveCount(wvw.tiers.NA);
    await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
    await wvw.settle();
    expect(await page.evaluate(() => !document.getElementById('runBtn').disabled && !document.querySelector('#statusMsg .spinner')),
      'the Check button left disabled').toBe(true);
  });
}

// A failed load and a slow line: the live standings and the guild tables answer
// 503, the page says it will try again and counts down, and once the API
// answers again the table paints with no reload. Then the guild search fails
// the same way, and its button repeats it. The page's random is pinned to 0 so
// the first extra try waits 5 s, the window's start; those 5 s are waited for
// real, on the page's real clock.
test('a failed load tries again and paints without a reload', async ({ page, wvw }) => {
  test.setTimeout(60 * 1000);
  await page.addInitScript(() => { Math.random = () => 0; });
  const down = await fail(page, wvw, /^https:\/\/api\.guildwars2\.com\//);
  await page.goto(wvw.url);
  const alert = region => page.locator(`#standingsAlert${region}`);
  await expect(alert('NA'), 'the "Trying again in N s" message under both standings').toContainText(/Trying again in \d+ s/);
  await expect(alert('EU')).toContainText(/Trying again in \d+ s/);
  await expect(alert('NA').locator('button.retry-btn'), 'the Try again button').toHaveText('Try again');
  expect(await page.evaluate(() => !!document.querySelector('.standings-header .retry-btn, .standings-header .sr-only')),
    "the error message sits in the title's row, not the card's top strip").toBe(false);
  expect(await page.locator(TIERS).count() + await page.locator('#standingsGridEU > .standing-match').count(),
    'tiers painted while the API was failing').toBe(0);
  // The whole API down: no relink bar either, so the columns' tops must still
  // clear the notice bar. Measured at 1920, where the columns stand beside the
  // page: the error text's top must be on screen and hit the strip itself.
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect(page.locator('#relinkBanner'), 'the relink bar gone with the API down').toHaveCSS('display', 'none');
  const seenAt = await page.evaluate(() => {
    window.scrollTo(0, 0);
    const box = document.getElementById('standingsAlertNA');
    const r = document.createRange(); r.selectNodeContents(box.querySelector('.retry-vis'));
    const b = r.getClientRects()[0], n = document.getElementById('teamsNotice');
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 1);
    return { top: Math.round(b.top), hit: !!hit && box.contains(hit),
      under: n && getComputedStyle(n).display !== 'none' ? Math.round(n.getBoundingClientRect().bottom) : 0 };
  });
  expect(seenAt.hit && seenAt.top >= seenAt.under,
    `the error text's top (${seenAt.top}px) is hidden or under the notice bar (${seenAt.under}px) at 1920 px`).toBe(true);
  await page.evaluate(() => { window.__sameDocument = true; });
  down.off();
  await expect(page.locator(TIERS), 'the tables painted by the extra try, without a reload').not.toHaveCount(0, { timeout: 20000 });
  await expect(page.locator('#standingsGridEU > .standing-match')).not.toHaveCount(0);
  expect(await page.evaluate(() => window.__sameDocument === true), 'the page was reloaded').toBe(true);
  await expect(alert('NA').locator('.retry-btn'), 'the message gone once the standings loaded').toHaveCount(0);
  await wvw.settle();

  const tables = await fail(page, wvw, /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/guilds\/(na|eu)$/);
  await page.locator('#guildInput').fill(wvw.guilds.join('\n'));
  await page.locator('#runBtn').click();
  const again = page.locator('#statusMsg .retry-btn');
  await expect(again, 'the guild search message with its Try again button').toBeVisible();
  await expect(page.locator('#runBtn')).toBeEnabled();
  tables.off();
  await again.click();
  await expect(page.locator('#statusMsg'), 'the "Done" status after Try again').toHaveText(/^Done/, { timeout: 15000 });
  await wvw.settle();
});

// A second load with /api/* answering 503: the page falls back to the sheets,
// and the relink notice the first load showed is still shown, from them.
test('with /api down the page reads the sheets and keeps the relink notice', async ({ page, wvw }) => {
  const sheets = [], own = [];
  page.on('request', r => {
    if (/^https:\/\/docs\.google\.com\//.test(r.url())) sheets.push(r.url());
    if (/^http:\/\/127\.0\.0\.1:\d+\/api\/(kills|relink)$/.test(r.url())) own.push(r.url());
  });
  const noticeUp = () => page.evaluate(() => getComputedStyle(document.getElementById('teamsNotice')).display !== 'none'
    || getComputedStyle(document.getElementById('relinkBanner')).display !== 'none');
  await page.goto(wvw.url);
  await expect(page.locator(TIERS)).toHaveCount(wvw.tiers.NA);
  await wvw.settle();
  const hadNotice = await noticeUp();
  await fail(page, wvw, /^http:\/\/127\.0\.0\.1:\d+\/api\//);
  sheets.length = 0;
  own.length = 0;
  await page.goto(wvw.url);
  await expect(page.locator(TIERS)).toHaveCount(wvw.tiers.NA);
  await wvw.settle();
  expect(own.length, 'times the page asked /api/kills or /api/relink').toBeGreaterThan(0);
  expect(sheets.length, 'times the page read the sheets instead').toBeGreaterThan(0);
  if (hadNotice) await expect.poll(noticeUp, { message: 'the relink notice from the sheets' }).toBe(true);
});

// ---- the game's API failing, state by state ----------------------------------
const GAME = /^https:\/\/api\.guildwars2\.com\//;
const ALL = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
const ALL_RE = /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=all$/;
const BY_ID = /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=/;
const EU_ONLY = /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=2-[1-9](,2-[1-9])*$/;
// The game's plain list of match ids, which the recording lacks: what the fallback asks first.
const idList = page => answer(page, 'https://api.guildwars2.com/v2/wvw/matches', recordedJson(ALL).map(m => m.id));
const EU = '#standingsGridEU > .standing-match';
const alertOf = (page, region) => page.locator(`#standingsAlert${region}`);

// With the fixture's clock: 'playwright', the page's clock stops a second after it
// opened and only runFor moves it from there, so a wait of the page's own (a retry's
// sleep, a Retry-After) is measured on the page's clock and not raced.
const stopClock = (page, wvw) => page.clock.pauseAt(wvw.opensAt + 1000);

test.describe('the game answering badly', () => {
  test('a 503 once on every address and a 200 after: the tables paint, nothing is said', async ({ page, wvw }) => {
    const down = await fail(page, wvw, GAME, 503, { first: 1 });
    await page.goto(wvw.url);
    await expect(page.locator(TIERS), 'tables painted through the page\'s own retry').toHaveCount(wvw.tiers.NA);
    await expect(page.locator(EU)).toHaveCount(wvw.tiers.EU);
    await wvw.settle();
    expect(down.reads, 'reads that failed').toBeGreaterThan(0);
    await expect(page.locator('.retry-btn'), 'no "Try again": the retry is not something to show').toHaveCount(0);
    await expect(alertOf(page, 'NA')).toBeEmpty();
    await expect(page.locator('#standingsStatusNA')).toContainText('Synced');
  });

  test('the network dropping once on every address: the same', async ({ page, wvw }) => {
    const down = await abort(page, wvw, GAME, { first: 1 });
    await page.goto(wvw.url);
    await expect(page.locator(TIERS)).toHaveCount(wvw.tiers.NA);
    await expect(page.locator(EU)).toHaveCount(wvw.tiers.EU);
    await wvw.settle();
    expect(down.reads, 'reads cut off').toBeGreaterThan(0);
    await expect(page.locator('.retry-btn')).toHaveCount(0);
  });

  test('the network down: the message, the button, and the button brings the tables', async ({ page, wvw }) => {
    const down = await abort(page, wvw, GAME);
    await page.goto(wvw.url);
    await expect(alertOf(page, 'NA'), 'the message under the standings').toContainText(/Trying again in \d+ s/);
    await expect(alertOf(page, 'EU')).toContainText(/Trying again in \d+ s/);
    expect(await page.locator(TIERS).count() + await page.locator(EU).count(), 'tiers painted with no network').toBe(0);
    await expect(page.locator('#standingsGridNA .skel-match'), 'the skeleton gone with the answer').toHaveCount(0);
    down.off();
    await alertOf(page, 'NA').locator('.retry-btn').click();
    await expect(page.locator(TIERS), 'the tables from the button').toHaveCount(wvw.tiers.NA, { timeout: 20000 });
    await expect(page.locator(EU)).toHaveCount(wvw.tiers.EU);
    await expect(page.locator('.retry-btn')).toHaveCount(0);
    await wvw.settle();
  });

});

test.describe('the page\'s own waits, on its clock', () => {
  test.use({ clock: 'playwright' });

  test('the extra tries run out: it says it will try again later, and the button still works', async ({ page, wvw }) => {
    test.setTimeout(60 * 1000);
    await page.addInitScript(() => { Math.random = () => 0; });
    await stopClock(page, wvw);
    const down = await fail(page, wvw, GAME);
    await page.goto(wvw.url);
    // Two extra tries (js/config.js, STANDINGS_RETRY_WINDOWS_MS), each failing after the
    // page's own retries; the clock is run in steps until the page has used them.
    const spent = /It will try again in a few minutes/;
    await expect.poll(async () => { await page.clock.runFor(2000); return alertOf(page, 'NA').textContent(); },
      { message: 'both extra tries used', timeout: 40000, intervals: [100] }).toMatch(spent);
    await expect(alertOf(page, 'EU')).toContainText(spent);
    await expect(alertOf(page, 'NA').locator('.retry-btn'), 'the Try again button after the last try').toHaveText('Try again');
    expect(await page.locator(TIERS).count(), 'tiers painted while failing').toBe(0);
    const before = down.reads;
    await page.clock.fastForward(60 * 1000);
    expect(down.reads, 'reads made on their own after the last extra try').toBe(before);
    down.off();
    await alertOf(page, 'NA').locator('.retry-btn').click();
    await expect(page.locator(TIERS), 'the button\'s single try paints').toHaveCount(wvw.tiers.NA);
    await expect(page.locator(EU)).toHaveCount(wvw.tiers.EU);
    await expect(page.locator('.retry-btn')).toHaveCount(0);
  });

  // The game's reply is a 429 asking for 9 s (a server that lets the page read the
  // header: js/api.js, retryAfterMs); the page's own wait, 1.5 s, is long gone by 8 s.
  test('a 429 with Retry-After: the page waits what the header says before it asks again', async ({ page, wvw }) => {
    await stopClock(page, wvw);
    let asked = 0;
    page.on('request', r => { if (r.url() === ALL) asked++; });
    const limited = await fail(page, wvw, ALL_RE, 429, { retryAfter: '9', first: 1 });
    await page.goto(wvw.url);
    await expect.poll(() => limited.reads, { message: 'the 429 answered' }).toBe(1);
    await wvw.settle();
    expect(asked, 'reads of the list so far').toBe(1);
    await page.clock.runFor(8000);
    await wvw.settle();
    expect(asked, 'asked again before the 9 s of Retry-After').toBe(1);
    expect(await page.locator(TIERS).count(), 'tiers before the wait is over').toBe(0);
    await page.clock.runFor(1500);
    await expect.poll(async () => { await page.clock.runFor(500); return page.locator(TIERS).count(); },
      { message: 'the tables once the wait is over', intervals: [100] }).toBe(wvw.tiers.NA);
    await expect(page.locator(EU)).toHaveCount(wvw.tiers.EU);
    expect(asked, 'reads of the list in all').toBe(2);
  });
});

// The list of all matches comes back empty: not a failure the page can see, but
// nothing to show; it asks region by region and the board is not empty.
test('an empty list from ids=all: the page asks region by region and paints', async ({ page, wvw }) => {
  const empty = await answer(page, ALL, []);
  await idList(page);
  await page.goto(wvw.url);
  await expect(page.locator(TIERS)).toHaveCount(wvw.tiers.NA);
  await expect(page.locator(EU)).toHaveCount(wvw.tiers.EU);
  await wvw.settle();
  expect(empty.reads, 'reads of the empty list').toBeGreaterThan(0);
  await expect(page.locator('#standingsStatusNA')).toContainText('Synced');
});

// A refresh that fails with the board painted: the tiers stay, the page says it will try again.
test('a refresh that fails keeps the tiers on screen and only says so', async ({ page, wvw }) => {
  await load(page, wvw);
  const names = await page.locator(TIERS).allInnerTexts();
  await idList(page);
  const down = await fail(page, wvw, BY_ID);
  await page.evaluate(() => loadStandings());
  await expect(alertOf(page, 'NA'), 'the message').toContainText(/Trying again in \d+ s/);
  await expect(alertOf(page, 'EU')).toContainText(/Trying again in \d+ s/);
  expect(down.reads, 'refresh reads that failed').toBeGreaterThan(0);
  await expect(page.locator(TIERS), 'tiers kept').toHaveCount(wvw.tiers.NA);
  await expect(page.locator(EU)).toHaveCount(wvw.tiers.EU);
  expect(await page.locator(TIERS).allInnerTexts(), 'the numbers kept as they were').toEqual(names);
  down.off();
  await alertOf(page, 'NA').locator('.retry-btn').click();
  await expect(page.locator('.retry-btn'), 'the message gone once a try got through').toHaveCount(0, { timeout: 20000 });
  await expect(page.locator(TIERS)).toHaveCount(wvw.tiers.NA);
  await wvw.settle();
});

// One region and the other, when the list of all fails: a request that failed
// is asked again; an answer with nothing in it is not (asking would change nothing).
test.describe('one region of the fallback', () => {
  test('EU fails: NA paints, EU says it will try again', async ({ page, wvw }) => {
    await answer(page, ALL, []);
    await idList(page);
    const down = await fail(page, wvw, EU_ONLY);
    await page.goto(wvw.url);
    await expect(page.locator(TIERS), 'NA, whose request answered').toHaveCount(wvw.tiers.NA);
    await expect(alertOf(page, 'EU'), 'EU, whose request failed').toContainText(/Trying again in \d+ s/);
    await expect(alertOf(page, 'EU').locator('.retry-btn')).toHaveText('Try again');
    await expect(page.locator(EU)).toHaveCount(0);
    await expect(alertOf(page, 'NA').locator('.retry-btn'), 'no message over NA').toHaveCount(0);
    await expect(page.locator('#standingsStatusNA')).toContainText('Synced');
    expect(down.reads).toBeGreaterThan(0);
  });

  test('EU answers with nothing: NA paints, EU says it could not load, and does not try again', async ({ page, wvw }) => {
    await answer(page, ALL, []);
    await idList(page);
    await answer(page, EU_ONLY, []);
    await page.goto(wvw.url);
    await expect(page.locator(TIERS)).toHaveCount(wvw.tiers.NA);
    await expect(page.locator('#standingsStatusEU')).toHaveText("Couldn't load EU standings.");
    await wvw.settle();
    await expect(page.locator('.retry-btn'), 'nothing to retry: the answer was empty').toHaveCount(0);
    await expect(alertOf(page, 'EU')).toBeEmpty();
    await expect(page.locator(EU)).toHaveCount(0);
    await expect(page.locator('#standingsStatusNA')).toContainText('Synced');
  });
});

// Only our /api/kills out, /api/relink answering: the kill history comes from the sheet,
// and a map shows its age from it, amber, as with /api/kills.
test('only /api/kills down: the sheet still gives the history, and the map its age', async ({ page, wvw }) => {
  const sheet = [];
  await page.route(/^https:\/\/docs\.google\.com\/spreadsheets\/.*sheet=kills/, async route => {
    sheet.push(route.request().url());
    const rows = await page.evaluate(() => [...newestMatches.keys()].map(k => [Date.now() - (k === window.__target ? 7 * 60000 : 60000), k, 5, 5, 5, 5]));
    await route.fulfill({ status: 200, contentType: 'text/csv', body: rows.map(r => r.join(',')).join('\n'),
      headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  const relink = [];
  page.on('response', r => { if (/^http:\/\/127\.0\.0\.1:\d+\/api\/relink$/.test(r.url())) relink.push(r.status()); });
  await load(page, wvw);
  const tier = await firstTier(page);
  await page.evaluate(id => { window.__target = id; }, tier.id);
  const down = await fail(page, wvw, /^http:\/\/127\.0\.0\.1:\d+\/api\/kills$/);
  await page.evaluate(async () => {
    for (const k of newestMatches.values()) { k.rose = false; k.at = Date.now(); }
    killSheetAt = 0;
    await getKillSheet();
  });
  expect(relink, 'answers of /api/relink, which stayed up').toContain(200);
  expect(down.reads, 'reads of /api/kills that failed').toBeGreaterThan(0);
  expect(sheet.length, 'reads of the sheet instead').toBeGreaterThan(0);
  expect(await page.evaluate(id => Date.now() - newestMatches.get(id).at, tier.id), 'the match backdated by the sheet\'s history')
    .toBeGreaterThanOrEqual(6 * 60000);
  await openMap(page, wvw, tier.button);
  await expect(page.locator('.info-popover .wvw-plot-wrap .wvw-hud-ago'), 'the map opens amber, from the sheet').toHaveText(/^⚠ data from /);
  await expect(page.locator('.info-popover .wvw-plot-wrap .wvw-hud-big')).toHaveText('–');
  await wvw.settle();
});
