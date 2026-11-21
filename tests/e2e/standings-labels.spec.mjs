// The dim labels inside the standings grid are lighter than the same labels in the match panel
// outside it, and a hovered map button's label lighter still.
import { test, expect } from './support/fixtures.mjs';
import { load, check } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

const grey = sel => sel.evaluate(el => {
  const [r, g, b] = getComputedStyle(el).color.match(/[\d.]+/g).map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
});

test('standings labels are lighter than the match panel outside the grid', async ({ page, wvw }) => {
  await load(page, wvw);
  await wvw.settle();
  const inGrid = {};
  for (const sel of ['.standings-grid .stat-label', '.standings-grid .skirmish-bar-pct', '.standings-grid .tier-map-label']) {
    inGrid[sel] = await grey(page.locator(sel).first());
  }
  await expect(page.locator('.tier-map-btn').first()).toBeVisible();
  await page.locator('.tier-map-btn').first().hover();
  const hovered = page.locator('.standings-grid .tier-map-btn:hover .tier-map-label').first();
  await expect.poll(() => grey(hovered), 'the hovered label').toBeGreaterThan(inGrid['.standings-grid .tier-map-label']);
  await check(page, wvw, [wvw.guilds[0]]);
  for (const [outside, inside] of [['.match-panel .stat-label', '.standings-grid .stat-label'], ['.match-panel .skirmish-bar-pct', '.standings-grid .skirmish-bar-pct']]) {
    expect(await grey(page.locator(outside).first()), `${outside} is dimmer than ${inside}`).toBeLessThan(inGrid[inside]);
  }
  expect(await grey(page.locator('.match-panel .stat-label').first()), 'the map label of the grid is lighter than the panel\'s dim grey')
    .toBeLessThan(inGrid['.standings-grid .tier-map-label']);
});
