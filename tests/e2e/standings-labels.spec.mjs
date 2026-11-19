// The dim labels inside the standings grid are #b1b8c2; the same grey elsewhere stays #8d97a6.
import { test, expect } from './support/fixtures.mjs';
import { load, check } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

test('standings labels use the lighter grey, the match panel outside keeps the old one', async ({ page, wvw }) => {
  await load(page, wvw);
  await wvw.settle();
  for (const sel of ['.standings-grid .stat-label', '.standings-grid .skirmish-bar-pct', '.standings-grid .tier-map-label']) {
    await expect(page.locator(sel).first(), sel).toHaveCSS('color', 'rgb(177, 184, 194)');
  }
  await expect(page.locator('.tier-map-btn').first()).toBeVisible();
  await page.locator('.tier-map-btn').first().hover();
  await expect(page.locator('.standings-grid .tier-map-btn:hover .tier-map-label').first()).toHaveCSS('color', 'rgb(231, 235, 240)');
  await check(page, wvw, [wvw.guilds[0]]);
  for (const sel of ['.match-panel .stat-label', '.match-panel .skirmish-bar-pct']) {
    await expect(page.locator(sel).first(), `${sel} outside the grid`).toHaveCSS('color', 'rgb(141, 151, 166)');
  }
});
