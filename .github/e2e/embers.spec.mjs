// The embers draw only while the page is being watched: losing focus or hiding
// the tab stops the canvas drawing and marks the page is-idle (which pauses the
// CSS animations), and coming back starts both again.
import { test, expect } from './support/fixtures.mjs';
import { load } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

test('embers stop drawing when focus or the tab is lost, and resume when it returns', async ({ page, wvw }) => {
  await page.addInitScript(() => {
    window.__emberDraws = 0;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) {
      if (this.canvas && this.canvas.id === 'fxEmbers') window.__emberDraws++;
      return draw.apply(this, a);
    };
  });
  await load(page, wvw);
  const draws = () => page.evaluate(() => window.__emberDraws);
  const idle = () => page.evaluate(() => document.documentElement.classList.contains('is-idle'));
  const watch = (focused, hidden) => page.evaluate(([f, h]) => {
    document.hasFocus = () => f;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, [focused, hidden]);
  // The count after the page has had time to settle and a frame to land.
  const quiet = async () => { await page.waitForTimeout(150); const n = await draws(); await page.waitForTimeout(350); return (await draws()) - n; };

  await watch(true, false);
  expect(await idle()).toBe(false);
  expect(await quiet(), 'drawing while watched').toBeGreaterThan(5);

  await watch(false, false);   // focus gone: a second monitor
  expect(await idle()).toBe(true);
  expect(await quiet(), 'drawing without focus').toBe(0);

  await watch(true, false);
  expect(await idle()).toBe(false);
  expect(await quiet(), 'drawing again after focus').toBeGreaterThan(5);

  await watch(true, true);     // the tab hidden
  expect(await idle()).toBe(true);
  expect(await quiet(), 'drawing in a hidden tab').toBe(0);

  await watch(true, false);
  expect(await quiet(), 'drawing after the tab is shown').toBeGreaterThan(5);
});

test('a burst of resize events reallocates the embers canvas once, at the final size', async ({ page, wvw }) => {
  await page.addInitScript(() => {
    window.__emberSizes = 0;
    const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', {
      configurable: true, get: d.get,
      set(v) { if (this.id === 'fxEmbers') window.__emberSizes++; d.set.call(this, v); },
    });
  });
  await load(page, wvw);
  await page.waitForTimeout(200);
  const r = await page.evaluate(async () => {
    const before = window.__emberSizes;
    for (let i = 0; i < 6; i++) window.dispatchEvent(new Event('resize'));
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    return window.__emberSizes - before;
  });
  expect(r).toBe(1);
  const c = await page.evaluate(() => {
    const k = document.getElementById('fxEmbers');
    return [k.width, Math.round(k.clientWidth * devicePixelRatio)];
  });
  expect(c[0]).toBe(c[1]);
});
