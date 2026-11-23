// A guild whose lookup failed says why in a short phrase in the results table,
// never the technical message; the two phrases that were already clear stay.
import { test, expect } from './support/fixtures.mjs';
import { abort, answer, fail, hold } from './support/faults.mjs';
import { load } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
const SEARCH = /^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/;
const ID = '11111111-2222-3333-4444-555555555555';
const GUILD = new RegExp(`^https://api\\.guildwars2\\.com/v2/guild/${ID}$`);

async function checkOne(page, wvw, name) {
  await load(page, wvw);
  await page.locator('#guildInput').fill(name);
  await page.locator('#runBtn').click();
  await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 20000 });
  return page.locator('#resultBody tr .status-err');
}

test('429 on the search: "Server busy, try again"', async ({ page, wvw }) => {
  await fail(page, wvw, SEARCH, 429);
  await expect(await checkOne(page, wvw, 'Busy Guild')).toHaveText('Server busy, try again');
});

test('503 on the search: "Server error, try again"', async ({ page, wvw }) => {
  await fail(page, wvw, SEARCH, 503);
  await expect(await checkOne(page, wvw, 'Down Guild')).toHaveText('Server error, try again');
});

test('the connection dropping: "Connection lost, try again"', async ({ page, wvw }) => {
  await abort(page, wvw, SEARCH);
  await expect(await checkOne(page, wvw, 'Offline Guild')).toHaveText('Connection lost, try again');
});

test('guild data in the wrong shape: "Server error, try again"', async ({ page, wvw }) => {
  await answer(page, GUILD, { unexpected: true });
  await expect(await checkOne(page, wvw, ID)).toHaveText('Server error, try again');
});

test('an unknown name keeps "Guild not found (name must match exactly)"', async ({ page, wvw }) => {
  await answer(page, SEARCH, []);
  await expect(await checkOne(page, wvw, 'Nobody Has This Name')).toHaveText('Guild not found (name must match exactly)');
});

test('a 404 on the guild id: "Guild not found"', async ({ page, wvw }) => {
  await fail(page, wvw, GUILD, 404);
  await expect(await checkOne(page, wvw, ID)).toHaveText('Guild not found (name must match exactly)');
});

test('the same missing id checked twice (the second from the cache) says the same', async ({ page, wvw }) => {
  const missing = await fail(page, wvw, GUILD, 404);
  await expect(await checkOne(page, wvw, ID)).toHaveText('Guild not found (name must match exactly)');
  const reads = missing.reads;
  await page.locator('#runBtn').click();
  await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 20000 });
  await expect(page.locator('#resultBody tr .status-err')).toHaveText('Guild not found (name must match exactly)');
  expect(missing.reads, 'the second Check read nothing').toBe(reads);
});

test('a guild with no link keeps "No WvW link registered yet"', async ({ page, wvw }) => {
  await answer(page, GUILD, { id: ID, name: 'Linkless', tag: 'NO' });
  await expect(await checkOne(page, wvw, ID)).toHaveText('No WvW link registered yet');
});

// The game not answering: after 3 lookups in a row lost to the connection or to time the series
// stops, the rows already drawn stay, and "Try again" runs the search again.
const SILENT = /^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?name=Silent/;
const names = n => Array.from({ length: n }, (_, i) => `Silent ${i + 1}`);

async function checkMany(page, wvw, list) {
  await load(page, wvw);
  await page.locator('#guildInput').fill(list.join('\n'));
  await page.locator('#runBtn').click();
}

test('20 names with the game out: stops after 3 and offers "Try again"', async ({ page, wvw }) => {
  const out = await abort(page, wvw, SILENT);
  await checkMany(page, wvw, names(20));
  const retry = page.locator('#statusMsg .retry-btn');
  await expect(retry).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#statusMsg')).toContainText("Couldn't reach the game. Checked 3 of 20");
  await expect(page.locator('#runBtn')).toBeEnabled();
  await expect(page.locator('#resultBody tr')).toHaveCount(3);
  // 3 names, each read once and retried twice.
  expect(out.reads).toBe(9);
  out.off();
  await answer(page, SILENT, []);
  await retry.click();
  await expect(page.locator('#statusMsg')).toHaveText(/^Done, checked 20/, { timeout: 30000 });
  await expect(page.locator('#resultBody tr')).toHaveCount(20);
});

test('2 lost, 1 found, 2 lost: the series goes on', async ({ page, wvw }) => {
  await abort(page, wvw, /^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?name=Silent%20[1245]$/);
  await answer(page, /^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?name=Silent%203$/, [ID]);
  await answer(page, GUILD, { id: ID, name: 'Silent 3', tag: 'S3' });
  await checkMany(page, wvw, names(5));
  await expect(page.locator('#statusMsg')).toHaveText(/^Done, checked 5/, { timeout: 30000 });
  await expect(page.locator('#statusMsg .retry-btn')).toHaveCount(0);
  await expect(page.locator('#resultBody tr')).toHaveCount(5);
});

test('3 answers that are not good (503) in a row are not silence: the series goes on', async ({ page, wvw }) => {
  await fail(page, wvw, /^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?name=Silent%20[123]$/, 503);
  await checkMany(page, wvw, names(3));
  await expect(page.locator('#statusMsg')).toHaveText(/^Done, checked 3/, { timeout: 30000 });
  await expect(page.locator('#statusMsg .retry-btn')).toHaveCount(0);
});

test('a list cut to 20 keeps its note beside the stop', async ({ page, wvw }) => {
  await abort(page, wvw, SILENT);
  await checkMany(page, wvw, names(25));
  await expect(page.locator('#statusMsg .retry-btn')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#statusMsg')).toContainText("Checked 3 of 20 guild(s). Only the first 20 guilds were checked.");
});

test.describe('the game answering nothing at all', () => {
  test.use({ clock: 'playwright' });

  test('3 lookups timing out in a row: stops and offers "Try again"', async ({ page, wvw }) => {
    test.setTimeout(60 * 1000);
    await page.clock.pauseAt(wvw.opensAt + 1000);
    await load(page, wvw);
    await hold(page, SILENT);
    await page.locator('#guildInput').fill(names(20).join('\n'));
    await page.locator('#runBtn').click();
    await expect.poll(async () => { await page.clock.runFor(2000); return page.locator('#statusMsg .retry-btn').count(); },
      { message: 'the stop after three timeouts', timeout: 40000, intervals: [100] }).toBe(1);
    await expect(page.locator('#statusMsg')).toContainText("Couldn't reach the game. Checked 3 of 20");
    await expect(page.locator('#resultBody tr .status-err')).toHaveText(['Server slow, try again', 'Server slow, try again', 'Server slow, try again']);
  });
});
