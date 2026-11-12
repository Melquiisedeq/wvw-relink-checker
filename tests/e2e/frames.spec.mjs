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

test('a run-once effect cancelled on the clock just before the tab hides is not played again', async ({ page, wvw }) => {
  await load(page, wvw);
  await page.locator('.tier-map-btn').first().click();
  // Found, cancelled and hidden in one script: no clock frame can finish the effect in between.
  await expect.poll(() => page.evaluate(() => {
    if (window.__cancelled) return window.__cancelled.playStateOnHide;
    const a = document.getAnimations().find(x => x.effect.getComputedTiming().iterations !== Infinity
      && x.playState === 'paused' && x.currentTime < x.effect.getComputedTiming().endTime);
    if (!a) return 'none on the clock';
    window.__cancelled = a;
    a.cancel();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    return (a.playStateOnHide = a.playState);
  }), { message: 'the cancelled effect once the tab is hidden' }).toBe('idle');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__cancelled.playState), 'the cancelled effect with the tab shown again').toBe('idle');
  await allFinish(page, 'the other run-once effects');
});

test("the head's fire on a round's trail, with the tab hidden and shown mid-flight, burns out", async ({ page, wvw }) => {
  // Hidden the moment the trail's head is added, inside the flight, whatever the machine's speed.
  await page.addInitScript(() => {
    new MutationObserver(ms => {
      if (!ms.some(m => [...m.addedNodes].some(n => n.classList && n.classList.contains('flame-head')))) return;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.__hiddenWithHead = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await load(page, wvw);
  await search(page, wvw.guilds);
  await expect.poll(() => page.evaluate(() => window.__hiddenWithHead), { message: 'the tab hidden with the head lit' }).toBe(true);
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.flame-head'), 'the head of the trail, burnt out').toHaveCount(0);
});

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

test("the page's layer is made before the shake, and the cards' glass is off from the wind-up to 1.7 s after the break", async ({ page, wvw }) => {
  await page.addInitScript(() => {
    const seen = window.__finale = { willChange: null, glassAtBreak: null, glassAtBrokenEnd: null, glassAtWindUp: null };
    const glass = () => getComputedStyle(document.querySelector('.card')).backdropFilter;
    new MutationObserver(() => {
      const pg = document.getElementById('page');
      if (pg && pg.classList.contains('struck') && seen.willChange === null) seen.willChange = getComputedStyle(pg).willChange;
      const o = document.querySelector('.impact-overlay.broken');
      if (o && seen.glassAtBreak === null) seen.glassAtBreak = glass();
      if (o) seen.sawBroken = true;
      const ov = document.querySelector('.impact-overlay');
      if (seen.sawBroken && ov && !ov.classList.contains('broken') && seen.glassAtBrokenEnd === null) seen.glassAtBrokenEnd = glass();
      if (document.querySelector('.siege-charge.charging') && seen.glassAtWindUp === null) seen.glassAtWindUp = glass();
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
  await load(page, wvw);
  const glass = () => page.evaluate(() => getComputedStyle(document.querySelector('.card')).backdropFilter);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('page')).willChange), 'the page layer before any shake').toContain('transform');
  expect(await glass(), 'the cards\' glass at rest').not.toBe('none');
  await search(page, wvw.guilds);
  await expect.poll(() => page.evaluate(() => window.__finale.glassAtBrokenEnd), { message: 'the break effect ended', timeout: 10000 }).not.toBeNull();
  const seen = await page.evaluate(() => window.__finale);
  expect(seen.willChange, 'the page layer when the shake starts').toContain('transform');
  expect(seen.glassAtWindUp, 'the glass as the round gathers').toBe('none');
  expect(seen.glassAtBreak, 'the glass at the break').toBe('none');
  expect(seen.glassAtBrokenEnd, 'the glass when the break effect ends, before the tail is over').toBe('none');
  await expect.poll(glass, { message: 'the glass back after the finale', timeout: 5000 }).not.toBe('none');
});

// A drop-shadow over pieces that move is blurred again on every frame: the crest's glow
// is painted once into canvases before the round flies, and nothing over the break filters.
for (const idle of [true, false]) test(`the crest breaks under a glow painted beforehand${idle ? '' : ', by the click when the page never idles'}: no filter over the shield or the blast`, async ({ page, wvw }) => {
  if (!idle) await page.addInitScript(() => { window.requestIdleCallback = () => 0; });
  await page.addInitScript(() => {
    const seen = window.__crest = { beforeBreak: null, midBreak: null };
    const glows = () => [...document.querySelectorAll('.impact-overlay .crest-glow')].map(c => {
      let lit = 0;
      if (c.width && c.height) {
        const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < px.length; i += 4) if (px[i]) lit++;
        lit /= c.width * c.height;
      }
      return { lit, visibility: getComputedStyle(c).visibility };
    });
    const filters = () => {
      const out = [];
      for (const piece of document.querySelectorAll('.impact-overlay .crest-blast, .impact-overlay .crest-crack, .impact-overlay .crest-half')) {
        for (let el = piece; el && !el.classList.contains('impact-overlay'); el = el.parentElement) out.push(getComputedStyle(el).filter);
      }
      return [...new Set(out)];
    };
    const names = sel => [...document.querySelectorAll(sel)].flatMap(el => el.getAnimations().map(a => a.animationName));
    new MutationObserver(() => {
      const o = document.querySelector('.impact-overlay');
      if (!o) return;
      if (o.classList.contains('play') && !o.classList.contains('broken') && seen.beforeBreak === null) seen.beforeBreak = glows();
      if (o.classList.contains('broken') && seen.midBreak === null) {
        seen.midBreak = false;
        setTimeout(() => {
          seen.midBreak = { filters: filters(), glows: glows(), sides: names('.crest-side'), fracture: names('.crest-fracture') };
        }, 120);
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] });
    window.__crestGlows = glows;
  });
  await load(page, wvw);
  if (idle) await expect.poll(() => page.evaluate(() => window.__crestGlows().filter(g => g.lit > 0).length), { message: 'every glow painted while the page idles, before any click' }).toBe(4);
  await search(page, wvw.guilds);
  await expect.poll(() => page.evaluate(() => window.__crest.midBreak), { message: 'the crest broke', timeout: 10000 }).toBeTruthy();
  const { beforeBreak, midBreak } = await page.evaluate(() => window.__crest);
  expect.soft(beforeBreak, 'four glows: the whole crest, two halves, the crack').toHaveLength(4);
  // Share of each canvas lit: above what the same shape lights unblurred (or, for the
  // crack, with its inner blur alone), so a glow painted without its blur fails.
  const spread = [['the whole crest', 0.3], ['the left half', 0.2], ['the right half', 0.2], ['the crack', 0.15]];
  spread.forEach(([what, min], i) => expect.soft(beforeBreak[i]?.lit, `${what}'s glow painted, blurred out, before the round lands`).toBeGreaterThan(min));
  expect.soft(beforeBreak.map(g => g.visibility), 'before the break only the whole crest glows').toEqual(['visible', 'hidden', 'hidden', 'visible']);
  expect.soft(midBreak.filters, 'no filter on the shield, the crack, the blast or anything holding them').toEqual(['none']);
  expect.soft(midBreak.glows.map(g => g.visibility), 'in the break each half carries its own glow').toEqual(['hidden', 'visible', 'visible', 'visible']);
  expect.soft(midBreak.sides, 'the halves move with their glows').toEqual(['half-l', 'half-r']);
  expect.soft(midBreak.fracture, 'the crack flashes with its glow').toEqual(['crack-flash']);
});
