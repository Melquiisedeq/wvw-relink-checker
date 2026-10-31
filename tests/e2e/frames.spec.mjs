// How often the page, standing still and watched, asks the screen for a frame. An
// infinite CSS animation draws one at every beat of the monitor, which stutters a
// video playing in another window; on the embers' clock (js/boot.js) the page draws
// only when the embers do. The frame limit is lifted here, so a looping animation
// left on CSS draws as fast as the machine goes, well past the embers. Counted
// against the embers' own frames, not the second: a busy machine slows both.
import { test, expect } from './support/fixtures.mjs';
import { load } from './support/steps.mjs';

const ARGS = ['--disable-frame-rate-limit', '--disable-gpu-vsync'];
test.use({
  viewport: { width: 1280, height: 800 }, locale: 'en-US',
  launchOptions: [async ({ launchOptions }, use) => use({ ...launchOptions, args: [...(launchOptions.args || []), ...ARGS] }), { scope: 'worker' }],
});

// Frames drawn by the compositor over `ms`, and how many animation frames drew embers.
async function count(page, ms) {
  const cdp = await page.context().newCDPSession(page);
  let drawn = 0;
  cdp.on('Tracing.dataCollected', d => { for (const e of d.value) if (e.name === 'DrawFrame') drawn++; });
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline.frame'] } });
  const embers0 = await page.evaluate(() => window.__emberFrames);
  await page.waitForTimeout(ms);
  const embers = (await page.evaluate(() => window.__emberFrames)) - embers0;
  const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  return { drawn, embers };
}

test('standing still and watched, the page draws only when the embers do', async ({ page, wvw }) => {
  await page.addInitScript(() => {
    let tick = 0, counted = -1;
    window.__emberFrames = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = cb => raf(t => { tick++; cb(t); });
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) {
      if (this.canvas && this.canvas.id === 'fxEmbers' && counted !== tick) { counted = tick; window.__emberFrames++; }
      return draw.apply(this, a);
    };
  });
  await load(page, wvw);
  await page.waitForTimeout(1500);

  const running = await count(page, 3000);
  const line = `${running.drawn} frames drawn for ${running.embers} ember frames in 3 s`;
  test.info().annotations.push({ type: 'frames', description: line });
  console.log('frames.spec: ' + line);
  expect(running.embers, 'the embers drawing (the count works)').toBeGreaterThan(30);
  expect(running.drawn, 'frames drawn: the trace works').toBeGreaterThan(0);
  // About one a frame of embers; a looping animation on CSS draws two or more.
  expect.soft(running.drawn, `${line}: about one per ember frame`).toBeLessThan(1.5 * running.embers);

  // The clock stopped by hand: whatever still draws is moving on its own.
  await page.evaluate(() => emberField.stop());
  await page.waitForTimeout(300);
  const still = await count(page, 2000);
  console.log(`frames.spec: ${still.drawn} frames drawn in 2 s with the clock stopped`);
  expect(still.drawn, 'frames drawn in 2 s with the clock stopped').toBeLessThan(20);
});
