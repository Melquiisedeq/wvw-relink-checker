// Every icon button of the standings, in page order: it opens a popover, the
// popover holds its content once loaded, it closes. A tier's map also shows
// every one of its tabs with the objectives drawn, the Seared Borderlands too.
import { test, expect } from './support/fixtures.mjs';
import { seared } from './support/scenarios.mjs';
import { load, firstTier, openMap } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ timeout: 2 * 60 * 1000 });

// What each kind's popover must hold once it has finished loading.
const CONTENT = {
  'tier-map-btn': ".info-popover .wvw-plot g[role='button']",
  'server-guilds-btn': '.info-popover .info-popover-body',
  'map-kd-btn': '.info-popover > :nth-child(2)',
  'activity-btn': '.info-popover > :nth-child(2)',
  'activity-info-btn': '.info-popover > :nth-child(2)',
};
// A tier's map is a button on each tier of a region: a test each, which keeps
// the longest of them short.
const SETS = [
  ['tier-map-btn', '#standingsGridNA '], ['tier-map-btn', '#standingsGridEU '],
  ['server-guilds-btn', ''], ['map-kd-btn', ''], ['activity-btn', ''], ['activity-info-btn', ''],
];

for (const [kind, scope] of SETS) {
  test(`${kind}${scope ? ' in ' + scope.trim() : ''}: open, content, close`, async ({ page, wvw }) => {
    await page.goto(wvw.url);
    await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
    await expect(page.locator('#standingsGridEU > .standing-match').first()).toBeVisible();
    await wvw.settle();
    const buttons = page.locator(`${scope}.icon-btn.${kind}`);
    const count = await buttons.count();
    let pressed = 0;
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i);
      // Folded away at this width: a visitor cannot press it either.
      if (!(await button.evaluate(b => !!b.offsetParent))) continue;
      const name = `${kind} '${await button.getAttribute('aria-label')}'`;
      await button.click();
      pressed++;
      await expect(page.locator(CONTENT[kind]).first(), `${name}: popover content`).toBeAttached();
      await wvw.settle();
      if (kind === 'tier-map-btn') {
        const types = await page.$$eval('.info-popover .wvw-tab', tabs => tabs.map(b => b.dataset.type));
        for (const type of types) {
          const tab = page.locator('.info-popover .wvw-tab').and(page.locator(`[data-type="${type}"]`));
          await tab.click();
          await expect(tab, `${name} ${type}: drawn objectives`).toHaveClass(/is-active/);
          await expect(page.locator(CONTENT[kind]).first()).toBeAttached();
          await wvw.settle();
        }
      }
      await page.locator('.info-popover .info-popover-close').click();
      await expect(page.locator('.info-popover'), `${name}: the popover closing`).toHaveCount(0);
    }
    expect(pressed, `visible ${kind} to press`).toBeGreaterThan(0);
  });
}

// The game's Seared Borderlands, ids no recording holds: each borderland draws
// its objectives (18, the spawns left out), its garrison, held by its home
// team, carries the waypoint whose chat link can be copied, and the frame holds
// the whole disc of the east keep, which sits past the sectors' edge.
test.describe('the Seared Borderlands', () => {
  test.use({ timeline: seared(10) });
  test('every borderland tab draws its objectives and its garrison waypoint', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page, page.locator('#standingsGridNA .tier-map-btn').first());
    expect(tier.id).toBe('1-1');
    await openMap(page, wvw, tier.button);
    for (const [type, map] of [['RedHome', 1652], ['BlueHome', 1654], ['GreenHome', 1651]]) {
      await page.locator(`.info-popover .wvw-tab[data-type="${type}"]`).click();
      const marks = page.locator('.info-popover .wvw-plot .wvw-marker');
      await expect(marks, `${type}: its objectives drawn`).toHaveCount(18);
      expect(await marks.evaluateAll(gs => gs.map(g => g.dataset.obj.split('-')[0])), `${type}: all of map ${map}`)
        .toEqual(Array(18).fill(String(map)));
      await expect(page.locator(`.info-popover .wvw-marker[data-obj="${map}-37"] .wvw-wp.is-copyable`),
        `${type}: the garrison's waypoint`).toHaveCount(1);
      const east = await page.evaluate(id => {
        const [x, , w] = document.querySelector('.info-popover .wvw-plot').getAttribute('viewBox').split(' ').map(Number);
        const keep = WVW_STATIC.objectives.find(o => o.id === id);
        return { right: x + w, disc: keep.coord[0] + 110 };
      }, `${map}-32`);
      expect(east.right, `${type}: the east keep's disc inside the frame`).toBeGreaterThanOrEqual(east.disc);
      await wvw.settle();
    }
  });
});
