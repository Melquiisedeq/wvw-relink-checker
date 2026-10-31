// A guild whose lookup failed says why in a short phrase in the results table,
// never the technical message; the two phrases that were already clear stay.
import { test, expect } from './support/fixtures.mjs';
import { abort, answer, fail } from './support/faults.mjs';
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

test('429 on the search: "API busy, try again"', async ({ page, wvw }) => {
  await fail(page, wvw, SEARCH, 429);
  await expect(await checkOne(page, wvw, 'Busy Guild')).toHaveText('API busy, try again');
});

test('503 on the search: "API error, try again"', async ({ page, wvw }) => {
  await fail(page, wvw, SEARCH, 503);
  await expect(await checkOne(page, wvw, 'Down Guild')).toHaveText('API error, try again');
});

test('the connection dropping: "Connection lost, try again"', async ({ page, wvw }) => {
  await abort(page, wvw, SEARCH);
  await expect(await checkOne(page, wvw, 'Offline Guild')).toHaveText('Connection lost, try again');
});

test('guild data in the wrong shape: "API error, try again"', async ({ page, wvw }) => {
  await answer(page, GUILD, { unexpected: true });
  await expect(await checkOne(page, wvw, ID)).toHaveText('API error, try again');
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
