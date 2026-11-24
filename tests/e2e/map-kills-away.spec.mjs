// The map's kills corner after a tab hidden for hours: a server group that moved hours behind and then
// caught up.
import { test, expect } from './support/fixtures.mjs';
import { load, openMap, play } from './support/steps.mjs';
import { FOCUS, MIN, catchUpBehind, hidden, visible } from './support/scenarios.mjs';

test.describe.configure({ timeout: 4 * 60 * 1000 });
test.use({ clock: 'playwright', viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });

const BUTTON = page => page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`);
const BIG = page => page.locator('.info-popover .wvw-plot-wrap .wvw-hud-l .wvw-hud-big');

// Our readers stuck while the visitor's group runs 400 min behind and moves; back 12 min before it catches up,
// with the map open. One read then brings 400 minutes of kills.
test.describe('a group hours behind catching up', () => {
  test.use({ timeline: catchUpBehind(470, 400, 10) });
  test('no map wears swords and the corner never counts thousands in ten minutes', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 458 * MIN);
    await visible(page);
    await openMap(page, wvw, BUTTON(page));
    await play(page, 12 * MIN);
    for (let i = 0; i < 8; i++) {
      await play(page, 30000);
      const big = await BIG(page).textContent();
      await expect(page.locator('.info-popover .wvw-tab.is-lit'), `${i * 30 + 30} s after the catch-up`).toHaveCount(0);
      expect(big === '–' || Number(big) < 1000, `the count ${big}, ${i * 30 + 30} s after the catch-up`).toBe(true);
    }
  });
});
