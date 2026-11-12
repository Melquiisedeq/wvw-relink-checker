// The embers draw while the page is visible, with the focus or without it (a second
// monitor); hiding the tab stops the canvas drawing, and showing it starts it again.
// The looping animations move on the embers' clock (js/boot.js), so they stand still
// whenever it does; the run-once ones play to the end in every case. Reduced motion
// stops the looping ones the same way and leaves the run-once ones and the loading
// indicators playing.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { load, search, recordedJson, serveList, iso, looping, LOADERS } from './support/steps.mjs';
import { HOUR, MIN } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

const DAY = 24 * HOUR;

const allMoving = r => r.moved > 0 && r.still === 0 && r.onCss.length === 0;
// Until every one of them moves on the clock: a sweep adopts what was rebuilt or resumed.
const expectAllMoving = (page, message) => expect.poll(async () => allMoving(await looping(page)), { message, timeout: 5000 }).toBe(true);
// At once: every frame of embers sweeps, so the next one takes a new animation.
const expectAllMovingNow = async (page, message) => {
  const r = await looping(page, { ms: 300 });
  expect(allMoving(r), `${message}: ${JSON.stringify(r)}`).toBe(true);
};

// Left running on CSS this instant, with no frame asked for.
const onCssNow = page => page.evaluate(sel => document.getAnimations()
  .filter(a => a.effect && a.effect.target && a.effect.getComputedTiming().iterations === Infinity
    && a.playState === 'running' && !a.effect.target.closest(sel)).map(a => a.animationName), LOADERS);

// The page as a visitor leaves it: the focus in another window, the tab hidden.
const watch = (page, { focused = true, hidden = false } = {}) => page.evaluate(([f, h]) => {
  document.hasFocus = () => f;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  window.dispatchEvent(new Event(f ? 'focus' : 'blur'));
  document.dispatchEvent(new Event('visibilitychange'));
}, [focused, hidden]);

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

test('embers draw with or without focus, stop when the tab is hidden, and resume when it is shown', async ({ page, wvw }) => {
  await countEmberDraws(page);
  await load(page, wvw);
  const draws = () => page.evaluate(() => window.__emberDraws);
  // The count after the page has had time to settle and a frame to land.
  const quiet = async () => { await page.waitForTimeout(150); const n = await draws(); await page.waitForTimeout(350); return (await draws()) - n; };

  await watch(page);
  expect(await quiet(), 'drawing while watched').toBeGreaterThan(5);
  await expectAllMoving(page, 'looping animations moving while watched');

  await watch(page, { focused: false });   // a second monitor
  expect(await quiet(), 'drawing without focus').toBeGreaterThan(5);
  await expectAllMovingNow(page, 'looping animations moving without focus');

  await watch(page, { focused: false, hidden: true });
  expect(await quiet(), 'drawing in a hidden tab').toBe(0);
  expect((await looping(page)).moved, 'looping animations moving in a hidden tab').toBe(0);

  await watch(page, { focused: false });
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

test.describe('on a sharp screen', () => {
  test.use({ deviceScaleFactor: 2 });

  test('the embers canvas has a pixel for every device pixel and the embers still cover the screen', async ({ page, wvw }) => {
    await load(page, wvw);
    await page.waitForTimeout(500);
    const c = await page.evaluate(() => {
      const k = document.getElementById('fxEmbers');
      return { w: k.width, h: k.height, cw: k.clientWidth, ch: k.clientHeight, dpr: devicePixelRatio };
    });
    expect(c.dpr).toBe(2);
    expect([c.w, c.h], 'backing store').toEqual([c.cw * 2, c.ch * 2]);
    // Embers are lit in every quarter of the width; one drawn in CSS pixels on a doubled store crowds the top-left.
    const columns = await page.evaluate(() => {
      const k = document.getElementById('fxEmbers');
      const px = k.getContext('2d').getImageData(0, 0, k.width, k.height).data;
      const lit = [0, 0, 0, 0];
      for (let i = 3; i < px.length; i += 4) if (px[i]) lit[Math.min(3, Math.floor(((i >> 2) % k.width) / (k.width / 4)))]++;
      return lit;
    });
    expect(columns.filter(n => n === 0), `lit pixels in the four columns of the canvas: ${JSON.stringify(columns)}`).toEqual([]);
  });
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

// The run-once animations on the page: paused at or past their end (which never finish), and
// all not yet finished. The clock moves them while it runs, so mid-way one may be paused.
const runOnce = page => page.evaluate(() => {
  const name = a => `${a.animationName || a.transitionProperty || 'animate'} on ${a.effect.target.getAttribute('class')}`;
  const all = document.getAnimations().filter(a => a.effect && a.effect.getComputedTiming().iterations !== Infinity);
  return {
    pastEnd: all.filter(a => a.playState === 'paused' && a.currentTime >= a.effect.getComputedTiming().endTime).map(name),
    left: all.filter(a => a.playState !== 'finished').map(name),
  };
});

// A run-once animation frozen at its first frame leaves a blank or a stuck value.
for (const when of ['with reduced motion', 'without focus', 'in a hidden tab']) {
  test(`${when} the run-once animations play: the found strip shows`, async ({ page, wvw }) => {
    if (when === 'with reduced motion') await page.emulateMedia({ reducedMotion: 'reduce' });
    await load(page, wvw);
    if (when === 'without focus') await watch(page, { focused: false });
    if (when === 'in a hidden tab') await watch(page, { hidden: true });
    await search(page, wvw.guilds);
    const strip = page.locator('.guild-found-strip');
    await expect(strip).toBeAttached();
    await expect.poll(() => strip.evaluate(e => getComputedStyle(e).opacity), { message: 'the strip fading in' }).toBe('1');
    await expect.poll(() => runOnce(page), { message: 'run-once animations not finished', timeout: 5000 }).toEqual({ pastEnd: [], left: [] });
  });
}

test('without focus the loading indicators turn', async ({ page, wvw }) => {
  await load(page, wvw);
  let release;
  const held = new Promise(r => { release = r; });
  await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/, async route => { await held; await route.fallback(); });
  await page.locator('#guildInput').focus();
  await page.keyboard.insertText(wvw.guilds.join('\n'));
  await page.locator('#runBtn').click();
  await expect(page.locator('#statusMsg .spinner')).toBeAttached();
  await watch(page, { focused: false });
  // A cancelled animation rejects its ready.
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.ready.catch(() => {}))));
  const loaders = await looping(page, { loaders: true });
  expect(loaders.moved, 'loading indicators turning without focus').toBeGreaterThan(0);
  expect(loaders.still, 'loading indicators standing still without focus').toBe(0);
  // The clock runs without focus: it moves them, paused, rather than CSS.
  const onCss = await page.evaluate(sel => document.getAnimations()
    .filter(a => a.effect && a.effect.target && a.effect.target.closest(sel) && a.playState !== 'paused').length, LOADERS);
  expect(onCss, 'loading indicators left on CSS while the clock runs').toBe(0);
  release();
  await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 15000 });
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
      // Long enough for the clock to have taken them: the stop must hand them back to CSS.
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

// Each core the embers canvas fills, with when: the surge brightens it there, the canvas itself unfiltered.
function recordEmberFills(page) {
  return page.addInitScript(() => {
    window.__emberFills = [];
    const fill = CanvasRenderingContext2D.prototype.fill;
    CanvasRenderingContext2D.prototype.fill = function (...a) {
      if (this.canvas && this.canvas.id === 'fxEmbers') window.__emberFills.push([performance.now(), this.fillStyle]);
      return fill.apply(this, a);
    };
  });
}
const BASE_CORES = ['#ffb765', '#9fe6ff'];

test('reduced motion: a blast plays and leaves the looping animations still, then the field stops once its surge ends', async ({ page, wvw }) => {
  await countEmberDraws(page);
  await recordEmberFills(page);
  await load(page, wvw);
  // Set after the load, so the clock already holds the looping ones.
  await expectAllMoving(page, 'looping animations moving before reduced motion');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const draws = () => page.evaluate(() => window.__emberDraws);
  // Wait for the field to stop: the setting reaches the page on a later frame.
  await expect.poll(async () => { const n = await draws(); await page.waitForTimeout(200); return (await draws()) - n; },
    { message: 'the field stopping for reduced motion' }).toBe(0);
  const before = await draws();
  const t0 = await page.evaluate(() => { const t = performance.now(); emberField.blast(); return t; });
  expect((await looping(page, { ms: 500 })).moved, 'looping animations moving during the blast').toBe(0);
  expect((await draws()) - before, 'drawing during the blast').toBeGreaterThan(5);
  await page.waitForFunction(t => performance.now() - t > 3200, t0);
  const after = await draws();
  await page.waitForTimeout(400);
  expect((await draws()) - after, 'drawing once the sparks and the surge are gone').toBe(0);
  // The sparks are gone by 2.25 s; the surge, painted into the embers, by 2.8 s.
  const fills = (await page.evaluate(() => window.__emberFills)).filter(([t]) => t > t0);
  expect(fills[fills.length - 1][0] - t0, 'the field drawing until the surge ends').toBeGreaterThan(2750);
});

test('reduced motion: a tab hidden during the surge comes back to embers in their own colours, standing still', async ({ page, wvw }) => {
  await countEmberDraws(page);
  await recordEmberFills(page);
  await load(page, wvw);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const draws = () => page.evaluate(() => window.__emberDraws);
  await expect.poll(async () => { const n = await draws(); await page.waitForTimeout(200); return (await draws()) - n; },
    { message: 'the field stopping for reduced motion' }).toBe(0);
  await page.evaluate(() => emberField.blast());
  await page.waitForTimeout(400);
  await watch(page, { hidden: true });
  await watch(page);
  const after = await draws();
  await page.waitForTimeout(400);
  expect((await draws()) - after, 'drawing once shown again').toBe(0);
  const fills = await page.evaluate(() => window.__emberFills);
  expect(BASE_CORES, 'the embers left standing painted without the surge').toContain(fills[fills.length - 1][1]);
});

test('the surge brightens the embers as they are painted and only lifts the canvas', async ({ page, wvw }) => {
  await recordEmberFills(page);
  await load(page, wvw);
  const { t0, samples } = await page.evaluate(() => new Promise((done) => {
    const host = document.getElementById('fxEmbers');
    const t0 = performance.now();
    spawnEmberBlast();
    const samples = [];
    const loop = (t) => {
      const cs = getComputedStyle(host);
      samples.push([t - t0, cs.filter, cs.transform === 'none' ? 0 : new DOMMatrix(cs.transform).m42]);
      if (t - t0 < 3100) requestAnimationFrame(loop); else done({ t0, samples });
    };
    requestAnimationFrame(loop);
  }));
  expect(samples.filter(([, f]) => f !== 'none'), 'a filter on the canvas during the surge').toEqual([]);
  expect(Math.min(...samples.map(([, , y]) => y)), 'the canvas lifting').toBeLessThan(-6);
  const fills = await page.evaluate(() => window.__emberFills);
  const surged = fills.filter(([t, c]) => t > t0 && t - t0 < 600 && !BASE_CORES.includes(c));
  expect(surged.length, 'embers painted brighter in the flare').toBeGreaterThan(20);
  const late = fills.filter(([t]) => t - t0 > 2900).map(([, c]) => c);
  expect(late.length, 'embers drawn after the surge').toBeGreaterThan(0);
  expect(late.filter(c => !BASE_CORES.includes(c)), 'embers painted brighter after the surge').toEqual([]);
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

for (const focused of [true, false]) {
  test(`the relink bar rebuilt every minute${focused ? '' : ' without focus'} leaves no looping animation off the clock`, async ({ page, wvw }) => {
    await bar(page, wvw, { lockout: -1 * HOUR, assign: { na: 2 * DAY, eu: 2 * DAY - 8 * HOUR }, na: { start: -2 * DAY, end: 5 * DAY } });
    await expect(page.locator('#relinkBanner')).toHaveClass(/is-rebuild/);
    await watch(page, { focused });
    await expectAllMoving(page, 'looping animations moving in the rebuild week');
    // A few frames after the new animations start: every frame sweeps.
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
}

// Rebuilt with the clock stopped, they start on CSS: the first frame back takes them, with
// their animationstart held back so that only the frame's sweep can.
test('the relink bar rebuilt in a hidden tab leaves no looping animation off the clock once shown', async ({ page, wvw }) => {
  await countEmberDraws(page);
  await bar(page, wvw, { lockout: -1 * HOUR, assign: { na: 2 * DAY, eu: 2 * DAY - 8 * HOUR }, na: { start: -2 * DAY, end: 5 * DAY } });
  await expect(page.locator('#relinkBanner')).toHaveClass(/is-rebuild/);
  await watch(page, { hidden: true });
  await page.evaluate(() => {
    window.addEventListener('animationstart', e => e.stopImmediatePropagation(), true);
    window.__emberDraws = 0;
    updateRelinkBanner();
  });
  const r = await looping(page);
  expect(r.onCss.length, 'the state: looping animations started on CSS in the hidden tab').toBeGreaterThan(0);
  await watch(page);
  await page.waitForFunction(() => window.__emberDraws > 0);
  expect(await onCssNow(page), 'left on CSS at the first frame of embers').toEqual([]);
  await expectAllMoving(page, 'looping animations moving after the tab is shown');
});

// An animation can stay pending and its animationstart never come: held back here, it is
// the frame's sweep that takes it.
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

// The opacity of a rising ember by how far up it is (0 at the bottom, 1 at the top).
const riseAlpha = p => (p < .10 ? p / .10 * .9 : p < .82 ? .9 - (p - .10) / .72 * .2 : .7 * (1 - (p - .82) / .18));

test('a rising ember holds its glow up the page and goes out only near the top', async ({ page, wvw }) => {
  // Each halo is drawn at the alpha just set, and its core arc follows at the ember's own y.
  // The seed fixes the 46 phases: with it, every band always has embers in a one-second sample.
  await page.addInitScript(() => {
    let seed = 13;
    Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    window.__rise = [];
    const proto = CanvasRenderingContext2D.prototype;
    const draw = proto.drawImage, arc = proto.arc;
    let pending = null;
    proto.drawImage = function (...a) {
      if (this.canvas && this.canvas.id === 'fxEmbers') pending = this.globalAlpha;
      return draw.apply(this, a);
    };
    proto.arc = function (x, y, ...a) {
      if (this.canvas && this.canvas.id === 'fxEmbers' && pending !== null) {
        window.__rise.push([y, pending]);
        pending = null;
      }
      return arc.call(this, x, y, ...a);
    };
  });
  await load(page, wvw);
  await expect.poll(() => page.evaluate(() => window.__rise.length), { timeout: 15000 }).toBeGreaterThan(3000);
  const { H, samples } = await page.evaluate(() => ({ H: document.getElementById('fxEmbers').clientHeight, samples: window.__rise }));
  const points = samples.map(([y, alpha]) => ({ p: (H + 10.5 - y) / (H * 1.02), alpha }));
  for (const [lo, hi, label] of [[.03, .08, 'rising'], [.45, .55, 'middle'], [.88, .97, 'near the top']]) {
    const band = points.filter(s => s.p >= lo && s.p <= hi);
    expect(band.length, `embers seen ${label}`).toBeGreaterThan(0);
    for (const s of band) expect(s.alpha, `alpha ${label} at p=${s.p.toFixed(3)}`).toBeCloseTo(riseAlpha(s.p), 3);
  }
});
