import { test, expect } from './support/fixtures.mjs';
import { fail } from './support/faults.mjs';
import { load } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

test('the guild tables failing on a Check: the message, the Check button free, and Try again runs the search', async ({ page, wvw }) => {
  await load(page, wvw);
  const tables = await fail(page, wvw, /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/guilds\/(na|eu)$/);
  await page.locator('#guildInput').fill(wvw.guilds[0]);
  await page.locator('#runBtn').click();
  const said = page.locator('#searchAnswer .search-err');
  await expect(said).toHaveText("Couldn't load WvW data. The connection may be slow. Try again");
  await expect(page.locator('#runBtn'), 'Check left free').toBeEnabled();
  await expect(page.locator('#runBtn')).toHaveText('Check');
  await expect(page.locator('#searchAnswer .search-card')).toHaveCount(0);
  tables.off();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('#searchAnswer .search-card'), 'the search run by the button').toBeVisible({ timeout: 15000 });
  await expect(said).toHaveCount(0);
  await wvw.settle();
});
