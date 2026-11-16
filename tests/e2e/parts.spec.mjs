// A script of the page that does not download: an effect-only file (trebuchet.js) costs the effect and nothing
// else; maps-early.js, which the standings need, makes the page say to reload instead of "couldn't load" forever.
import { test, expect } from './support/fixtures.mjs';
import { abort } from './support/faults.mjs';

const RELOAD = /Reload/;

test('js/trebuchet.js missing: Check runs and shows its result, without a word about it', async ({ page, wvw }) => {
  const down = await abort(page, wvw, /\/js\/trebuchet\.js$/);
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await expect(page.locator('#standingsStatusNA')).toContainText('Synced');
  await page.locator('#guildInput').fill(wvw.guilds[0]);
  await page.locator('#runBtn').click();
  expect(down.reads, 'reads cut off').toBeGreaterThan(0);
  await expect(page.locator('#statusMsg')).toContainText('Done, checked 1 guild');
  await expect(page.locator('#runBtn'), 'Check is not left off').toBeEnabled();
  await expect(page.locator('#runBtn')).toHaveText('Check');
  await expect(page.locator('body')).not.toContainText(RELOAD);
});

test('js/maps-early.js missing: the standings say to reload, not that they could not load', async ({ page, wvw }) => {
  const down = await abort(page, wvw, /\/js\/maps-early\.js$/);
  await page.goto(wvw.url);
  await expect(page.locator('#standingsStatusNA')).toHaveText(RELOAD);
  await expect(page.locator('#standingsStatusEU')).toHaveText(RELOAD);
  expect(down.reads, 'reads cut off').toBeGreaterThan(0);
  await expect(page.locator('body')).not.toContainText("Couldn't load");
  await page.locator('#guildInput').fill(wvw.guilds[0]);
  await page.locator('#runBtn').click();
  await expect(page.locator('#statusMsg')).toHaveText(RELOAD);
  await expect(page.locator('#runBtn')).toBeEnabled();
  await expect(page.locator('#runBtn')).toHaveText('Check');
});
