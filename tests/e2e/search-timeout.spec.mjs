import { test, expect } from './support/fixtures.mjs';
import { load, search } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

// ---- a read that outlasts its deadline ---------------------------------------
// The guild search's first read (the name's id) never answers. After the page's
// 10 s it gives up on its own and the answer says the game is not answering.
test.describe('a read that never answers', () => {
  test.use({ clock: 'playwright' });

  test('the answer says the game is not answering, and the search ends', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/, () => new Promise(() => {}));
    await page.locator('#guildInput').fill('Nobody Answers Here');
    // The 10 s run from the moment the read leaves, after the page's own wait for the tables.
    const out = page.waitForRequest(/\/guild\/search\?/);
    await page.locator('#runBtn').click();
    await out;
    const row = page.locator('#searchAnswer .search-err');
    await expect(row, 'nothing said before the deadline').toHaveCount(0);
    await page.clock.runFor(9 * 1000);
    await expect(row, 'nothing said one second before the deadline').toHaveCount(0);
    await page.clock.runFor(1500);
    await expect(row, 'said after the deadline').toContainText("The game isn't answering.");
    await expect(page.locator('#runBtn')).toBeEnabled();
    await wvw.settle();
  });
});
