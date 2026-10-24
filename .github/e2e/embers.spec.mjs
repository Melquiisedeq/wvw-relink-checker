// The embers draw only while the page is being watched: losing focus or hiding
// the tab stops the canvas drawing and marks the page is-idle (which pauses the
// CSS animations), and coming back starts both again. Reduced motion stops the
// looping ones the same way and leaves the run-once ones playing.
import { test, expect } from './support/fixtures.mjs';
import { load, search } from './support/steps.mjs';

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

test('reduced motion stops the looping animations and the canvas, and follows the setting live', async ({ page, wvw }) => {
  await page.addInitScript(() => {
    window.__emberDraws = 0;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) {
      if (this.canvas && this.canvas.id === 'fxEmbers') window.__emberDraws++;
      return draw.apply(this, a);
    };
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page, wvw);
  const draws = () => page.evaluate(() => window.__emberDraws);
  const quiet = async () => { await page.waitForTimeout(150); const n = await draws(); await page.waitForTimeout(350); return (await draws()) - n; };
  // The loading indicators (.spinner, .btn-pips) are the exception: they keep turning.
  const looping = () => page.evaluate(() => document.getAnimations()
    .filter(a => a.effect.getComputedTiming().iterations === Infinity && !a.effect.target.closest('.spinner, .btn-pips'))
    .map(a => a.playState));

  const stopped = await looping();
  expect(stopped.length, 'looping animations on the page').toBeGreaterThan(0);
  expect(stopped.every(s => s === 'paused'), 'all looping animations paused').toBe(true);
  expect(await quiet(), 'drawing with reduced motion').toBe(0);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect((await looping()).every(s => s === 'running'), 'looping animations running again').toBe(true);
  expect(await quiet(), 'drawing after the setting is lifted').toBeGreaterThan(5);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await looping()).every(s => s === 'paused'), 'paused again').toBe(true);
  expect(await quiet(), 'drawing after the setting returns').toBe(0);
});

test('reduced motion leaves the run-once animations playing: the found strip shows', async ({ page, wvw }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page, wvw);
  await search(page, wvw.guilds);
  const strip = page.locator('.guild-found-strip');
  await expect(strip).toBeAttached();
  await expect.poll(() => strip.evaluate(e => getComputedStyle(e).opacity), { message: 'the strip fading in' }).toBe('1');
  const paused = await page.evaluate(() => document.getAnimations()
    .filter(a => a.effect.getComputedTiming().iterations !== Infinity && a.playState === 'paused').length);
  expect(paused, 'paused run-once animations').toBe(0);
});

test('reduced motion: a blast still plays, then the field stops again', async ({ page, wvw }) => {
  await page.addInitScript(() => {
    window.__emberDraws = 0;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) {
      if (this.canvas && this.canvas.id === 'fxEmbers') window.__emberDraws++;
      return draw.apply(this, a);
    };
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page, wvw);
  const draws = () => page.evaluate(() => window.__emberDraws);
  await page.waitForTimeout(300);
  const before = await draws();
  await page.evaluate(() => emberField.blast());
  await page.waitForTimeout(500);
  expect((await draws()) - before, 'drawing during the blast').toBeGreaterThan(5);
  await page.waitForTimeout(2500);
  const after = await draws();
  await page.waitForTimeout(400);
  expect((await draws()) - after, 'drawing once the sparks are gone').toBe(0);
});
