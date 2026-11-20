// Swords on every map with a fight, the busiest one striking (js/maps-early.js killView's `lit`,
// js/maps.js markHotTab and strikeCorner). NA tier 1 plays fights on three maps for 25 minutes:
// Green BL the busiest (14 kills a minute), EBG (8) and Red BL (6) past the floor of 50 in ten minutes,
// Blue BL (4) under it. The map is open the whole time, so the page's one-second repaint runs over it.
import { test, expect } from './support/fixtures.mjs';
import { load, looping } from './support/steps.mjs';
import { FOCUS, fightsOnThree } from './support/scenarios.mjs';

test.describe.configure({ timeout: 90 * 1000 });
test.use({ clock: 'playwright', timeline: fightsOnThree(25), locale: 'en-US', viewport: { width: 1280, height: 900 } });

const POP = '.info-popover';
const tab = type => `${POP} .wvw-tab[data-type="${type}"]`;
const hud = `${POP} .wvw-plot-wrap .wvw-hud-l`;

// The map of the focus tier open, then the fight played out in half-minute steps.
async function fightOn(page, wvw) {
  await load(page, wvw);
  await page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`).click();
  await expect(page.locator(`${POP} .wvw-plot g[role='button']`).first()).toBeVisible();
  for (let i = 0; i < 50; i++) {
    await page.clock.fastForward(30 * 1000);
    await wvw.settle();
  }
  await page.clock.fastForward(1000);
  await expect(page.locator(tab('GreenHome'))).toHaveClass(/is-hot/);
}

// What a tab wears: the plain swords, the striking pair, and how many animations run inside it (the line under it included).
const worn = (page, type) => page.evaluate(t => {
  const b = document.querySelector(`.info-popover .wvw-tab[data-type="${t}"]`);
  return {
    lit: b.classList.contains('is-lit'), hot: b.classList.contains('is-hot'),
    plain: !!b.querySelector('.wvw-tab-swords'), strike: !!b.querySelector('.wvw-clash'),
    room: getComputedStyle(b).paddingLeft,
    under: b.querySelector('.wvw-tab-swords') ? getComputedStyle(b.querySelector('.wvw-tab-swords')).visibility : null,
    moving: b.getAnimations({ subtree: true }).filter(a => a instanceof CSSAnimation).length,
  };
}, type);

test('every map past the floor wears swords, only the busiest strikes, the one under wears none', async ({ page, wvw }) => {
  await fightOn(page, wvw);
  expect(await worn(page, 'GreenHome'), 'the busiest').toMatchObject({ lit: true, hot: true, plain: true, strike: true, room: '22px', under: 'hidden' });
  expect((await worn(page, 'GreenHome')).moving, 'the busiest tab animates').toBeGreaterThan(5);
  for (const type of ['Center', 'RedHome']) {
    expect(await worn(page, type), `${type}, past the floor`).toEqual({ lit: true, hot: false, plain: true, strike: false, room: '22px', under: 'visible', moving: 0 });
  }
  expect(await worn(page, 'BlueHome'), 'Blue BL, under the floor').toEqual({ lit: false, hot: false, plain: false, strike: false, room: '11px', under: null, moving: 0 });
  await expect(page.locator(tab('GreenHome')), 'the busiest says so').toHaveAttribute('title', /^Green Borderlands — \d+ kills in \d+ min, more than any other map$/);
  await expect(page.locator(tab('Center'))).toHaveAttribute('title', /^Eternal Battlegrounds — \d+ kills in \d+ min$/);
  await expect(page.locator(tab('RedHome'))).toHaveAttribute('title', /^Red Borderlands — \d+ kills in \d+ min$/);
  await expect(page.locator(tab('BlueHome'))).toHaveAttribute('title', 'Blue Borderlands');
});

test('the corner is orange on every map with a fight and strikes only on the busiest', async ({ page, wvw }) => {
  await fightOn(page, wvw);
  const corner = () => page.evaluate(sel => {
    const l = document.querySelector(sel);
    return { cold: l.classList.contains('is-cold'), striking: l.classList.contains('is-striking'),
      clash: !!l.querySelector('.wvw-hud-clash'), moving: l.getAnimations({ subtree: true }).filter(a => a instanceof CSSAnimation).length,
      icon: getComputedStyle(l.querySelector('.wvw-hud-swords > img')).visibility, ...(n => ({
        // The number painted by its background, the button's text-shadow gone, a drop-shadow under it.
        number: [n.color, n.webkitBackgroundClip, n.textShadow === 'none' ? 'none' : 'shadow', n.filter.startsWith('drop-shadow')].join('|') }))(getComputedStyle(l.querySelector('.wvw-hud-big'))) };
  }, hud);
  const states = {};
  for (const type of ['Center', 'RedHome', 'BlueHome', 'GreenHome']) {
    await page.locator(tab(type)).click();
    await expect(page.locator(`${POP} .wvw-tab.is-active`)).toHaveAttribute('data-type', type);
    states[type] = await corner();
  }
  expect(states.GreenHome.cold, 'the busiest map').toBe(false);
  expect(states.GreenHome.striking && states.GreenHome.clash, 'strikes').toBe(true);
  expect(states.GreenHome.moving, 'the corner animates').toBeGreaterThan(5);
  expect(states.GreenHome.icon, 'the plain icon steps aside for the strike').toBe('hidden');
  expect(states.GreenHome.number, 'the number is painted by its background').toBe('rgba(0, 0, 0, 0)|text|none|true');
  for (const type of ['Center', 'RedHome']) {
    expect(states[type], `${type}: orange and still`).toMatchObject({ cold: false, striking: false, clash: false, moving: 0, icon: 'visible', number: 'rgb(255, 176, 112)|border-box|shadow|false' });
  }
  expect(states.BlueHome, 'Blue BL: neutral as before').toMatchObject({ cold: true, striking: false, clash: false, moving: 0, icon: 'visible' });
});

test('the strike is not rebuilt by the page\'s repaint, and the corner joins it in step', async ({ page, wvw }) => {
  await fightOn(page, wvw);
  await page.evaluate(() => { window.__clash = document.querySelector('.info-popover .wvw-tab[data-type="GreenHome"] .wvw-clash'); });
  await page.clock.fastForward(3000);
  expect(await page.evaluate(() => window.__clash.isConnected && window.__clash === document.querySelector('.info-popover .wvw-tab[data-type="GreenHome"] .wvw-clash')),
    'the same element after three repaints').toBe(true);
  await page.locator(tab('Center')).click();
  await page.clock.fastForward(1000);
  await page.locator(tab('GreenHome')).click();
  const gap = await page.evaluate(sel => {
    const own = list => list.filter(a => a instanceof CSSAnimation);
    const t = own(document.querySelector('.info-popover .wvw-tab[data-type="GreenHome"]').getAnimations({ subtree: true }));
    const c = own(document.querySelector(sel).getAnimations({ subtree: true }));
    const at = list => list.map(a => Number(a.currentTime));
    return { tab: Math.min(...at(t)), corner: Math.min(...at(c)), moving: c.length };
  }, hud);
  expect(gap.moving).toBeGreaterThan(5);
  expect(gap.tab, 'the tab has been striking for a while').toBeGreaterThan(1000);
  expect(Math.abs(gap.tab - gap.corner), `the tab at ${gap.tab} ms, the corner at ${gap.corner}`).toBeLessThan(300);
});

test.describe('reduced motion', () => {
  test.beforeEach(async ({ page }) => { await page.emulateMedia({ reducedMotion: 'reduce' }); });

  test('the strike, the line under the tab and the number stand still', async ({ page, wvw }) => {
    await fightOn(page, wvw);
    await page.locator(tab('GreenHome')).click();
    const r = await looping(page);
    expect(r.still, 'looping animations on the page').toBeGreaterThan(20);
    expect(r.moved, `moving: ${JSON.stringify(r)}`).toBe(0);
    expect(r.onCss, 'left running on CSS').toEqual([]);
    // The tab's and the corner's own, by name: the page holds more than these.
    const names = await page.evaluate(sel => [...document.querySelector('.info-popover .wvw-tab[data-type="GreenHome"]').getAnimations({ subtree: true }),
      ...document.querySelector(sel).getAnimations({ subtree: true })].map(a => `${a.animationName}:${a.playState}`), hud);
    for (const n of ['clash-line', 'clash-punch', 'clash-swing-up', 'clash-swing-back', 'clash-flash', 'clash-shine', 'clash-spark']) {
      expect(names.filter(x => x.startsWith(`${n}:`)).length, n).toBeGreaterThan(0);
    }
    expect(names.filter(x => !x.endsWith(':paused')), 'not paused').toEqual([]);
  });
});
