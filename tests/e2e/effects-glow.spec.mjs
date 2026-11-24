// The glows that flash or beat when something happens (the urgent and lockout
// bars, a new score, a guild found) are painted once and only their opacity
// moves, so no frame repaints them. Each state is brought up and every running
// CSS animation, one-shot or looping, is read: none may move a property the
// compositor cannot run alone (the guild strip's clip-path, named in its own test, is the
// one exception). perf-paint.spec.mjs holds the looping ones at rest;
// this one reaches the states it never sees.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { FOCUS, HOUR, MIN, hidden, visible } from './support/scenarios.mjs';
import { board, load, recordedJson, search, serveList, iso } from './support/steps.mjs';

const GAME = 'https://api.guildwars2.com/v2/';
const DAY = 24 * HOUR;
const S = 45 * 1000;
const COMPOSITABLE = ['opacity', 'transform', 'translate', 'rotate', 'scale', 'filter', 'backdropFilter'];
const NOT_PROPERTIES = ['offset', 'easing', 'composite', 'computedOffset'];

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });

// One read of everything running: the names, and name -> the properties off the
// compositor that its keyframes move. One read, so none can end between two looks.
const look = page => page.evaluate(([ok, skip]) => {
  const names = new Set(), off = {};
  for (const a of document.getAnimations()) {
    if (!a.animationName || !a.effect) continue;
    names.add(a.animationName);
    const bad = new Set();
    for (const k of a.effect.getKeyframes()) for (const p of Object.keys(k)) if (!skip.includes(p) && !ok.includes(p)) bad.add(p);
    if (bad.size) off[a.animationName] = [...bad].sort();
  }
  return { names: [...names], off };
}, [COMPOSITABLE, NOT_PROPERTIES]);

// A relink bar inside its window: `lockout` and `na` are milliseconds from the page's opening.
async function bar(page, wvw, { lockout, na }) {
  const at = ms => iso(wvw.opensAt + ms);
  const list = recordedJson(GAME + 'wvw/matches?ids=all').map(m => ({ ...m, start_time: at(-2 * DAY), end_time: at(na) }));
  await serveList(page, list);
  await answer(page, GAME + 'wvw/timers/lockout', { na: at(lockout), eu: at(lockout) });
  await answer(page, GAME + 'wvw/timers/teamAssignment', { na: at(10 * DAY), eu: at(10 * DAY) });
  await page.goto(wvw.url);
  await expect(page.locator('#relinkBanner')).toBeVisible();
  await wvw.settle();
}

test('the urgent bar beats on the compositor', async ({ page, wvw }) => {
  await bar(page, wvw, { lockout: 6 * DAY, na: HOUR + 50 * MIN + S });
  await expect(page.locator('#relinkBanner')).toHaveClass(/is-urgent/);
  const { names, off } = await look(page);
  expect(names, 'the beat is running').toContain('urgent-pulse');
  expect(off).toEqual({});
});

test('the lockout bar beats on the compositor', async ({ page, wvw }) => {
  await bar(page, wvw, { lockout: 2 * DAY + 5 * HOUR + S, na: 3 * DAY });
  await expect(page.locator('#relinkBanner')).toHaveClass(/is-lockout/);
  const { names, off } = await look(page);
  expect(names, 'the beat is running').toContain('lockout-pulse');
  expect(off).toEqual({});
});

// The first look in which every name in `want` runs.
async function lookWith(page, want) {
  let seen = null;
  await expect.poll(async () => { seen = await look(page); return want.filter(n => !seen.names.includes(n)); },
    { message: `${want.join(', ')} running`, intervals: [50] }).toEqual([]);
  return seen;
}

test('a new score flashes on the compositor', async ({ page, wvw }) => {
  await load(page, wvw);
  const { list } = await board(page, FOCUS);
  const focus = list.find(m => m.id === FOCUS);
  for (const c of ['red', 'blue', 'green']) focus.victory_points[c] = Number(focus.victory_points[c]) + 1;
  await serveList(page, list);
  // Back after 5 min, the tab reads the board again.
  await hidden(page, wvw, 5 * MIN);
  await visible(page);
  const { off } = await lookWith(page, ['value-flash', 'side-pulse']);
  expect(off).toEqual({});
});

test('a guild found flashes on the compositor', async ({ page, wvw }) => {
  await load(page, wvw);
  await search(page, wvw.guilds[0]);
  const { off } = await lookWith(page, ['guild-found-flash']);
  // The strip's entrance runs too: its clip-path is the exception, named in its own test.
  expect(off).toEqual({ 'guild-found-in-clip': ['clipPath'] });
});

// The strip's clip-path animations, by exact name, are the one thing off the COMPOSITABLE list:
// they change no layout, and Chrome composites a clip-path animation only when nothing else
// shares it, so each stays apart from its fade.
const offList = samples => {
  const off = {};
  for (const { props } of samples) for (const [name, ...ps] of props) {
    const bad = ps.filter(p => !NOT_PROPERTIES.includes(p) && !COMPOSITABLE.includes(p));
    if (bad.length) off[name] = bad;
  }
  return off;
};

// The strip takes its room at once and is uncovered by clip-path: its height is
// the final one from the first frame and the cards below jump, they do not slide.
test('the guild strip opens and closes without moving its height', async ({ page, wvw }) => {
  await load(page, wvw);
  await page.evaluate(() => {
    window.__h = [];
    const tick = () => {
      const s = document.querySelector('.guild-found-strip');
      if (s) window.__h.push({ h: s.getBoundingClientRect().height, leaving: s.classList.contains('is-leaving'), anim: s.getAnimations().map(a => a.animationName),
        props: s.getAnimations().map(a => [a.animationName, ...new Set(a.effect.getKeyframes().flatMap(k => Object.keys(k)))]) });
      window.__raf = requestAnimationFrame(tick);
    };
    tick();
  });
  await search(page, wvw.guilds[0]);
  const strip = page.locator('.guild-found-strip');
  await expect(strip).toBeVisible();
  // It leaves on its own, some seconds on, and is gone once its exit has played.
  await expect(strip).toHaveCount(0, { timeout: 15000 });
  const open = await page.evaluate(() => window.__h.filter(x => !x.leaving));
  expect(open.length, 'sampled while open').toBeGreaterThan(20);
  expect(open.some(x => x.anim.includes('guild-found-in-clip')), 'the entrance ran').toBe(true);
  expect(new Set(open.map(x => x.h)).size, `one height: ${[...new Set(open.map(x => x.h))]}`).toBe(1);
  expect(open[0].h).toBeGreaterThan(15);
  expect(offList(open), 'the entrance: only the clip animation is off the list').toEqual({ 'guild-found-in-clip': ['clipPath'] });
  // The exit: the room stays until the strip is removed.
  const leaving = await page.evaluate(() => window.__h.filter(x => x.leaving));
  expect(leaving.some(x => x.anim.includes('guild-found-out-clip')), 'the exit ran').toBe(true);
  expect(new Set(leaving.map(x => x.h)).size, 'the exit keeps its height').toBe(1);
  expect(leaving[0].h).toBe(open[0].h);
  expect(offList(leaving), 'the exit: only the clip animation is off the list').toEqual({ 'guild-found-out-clip': ['clipPath'] });
});

// The round that gathers at the button and the two shockwaves change size on every frame
// (impact.css says how they are drawn). paintCount does not see that (nothing repaints), so the trace's raster tasks are counted
// per layer, as frames: one raster of a layer is cut into tiles, one task each.
test('the round and the shockwaves are rastered once, not at every size', async ({ page, wvw, context }) => {
  await load(page, wvw);
  const cdp = await context.newCDPSession(page);
  const owner = new Map();
  cdp.on('LayerTree.layerTreeDidChange', e => { for (const l of e.layers || []) if (l.backendNodeId) owner.set(String(l.layerId), l.backendNodeId); });
  const raster = [];
  cdp.on('Tracing.dataCollected', d => { for (const e of d.value) if (e.name === 'RasterTask' && e.args && e.args.tileData) raster.push(e.args.tileData); });
  await cdp.send('DOM.enable');
  await cdp.send('LayerTree.enable');
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline'] } });
  // Each frame keeps the largest scale either was shown at.
  await page.evaluate(() => {
    window.__scale = { round: 0, rings: 0 };
    const most = (key, els) => { for (const el of els) window.__scale[key] = Math.max(window.__scale[key], new DOMMatrix(getComputedStyle(el).transform).a); };
    const tick = () => { most('round', document.querySelectorAll('.siege-charge b')); most('rings', document.querySelectorAll('.impact-overlay.play .impact-ring')); window.__raf = requestAnimationFrame(tick); };
    tick();
  });
  // A Check with the guild lookups held: the round gathers on the sling until they answer,
  // then flies, and the shockwaves play where it lands.
  let release;
  const held = new Promise(r => { release = r; });
  await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/, async route => { await held; await route.fallback(); });
  await page.locator('#guildInput').focus();
  await page.keyboard.insertText(wvw.guilds.join('\n'));
  await page.locator('#runBtn').click();
  await expect(page.locator('.siege-charge.charging'), 'the round gathering').toBeAttached();
  const root = (await cdp.send('DOM.getDocument', { depth: 0 })).root.nodeId;
  const node = async selector => {
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root, selector });
    return Promise.all(nodeIds.map(async nodeId => (await cdp.send('DOM.describeNode', { nodeId })).node.backendNodeId));
  };
  const nodes = { round: await node('.siege-charge b'), rings: await node('.impact-ring') };
  await page.waitForTimeout(1500);
  release();
  await expect(page.locator('.impact-overlay.play'), 'the round launched').toBeAttached({ timeout: 15000 });
  await page.waitForTimeout(1300);
  const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.end');
  await done;
  await cdp.send('LayerTree.disable');
  const scale = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return window.__scale; });
  // The flight's last frame, grown from the most the wind-up reaches: the largest the round gets.
  const flight = await page.evaluate(() => {
    const ball = document.createElement('div');
    ball.className = 'siege-charge flying';
    ball.style.setProperty('--grow', '2.4');
    ball.innerHTML = '<i><b></b></i>';
    document.body.appendChild(ball);
    const b = ball.querySelector('b');
    for (const a of b.getAnimations()) { a.pause(); a.currentTime = a.effect.getComputedTiming().endTime; }
    const most = new DOMMatrix(getComputedStyle(b).transform).a;
    ball.remove();
    return most;
  });
  const frames = ids => new Set(raster.filter(t => ids.includes(owner.get(String(t.layerId)))).map(t => `${t.layerId}:${t.sourceFrameNumber}`)).size;
  expect(nodes.round, 'the round is on the page').toHaveLength(1);
  expect(nodes.rings, 'both rings are on the page').toHaveLength(2);
  const round = frames(nodes.round), rings = frames(nodes.rings);
  // Without one raster of the round seen, the ceilings below would hold for nothing.
  expect(round, 'the round was rastered at all').toBeGreaterThan(0);
  expect(round, 'frames the round was rastered on').toBeLessThanOrEqual(8);
  expect(rings, 'the rings were rastered at all').toBeGreaterThan(0);
  expect(rings, 'frames the rings were rastered on').toBeLessThanOrEqual(8);
  expect(scale.round, 'the round grew while watched').toBeGreaterThan(0.3);
  expect(scale.rings, 'the rings grew while watched').toBeGreaterThan(0.5);
  expect(scale.round, 'the round is never scaled above the size it is painted at').toBeLessThanOrEqual(1);
  expect(scale.rings, 'the rings are never scaled above the size they are painted at').toBeLessThanOrEqual(1);
  expect(flight, 'the round at the end of its flight is scaled').toBeGreaterThan(0.9);
  expect(flight, 'the round at the end of its flight, not above the size it is painted at').toBeLessThanOrEqual(1 + 1e-6);
});
