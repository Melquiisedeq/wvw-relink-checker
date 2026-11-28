// The guild search: the strip the arrow hangs leaves by itself; the cache of what a
// lookup answered; the standings tick.
import { test, expect } from './support/fixtures.mjs';
import { fail, answer } from './support/faults.mjs';
import { check, firstTier, load, matchReads, openMap, play, search } from './support/steps.mjs';
import { MIN, visible } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const GAME = /^https:\/\/api\.guildwars2\.com\/v2\/guild\//;
const team = page => page.locator('#searchAnswer .search-team').textContent();

test("guild found: the arrow's strip names the guild and leaves by itself", async ({ page, wvw }) => {
  expect(wvw.guilds.length, 'guilds in the recording').toBeGreaterThanOrEqual(2);
  await load(page, wvw);
  await search(page, wvw.guilds[0]);
  const named = (await page.locator('#searchAnswer .search-who').textContent()).replace(/ is on$/, '');
  await page.getByRole('button', { name: new RegExp(`^Show ${await team(page)} in the standings`) }).click();
  await expect.poll(() => page.evaluate(() => window.__found.strip), { message: 'the strip appearing' })
    .toBe(`${named} · from your search`);
  await expect.poll(() => page.evaluate(() => window.__found.gone && !document.querySelector('.guild-found-strip')),
    { message: 'the strip leaving by itself', timeout: 20000 }).toBe(true);
  await wvw.settle();
});

// A guild lookup answered 429 (after its retries) says nothing about the guild:
// the next Check asks again. (That a 404 is kept is search-errors.spec.mjs.)
test('a 429 is not kept against a guild', async ({ page, wvw }) => {
  await load(page, wvw);
  const id = '11111111-2222-3333-4444-555555555555';
  const url = `https://api.guildwars2.com/v2/guild/${id}`;
  wvw.allowLog(GAME);
  const busy = await fail(page, wvw, url, 429);
  await check(page, wvw, id);
  await expect(page.locator('#searchAnswer .search-err'), 'the 429 lookup').toHaveText("The game isn't answering. Try again");
  busy.off();
  const found = await answer(page, url, { id, name: 'Check Page Guild', tag: 'CPG', emblem: null });
  await check(page, wvw, id);
  await expect(page.locator('#searchAnswer .search-err'), 'the lookup after the 429: the guild is known, with no link yet').toHaveText('Check Page Guild has no WvW team yet.');
  found.off();
  await wvw.settle();
});

// A refresh that skips (a popover open) is not counted by the scheduler, so closing the
// popover runs it; one that ran is counted, so a focus return right after does not.
// Reads of the game's list (ids=all) are the refreshes.
const LIST = /\/wvw\/matches\?ids=all$/;
test.describe('the standings tick', () => {
  test.use({ clock: 'playwright', reducedMotion: 'reduce' });

  test('a skipped refresh does not spend its turn', async ({ page, wvw }) => {
    await load(page, wvw);
    const { button } = await firstTier(page);
    await openMap(page, wvw, button);
    const asked = matchReads(page);
    await play(page, 5 * MIN + 3000);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)), 'list reads over a tick with a map open').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('.info-popover')).toHaveCount(0);
    await expect.poll(() => asked.filter(u => LIST.test(u)).length, { message: 'list reads when the map closes after the skip' }).toBe(1);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'one list read, not two').toBe(1);
  });

  test('a refresh that ran is counted: the focus return right after reads nothing', async ({ page, wvw }) => {
    await load(page, wvw);
    const asked = matchReads(page);
    await play(page, 5 * MIN + 3000);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'list reads over a tick').toBe(1);
    await visible(page);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'list reads after the focus return').toBe(1);
  });
});
