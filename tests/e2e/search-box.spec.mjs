// Ctrl+Enter runs the search; the saved list comes back whole.
import { test, expect } from './support/fixtures.mjs';
import { search } from './support/steps.mjs';
import { refuseStorage } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
test.describe.configure({ timeout: 60 * 1000 });

test.describe('Ctrl+Enter and the saved list', () => {
  test('Ctrl+Enter runs the search; plain Enter only adds a line; a second press during a run is ignored', async ({ page, wvw }) => {
    await page.goto(wvw.url);
    await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
    await wvw.settle();
    const searches = [];
    page.on('request', r => { if (/\/v2\/guild\/search\?/.test(r.url())) searches.push(r.url()); });
    await page.locator('#guildInput').focus();
    await page.keyboard.insertText(wvw.guilds.join('\n'));
    await page.keyboard.press('Enter');
    await expect(page.locator('#guildInput')).toHaveValue(wvw.guilds.join('\n') + '\n');
    await wvw.settle();
    await expect(page.locator('#statusMsg'), 'Enter alone does not run').not.toHaveText(/Asking|Done/);
    expect(searches, 'Enter alone asks nothing').toEqual([]);
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('#runBtn')).toBeDisabled();
    await page.keyboard.press('Control+Enter');
    await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 15000 });
    await expect(page.locator('#resultBody tr').first()).toBeVisible();
    expect(await page.locator('#resultBody tr').count(), 'one row per name, from one run').toBe(wvw.guilds.length);
    expect(searches.length, 'searches asked, one run').toBeLessThanOrEqual(wvw.guilds.length);
    await wvw.settle();
  });

  const typed = ['First Guild', 'Second Guild [ABC]', 'Third Guild', 'Fourth Guild'];
  const saved = page => page.evaluate(() => localStorage.getItem('wvw-relink-checker:guilds'));

  test('the list comes back whole after a reload, and an emptied box stays empty', async ({ page, wvw }) => {
    await page.goto(wvw.url);
    await page.locator('#guildInput').focus();
    await page.keyboard.insertText(typed.join('\n'));
    await expect.poll(() => saved(page), { message: 'the list being saved' }).toBe(typed.join('\n'));
    await page.reload();
    await expect(page.locator('#guildInput')).toHaveValue(typed.join('\n'));
    await page.locator('#guildInput').fill('');
    await expect.poll(() => saved(page), { message: 'the emptied list being saved' }).toBe('');
    await page.reload();
    await expect(page.locator('#guildInput')).toHaveValue('');
    await wvw.settle();
  });

  test('storage that refuses: the box stays empty, what is typed stays typed, no error', async ({ page, wvw }) => {
    const saveTries = await refuseStorage(page);
    await page.goto(wvw.url);
    await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
    await page.locator('#guildInput').focus();
    await page.keyboard.insertText('Some Guild');
    await expect.poll(saveTries, { message: 'the page tried to save the typed list' }).toBeGreaterThan(0);
    await expect(page.locator('#guildInput')).toHaveValue('Some Guild');
    await wvw.settle();
  });
});
