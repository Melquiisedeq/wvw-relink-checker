// What the page costs to draw while it stands still and is watched, counted
// rather than timed. The compositor layers and why each exists, the looping
// animations moving on the embers' clock (js/boot.js), the ones that cannot run
// on the compositor (a new one is a new cost per frame: it fails until it is
// named here), the embers on a layer of their own, the photo on none and with
// no filter and no blend mode (its effect is baked into the file), and the
// raster work after the warm-up against a wide ceiling in data/budget.json. Paint and
// layout go to one "e2e paint: ..." line, and to $GITHUB_STEP_SUMMARY on CI,
// never to a failure. Frames drawn are frames.spec.mjs's.
//
// LayerTree is an experimental CDP domain: a test that breaks after a Chrome
// update points at the domain first, not at the page.
import { appendFileSync, readFileSync } from 'node:fs';
import { test, expect } from './support/fixtures.mjs';
import { playing } from './support/scenarios.mjs';
import { load, looping } from './support/steps.mjs';

const budget = JSON.parse(readFileSync(new URL('./data/budget.json', import.meta.url), 'utf8')).paint;

// Those the compositor can run without the main thread; an
// infinite animation with any other property in a keyframe runs on the main thread.
const COMPOSITABLE = ['opacity', 'transform', 'translate', 'rotate', 'scale', 'filter', 'backdropFilter'];
const NOT_PROPERTIES = ['offset', 'easing', 'composite', 'computedOffset'];
// The exact list: add a name here only on purpose.
const OFF_COMPOSITOR = [];

test.use({
  timeline: playing(150), timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1280, height: 800 },
});
test.describe.configure({ timeout: 120000 });

const offCompositor = page => page.evaluate(([ok, skip]) => [...new Set(document.getAnimations()
  .filter(a => a.effect && a.effect.getComputedTiming().iterations === Infinity
    && a.effect.getKeyframes().some(k => Object.keys(k).some(p => !skip.includes(p) && !ok.includes(p))))
  .map(a => a.animationName))].sort(), [COMPOSITABLE, NOT_PROPERTIES]);

test('standing still and watched, the layers, the animations and the raster stay inside the budget', async ({ page, wvw, context, browser }) => {
  await page.addInitScript(() => {
    window.__emberDraws = 0;
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) {
      if (this.canvas && this.canvas.id === 'fxEmbers') window.__emberDraws++;
      return draw.apply(this, a);
    };
  });
  await load(page, wvw);
  await page.waitForTimeout(3000);

  const cdp = await context.newCDPSession(page);
  let layers = [];
  cdp.on('LayerTree.layerTreeDidChange', e => { if (e.layers) layers = e.layers; });
  // The document first: a layer names its element only after the DOM domain has been asked for it.
  await cdp.send('DOM.enable');
  const root = (await cdp.send('DOM.getDocument', { depth: 0 })).root.nodeId;
  await cdp.send('LayerTree.enable');
  await expect.poll(() => layers.length, { message: 'LayerTree reported no layers' }).toBeGreaterThan(0);
  // The first report names few of the elements; a second one names them all.
  await cdp.send('LayerTree.disable');
  layers = [];
  await cdp.send('LayerTree.enable');
  await expect.poll(() => layers.length, { message: 'LayerTree reported no layers' }).toBeGreaterThan(0);
  await cdp.send('Performance.enable');

  // The layers, and why each exists.
  const reasons = {};
  // An element can own several layers (itself and what draws into it): its reasons are all of theirs.
  const reasonsOf = new Map();
  for (const l of layers) {
    const r = await cdp.send('LayerTree.compositingReasons', { layerId: l.layerId });
    for (const id of r.compositingReasonIds) reasons[id] = (reasons[id] || 0) + 1;
    if (l.backendNodeId) reasonsOf.set(l.backendNodeId, [...(reasonsOf.get(l.backendNodeId) || []), ...r.compositingReasonIds]);
  }
  const ownLayer = async selector => {
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root, selector });
    const { node } = await cdp.send('DOM.describeNode', { nodeId });
    return reasonsOf.get(node.backendNodeId) || [];
  };
  const photo = await ownLayer('.fx-photo');
  // A filter or a blend mode on a full-viewport layer is redone on every frame.
  const photoStyle = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.fx-photo'));
    return { filter: cs.filter, mixBlendMode: cs.mixBlendMode };
  });
  const embers = await ownLayer('#fxEmbers');

  // The looping animations advance (by currentTime: the clock pauses them) and the embers draw.
  const drawsBefore = await page.evaluate(() => window.__emberDraws);
  const loop = await looping(page, { ms: 600 });
  const drawn = (await page.evaluate(() => window.__emberDraws)) - drawsBefore;
  const off = await offCompositor(page);

  // Three windows after the warm-up; the last is what must hold.
  const windows = [];
  for (let w = 0; w < 3; w++) {
    const m0 = (await cdp.send('Performance.getMetrics')).metrics;
    await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
    await page.waitForTimeout(2000);
    const ev = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
    const m1 = (await cdp.send('Performance.getMetrics')).metrics;
    const d = n => m1.find(x => x.name === n).value - m0.find(x => x.name === n).value;
    const count = n => ev.filter(e => e.name === n).length;
    windows.push({ raster: count('RasterTask'), paint: count('Paint'), updateLayer: count('UpdateLayer'), layout: d('LayoutCount'), style: d('RecalcStyleCount') });
  }
  const last = windows[windows.length - 1];

  const line = `e2e paint: ${layers.length} layers, ${JSON.stringify(reasons)}, per 2 s: ${windows.map(w => `raster ${w.raster} paint ${w.paint} update ${w.updateLayer} layout ${w.layout} style ${w.style}`).join(' | ')}`;
  console.log(line);
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);

  const RAISE = 'if the rise is on purpose, raise the ceiling in data/budget.json in the same PR';
  expect(layers.length, `layers: ${layers.length}, ceiling ${budget.layers}; ${RAISE}`).toBeLessThanOrEqual(budget.layers);
  expect(Object.keys(reasons).filter(r => !(r in budget.reasons)), 'a reason for a layer with no ceiling in data/budget.json').toEqual([]);
  for (const [r, ceiling] of Object.entries(budget.reasons)) {
    expect(reasons[r] || 0, `layers for ${r}: ${reasons[r] || 0}, ceiling ${ceiling}; ${RAISE}`).toBeLessThanOrEqual(ceiling);
  }
  // Its own layer is one more full-viewport layer to composite on every frame.
  expect(photo, 'the photo draws into the background\'s layer, not one of its own').toEqual([]);
  expect(photoStyle, 'the photo carries its effect in the file, not in a filter or a blend mode').toEqual({ filter: 'none', mixBlendMode: 'normal' });
  expect(embers, 'the embers canvas is its own layer').toContain('Canvas');
  expect(drawn, 'ember frames drawn in 0.6 s').toBeGreaterThan(0);
  expect(loop.moved, `looping animations moving: ${JSON.stringify(loop)}`).toBeGreaterThan(0);
  expect(loop.still, `looping animations standing still: ${JSON.stringify(loop)}`).toBe(0);
  expect(loop.onCss, 'looping animations left on CSS').toEqual([]);
  expect(off, 'infinite animations off the compositor (name a new one in OFF_COMPOSITOR only on purpose)').toEqual(OFF_COMPOSITOR);
  expect(last.raster, `raster tasks in 2 s after the warm-up, ceiling ${budget.raster}; ${RAISE}`).toBeLessThanOrEqual(budget.raster);
});
