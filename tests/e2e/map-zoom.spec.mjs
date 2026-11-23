// The map zooms and pans by buttons, wheel and drag.
import { test, expect } from './support/fixtures.mjs';
import { load, firstTier, openMap } from './support/steps.mjs';

test.describe.configure({ timeout: 60 * 1000 });
const POP = '.info-popover';

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

  test('the click of a drag that began on a marker is swallowed even when a timer runs before it, and a later click still picks', async ({ page, wvw }) => {
    await map(page, wvw);
    for (let i = 0; i < 3; i++) await zoom(page, 'Zoom in').click();
    const marker = page.locator(`${POP} .wvw-marker`).locator('visible=true').first();
    const handle = await marker.elementHandle();
    const selected = page.locator(`${POP} .wvw-marker.is-selected`);
    const press = (after) => handle.evaluate(async (el, wait) => {
      const b = el.getBoundingClientRect();
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      const pe = (type, dx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x + dx, clientY: y }));
      pe('pointerdown', 0);
      pe('pointermove', 10);
      pe('pointerup', 10);
      await new Promise((r) => setTimeout(r, wait));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, after);
    await press(0);
    await expect(selected, 'a timer ran between the pointerup and its click: still swallowed').toHaveCount(0);
    await press(300);
    await expect(selected, 'a click long after a drag is not the drag\'s').toHaveCount(1);
    await wvw.settle();
  });
});
