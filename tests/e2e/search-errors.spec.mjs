// A guild search that went wrong says which of three things happened, in a short phrase,
// never the technical message: not found, no team yet, or the game not answering (with
// "Try again", which asks again).
import { test, expect } from './support/fixtures.mjs';
import { abort, answer, fail } from './support/faults.mjs';
import { answered, load } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

const SEARCH = /^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/;
const ID = '11111111-2222-3333-4444-555555555555';
const GUILD = new RegExp(`^https://api\\.guildwars2\\.com/v2/guild/${ID}$`);
const NOT_FOUND = 'Not found. Check the exact in-game name.';
const SILENT = "The game isn't answering. Try again";

async function checkOne(page, wvw, name) {
  await load(page, wvw);
  await page.getByRole('combobox', { name: 'Guild name, exactly as in game' }).fill(name);
  await page.getByRole('button', { name: 'Check' }).click();
  await answered(page);
  return page.locator('#searchAnswer .search-err');
}

test('429 on the search: the game is not answering', async ({ page, wvw }) => {
  await fail(page, wvw, SEARCH, 429);
  await expect(await checkOne(page, wvw, 'Busy Guild')).toHaveText(SILENT);
});

test('503 on the search: the game is not answering', async ({ page, wvw }) => {
  await fail(page, wvw, SEARCH, 503);
  await expect(await checkOne(page, wvw, 'Down Guild')).toHaveText(SILENT);
});

test('the connection dropping: the game is not answering, and Try again asks again', async ({ page, wvw }) => {
  const dropped = await abort(page, wvw, SEARCH);
  await expect(await checkOne(page, wvw, 'Offline Guild')).toHaveText(SILENT);
  const reads = dropped.reads;
  await page.getByRole('button', { name: 'Try again' }).click();
  await answered(page);
  expect(dropped.reads, 'Try again asked the game again').toBeGreaterThan(reads);
});

test('guild data in the wrong shape: the game is not answering', async ({ page, wvw }) => {
  await answer(page, GUILD, { unexpected: true });
  await expect(await checkOne(page, wvw, ID)).toHaveText(SILENT);
});

test('an unknown name: not found', async ({ page, wvw }) => {
  await answer(page, SEARCH, []);
  await expect(await checkOne(page, wvw, 'Nobody Has This Name')).toHaveText(NOT_FOUND);
});

test('a 404 on the guild id: not found', async ({ page, wvw }) => {
  await fail(page, wvw, GUILD, 404);
  await expect(await checkOne(page, wvw, ID)).toHaveText(NOT_FOUND);
});

test('the same missing id checked twice (the second from the cache) says the same', async ({ page, wvw }) => {
  const missing = await fail(page, wvw, GUILD, 404);
  await expect(await checkOne(page, wvw, ID)).toHaveText(NOT_FOUND);
  const reads = missing.reads;
  await page.getByRole('button', { name: 'Check' }).click();
  await answered(page);
  await expect(page.locator('#searchAnswer .search-err')).toHaveText(NOT_FOUND);
  expect(missing.reads, 'the second Check read nothing').toBe(reads);
});

test('a guild with no link: no WvW team yet, by its own name', async ({ page, wvw }) => {
  await answer(page, GUILD, { id: ID, name: 'Linkless', tag: 'NO' });
  await expect(await checkOne(page, wvw, ID)).toHaveText('Linkless has no WvW team yet.');
});
