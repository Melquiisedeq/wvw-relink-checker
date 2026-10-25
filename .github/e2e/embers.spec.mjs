// The embers draw only while the page is being watched: losing focus or hiding
// the tab stops the canvas drawing and marks the page is-idle, and coming back
// starts both again. The looping animations move on the embers' clock (js/boot.js),
// so they stand still whenever it does. Reduced motion stops the looping ones the
// same way and leaves the run-once ones and the loading indicators playing.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { load, search, recordedJson, serveList, iso } from './support/steps.mjs';
import { HOUR, MIN } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

const DAY = 24 * HOUR;
const LOADERS = '.spinner, .btn-pips';

// The infinite animations on the page, `loaders` or the rest, over `ms`: how many
// moved on and how many stood still (each by its currentTime), and which of the
// rest are still left running on CSS at the end (the clock pauses the ones it moves).
// It asks for frames while it waits: with the embers stopped, a headless page draws
// none, and an animation started meanwhile stays pending at 0.
function looping(page, { ms = 400, loaders = false } = {}) {
  return page.evaluate(async ([ms, loaders, sel]) => {
    const now = () => document.getAnimations().filter(a => a.effect && a.effect.target
      && a.effect.getComputedTiming().iterations === Infinity && !!a.effect.target.closest(sel) === loaders);
    const before = new Map(now().map(a => [a, a.currentTime]));
    await new Promise(r => { const t0 = performance.now(); const f = t => (t - t0 < ms ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); });
    let moved = 0, still = 0;
    for (const [a, t] of before) {
      if (!a.effect.target.isConnected || a.playState === 'idle') continue;
      if (a.currentTime > t) moved++; else still++;
    }
    const onCss = loaders ? [] : now().filter(a => a.playState === 'running').map(a => a.animationName);
    return { moved, still, onCss };
  }, [ms, loaders, LOADERS]);
}
const allMoving = r => r.moved > 0 && r.still === 0 && r.onCss.length === 0;
// Until every one of them moves on the clock: a sweep adopts what was rebuilt or resumed.
const expectAllMoving = (page, message) => expect.poll(async () => allMoving(await looping(page)), { message, timeout: 5000 }).toBe(true);
// At once: the sweep a start or a new animation asks for comes on the next frame, the
// one a second only later.
const expectAllMovingNow = async (page, message) => {
  const r = await looping(page, { ms: 300 });
  expect(allMoving(r), `${message}: ${JSON.stringify(r)}`).toBe(true);
};

// Left running on CSS this instant, with no frame asked for.
const onCssNow = page => page.evaluate(sel => document.getAnimations()
  .filter(a => a.effect && a.effect.target && a.effect.getComputedTiming().iterations === Infinity
    && a.playState === 'running' && !a.effect.target.closest(sel)).map(a => a.animationName), LOADERS);

function countEmberDraws(page) {
  return page.addInitScript(() => {
    window.__emberDraws = 0;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) {
      if (this.canvas && this.canvas.id === 'fxEmbers') window.__emberDraws++;
      return draw.apply(this, a);
    };
  });
}

test('embers stop drawing when focus or the tab is lost, and resume when it returns', async ({ page, wvw }) => {
  await countEmberDraws(page);
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
  await expectAllMoving(page, 'looping animations moving while watched');

  await watch(false, false);   // focus gone: a second monitor
  expect(await idle()).toBe(true);
  expect(await quiet(), 'drawing without focus').toBe(0);
  expect((await looping(page)).moved, 'looping animations moving without focus').toBe(0);

  await watch(true, false);
  await expectAllMovingNow(page, 'looping animations moving again after focus');
  expect(await idle()).toBe(false);
  expect(await quiet(), 'drawing again after focus').toBeGreaterThan(5);

  await watch(true, true);     // the tab hidden
  expect(await idle()).toBe(true);
  expect(await quiet(), 'drawing in a hidden tab').toBe(0);
  expect((await looping(page)).moved, 'looping animations moving in a hidden tab').toBe(0);

  await watch(true, false);
  await expectAllMovingNow(page, 'looping animations moving after the tab is shown');
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
  await countEmberDraws(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page, wvw);
  const draws = () => page.evaluate(() => window.__emberDraws);
  const quiet = async () => { await page.waitForTimeout(150); const n = await draws(); await page.waitForTimeout(350); return (await draws()) - n; };

  const stopped = await looping(page);
  expect(stopped.still, 'looping animations on the page').toBeGreaterThan(0);
  expect(stopped.moved, 'looping animations moving with reduced motion').toBe(0);
  expect(await quiet(), 'drawing with reduced motion').toBe(0);

  // The first frame of embers takes the looping ones, which ran nowhere until now.
  const n = await draws();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(n => window.__emberDraws > n, n);
  expect(await onCssNow(page), 'left on CSS at the first frame of embers').toEqual([]);
  await expectAllMoving(page, 'looping animations moving again');
  expect(await quiet(), 'drawing after the setting is lifted').toBeGreaterThan(5);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The setting reaches the page on a later frame.
  await expect.poll(async () => (await looping(page)).moved, { message: 'looping animations moving after the setting returns' }).toBe(0);
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

for (const when of ['before the search', 'during the search']) {
  test(`reduced motion set ${when} leaves the loading indicators turning`, async ({ page, wvw }) => {
    if (when === 'before the search') await page.emulateMedia({ reducedMotion: 'reduce' });
    await load(page, wvw);
    // The guild lookups held back, so the search stays loading while it is looked at.
    let release;
    const held = new Promise(r => { release = r; });
    await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/, async route => { await held; await route.fallback(); });
    await page.locator('#guildInput').focus();
    await page.keyboard.insertText(wvw.guilds.join('\n'));
    await page.locator('#runBtn').click();
    await expect(page.locator('#runBtn .btn-pips')).toBeAttached();
    await expect(page.locator('#statusMsg .spinner')).toBeAttached();
    if (when === 'during the search') {
      // Long enough for the clock to have swept: it must have left them to CSS.
      await page.waitForTimeout(300);
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }
    const loaders = await looping(page, { loaders: true });
    expect(loaders.moved, 'loading indicators turning').toBeGreaterThan(0);
    expect(loaders.still, 'loading indicators standing still').toBe(0);
    expect((await looping(page)).moved, 'looping animations moving meanwhile').toBe(0);
    release();
    await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 15000 });
  });
}

test('reduced motion: a blast plays and leaves the looping animations still, then the field stops again', async ({ page, wvw }) => {
  await countEmberDraws(page);
  await load(page, wvw);
  // Set after the load, so the clock already holds the looping ones.
  await expectAllMoving(page, 'looping animations moving before reduced motion');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const draws = () => page.evaluate(() => window.__emberDraws);
  // Wait for the field to stop: the setting reaches the page on a later frame.
  await expect.poll(async () => { const n = await draws(); await page.waitForTimeout(200); return (await draws()) - n; },
    { message: 'the field stopping for reduced motion' }).toBe(0);
  const before = await draws();
  await page.evaluate(() => emberField.blast());
  expect((await looping(page, { ms: 500 })).moved, 'looping animations moving during the blast').toBe(0);
  expect((await draws()) - before, 'drawing during the blast').toBeGreaterThan(5);
  await page.waitForTimeout(2500);
  const after = await draws();
  await page.waitForTimeout(400);
  expect((await draws()) - after, 'drawing once the sparks are gone').toBe(0);
});

// The relink bar's timers, in milliseconds from the page's opening (as in banners.spec.mjs).
async function bar(page, wvw, { lockout, assign, na }) {
  const at = ms => iso(wvw.opensAt + ms);
  const regions = { 1: na, 2: { start: -2 * DAY, end: 3 * DAY } };
  await serveList(page, recordedJson('https://api.guildwars2.com/v2/wvw/matches?ids=all')
    .map(m => ({ ...m, start_time: at(regions[m.id[0]].start), end_time: at(regions[m.id[0]].end) })));
  await answer(page, 'https://api.guildwars2.com/v2/wvw/timers/lockout', { na: at(lockout), eu: at(lockout) });
  await answer(page, 'https://api.guildwars2.com/v2/wvw/timers/teamAssignment', { na: at(assign.na), eu: at(assign.eu) });
  await answer(page, '**/api/relink', { window: Math.floor((wvw.opensAt + assign.na) / 1000), published: 0 });
  await load(page, wvw);
}

test('the relink bar leaving reset night: its pulse, cancelled, does not come back', async ({ page, wvw }) => {
  // A new week just published: reset night for its first 5 minutes.
  await bar(page, wvw, { lockout: 6 * DAY, assign: { na: 10 * DAY, eu: 10 * DAY }, na: { start: -1 * MIN, end: 7 * DAY - 1 * MIN } });
  await expect(page.locator('#relinkBanner')).toHaveClass(/is-urgent/);
  await expectAllMoving(page, 'looping animations moving on reset night');
  await wvw.skew(6 * MIN);
  await page.evaluate(() => updateRelinkBanner());
  await expect(page.locator('#relinkBanner')).not.toHaveClass(/is-urgent/);
  await page.waitForTimeout(400);
  const pulses = await page.evaluate(() => document.getAnimations().filter(a => a.animationName === 'urgent-pulse').length);
  expect(pulses, 'the reset night pulse after reset night').toBe(0);
  await expectAllMoving(page, 'looping animations moving after reset night');
});

test('the relink bar rebuilt every minute leaves no looping animation off the clock', async ({ page, wvw }) => {
  await bar(page, wvw, { lockout: -1 * HOUR, assign: { na: 2 * DAY, eu: 2 * DAY - 8 * HOUR }, na: { start: -2 * DAY, end: 5 * DAY } });
  await expect(page.locator('#relinkBanner')).toHaveClass(/is-rebuild/);
  await expectAllMoving(page, 'looping animations moving in the rebuild week');
  // A few frames after the new animations start, not a second: the sweep they ask for,
  // not the one a second.
  for (let i = 0; i < 5; i++) {
    const left = await page.evaluate(() => new Promise(done => {
      const frames = n => (n ? requestAnimationFrame(() => frames(n - 1)) : done(document.getAnimations()
        .filter(a => a.effect && a.effect.getComputedTiming().iterations === Infinity && a.playState === 'running'
          && !a.effect.target.closest('.spinner, .btn-pips')).map(a => a.animationName)));
      document.addEventListener('animationstart', () => frames(3), { capture: true, once: true });
      updateRelinkBanner();
    }));
    expect(left, `left on CSS just after rebuild ${i + 1}`).toEqual([]);
  }
  await expectAllMoving(page, 'looping animations moving after the bar is rebuilt');
});

// An animation can stay pending and its animationstart never come: held back here,
// so the sweep once a second is all that can take it.
test('without animationstart, the relink bar rebuilt still leaves no looping animation off the clock', async ({ page, wvw }) => {
  await bar(page, wvw, { lockout: -1 * HOUR, assign: { na: 2 * DAY, eu: 2 * DAY - 8 * HOUR }, na: { start: -2 * DAY, end: 5 * DAY } });
  await expect(page.locator('#relinkBanner')).toHaveClass(/is-rebuild/);
  await expectAllMoving(page, 'looping animations moving in the rebuild week');
  await page.evaluate(() => {
    window.addEventListener('animationstart', e => e.stopImmediatePropagation(), true);
    updateRelinkBanner();
  });
  await expectAllMoving(page, 'looping animations moving after the bar is rebuilt');
});
