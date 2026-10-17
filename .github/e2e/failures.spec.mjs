// A page that is used before it is ready, and one whose lines fail: a visitor
// acting before the last scripts have loaded, a failed load that tries again,
// and /api down so that the page falls back to the sheets.
import { test, expect } from './support/fixtures.mjs';
import { fail, hold } from './support/faults.mjs';

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
