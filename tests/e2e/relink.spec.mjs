// The maps over a tier that has just turned over or is being relinked, and over a
// page whose written-out copy (js/wvw-static.js) did not arrive. What a player
// sees: every objective drawn, none with an owner (Neutral), the line that says
// the colours are late; and, when the static copy is missing, the same map drawn
// from the API, or the plain sentence when the read of /v2/wvw/objectives fails too (503).
import { test, expect } from './support/fixtures.mjs';
import { answer, fail } from './support/faults.mjs';
import { firstTier, keptMatch, later, load, openMap, recordedJson, serveList } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
const ALL = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
const MARKERS = '.info-popover .wvw-marker';
const WAITING = '.info-popover .wvw-waiting';

const blanked = m => ({ ...m, maps: m.maps.map(x => ({ ...x, objectives: [] })) });
const owners = page => page.evaluate(sel => [...document.querySelectorAll(sel)].map(g => g.getAttribute('class').match(/own-(\w+)/)[1]), MARKERS);
const titles = page => page.evaluate(sel => [...document.querySelectorAll(sel)].map(g => g.querySelector('title').textContent), MARKERS);

test.describe('a tier whose objective lists are blank', () => {
  test('opened blank: every objective is drawn Neutral, and the map says the colours are late', async ({ page, wvw }) => {
    await serveList(page, recordedJson(ALL).map(blanked));
    await load(page, wvw);
    const tier = await firstTier(page);
    await answer(page, tier.url, blanked(await keptMatch(page, tier.id)));
    await openMap(page, wvw, tier.button);
    const seen = await owners(page);
    expect(seen.length, 'objectives drawn').toBeGreaterThan(10);
    expect([...new Set(seen)], 'owners drawn').toEqual(['neutral']);
    expect((await titles(page)).every(t => / · Neutral$/.test(t)), 'every marker names Neutral').toBe(true);
    await expect(page.locator(WAITING)).toBeVisible();
    await expect(page.locator(WAITING)).toHaveText(/Just after reset/);
  });

  test('a list that goes blank under an open map turns every marker Neutral, and back when the owners return', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    const full = await keptMatch(page, tier.id);
    await openMap(page, wvw, tier.button);
    expect((await owners(page)).some(o => o !== 'neutral'), 'owners drawn before').toBe(true);
    await expect(page.locator(WAITING)).toBeHidden();
    const blank = await answer(page, tier.url, blanked(full));
    await later(page, wvw, 31000);
    await expect.poll(async () => [...new Set(await owners(page))], { message: 'owners once the list is blank' }).toEqual(['neutral']);
    await expect(page.locator(WAITING)).toBeVisible();
    blank.off();
    await answer(page, tier.url, full);
    await later(page, wvw, 31000);
    await expect.poll(async () => (await owners(page)).some(o => o !== 'neutral'), { message: 'owners back' }).toBe(true);
    await expect(page.locator(WAITING)).toBeHidden();
  });

  test('the week over: the map shows no owners even though the list is full', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    const full = await keptMatch(page, tier.id);
    await openMap(page, wvw, tier.button);
    expect((await owners(page)).some(o => o !== 'neutral'), 'owners drawn before').toBe(true);
    await answer(page, tier.url, full);
    await later(page, wvw, Date.parse(full.end_time) - await wvw.now() + 60000);
    await expect.poll(async () => [...new Set(await owners(page))], { message: 'owners drawn after the end_time' }).toEqual(['neutral']);
    await expect(page.locator(WAITING)).toBeVisible();
  });
});

test.describe('js/wvw-static.js did not load', () => {
  const noStatic = page => page.route(/\/js\/wvw-static\.js(\?|$)/, route => route.abort('failed'));

  test('the map is drawn from the API alone, with its owners', async ({ page, wvw }) => {
    wvw.allowLog(/\/js\/wvw-static\.js/);
    await noStatic(page);
    await load(page, wvw);
    expect(await page.evaluate(() => typeof WVW_STATIC), 'the static copy').toBe('undefined');
    const tier = await firstTier(page);
    await openMap(page, wvw, tier.button);
    const seen = await owners(page);
    expect(seen.length, 'objectives drawn').toBeGreaterThan(10);
    expect(seen.some(o => o !== 'neutral'), 'owners drawn').toBe(true);
    await expect(page.locator(WAITING)).toBeHidden();
  });

  test('with /v2/wvw/objectives answering 503 too, the map says it could not load', async ({ page, wvw }) => {
    wvw.allowLog(/\/js\/wvw-static\.js/);
    await noStatic(page);
    await load(page, wvw);
    await fail(page, wvw, /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/objectives/);
    const tier = await firstTier(page);
    await tier.button.click();
    await expect(page.locator('.info-popover')).toHaveText("Couldn't load the map data right now.", { timeout: 15000 });
    await expect(page.locator(MARKERS)).toHaveCount(0);
  });
});
