// The pulsing rings on a map's markers (missedRingMark, js/maps.js): while they
// pulse, the maps popover is not repainted on every frame (css/maps.css gives it
// its outer shadow as a filter), each ring stays centred on its icon through a
// zoom, a drag and a scrolled popover, and none outlives its map, closed or
// swapped for another tier's.
//
// LayerTree is an experimental CDP domain: a test that breaks after a Chrome
// update points at the domain first, not at the page.
import { test, expect } from './support/fixtures.mjs';
import { load, firstTier, openMap, frame } from './support/steps.mjs';

const POP = '.info-popover--maps';
test.describe.configure({ timeout: 90000 });

// Rings on the first `n` objectives of the open map, for `ms`, as a return after
// a gap leaves them (missedRingFor in js/maps-early.js).
const ring = (page, n = 3, ms = 60000) => page.evaluate(([n, ms]) => {
  const wrap = document.querySelector('.info-popover--maps .wvw-plot-wrap');
  const ids = [...wrap.querySelectorAll('.wvw-marker[data-obj]')].map(g => g.dataset.obj).slice(0, n);
  missedRings.set(missedOpen.matchId, { ids: new Set(ids), until: Date.now() + ms });
  wrap.ringChanged();
  return ids;
}, [n, ms]);

// Each ringed marker: how far, in CSS px, its ring's centre is from its icon's.
const offsets = page => page.evaluate(sel => [...document.querySelectorAll(`${sel} .wvw-marker`)]
  .filter(g => g.querySelector('.wvw-ring'))
  .map(g => {
    const c = b => [(b.left + b.right) / 2, (b.top + b.bottom) / 2];
    const [rx, ry] = c(g.querySelector('.wvw-ring-a').getBoundingClientRect());
    const [ix, iy] = c(g.querySelector('.pip').getBoundingClientRect());
    return { obj: g.dataset.obj, off: Math.round(Math.hypot(rx - ix, ry - iy) * 10) / 10 };
  }), POP);

const ringTimes = page => page.evaluate(() => document.getAnimations()
  .filter(a => a.animationName === 'wvw-ring').map(a => Number(a.currentTime)));

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });

test('the rings pulse without the maps popover being repainted on every frame', async ({ page, wvw, context }) => {
  await load(page, wvw);
  // From the keyboard: opened with a mouse click, the popover's layers fall out so that a
  // box-shadow costs nothing, and this test would prove nothing.
  await page.locator('.tier-map-btn').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(".info-popover .wvw-plot g[role='button']").first()).toBeAttached();
  await wvw.settle();

  const cdp = await context.newCDPSession(page);
  let layers = [];
  let reports = 0;
  cdp.on('LayerTree.layerTreeDidChange', e => {
    if (!e.layers) return;
    layers = e.layers;
    if (e.layers.some(l => typeof l.paintCount === 'number')) reports++;
  });
  await cdp.send('DOM.enable');
  const root = (await cdp.send('DOM.getDocument', { depth: 0 })).root.nodeId;
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root, selector: POP });
  const popover = (await cdp.send('DOM.describeNode', { nodeId })).node.backendNodeId;
  await cdp.send('LayerTree.enable');
  await expect.poll(() => layers.length, { message: 'LayerTree reported no layers' }).toBeGreaterThan(0);

  // paintCount per layer, from the tree's reports (layerPainted is not sent here).
  const own = () => layers.filter(l => l.backendNodeId === popover);
  const paints = () => own().reduce((n, l) => n + (l.paintCount || 0), 0);
  // The map just drawn: the popover quiet before the rings start.
  let last = -1;
  await expect.poll(() => { const n = paints(); const still = own().length > 0 && n === last; last = n; return still; },
    { message: 'the popover stopped painting after the map was drawn', intervals: [300], timeout: 15000 }).toBe(true);
  reports = 0;
  const before = new Map(own().map(l => [l.layerId, l.paintCount]));
  const ids = await ring(page);
  expect(ids, 'objectives ringed').toHaveLength(3);
  await frame(page);
  const t0 = await ringTimes(page);
  await page.waitForTimeout(1500);
  const t1 = await ringTimes(page);
  const after = own();
  const repaints = Math.max(0, ...after.map(l => l.paintCount - (before.get(l.layerId) || 0)));
  await cdp.send('LayerTree.disable');

  expect(after.length, 'the popover draws into layers of its own').toBeGreaterThan(0);
  // Without fresh paint counts the ceiling below would hold for nothing.
  expect(reports, 'layer tree reports with paint counts during the rings').toBeGreaterThan(0);
  expect(after.every(l => typeof l.paintCount === 'number'), 'a paint count on each popover layer').toBe(true);
  // Moved on by the embers' clock (js/boot.js), as every animation on the page.
  expect(t1.length, 'two circles pulsing on each of three markers').toBe(6);
  expect(t1.every((t, i) => t > t0[i] + 1000), `the rings pulsed on through the 1.5 s (${t0} -> ${t1})`).toBe(true);
  // About 30 frames in 1.5 s; one repaint of the popover per frame is the cost this guards.
  expect(repaints, `the maps popover's busiest layer repainted ${repaints} times in 1.5 s of rings`).toBeLessThanOrEqual(2);
});

test('a ring stays on its icon through a zoom, a drag and a scrolled popover', async ({ page, wvw }) => {
  // Narrow enough that the map stacks over the side panel and the popover scrolls.
  await page.setViewportSize({ width: 700, height: 900 });
  await load(page, wvw);
  await openMap(page, wvw, (await firstTier(page)).button);
  await ring(page);
  await frame(page);
  const check = async (when) => {
    const got = await offsets(page);
    expect(got, `rings ${when}`).toHaveLength(3);
    for (const { obj, off } of got) expect(off, `the ring on ${obj}, px from its icon's centre, ${when}`).toBeLessThanOrEqual(3);
    return got;
  };
  await check('as drawn');

  await page.locator(`${POP} .wvw-zoom button[aria-label="Zoom in"]`).click();
  await page.locator(`${POP} .wvw-zoom button[aria-label="Zoom in"]`).click();
  await expect(page.locator(`${POP} .wvw-plot-wrap`)).toHaveClass(/is-zoomed/);
  await frame(page);
  await check('after a zoom');

  // A drag from an empty spot of the map (a marker takes the press for itself).
  const box = await page.locator(`${POP} .wvw-plot-wrap`).boundingBox();
  const start = await page.evaluate(([sel, b]) => {
    for (let fy = 0.3; fy < 0.8; fy += 0.05) for (let fx = 0.3; fx < 0.8; fx += 0.05) {
      const x = b.x + b.width * fx, y = b.y + b.height * fy;
      const e = document.elementFromPoint(x, y);
      if (e && e.closest(`${sel} .wvw-plot-wrap`) && !e.closest('.wvw-marker, .wvw-zoom, .wvw-hud, .wvw-hud-note')) return [x, y];
    }
    return null;
  }, [POP, box]);
  expect(start, 'an empty spot on the map to drag from').not.toBeNull();
  const before = await page.evaluate(sel => document.querySelector(`${sel} .wvw-ring-a`).getBoundingClientRect().left, POP);
  await page.mouse.move(...start);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(start[0] + i * 6, start[1] + i * 4);
  await page.mouse.up();
  await frame(page);
  const after = await page.evaluate(sel => document.querySelector(`${sel} .wvw-ring-a`).getBoundingClientRect().left, POP);
  expect(Math.abs(after - before), 'the drag moved the map, its rings with it').toBeGreaterThan(10);
  await check('after a drag');

  const scrolled = await page.evaluate(sel => { const p = document.querySelector(sel); p.scrollTop = 120; return p.scrollTop; }, POP);
  expect(scrolled, 'the maps popover scrolls at this height').toBeGreaterThan(0);
  await frame(page);
  await check('with the popover scrolled');
});

test('no ring outlives its map: closed, or swapped for another tier\'s', async ({ page, wvw }) => {
  await load(page, wvw);
  await openMap(page, wvw, (await firstTier(page)).button);
  await ring(page);
  await expect(page.locator('.wvw-ring'), 'rings on the open map').toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.locator(POP), 'the map closed').toHaveCount(0);
  await expect(page.locator('.wvw-ring'), 'rings once the map is closed').toHaveCount(0);

  // Another tier: the maps open over a backdrop, so the way there is through a close.
  await openMap(page, wvw, (await firstTier(page)).button);
  await expect(page.locator('.wvw-ring'), 'rings on the map opened again, their time not yet out').toHaveCount(3);
  await page.keyboard.press('Escape');
  await openMap(page, wvw, (await firstTier(page, page.locator('.tier-map-btn').nth(1))).button);
  await expect(page.locator(POP), 'one map open').toHaveCount(1);
  await expect(page.locator('.wvw-ring'), 'rings once another tier\'s map took its place').toHaveCount(0);
});
