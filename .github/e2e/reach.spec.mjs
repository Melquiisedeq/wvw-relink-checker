// Popovers and the map by hand and by finger: a click outside closes and one
// inside does not; the guilds popover expands and shrinks back leaving
// nothing over the page; on a phone a tap opens and closes, the popover
// follows its icon when the page scrolls, and the trebuchet does not aim at
// a finger; the map zooms and pans by buttons, wheel and drag.
import { test, expect } from './support/fixtures.mjs';
import { load, firstTier, openMap } from './support/steps.mjs';

test.describe.configure({ timeout: 60 * 1000 });
const POP = '.info-popover';
const GUILDS = '.server-guilds-btn';

// The first icon of that kind a visitor can see, and its popover opened with
// the content loaded.
async function openGuilds(page, wvw, tap) {
  await load(page, wvw);
  const btn = page.locator(GUILDS).locator('visible=true').first();
  await expect(btn).toBeVisible();
  if (tap) await btn.tap(); else await btn.click();
  await expect(page.locator(`${POP} .info-popover-body`).first()).toBeAttached();
  await wvw.settle();
  return btn;
}
const state = (page, btn) => btn.evaluate(b => ({
  pops: document.querySelectorAll('.info-popover').length,
  backdrops: document.querySelectorAll('.info-popover-backdrop').length,
  expanded: !!document.querySelector('.info-popover--expanded'),
  active: b.classList.contains('active'), aria: b.getAttribute('aria-expanded') }));
const CLOSED = { pops: 0, backdrops: 0, expanded: false, active: false, aria: 'false' };
const OPEN = { pops: 1, backdrops: 0, expanded: false, active: true, aria: 'true' };

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

  test('a click outside closes the popover and keeps the caret; a click inside does not', async ({ page, wvw }) => {
    // Tall enough that the guild box needs no scrolling to be clicked: a scroll
    // would close the popover by itself and the click would prove nothing.
    await page.setViewportSize({ width: 1280, height: 2000 });
    const btn = await openGuilds(page, wvw);
    expect(await page.locator('#guildInput').evaluate(i => i.getBoundingClientRect().bottom < innerHeight), 'the guild box in view').toBe(true);
    expect(await state(page, btn)).toEqual(OPEN);
    for (const inside of [`${POP} .info-popover-header span`, `${POP} .info-popover-body`]) {
      await page.locator(inside).first().click();
      expect(await state(page, btn), `after a click on ${inside}`).toEqual(OPEN);
    }
    await page.locator('#guildInput').click();
    expect(await state(page, btn), 'after a click on the guild box').toEqual(CLOSED);
    expect(await page.evaluate(() => document.activeElement.id), 'the caret stays where it was clicked').toBe('guildInput');
    // And again, with a click on blank page.
    await btn.click();
    await expect(page.locator(POP)).toHaveCount(1);
    await page.mouse.click(4, 4);
    expect(await state(page, btn), 'after a click on the page margin').toEqual(CLOSED);
  });

  test('the icon toggles, Escape closes and hands focus back, a reopen is a fresh popover', async ({ page, wvw }) => {
    const btn = await openGuilds(page, wvw);
    await btn.click();
    expect(await state(page, btn), 'the icon pressed again').toEqual(CLOSED);
    await btn.click();
    await expect(page.locator(POP)).toHaveCount(1);
    await page.keyboard.press('Escape');
    expect(await state(page, btn), 'Escape').toEqual(CLOSED);
    expect(await btn.evaluate(b => b === document.activeElement), 'focus back on the icon').toBe(true);
  });

  test('expand and shrink: the backdrop comes and goes, the popover goes back beside its icon', async ({ page, wvw }) => {
    const btn = await openGuilds(page, wvw);
    const expand = page.locator(`${POP} .info-popover-expand`);
    const aria = () => expand.getAttribute('aria-label');
    const before = await page.locator(POP).boundingBox();
    expect(await aria()).toMatch(/^Expand/);

    await expand.click();
    expect(await state(page, btn), 'expanded').toEqual({ ...OPEN, expanded: true, backdrops: 1 });
    expect(await aria(), 'the button now offers to shrink').toMatch(/^Shrink/);
    const wide = await page.locator(POP).boundingBox();
    expect(wide.width, 'the expanded popover is wider').toBeGreaterThan(before.width);
    expect(await page.evaluate(() => document.elementFromPoint(5, 5).className), 'the backdrop covers the page').toContain('info-popover-backdrop');

    await expand.click();
    expect(await state(page, btn), 'shrunk').toEqual(OPEN);
    expect(await aria()).toMatch(/^Expand/);
    const after = await page.locator(POP).boundingBox();
    expect(Math.abs(after.width - before.width), 'the width it had').toBeLessThan(2);
    const rect = await btn.boundingBox();
    const vw = 1280, vh = 800;
    const wantLeft = Math.max(12, Math.min(rect.x, vw - after.width - 12));
    expect(Math.abs(after.x - wantLeft), `left: ${after.x}, wanted ${wantLeft}`).toBeLessThan(2);
    expect(await page.evaluate(() => {
      const hits = new Set();
      for (let x = 2; x < innerWidth; x += 160) for (let y = 2; y < innerHeight; y += 100) hits.add(document.elementFromPoint(x, y)?.className);
      return [...hits].filter(c => String(c).includes('backdrop'));
    }), 'nothing left over the page').toEqual([]);
    // The page answers again: a click on a control outside works and closes it.
    await page.locator('#guildInput').click();
    expect(await state(page, btn)).toEqual(CLOSED);
  });

  test('Enter four times on the expand button, Space, Escape, reopen: one backdrop at a time', async ({ page, wvw }) => {
    const btn = await openGuilds(page, wvw);
    const expand = page.locator(`${POP} .info-popover-expand`);
    await expand.focus();
    for (const want of [1, 0, 1, 0]) {
      await page.keyboard.press('Enter');
      expect((await state(page, btn)).backdrops, 'backdrops after Enter on the expand button').toBe(want);
    }
    await page.keyboard.press(' ');
    expect((await state(page, btn)).expanded, 'Space expands').toBe(true);
    await page.keyboard.press('Escape');
    expect(await state(page, btn), 'Escape from the expanded popover').toEqual(CLOSED);
    await btn.click();
    await expect(page.locator(POP)).toHaveCount(1);
    expect(await state(page, btn), 'reopened: not expanded, no backdrop').toEqual(OPEN);
  });

  test('expanded: a click on the backdrop closes everything; so does the ×', async ({ page, wvw }) => {
    const btn = await openGuilds(page, wvw);
    await page.locator(`${POP} .info-popover-expand`).click();
    await page.locator(`${POP} .info-popover-body`).first().click();
    expect((await state(page, btn)).expanded, 'a click inside keeps it').toBe(true);
    await page.mouse.click(5, 5);
    expect(await state(page, btn), 'the backdrop clicked').toEqual(CLOSED);
    await btn.click();
    await page.locator(`${POP} .info-popover-expand`).click();
    await page.locator(`${POP} .info-popover-close`).click();
    expect(await state(page, btn), 'the ×').toEqual(CLOSED);
  });

  test("a tier's map, opened expanded: the backdrop closes it, nothing stays over the page", async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    await openMap(page, wvw, tier.button);
    expect(await state(page, tier.button)).toEqual({ ...OPEN, expanded: true, backdrops: 1 });
    await page.mouse.click(5, 5);
    expect(await state(page, tier.button)).toEqual(CLOSED);
  });
});

// A phone: touch on, mobile on, 390 x 844.
test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' });

  test('a tap opens, a tap outside closes, a tap inside does not; no round is thrown', async ({ page, wvw }) => {
    const btn = await openGuilds(page, wvw, true);
    expect(await state(page, btn)).toEqual(OPEN);
    await page.locator(`${POP} .info-popover-header span`).tap();
    expect(await state(page, btn), 'a tap inside').toEqual(OPEN);
    await page.locator('#guildInput').tap();
    expect(await state(page, btn), 'a tap on the guild box').toEqual(CLOSED);
    // Watched from before the tap to after the round would have landed.
    const watch = () => page.evaluate(() => {
      window.__shots = { shot: false, firing: false };
      new MutationObserver(() => {
        if (document.querySelector('.siege-shot, .shot-bloom')) window.__shots.shot = true;
        if (document.getElementById('trebuchet').classList.contains('firing')) window.__shots.firing = true;
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
    });
    await watch();
    await page.touchscreen.tap(6, 6);
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => window.__shots), 'a tap throws no round, at any moment').toEqual({ shot: false, firing: false });
    // The same watch sees a mouse click throw one.
    await page.mouse.click(6, 6);
    await expect.poll(() => page.evaluate(() => window.__shots), { message: 'a click throwing a round' }).toEqual({ shot: true, firing: true });
  });

  test('scrolling the page, the popover follows its icon; the icon gone, it closes', async ({ page, wvw }) => {
    await load(page, wvw);
    const btn = page.locator(GUILDS).locator('visible=true').first();
    await btn.evaluate(b => window.scrollTo(0, b.getBoundingClientRect().top + scrollY - 90));
    await wvw.settle();
    await btn.tap();
    await expect(page.locator(`${POP} .info-popover-body`).first()).toBeAttached();
    // Where the page's rule puts a popover for this icon (below it when it fits,
    // else above, and never off the screen) against where it is.
    const beside = () => page.evaluate(() => {
      const p = document.querySelector('.info-popover')?.getBoundingClientRect();
      const t = document.querySelector('.server-guilds-btn.active')?.getBoundingClientRect();
      if (!p || !t) return null;
      const vh = window.visualViewport.height;
      const top = vh - t.bottom >= p.height + 12 ? t.bottom + 6 : t.top - p.height - 6;
      return { trigger: Math.round(t.top), off: Math.round(Math.abs(p.top - Math.max(12, Math.min(top, vh - p.height - 12)))) };
    });
    const first = await beside();
    expect(first.off, 'placed by the rule when opened').toBeLessThanOrEqual(2);
    const y0 = await page.evaluate(() => scrollY);
    await page.evaluate(() => window.scrollBy(0, 60));
    expect(await page.evaluate(() => scrollY), 'the page scrolled').toBeGreaterThan(y0);
    // The icon has moved and the popover stands where the rule puts it for the new place.
    await expect.poll(async () => {
      const now = await beside();
      return !!now && now.trigger !== first.trigger && now.off <= 2;
    }, { message: 'the popover following its icon to its new place' }).toBe(true);
    await page.evaluate(() => window.scrollBy(0, 4000));
    await expect(page.locator(POP), 'the icon out of sight').toHaveCount(0);
    expect((await state(page, btn)).active).toBe(false);
  });

  test('a finger does not aim the trebuchet; a mouse does', async ({ page, wvw }) => {
    await load(page, wvw);
    const aim = () => page.evaluate(() => {
      const t = document.getElementById('trebuchet');
      return { yaw: t.style.getPropertyValue('--yaw'), arm: document.getElementById('trebArm').style.transform };
    });
    const rest = await aim();
    // A finger's moves as the page hears them: a swipe sideways in the emulator
    // would be taken for the browser's own back gesture and leave the page, so
    // the pointer events are dispatched, with the type a finger gives them.
    await page.evaluate(() => {
      for (const [x, y] of [[100, 300], [200, 200], [350, 100]]) {
        window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', clientX: x, clientY: y, bubbles: true }));
      }
    });
    await page.waitForTimeout(300);
    expect(await aim(), 'the beam and frame after a finger dragged across the screen').toEqual(rest);
    await page.mouse.move(380, 20);
    await page.mouse.move(370, 30);
    await expect.poll(async () => (await aim()).yaw, { message: 'a mouse aiming it' }).not.toBe(rest.yaw);
  });
});

test.describe('the map: zoom and drag', () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true, locale: 'en-US' });
  const view = page => page.locator(`${POP} .wvw-plot`).evaluate(s => s.getAttribute('viewBox').split(' ').map(Number));
  async function map(page, wvw) {
    await load(page, wvw);
    const tier = await firstTier(page);
    await openMap(page, wvw, tier.button);
    return view(page);
  }
  const zoom = (page, name) => page.locator(`${POP} .wvw-zoom button[aria-label="${name}"]`);

  test('the buttons zoom in and out and recentre; the wheel zooms; a drag pans', async ({ page, wvw }) => {
    const full = await map(page, wvw);
    await zoom(page, 'Zoom in').click();
    const inn = await view(page);
    expect(inn[2], 'zoom in narrows the view by 1.35').toBeCloseTo(full[2] / 1.35, 0);
    await zoom(page, 'Zoom in').click();
    const twice = await view(page);
    expect(twice[2]).toBeLessThan(inn[2]);
    await zoom(page, 'Zoom out').click();
    expect((await view(page))[2], 'zoom out widens it again').toBeCloseTo(inn[2], 0);
    await zoom(page, 'Recentre the map').click();
    expect(await view(page), 'recentre is the whole map').toEqual(full);

    const box = await page.locator(`${POP} .wvw-plot-wrap`).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -300);
    await expect.poll(async () => (await view(page))[2], { message: 'the wheel zooming in' }).toBeLessThan(full[2]);
    await page.mouse.wheel(0, 3000);
    await expect.poll(async () => (await view(page))[2], { message: 'the wheel zooming out to the whole map' }).toBe(full[2]);

    for (let i = 0; i < 3; i++) await zoom(page, 'Zoom in').click();
    const z = await view(page);
    // Grab empty ground at the centre and pull it right and down: the view moves left and up.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 30, { steps: 4 });
    await page.mouse.move(cx + 80, cy + 60, { steps: 4 });
    await page.mouse.up();
    const panned = await view(page);
    expect(panned[2], 'a drag does not change the zoom').toBeCloseTo(z[2], 3);
    expect(panned[0], 'dragged right: the view moves left').toBeLessThan(z[0]);
    expect(panned[1], 'dragged down: the view moves up').toBeLessThan(z[1]);
    await wvw.settle();
  });

  test('a finger: tap to zoom, drag to pan', async ({ page, wvw, context }) => {
    await map(page, wvw);
    for (let i = 0; i < 3; i++) await zoom(page, 'Zoom in').tap();
    const z = await view(page);
    await expect(page.locator(`${POP} .wvw-plot-wrap`)).toHaveClass(/is-zoomed/);
    const box = await page.locator(`${POP} .wvw-plot-wrap`).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const t = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await t('touchStart', cx, cy);
    for (let i = 1; i <= 6; i++) await t('touchMove', cx + i * 12, cy + i * 8);
    await t('touchEnd');
    await expect.poll(async () => (await view(page))[0], { message: 'a finger dragging the map right' }).toBeLessThan(z[0]);
    expect((await view(page))[1]).toBeLessThan(z[1]);
    await wvw.settle();
  });
});
