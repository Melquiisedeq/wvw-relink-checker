// A script of the page that does not download: the page says so and to reload,
// instead of a Check button off for good or standings that "couldn't load" forever.
import { test, expect } from './support/fixtures.mjs';
import { abort } from './support/faults.mjs';

const RELOAD = /Reload/;

test('js/trebuchet.js missing: Check comes back and says to reload', async ({ page, wvw }) => {
  const down = await abort(page, wvw, /\/js\/trebuchet\.js$/);
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await expect(page.locator('#standingsStatusNA')).toContainText('Synced');
  await page.locator('#guildInput').fill('Some Guild');
  await page.locator('#runBtn').click();
  expect(down.reads, 'reads cut off').toBeGreaterThan(0);
  await expect(page.locator('#runBtn'), 'Check is not left off').toBeEnabled();
  await expect(page.locator('#runBtn')).toHaveText('Check');
  await expect(page.locator('#statusMsg')).toHaveText(RELOAD);
});

test('js/maps-early.js missing: the standings say to reload, not that they could not load', async ({ page, wvw }) => {
  const down = await abort(page, wvw, /\/js\/maps-early\.js$/);
  await page.goto(wvw.url);
  await expect(page.locator('#standingsStatusNA')).toHaveText(RELOAD);
  await expect(page.locator('#standingsStatusEU')).toHaveText(RELOAD);
  expect(down.reads, 'reads cut off').toBeGreaterThan(0);
  await expect(page.locator('body')).not.toContainText("Couldn't load");
});
