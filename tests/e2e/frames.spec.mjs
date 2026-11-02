// How often the page, standing still and watched, asks the screen for a frame. An
// infinite CSS animation draws one at every beat of the monitor, which stutters a
// video playing in another window; on the embers' clock (js/boot.js) the page draws
// only when the embers do. The frame limit is lifted here, so a looping animation
// left on CSS draws as fast as the machine goes, well past the embers. Counted
// against the embers' own frames, not the second: a busy machine slows both. A click's
// run-once effects (transitions, CSS animations, element.animate) ride the same clock while
// they last, and whatever stops it hands them back to play out.
import { test, expect } from './support/fixtures.mjs';
import { load, search } from './support/steps.mjs';

const ARGS = ['--disable-frame-rate-limit', '--disable-gpu-vsync'];
test.use({
  viewport: { width: 1280, height: 800 }, locale: 'en-US',
  launchOptions: [async ({ launchOptions }, use) => use({ ...launchOptions, args: [...(launchOptions.args || []), ...ARGS] }), { scope: 'worker' }],
});

// Frames drawn by the compositor over `ms`, and how many animation frames drew embers;
// `act` runs once the count has started.
async function count(page, ms, act) {
  const cdp = await page.context().newCDPSession(page);
  let drawn = 0;
  cdp.on('Tracing.dataCollected', d => { for (const e of d.value) if (e.name === 'DrawFrame') drawn++; });
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline.frame'] } });
  const embers0 = await page.evaluate(() => window.__emberFrames);
  const t0 = Date.now();
  if (act) await act();
  await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0)));
  const embers = (await page.evaluate(() => window.__emberFrames)) - embers0;
  const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.end');
  await done;
  await cdp.detach();
  return { drawn, embers };
}

const countEmberFrames = page => page.addInitScript(() => {
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

test('standing still and watched, the page draws only when the embers do', async ({ page, wvw }) => {
  await countEmberFrames(page);
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

test('a click draws only when the embers do: switching a map, opening and closing a popover', async ({ page, wvw }) => {
  await countEmberFrames(page);
  await load(page, wvw);
  await page.waitForTimeout(1500);
  const popover = page.locator('.info-popover');
  const clicks = {
    'opening a map': () => page.locator('.tier-map-btn').first().click(),
    'switching the map': async () => {
      const tabs = page.locator('.info-popover .wvw-tab');
      await tabs.and(page.locator(':not(.is-active)')).first().click();
    },
    'closing the popover': () => page.locator('.info-popover .info-popover-close').click(),
  };
  for (const [what, click] of Object.entries(clicks)) {
    const r = await count(page, 1000, click);
    const line = `${what}: ${r.drawn} frames drawn for ${r.embers} ember frames in 1 s`;
    test.info().annotations.push({ type: 'frames', description: line });
    console.log('frames.spec: ' + line);
    expect(r.embers, `${what}: the embers drawing`).toBeGreaterThan(10);
    // A few frames of the click's own (the press, the answer, the map built); a run-once effect
    // on CSS draws as fast as the machine goes, dozens more.
    expect.soft(r.drawn - r.embers, `${line}: frames beyond the embers'`).toBeLessThan(20);
    if (what === 'opening a map') await expect(popover.locator(".wvw-plot g[role='button']").first()).toBeAttached();
    await wvw.settle();
    await page.waitForTimeout(500);
  }
  await expect(popover).toHaveCount(0);
});

// The run-once animations on the page: moving on the clock (paused before their end), paused at or
// past it (which never finish), and not finished.
const runOnce = page => page.evaluate(() => {
  const name = a => `${a.animationName || a.transitionProperty || 'animate'} on ${a.effect.target.getAttribute('class')}`;
  const all = document.getAnimations().filter(a => a.effect && a.effect.getComputedTiming().iterations !== Infinity);
  const paused = all.filter(a => a.playState === 'paused');
  return {
    onClock: paused.filter(a => a.currentTime < a.effect.getComputedTiming().endTime).length,
    pastEnd: paused.filter(a => a.currentTime >= a.effect.getComputedTiming().endTime).map(name),
    left: all.filter(a => a.playState !== 'finished').map(name),
  };
});
const allFinish = (page, message) => expect.poll(async () => {
  const { pastEnd, left } = await runOnce(page);
  return { pastEnd, left };
}, { message, timeout: 5000 }).toEqual({ pastEnd: [], left: [] });

const cuts = {
  'the tab hidden': page => page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }),
  'reduced motion set': page => page.emulateMedia({ reducedMotion: 'reduce' }),
  'nothing': null,
};
for (const [cut, stop] of Object.entries(cuts)) {
  test(`a run-once effect cut mid-way by ${cut} never stays paused`, async ({ page, wvw }) => {
    await load(page, wvw);
    await page.locator('.tier-map-btn').first().click();
    await expect.poll(async () => (await runOnce(page)).onClock, { message: 'run-once effects on the clock' }).toBeGreaterThan(0);
    if (stop) await stop(page);
    await allFinish(page, `run-once effects after ${cut}`);
    await expect(page.locator(".info-popover .wvw-plot g[role='button']").first()).toBeAttached();
  });
}

for (const reduced of [false, true]) {
  test(`the trebuchet's shots${reduced ? ' under reduced motion' : ''} fly and leave nothing behind`, async ({ page, wvw }) => {
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      window.__flames = 0;
      new MutationObserver(ms => {
        for (const m of ms) for (const n of m.addedNodes) if (n.classList && n.classList.contains('flame-head')) window.__flames++;
      }).observe(document, { childList: true, subtree: true });
    });
    await load(page, wvw);
    const flames = page.locator('.flame-seg, .flame-head');
    // A shot at an empty spot, then a Check's round, which rides the sling until it is let go.
    await page.mouse.click(640, 20);
    await expect.poll(() => page.evaluate(() => window.__flames), { message: 'a shot flying' }).toBe(1);
    await page.waitForTimeout(3000);
    await expect(flames, 'flames 3 s after the shot').toHaveCount(0);
    await search(page, wvw.guilds);
    await expect.poll(() => page.evaluate(() => window.__flames), { message: "the Check's round flying" }).toBe(2);
    await page.waitForTimeout(3000);
    await expect(flames, "flames 3 s after the Check's round").toHaveCount(0);
    await allFinish(page, 'run-once effects after the shots');
  });
}
