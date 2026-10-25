// js/maps.js, the drawing code, is not in index.html: js/maps-early.js asks for
// it as the first standings are drawn, without waiting for the browser to be
// idle, or at the first click on a map button. Here: it is asked for after the
// board and not before; a standings refresh or a click while it is still
// downloading asks for nothing more, and the click opens the map when it lands;
// a download that fails says so and its "Try again" opens the map.
import { test, expect } from './support/fixtures.mjs';
import { abort, hold } from './support/faults.mjs';
import { load } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const PLOT = ".info-popover .wvw-plot g[role='button']";

test('maps.js is asked for as the board is drawn, not before and not at idle', async ({ page, wvw }) => {
  await page.addInitScript(() => {
    // The ember canvas keeps the browser busy: an idle callback may never run.
    window.requestIdleCallback = () => 0;
    // Mutation records come in the order the page made them: the board's first
    // tier and the <script> for maps.js, whichever was inserted first.
    window.__order = [];
    const mo = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (r.target.id === 'standingsGridNA' && n.classList.contains('standing-match') && !window.__order.includes('board')) window.__order.push('board');
        if (n.tagName === 'SCRIPT' && /\/js\/maps\.js$/.test(n.src)) window.__order.push('maps');
      }
    });
    mo.observe(document, { childList: true, subtree: true });
  });
  await load(page, wvw);
  const requests = () => page.evaluate(() =>
    performance.getEntriesByType('resource').filter(r => new URL(r.name).pathname === '/js/maps.js').length);
  await expect.poll(requests, { message: 'maps.js asked for after the board, with no idle callback' }).toBeGreaterThan(0);
  expect(await requests(), 'one request for maps.js').toBe(1);
  expect(await page.evaluate(() => window.__order), 'maps.js inserted after the board, once').toEqual(['board', 'maps']);
});

test('a refresh or a click while maps.js is still downloading asks for nothing more, and the map opens when it lands', async ({ page, wvw }) => {
  const release = await hold(page, wvw.url + 'js/maps.js');
  // Not load(): the held script keeps the load event and the network busy.
  await page.goto(wvw.url, { waitUntil: 'commit' });
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
  await expect.poll(() => release.reads, { message: 'the board asked for maps.js' }).toBe(1);
  expect(await page.evaluate(() => refreshStandings()), 'the standings redrawn, not skipped').not.toBe(false);
  await page.locator('.tier-map-btn').first().click();
  await expect(page.locator('.info-popover'), 'the popover opens at once, loading').toContainText('Loading maps');
  expect(release.reads, 'the refresh and the click joined the request in flight').toBe(1);
  await expect(page.locator(PLOT)).toHaveCount(0);
  release();
  await expect(page.locator(PLOT).first(), 'the map drawn once maps.js landed').toBeAttached();
  await wvw.settle();
  expect(release.reads, 'one request for maps.js').toBe(1);
});

test('a failed download of maps.js says so, and "Try again" opens the map', async ({ page, wvw }) => {
  // The first read is the board's, failing in silence; the second is the click's.
  const cut = await abort(page, wvw, /\/js\/maps\.js$/, { first: 2 });
  await load(page, wvw);
  await expect.poll(() => cut.reads, { message: 'the board asked for maps.js' }).toBe(1);
  await page.locator('.tier-map-btn').first().click();
  const pop = page.locator('.info-popover');
  await expect(pop).toContainText("Couldn't load the maps right now.");
  expect(cut.reads, 'the click asked again after the failed download').toBe(2);
  await pop.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator(PLOT).first(), 'the map drawn after trying again').toBeAttached();
  await wvw.settle();
});

test('closed and opened again while maps.js downloads: one fill, into the open popover', async ({ page, wvw }) => {
  // maps.js served held, with fillTierMaps wrapped to log each popover it fills.
  let go;
  const gate = new Promise(ok => { go = ok; });
  await page.route(wvw.url + 'js/maps.js', async route => {
    await gate;
    const res = await route.fetch();
    const spy = '\n;(() => { const fill = fillTierMaps; window.__fills = [];' +
      ' fillTierMaps = function (p, ...rest) { window.__fills.push(p === activePopover); return fill.call(this, p, ...rest); }; })();\n';
    await route.fulfill({ response: res, body: (await res.text()) + spy });
  });
  await page.goto(wvw.url, { waitUntil: 'commit' });
  const btn = page.locator('.tier-map-btn').first();
  await btn.click();
  await expect(page.locator('.info-popover')).toContainText('Loading maps');
  await page.keyboard.press('Escape');
  await expect(page.locator('.info-popover')).toHaveCount(0);
  await btn.click();
  await expect(page.locator('.info-popover')).toContainText('Loading maps');
  go();
  await expect(page.locator(PLOT).first(), 'the map drawn once maps.js landed').toBeAttached();
  await wvw.settle();
  expect(await page.evaluate(() => window.__fills), 'fills, each true if into the open popover').toEqual([true]);
});
