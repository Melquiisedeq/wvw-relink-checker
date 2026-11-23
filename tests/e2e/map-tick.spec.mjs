import { test, expect } from './support/fixtures.mjs';
import { answer, hold } from './support/faults.mjs';
import { firstTier, iso, load } from './support/steps.mjs';
import { keptMatch } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

// The page's clock stops a moment ahead, and only runFor moves it from there. It runs by
// itself until then, so the instant asked for may already be behind it: asked again, further on.
async function pause(page, wvw) {
  for (let ahead = 100; ; ahead *= 2) {
    try { return await page.clock.pauseAt(await wvw.now() + ahead); }
    catch (e) { if (!/past/.test(String(e)) || ahead > 5000) throw e; }
  }
}

// Real time, not the page's clock: a request the page has sent reaches the route in it.
const realMs = ms => new Promise(done => setTimeout(done, ms));

const POP = '.info-popover';

// ---- the one-second tick of an open map ---------------------------------------
// While a map is open a tick every second judges its corners again as the data
// ages. Before the swords are marked (the map's first read has not landed and
// 2.5 s have not passed) it repaints the corners alone; once marked it judges
// the swords, the badge and the corners together. The clock is paused so that
// the state is held for as long as the test needs, and its date is jumped past
// the 6 minutes after which the data is called stale, then one tick is run.
const swords = page => page.locator(`${POP} .wvw-tab-swords`);
const corner = page => page.locator(`${POP} .wvw-hud-r`);
const ago = page => page.locator(`${POP} .wvw-hud-ago`);

test.describe('the tick of an open map', () => {
  test.use({ clock: 'playwright' });

  // The map of a tier whose button wears the swords, opened a couple of minutes after the page
  // (a body that fresh would mark the swords on opening).
  async function opening(page, wvw, holding) {
    await load(page, wvw);
    const tier = await firstTier(page, page.locator('.tier-map-btn:has(.tier-map-badge)').first());
    await page.clock.setSystemTime(await wvw.now() + 2 * 60 * 1000);
    let release = () => {};
    if (holding) {
      release = await hold(page, tier.url);
      await pause(page, wvw);
    }
    await tier.button.click();
    await expect(page.locator(`${POP} .wvw-plot g[role='button']`).first()).toBeAttached();
    return release;
  }
  const jump = async (page, wvw, min) => {
    await page.clock.setSystemTime(await wvw.now() + min * 60 * 1000);
    await page.clock.runFor(1000);
  };

  test('before the swords are marked it repaints the corners: data too old to trust without a read leaves the screen', async ({ page, wvw }) => {
    const release = await opening(page, wvw, true);
    await expect(corner(page), 'the age corner, the map just opened').toBeVisible();
    await expect(swords(page), 'swords on a tab before any read landed').toHaveCount(0);
    await page.clock.runFor(1000);
    await expect(swords(page), 'swords on a tab after a tick, nothing marked them').toHaveCount(0);
    await jump(page, wvw, 7);
    await expect(corner(page), 'the age corner, 7 min on with the read still out').toBeHidden();
    await expect(swords(page), 'swords on a tab, nothing marked them').toHaveCount(0);
    release();
    await wvw.settle();
  });

  test('a first read that never lands: after 2.5 s the swords go up from the body the map opened with', async ({ page, wvw }) => {
    const release = await opening(page, wvw, true);
    await page.clock.runFor(1000);
    await expect(swords(page), 'swords at 1 s, the read still out').toHaveCount(0);
    await page.clock.runFor(1600);
    await expect(swords(page), 'swords at 2.6 s, the read still out').toHaveCount(1);
    release();
    await wvw.settle();
  });

  test('a map closed before the idle warm-up leaves the other terrain pictures unasked', async ({ page, wvw }) => {
    const release = await opening(page, wvw, true);
    await page.locator(`${POP} .info-popover-close`).click();
    await expect(page.locator(POP)).toHaveCount(0);
    const asked = [];
    page.on('request', r => { if (/\/assets\/map-\w+-1280\.webp$/.test(r.url())) asked.push(r.url()); });
    await page.clock.runFor(5000);
    release();
    await wvw.settle();
    expect(asked, 'terrain pictures asked after the map was closed').toEqual([]);
  });

  test('a map left open and still warms the other tabs\' pictures: lite ones, one at a time, in tab order', async ({ page, wvw }) => {
    const release = await opening(page, wvw, true);
    const tabs = await page.locator(`${POP} .wvw-tab[data-type]`).evaluateAll(els => els.map(e => e.dataset.type));
    const active = await page.locator(`${POP} .wvw-tab.is-active`).getAttribute('data-type');
    const file = { Center: 'ebg', RedHome: 'rbl', BlueHome: 'bbl', GreenHome: 'gbl' };
    const want = tabs.filter(t => t !== active).map(t => `map-${file[t]}-1280.webp`);
    expect(want.length, 'the other tabs of the map').toBe(3);
    const held = [];
    const seen = [];
    const loaded = [];
    page.on('requestfinished', r => { if (/\/assets\/map-\w+-1280\.webp$/.test(r.url())) loaded.push(r.url()); });
    await page.route(/\/assets\/map-\w+-1280\.webp$/, route => {
      const name = route.request().url().split('/').pop();
      seen.push(name);
      held.push(route);
    });
    await page.clock.runFor(5000);
    for (let i = 0; i < want.length; i++) {
      await expect.poll(() => seen.length, `pictures asked, step ${i}`).toBe(i + 1);
      // The one asked is not answered yet: the next must not have been asked beside it.
      await page.clock.runFor(300);
      await realMs(300);
      expect(seen.length, `a second picture asked while the first was still out (step ${i})`).toBe(i + 1);
      await held.shift().fallback();
    }
    await expect.poll(() => seen.length).toBe(3);
    // The last picture is in; the page's decode() of it and the next ask would follow within the waits below.
    await expect.poll(() => loaded.length, { message: 'all three pictures loaded' }).toBe(3);
    await page.clock.runFor(300);
    await realMs(300);
    expect(seen, 'lite pictures of the tabs not in view, in tab order, each once').toEqual(want);
    release();
    await wvw.settle();
  });

  test('the badges of a fresh flip count down by the second, and go when their five minutes are up', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    const body = await keptMatch(page, tier.id);
    const now = await wvw.now();
    // On every map, every objective flipped an hour ago but one camp flipped 280 s ago (20 s of its protection left) and one 10 s ago.
    for (const m of body.maps) {
      for (const o of m.objectives) o.last_flipped = iso(now - 60 * 60 * 1000);
      const camps = m.objectives.filter(o => o.type === 'Camp');
      camps[0].last_flipped = iso(now - 280 * 1000);
      camps[1].last_flipped = iso(now - 10 * 1000);
    }
    await answer(page, tier.url, body);
    await page.locator('.tier-map-btn').first().click();
    const badges = page.locator(`${POP} .wvw-ri`);
    const clocks = () => badges.locator('text').allTextContents();
    await expect(badges.first(), 'a fresh flip wearing its badge').toBeAttached();
    // The map's first read has landed and been drawn: a clock that changes from here on is the tick's.
    await wvw.settle();
    await pause(page, wvw);
    const secs = c => { const [m, s] = c.split(':').map(Number); return m * 60 + s; };
    const before = (await clocks()).map(secs);
    expect(before.length, 'badges on the map').toBeGreaterThanOrEqual(2);
    await page.clock.runFor(2000);
    const after = (await clocks()).map(secs);
    expect(after.length, 'badges two seconds on').toBe(before.length);
    expect(after[0], 'the first clock, two seconds on').toBeLessThan(before[0]);
    await page.clock.setSystemTime(await wvw.now() + 30 * 1000);
    await page.clock.runFor(1000);
    await expect(badges, 'the badge of the older flip is gone, the newer one stays').toHaveCount(before.length - 1);
    await wvw.settle();
  });

  test('a page clock two days behind shows no badge: a remainder past five minutes is a wrong clock', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    const body = await keptMatch(page, tier.id);
    const now = await wvw.now();
    for (const m of body.maps) {
      for (const o of m.objectives) o.last_flipped = iso(now - 60 * 1000);
    }
    await answer(page, tier.url, body);
    await page.locator('.tier-map-btn').first().click();
    const badges = page.locator(`${POP} .wvw-ri`);
    await expect(badges.first(), 'a fresh flip wearing its badge').toBeAttached();
    await wvw.settle();
    await pause(page, wvw);
    const clocks = () => badges.locator('text').allTextContents();
    const secs = c => { const [m, s] = c.split(':').map(Number); return m * 60 + s; };
    for (const c of await clocks()) expect(secs(c), 'a clock on the right time').toBeLessThanOrEqual(300);
    await page.clock.setSystemTime(await wvw.now() - 2 * 24 * 60 * 60 * 1000);
    await page.clock.runFor(1000);
    await expect(badges, 'no badge once the page clock is two days behind').toHaveCount(0);
    // Drawn afresh on that clock, as when the map is opened again.
    await page.keyboard.press('Escape');
    await expect(page.locator(POP), 'the map closed').toHaveCount(0);
    await page.locator('.tier-map-btn').first().click();
    await expect(page.locator(`${POP} .wvw-marker`).first(), 'the map drawn again').toBeAttached();
    await wvw.settle();
    await expect(badges, 'no badge on a map drawn on that clock').toHaveCount(0);
    await wvw.settle();
  });

  test('once marked it judges the swords and the corners together: the swords leave, the data turns amber', async ({ page, wvw }) => {
    await opening(page, wvw, false);
    await expect(swords(page), 'swords on the busiest tab').toHaveCount(1);
    await expect(ago(page)).not.toHaveClass(/is-stale/);
    await jump(page, wvw, 7);
    await expect(swords(page), 'swords on a tab 7 min with no kills').toHaveCount(0);
    await expect(ago(page), 'the age corner, 7 min on').toHaveText(/^⚠ data from \d/);
    await expect(ago(page)).toHaveClass(/is-stale/);
    await expect(page.locator(`${POP} .wvw-hud-l`)).toContainText('⚠ data up to');
    await wvw.settle();
  });
});
