// The page's first screen: the NA/EU swap, and the tiers' marks of age. (That
// the page loads with every tier and nothing the browser objects to is
// smoke.spec.mjs.)
import { test, expect } from './support/fixtures.mjs';
import { phone } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

test('the NA/EU swap moves the columns, and back', async ({ page, wvw }) => {
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
  const root = page.locator('html');
  const was = await root.evaluate(h => h.dataset.railFirst);
  const other = was === 'na' ? 'EU' : 'NA', same = was === 'na' ? 'NA' : 'EU';
  await page.locator('.rail-swap').first().click();
  await expect(root, 'swapped columns (data-rail-first unchanged)').not.toHaveAttribute('data-rail-first', was);
  await expect(page.locator(`.rail-left #standingsGrid${other}`), 'columns on their new sides').toBeAttached();
  await expect(page.locator(`.rail-right #standingsGrid${same}`), 'columns on their new sides').toBeAttached();
  await page.locator('.rail-swap').first().click();
  await expect(root, 'columns back on their sides').toHaveAttribute('data-rail-first', was);
  await wvw.settle();
});

// A swap slides the four halves of the relink bar (NA, NA time, EU, EU time);
// a swap undone before its first frame (two in the same task) slides none. The
// move is measured with the running animation included, so the second swap
// finds each half where it will end and has nothing to move; measured any
// other way, a half would jump on a swap repeated in mid-flight.
test('the relink bar halves slide on a swap, and none does on a swap undone before its first frame', async ({ page, wvw }) => {
  await page.goto(wvw.url);
  await expect(page.locator('#relinkBanner .region').first()).toBeVisible();
  await wvw.settle();
  const swapping = page.locator('#relinkBanner .is-swapping');
  const click = n => page.evaluate(k => { for (let i = 0; i < k; i++) document.querySelector('.rail-swap').click(); }, n);

  await click(1);
  await expect(swapping, 'halves wearing is-swapping after one swap').toHaveCount(4);
  await expect(swapping, 'the class is gone once they arrived').toHaveCount(0);

  await click(2);
  await expect(page.locator('#relinkBanner .time').first(), 'the bar after two swaps').toBeVisible();
  expect(await swapping.count(), 'halves that moved nothing and were given is-swapping').toBe(0);
  await wvw.settle();
});

// The recorded body repeated for 1600 s leaves no swords badge on any tier, and at
// 320 px no tier box or title row spills over.
test('no tier wears a mark after 1600 s of the same body, and at 320 px none spills', async ({ page, wvw }) => {
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
  await wvw.settle();
  expect(await page.locator('.tier-map-badge').count(), 'tiers wearing the swords badge before the gap').toBeGreaterThan(0);
  await wvw.skew(1600000);
  await page.evaluate(() => { localStorage.removeItem('wvw-fight-v1'); return loadStandings(); });
  await wvw.settle();
  expect(await page.locator('.standing-match').count(), 'tiers in the standings').toBeGreaterThan(0);
  expect(await page.locator('.tier-map-badge').count(), 'tiers wearing a mark after 1600 s of the same body').toBe(0);
  await phone(page, 320, { exact: false });
  await wvw.settle();
  const spill = await page.evaluate(() => ({
    page: Math.max(0, ...[...document.querySelectorAll('.standing-match')].map(b => Math.round(b.getBoundingClientRect().right - innerWidth))),
    rows: [...document.querySelectorAll('.standing-match-title')].filter(t => t.scrollWidth > t.clientWidth).length,
    tall: [...document.querySelectorAll('.standing-match-title')].filter(t => t.offsetHeight > 24).length,
  }));
  expect(spill, 'at 320 px: px a tier box spills, title rows overflowing, titles grown taller').toEqual({ page: 0, rows: 0, tall: 0 });
});
