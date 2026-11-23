// The guild search: a name per region, the team it landed on found and named,
// the strip that leaves by itself; the cache of what a lookup answered; the
// limit of names.
import { test, expect } from './support/fixtures.mjs';
import { fail, answer } from './support/faults.mjs';
import { check, firstTier, load, matchReads, openMap, play, search } from './support/steps.mjs';
import { MIN, thirdInTierTwoStandingsOut, EU_STANDINGS_OUT, visible } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const GAME = /^https:\/\/api\.guildwars2\.com\/v2\/guild\//;

// The team the first guild landed on: its card blinks, the page brings it into
// view, a strip names the guild, and the strip leaves by itself.
test('guild found: the card blinks, the strip names the guild and leaves', async ({ page, wvw }) => {
  expect(wvw.guilds.length, 'guilds in the recording').toBeGreaterThanOrEqual(2);
  await load(page, wvw);
  await search(page, wvw.guilds);
  await expect.poll(() => page.evaluate(() => window.__found.flash && !!window.__found.strip),
    { message: "the found team's card blinking and the strip appearing" }).toBe(true);
  const named = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#resultBody tr')].find(r => r.querySelector('.server-cell'));
    return tr ? tr.cells[0].textContent : null;
  });
  const said = await page.evaluate(() => window.__found.strip);
  expect(named, 'a result row with a team').not.toBeNull();
  expect(said.toLowerCase()).toBe(`${named} · from your search`.toLowerCase());
  await expect.poll(() => page.evaluate(() => {
    const s = document.querySelector('.guild-found-strip');
    if (!s) return true;
    const b = s.previousElementSibling.getBoundingClientRect();
    return b.top >= 0 && b.bottom <= innerHeight;
  }), { message: "the found team's card in view" }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__found.gone && !document.querySelector('.guild-found-flash, .guild-found-strip')),
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
  await check(page, wvw, [id]);
  await expect(page.locator('#resultBody tr .status-err'), 'the 429 lookup').toHaveText('Server busy, try again');
  busy.off();
  const found = await answer(page, url, { id, name: 'Check Page Guild', tag: 'CPG', emblem: null });
  await check(page, wvw, [id]);
  await expect(page.locator('#resultBody tr .status-err'), 'the lookup after the 429: the guild is known, with no link yet').toHaveText('No WvW link registered yet');
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

// A pasted list of more than the page's promised limit ("Up to N guilds per run") of distinct names asks for the first
// N only, and says so; exactly N says nothing. Every search answers 404 on purpose, so only the asking is counted.
for (const over of [true, false]) {
  test(`guild limit: ${over ? 'one name over the limit says so' : 'exactly the limit says nothing'}`, async ({ page, wvw }) => {
    await load(page, wvw);
    const MAX = Number(/Up to (\d+) guilds per run/.exec(await page.getByText(/Up to \d+ guilds per run/).textContent())?.[1]);
    expect(MAX, 'the limit the page promises').toBeGreaterThan(0);
    const count = over ? MAX + 1 : MAX;
    const searches = await fail(page, wvw, /^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/, 404);
    wvw.allowLog(GAME);
    const names = Array.from({ length: count }, (_, i) => `Check Page Limit ${i + 1}`);
    await page.locator('#guildInput').fill(names.join('\n'));
    await page.locator('#runBtn').click();
    await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 30000 });
    await expect(page.locator('#runBtn')).toBeEnabled();
    const said = await page.locator('#statusMsg').textContent();
    expect(searches.reads, `${count} names asked searches`).toBe(MAX);
    expect(said.includes(`Only the first ${MAX} guilds were checked.`), `${count} names gave status "${said}"`).toBe(over);
    await wvw.settle();
  });
}

const marks = page => page.locator('#matchPanelsContainer .movement-indicator').evaluateAll(els => els.map(e => e.title));

test('standings out: third in tier 2 is not told it is already at the bottom tier', async ({ page, wvw }) => {
  await thirdInTierTwoStandingsOut(page, wvw);
  await page.goto(wvw.url);
  await search(page, wvw.guilds.slice(0, 1));
  const titles = await marks(page);
  expect(titles.length, 'movement marks in the panel').toBe(3);
  expect(titles.filter(t => /bottom tier/.test(t)), 'no claim about the bottom tier').toEqual([]);
  expect(titles.filter(t => /Moves down/.test(t)), 'no guess at the move down').toEqual([]);
});

// NA answered, so the page's one signal said "standings loaded": the EU's tier count is still unknown.
test('EU standings out, NA up: an EU third in tier 2 is not told it is at the bottom tier', async ({ page, wvw }) => {
  await thirdInTierTwoStandingsOut(page, wvw, { world: 12009, region: '2', out: EU_STANDINGS_OUT });
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await search(page, wvw.guilds.slice(1, 2));
  const titles = await marks(page);
  expect(titles.length, 'movement marks in the panel').toBe(3);
  expect(titles.filter(t => /bottom tier/.test(t)), 'no claim about the bottom tier').toEqual([]);
});

test('the pasted list comes back after a reload, and Check runs it', async ({ page, wvw }) => {
  await page.goto(wvw.url);
  const names = `${wvw.guilds[0]}\n${wvw.guilds[1]}`;
  await page.locator('#guildInput').fill(names);
  // Saved once typing pauses: polled, since the pause is the page's to time.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('wvw-relink-checker:guilds'))).toBe(names);
  await page.reload();
  await expect(page.locator('#guildInput')).toHaveValue(names);
  await page.locator('#runBtn').click();
  await expect(page.locator('#statusMsg')).toContainText('Done, checked 2 guild');
});
