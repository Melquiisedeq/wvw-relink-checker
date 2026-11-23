import { test, expect } from './support/fixtures.mjs';
import { fail } from './support/faults.mjs';
import { load } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

test('the guild tables failing on a Check: the message, the Check button free, and Try again runs the whole search', async ({ page, wvw }) => {
  await load(page, wvw);
  const tables = await fail(page, wvw, /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/guilds\/(na|eu)$/);
  await page.locator('#guildInput').fill(wvw.guilds.join('\n'));
  await page.locator('#runBtn').click();
  const status = page.locator('#statusMsg');
  await expect(status).toContainText("Couldn't load WvW data. The connection may be slow.");
  await expect(status, 'the error colour').toHaveClass(/status-err/);
  await expect(status.locator('.retry-btn'), 'the button').toHaveText('Try again');
  await expect(page.locator('#runBtn'), 'Check left free').toBeEnabled();
  await expect(page.locator('#runBtn')).toHaveText('Check');
  await expect(page.locator('#resultBody tr')).toHaveCount(0);
  await expect(page.locator('#copyRow')).toBeHidden();
  tables.off();
  await status.locator('.retry-btn').click();
  await expect(status, 'the whole search run by the button').toHaveText(`Done, checked ${wvw.guilds.length} guild(s).`, { timeout: 15000 });
  await expect(status).not.toHaveClass(/status-err/);
  await expect(page.locator('#resultBody tr').first()).toBeVisible();
  await expect(page.locator('#copyRow')).toBeVisible();
  await wvw.settle();
});
