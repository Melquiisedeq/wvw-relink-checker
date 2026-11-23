import { test, expect } from './support/fixtures.mjs';
import { load, search } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

// ---- a read that outlasts its deadline ---------------------------------------
// The guild search's first read (the name's id) never answers. After the page's
// 10 s it gives up on its own and the row says why; a name that was never
// looked up does not hang the run.
test.describe('a read that never answers', () => {
  test.use({ clock: 'playwright' });

  test('the guild row says the request timed out, and the search ends', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/, () => new Promise(() => {}));
    await page.locator('#guildInput').fill('Nobody Answers Here');
    // The 10 s run from the moment the read leaves, after the page's own wait for the tables.
    const out = page.waitForRequest(/\/guild\/search\?/);
    await page.locator('#runBtn').click();
    await out;
    const row = page.locator('#resultBody tr');
    await expect(row, 'no row before the deadline').toHaveCount(0);
    await page.clock.runFor(9 * 1000);
    await expect(row, 'no row one second before the deadline').toHaveCount(0);
    await page.clock.runFor(1500);
    await expect(row.first(), 'the row after the deadline').toContainText('Server slow, try again');
    await page.clock.runFor(2000);
    await expect(page.locator('#statusMsg'), 'the search ended').toHaveText(/^Done/);
    await expect(page.locator('#runBtn')).toBeEnabled();
    await wvw.settle();
  });
});
