// The maps over a tier that has just turned over or is being relinked, and over a
// page whose written-out copy (js/wvw-static.js) did not arrive. What a player
// sees: every objective drawn, none with an owner (Neutral), the line that says
// the colours are late; and, when the static copy is missing, the same map drawn
// from the API, or the plain sentence when the read of /v2/wvw/objectives fails too (503). With the copy present the
// map asks the game for neither list.
import { test, expect } from './support/fixtures.mjs';
import { answer, fail } from './support/faults.mjs';
import { firstTier, keptMatch, later, load, openMap, recordedJson, serveList } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
const ALL = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
const MARKERS = '.info-popover .wvw-marker';
const WAITING = '.info-popover .wvw-waiting';

const noStatic = page => page.route(/\/js\/wvw-static\.js(\?|$)/, route => route.abort('failed'));
const blanked = m => ({ ...m, maps: m.maps.map(x => ({ ...x, objectives: [] })) });
const owners = page => page.evaluate(sel => [...document.querySelectorAll(sel)].map(g => g.getAttribute('class').match(/own-(\w+)/)[1]), MARKERS);
const tints = page => page.evaluate(() => [...document.querySelectorAll('.info-popover .wvw-sector')].map(g => g.getAttribute('class').match(/own-(\w+)/)[1]));
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
    expect((await tints(page)).some(o => o !== 'neutral'), 'territory tinted before').toBe(true);
    await expect(page.locator(WAITING)).toBeHidden();
    const blank = await answer(page, tier.url, blanked(full));
    await later(page, wvw, 31000);
    await expect.poll(async () => [...new Set(await owners(page))], { message: 'owners once the list is blank' }).toEqual(['neutral']);
    await expect.poll(async () => [...new Set(await tints(page))], { message: 'territory tint once the list is blank' }).toEqual(['neutral']);
    await expect(page.locator(WAITING)).toBeVisible();
    blank.off();
    await answer(page, tier.url, full);
    await later(page, wvw, 31000);
    await expect.poll(async () => (await owners(page)).some(o => o !== 'neutral'), { message: 'owners back' }).toBe(true);
    await expect.poll(async () => (await tints(page)).some(o => o !== 'neutral'), { message: 'territory tint back' }).toBe(true);
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

test.describe('what opening a map asks the game for', () => {
  const LISTS = /\/v2\/(wvw\/objectives\?ids=all|continents\/2\/floors\/3\/regions\/7\/maps\/\d+\/sectors\?ids=all)/;
  const listReads = page => {
    const urls = [];
    page.on('request', r => { if (LISTS.test(r.url())) urls.push(r.url()); });
    return urls;
  };

  test('with the copy, neither the objectives nor the sectors are read', async ({ page, wvw }) => {
    const urls = listReads(page);
    await load(page, wvw);
    await openMap(page, wvw, (await firstTier(page)).button);
    expect((await owners(page)).length, 'objectives drawn').toBeGreaterThan(10);
    expect((await tints(page)).length, 'sectors drawn').toBeGreaterThan(0);
    expect(urls).toEqual([]);
  });

  test('without the copy, both are read and the map is drawn', async ({ page, wvw }) => {
    wvw.allowLog(/\/js\/wvw-static\.js/);
    await noStatic(page);
    const urls = listReads(page);
    await load(page, wvw);
    await openMap(page, wvw, (await firstTier(page)).button);
    expect((await owners(page)).length, 'objectives drawn').toBeGreaterThan(10);
    expect((await tints(page)).length, 'sectors drawn').toBeGreaterThan(0);
    expect(urls.filter(u => u.includes('/wvw/objectives')), 'objectives read').toHaveLength(1);
    expect(urls.filter(u => u.includes('/sectors')).length, 'sectors read').toBeGreaterThan(0);
  });
});
