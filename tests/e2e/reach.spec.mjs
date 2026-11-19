// Popovers and the map by hand and by finger: a click outside closes and one
// inside does not; the guilds popover expands and shrinks back leaving
// nothing over the page; on a phone a tap opens and closes, the popover
// follows its icon when the page scrolls, and the trebuchet does not aim at
// a finger; the map zooms and pans by buttons, wheel and drag.
import { test, expect } from './support/fixtures.mjs';
import { load, firstTier, openMap, search } from './support/steps.mjs';

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
    // Tall enough that the guild box needs no scrolling to be clicked: scrolling, the popover held at an edge could cover the box and the click would land inside it.
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
    expect(await page.evaluate(() => [...document.body.children].filter(e => e.inert).length), 'the page answers again after shrinking').toBe(0);
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
    // The popover stays through any scroll and may cover the box: tap the margin beside it.
    const margin = await page.evaluate(() => { const p = document.querySelector('.info-popover').getBoundingClientRect(); return { x: p.left / 2, y: p.top + p.height / 2 }; });
    await page.touchscreen.tap(margin.x, margin.y);
    expect(await state(page, btn), 'a tap outside').toEqual(CLOSED);
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

  test('scrolling the page, the popover follows its icon; the icon gone, it stays open at the edge', async ({ page, wvw }) => {
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
    // The icon out of sight above: the popover stays, clamped to the top edge (the rule gives 12 px).
    await expect.poll(async () => {
      const now = await beside();
      return !!now && now.trigger < -40 && now.off <= 2;
    }, { message: 'the popover held at the edge, the icon out of sight' }).toBe(true);
    await expect(page.locator(POP), 'the popover stays open').toHaveCount(1);
    expect((await state(page, btn)).active).toBe(true);
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

  test('in a short window a drag moves the drawing as far as the cursor, and the wheel keeps its point', async ({ page, wvw }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await map(page, wvw);
    for (let i = 0; i < 3; i++) await zoom(page, 'Zoom in').click();
    const plot = await page.locator(`${POP} .wvw-plot`).boundingBox();
    const markers = page.locator(`${POP} .wvw-marker`).locator('visible=true');
    let marker = null;
    for (const m of await markers.all()) {
      const b = await m.boundingBox();
      if (b && b.x > plot.x + 60 && b.x < plot.x + plot.width - 160 && b.y > plot.y + 60 && b.y < plot.y + plot.height - 160) { marker = m; break; }
    }
    expect(marker, 'a marker well inside the view').not.toBeNull();
    const before = await marker.boundingBox();
    // Grab the ground beside the marker.
    const gx = before.x - 30, gy = before.y - 30;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx + 50, gy + 50, { steps: 5 });
    await page.mouse.move(gx + 100, gy + 100, { steps: 5 });
    await page.mouse.up();
    const after = await marker.boundingBox();
    expect(Math.abs(after.x - before.x - 100), 'dragged 100 px right').toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y - 100), 'dragged 100 px down').toBeLessThanOrEqual(1);

    const px = after.x + after.width / 2, py = after.y + after.height / 2;
    const wBefore = (await view(page))[2];
    await page.mouse.move(px, py);
    await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await view(page))[2], { message: 'the wheel zooming in' }).toBeLessThan(wBefore);
    await wvw.settle();
    const zoomed = await marker.boundingBox();
    expect(Math.abs(zoomed.x + zoomed.width / 2 - px), 'the marker stays under the cursor (x)').toBeLessThanOrEqual(1);
    expect(Math.abs(zoomed.y + zoomed.height / 2 - py), 'the marker stays under the cursor (y)').toBeLessThanOrEqual(1);
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

  // Two fingers by hand: CDP touch points with ids, so a finger can lift while the other stays.
  const fingers = async (page, context) => {
    const cdp = await context.newCDPSession(page);
    let pts = [];
    const send = type => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(p => ({ ...p })) });
    return {
      down: async (...ps) => { pts = ps.map(([x, y], i) => ({ x, y, id: i + 1 })); await send('touchStart'); },
      move: async (...ps) => { pts = ps.map(([x, y], i) => ({ x, y, id: pts[i].id })); await send('touchMove'); },
      // touchEnd lists the points that lift.
      lift: async i => { const gone = pts[i]; await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ ...gone }] }); pts = pts.filter((_, j) => j !== i); },
      up: async () => { pts = []; await send('touchEnd'); },
    };
  };
  // The map point under a client point, through the SVG's own matrix.
  const under = (page, x, y) => page.locator(`${POP} .wvw-plot`).evaluate((s, [px, py]) => {
    const p = new DOMPoint(px, py).matrixTransform(s.getScreenCTM().inverse());
    return [p.x, p.y];
  }, [x, y]);

  test('two fingers zoom about the point between them, in and out, and carry the map with them', async ({ page, wvw, context }) => {
    const full = await map(page, wvw);
    const box = await page.locator(`${POP} .wvw-plot-wrap`).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const f = await fingers(page, context);
    const ground = await under(page, cx, cy);
    const onScreen = g => page.locator(`${POP} .wvw-plot`).evaluate((s, [x, y]) => {
      const p = new DOMPoint(x, y).matrixTransform(s.getScreenCTM());
      return [p.x, p.y];
    }, g);
    await f.down([cx - 40, cy], [cx + 40, cy]);
    for (let i = 1; i <= 8; i++) await f.move([cx - 40 - i * 10, cy], [cx + 40 + i * 10, cy]);
    await expect.poll(async () => (await view(page))[2], { message: 'spreading the fingers three-fold zooms in three-fold' }).toBeLessThan(full[2] / 2.9);
    const zoomed = await view(page);
    await expect.poll(async () => { const q = await onScreen(ground); return Math.abs(q[0] - cx) + Math.abs(q[1] - cy); }, { message: 'the point between the fingers stays' }).toBeLessThanOrEqual(3);

    // Pinch back in, the middle drifting 15 px right and 10 down: the map goes with it.
    for (let i = 1; i <= 4; i++) await f.move([cx - 120 + i * 10 + i * 3.75, cy + i * 2.5], [cx + 120 - i * 10 + i * 3.75, cy + i * 2.5]);
    await expect.poll(async () => { const q = await onScreen(ground); return Math.abs(q[0] - (cx + 15)) + Math.abs(q[1] - (cy + 10)); }, { message: 'the ground follows the middle' }).toBeLessThanOrEqual(3);
    expect((await view(page))[2], 'closing the fingers zooms out').toBeGreaterThan(zoomed[2] * 1.3);

    // One finger alone going down 40 px moves the middle 20: the ground goes there, not stays under the still finger.
    await f.move([cx - 65, cy + 10], [cx + 95, cy + 50]);
    await f.up();
    await expect.poll(async () => {
      const q = await onScreen(ground);
      return Math.abs(q[0] - (cx + 15)) + Math.abs(q[1] - (cy + 30));
    }, { message: 'the ground follows the middle when only one finger moves' }).toBeLessThanOrEqual(4);
    await expect(page.locator(`${POP} .wvw-plot-wrap`), 'no capture left').not.toHaveClass(/is-panning/);
    await wvw.settle();
  });

  test('lifting one finger of a pinch leaves the other dragging without a jump; a pinch with a finger on a marker picks nothing', async ({ page, wvw, context }) => {
    await map(page, wvw);
    for (let i = 0; i < 3; i++) await zoom(page, 'Zoom in').click();
    const plot = await page.locator(`${POP} .wvw-plot`).boundingBox();
    const markers = page.locator(`${POP} .wvw-marker`).locator('visible=true');
    let marker = null;
    for (const m of await markers.all()) {
      const b = await m.boundingBox();
      if (b && b.x > plot.x + 60 && b.x < plot.x + plot.width - 220 && b.y > plot.y + 60 && b.y < plot.y + plot.height - 220) { marker = m; break; }
    }
    expect(marker, 'a marker well inside the view').not.toBeNull();
    const b0 = await marker.boundingBox();
    const mx = b0.x + b0.width / 2, my = b0.y + b0.height / 2;
    const centre = async () => { const b = await marker.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const f = await fingers(page, context);
    // One finger on the marker, one on empty ground to its left.
    await f.down([mx, my], [mx - 100, my]);
    for (let i = 1; i <= 4; i++) await f.move([mx, my], [mx - 100 - i * 5, my]);
    await f.lift(1);
    // The finger on the marker now holds the map: it must not jump, then it drags.
    await f.move([mx, my]);
    const still = await centre();
    expect(Math.abs(still.x - mx) + Math.abs(still.y - my), 'no jump when a finger lifts').toBeLessThanOrEqual(3);
    const lone = await centre();
    for (let i = 1; i <= 6; i++) await f.move([mx + i * 10, my + i * 5]);
    await f.up();
    await expect.poll(async () => { const c = await centre(); return Math.abs(c.x - lone.x - 60) + Math.abs(c.y - lone.y - 30); }, { message: 'the finger left drags on, by as much as it moved' }).toBeLessThanOrEqual(3);
    await expect(page.locator(`${POP} .wvw-marker.is-selected`), 'a pinch picks nothing').toHaveCount(0);
    await expect(page.locator(`${POP} .wvw-plot-wrap`), 'no capture left').not.toHaveClass(/is-panning/);
    await wvw.settle();
  });

  test('a pinch that ends on a marker picks nothing; a mouse moving while a finger drags does not take the map', async ({ page, wvw, context }) => {
    await map(page, wvw);
    for (let i = 0; i < 3; i++) await zoom(page, 'Zoom in').click();
    const plot = await page.locator(`${POP} .wvw-plot`).boundingBox();
    const markers = page.locator(`${POP} .wvw-marker`).locator('visible=true');
    let marker = null;
    for (const m of await markers.all()) {
      const b = await m.boundingBox();
      if (b && b.x > plot.x + 60 && b.x < plot.x + plot.width - 220 && b.y > plot.y + 60 && b.y < plot.y + plot.height - 220) { marker = m; break; }
    }
    expect(marker, 'a marker well inside the view').not.toBeNull();
    const b0 = await marker.boundingBox();
    const mx = b0.x + b0.width / 2, my = b0.y + b0.height / 2;
    const f = await fingers(page, context);
    await f.down([mx, my], [mx - 100, my]);
    await f.move([mx, my], [mx - 102, my]);
    await f.lift(1);
    await f.up();
    await wvw.settle();
    await expect(page.locator(`${POP} .wvw-marker.is-selected`), 'a pinch picks nothing').toHaveCount(0);

    // One finger drags 50 px; a mouse wandering across the map meanwhile is not the finger.
    const gx = plot.x + 40, gy = plot.y + 40;
    const m0 = await marker.boundingBox();
    await f.down([gx, gy]);
    for (let i = 1; i <= 5; i++) await f.move([gx + i * 10, gy]);
    await page.mouse.move(plot.x + plot.width - 40, plot.y + plot.height - 40);
    await f.move([gx + 50, gy]);
    await f.up();
    await expect.poll(async () => { const m = await marker.boundingBox(); return Math.round(m.x - m0.x); }, { message: 'the finger dragged the map' }).toBeGreaterThan(40);
    const m1 = await marker.boundingBox();
    expect(Math.abs(m1.x - m0.x - 50), 'by what the finger moved, the mouse not counted (x)').toBeLessThanOrEqual(2);
    expect(Math.abs(m1.y - m0.y), 'and not at all the other way').toBeLessThanOrEqual(2);
    await wvw.settle();
  });

  test('a finger that lifts outside the map, over a marker the map has just redrawn, leaves no ghost: the next finger does not pinch', async ({ page, wvw, context }) => {
    await map(page, wvw);
    const box = await page.locator(`${POP} .wvw-plot-wrap`).boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const f = await fingers(page, context);
    await f.down([cx - 40, cy], [cx + 40, cy]);
    await f.move([cx - 50, cy], [cx + 50, cy]);
    // A live update empties the element the second finger holds, as a redraw of a marker does.
    await page.evaluate(([x, y]) => document.elementFromPoint(x, y).remove(), [cx + 50, cy]);
    const out = box.x + box.width + 60;
    await f.move([cx - 50, cy], [out, cy]);
    await f.lift(1);
    await f.lift(0);
    const v1 = await view(page);
    await f.down([cx, cy]);
    for (let i = 1; i <= 5; i++) await f.move([cx + i * 10, cy]);
    await f.up();
    expect((await view(page))[2], 'and does not zoom').toBeCloseTo(v1[2], 3);
    await expect(page.locator(`${POP} .wvw-plot-wrap`), 'no capture left').not.toHaveClass(/is-panning/);
  });

  for (const how of ['mouse', 'finger']) test(`a ${how} drag that starts on a marker pans the map and picks nothing; a tap on it picks`, async ({ page, wvw, context }) => {
    await map(page, wvw);
    for (let i = 0; i < 3; i++) await zoom(page, 'Zoom in').click();
    const plot = await page.locator(`${POP} .wvw-plot`).boundingBox();
    const markers = page.locator(`${POP} .wvw-marker`).locator('visible=true');
    let marker = null;
    for (const m of await markers.all()) {
      const b = await m.boundingBox();
      if (b && b.x > plot.x + 60 && b.x < plot.x + plot.width - 220 && b.y > plot.y + 60 && b.y < plot.y + plot.height - 220) { marker = m; break; }
    }
    expect(marker, 'a marker well inside the view').not.toBeNull();
    const centre = async () => { const b = await marker.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
    const picked = page.locator(`${POP} .wvw-marker.is-selected`);
    const cdp = await context.newCDPSession(page);
    const t = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

    {
      const before = await centre();
      if (how === 'mouse') {
        await page.mouse.move(before.x, before.y);
        await page.mouse.down();
        await page.mouse.move(before.x + 50, before.y + 50, { steps: 5 });
        await page.mouse.move(before.x + 100, before.y + 100, { steps: 5 });
        await page.mouse.up();
      } else {
        await t('touchStart', before.x, before.y);
        for (let i = 1; i <= 10; i++) await t('touchMove', before.x + i * 10, before.y + i * 10);
        await t('touchEnd');
      }
      await expect.poll(async () => Math.round((await centre()).x - before.x), { message: `${how}: the map following the drag` }).toBeGreaterThan(90);
      const after = await centre();
      expect(Math.abs(after.x - before.x - 100), `${how}: dragged 100 px right`).toBeLessThanOrEqual(1);
      expect(Math.abs(after.y - before.y - 100), `${how}: dragged 100 px down`).toBeLessThanOrEqual(1);
      await expect(picked, `${how}: a drag does not pick the objective`).toHaveCount(0);
      await expect(page.locator(`${POP} .wvw-plot-wrap`), `${how}: no capture left`).not.toHaveClass(/is-panning/);

      const at = await centre();
      if (how === 'mouse') await page.mouse.click(at.x, at.y);
      else await page.touchscreen.tap(at.x, at.y);
      await expect(picked, `${how}: a tap picks the objective`).toHaveCount(1);
    }
    await wvw.settle();
  });

  test('a short finger drag from a marker, which Chrome still turns into a click, moves the map and picks nothing', async ({ page, wvw, context }) => {
    await map(page, wvw);
    for (let i = 0; i < 3; i++) await zoom(page, 'Zoom in').click();
    const plot = await page.locator(`${POP} .wvw-plot`).boundingBox();
    const markers = page.locator(`${POP} .wvw-marker`).locator('visible=true');
    let marker = null;
    for (const m of await markers.all()) {
      const b = await m.boundingBox();
      if (b && b.x > plot.x + 60 && b.x < plot.x + plot.width - 220 && b.y > plot.y + 60 && b.y < plot.y + plot.height - 220) { marker = m; break; }
    }
    expect(marker, 'a marker well inside the view').not.toBeNull();
    const b0 = await marker.boundingBox();
    const x0 = b0.x + b0.width / 2, y0 = b0.y + b0.height / 2;
    const cdp = await context.newCDPSession(page);
    const t = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await t('touchStart', x0, y0);
    for (let i = 1; i <= 5; i++) await t('touchMove', x0 + i * 2, y0);
    await t('touchEnd');
    await expect.poll(async () => { const b = await marker.boundingBox(); return Math.round(b.x + b.width / 2 - x0); }, { message: 'the map following the finger' }).toBeGreaterThan(5);
    await expect(page.locator(`${POP} .wvw-marker.is-selected`), 'the click that follows the drag picks nothing').toHaveCount(0);
    await wvw.settle();
  });
});

test('Ctrl+Enter in the guild box closes a result row\'s popover and leaves no active trigger', async ({ page, wvw }) => {
  await page.setViewportSize({ width: 1280, height: 2000 });
  await load(page, wvw);
  await search(page, wvw.guilds.slice(0, 1));
  await page.locator('#resultBody .server-guilds-btn').first().click();
  await expect(page.locator(POP)).toHaveCount(1);
  await page.locator('#guildInput').focus();
  await page.keyboard.press('Control+Enter');
  await expect(page.locator(POP)).toHaveCount(0);
  expect(await page.evaluate(() => activeTrigger), 'activeTrigger').toBeNull();
  await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 15000 });
  await wvw.settle();
});
