// Budget: counts, not times (a count needs no judgement). Two parts.
//
//   load    after the page opens on the recording: compressed bytes per type
//           of what site/ served, requests to site/, blocking scripts, DOM
//           nodes and event listeners (CDP Memory.getDOMCounters after a
//           garbage collection). Each has a ceiling in budget.json, reviewed
//           by hand: today's measure plus a margin (bytes +1 KB, rounded up
//           to 100 B; requests and blocking scripts none; nodes and listeners +10 %).
//   cycles  20 turns of: clock jumps, tab hidden and back, a map opened and
//           closed. Nodes and listeners at the end of each cycle: the floor
//           of cycles 16-20 may not pass the floor of cycles 2-6 by more than
//           the tolerance (cycle 1 warms caches; a count that jumps for one
//           cycle and comes back is not a leak).
//
// Bytes are brotli (Cloudflare serves brotli to browsers that ask), default
// quality, computed here: the test server sends the files as they are. Only
// answers from the test server count, never the recorded API. Requests are
// site/'s only: the API's count depends on the recording.
//
// Time is not asserted. The load's duration, Event Timing's longest event and
// the long animation frames go to one "e2e budget: ..." line, and to
// $GITHUB_STEP_SUMMARY on CI.
import { appendFileSync, readFileSync } from 'node:fs';
import { brotliCompressSync } from 'node:zlib';
import { test, expect } from './support/fixtures.mjs';
import { MIN, hidden, playing, visible, wake } from './support/scenarios.mjs';
import { load, openMap, firstTier } from './support/steps.mjs';

const budget = JSON.parse(readFileSync(new URL('./budget.json', import.meta.url), 'utf8'));
const CYCLES = 20;
// What the floor may rise between the two halves of the cycles.
// Under 14, so that one node or listener left behind per cycle (14 cycles
// between the floors) fails, and over what the floors may wander.
const TOLERANCE = { nodes: 8, listeners: 8 };
const RAISE = 'if the rise is on purpose, raise the ceiling in budget.json in the same PR';

const typeOf = (ct, url) => {
  if (/html/.test(ct)) return 'html';
  if (/javascript/.test(ct)) return 'js';
  if (/css/.test(ct)) return 'css';
  if (/^image\//.test(ct)) return 'image';
  if (/font/.test(ct) || /\.(woff2?|ttf|otf)$/.test(url)) return 'font';
  return 'other';
};

test.use({ timeline: playing(150), clock: 'playwright', timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1280, height: 900 } });
test.describe.configure({ timeout: 4 * 60 * 1000 });

async function counters(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const c = await cdp.send('Memory.getDOMCounters');
  return { nodes: c.nodes, listeners: c.jsEventListeners };
}

function over(what, measured, ceiling) {
  expect(measured, `${what}: measured ${measured}, ceiling ${ceiling}; ${RAISE}`).toBeLessThanOrEqual(ceiling);
}

test('the load stays inside the budget, and 20 cycles leak nothing', async ({ page, wvw, context }) => {
  const bytes = {};
  let requests = 0;
  const bodies = [];
  const ours = u => u.startsWith(wvw.url) && !u.startsWith(wvw.url + 'api/');
  page.on('request', r => { if (ours(r.url())) requests++; });
  page.on('response', r => {
    if (!ours(r.url())) return;
    bodies.push(r.body().then(b => {
      const t = typeOf(r.headers()['content-type'] || '', r.url());
      bytes[t] = (bytes[t] || 0) + brotliCompressSync(b).length;
    }, () => {}));
  });
  await page.addInitScript(() => {
    window.__perf = { events: 0, longest: 0, frames: 0, longestFrame: 0 };
    const watch = (type, init, fn) => { try { new PerformanceObserver(l => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...init }); } catch {} };
    watch('event', { durationThreshold: 16 }, e => { window.__perf.longest = Math.max(window.__perf.longest, e.duration); });
    watch('long-animation-frame', {}, e => { window.__perf.frames++; window.__perf.longestFrame = Math.max(window.__perf.longestFrame, e.duration); });
  });

  const t0 = performance.now();
  await load(page, wvw);
  const loadMs = Math.round(performance.now() - t0);
  // js/maps.js is asked for as the board is drawn: counted with the load.
  await expect.poll(() => page.evaluate(() => typeof fillTierMaps), { message: 'js/maps.js loaded after the board' }).toBe('function');
  await wvw.settle();
  await Promise.all(bodies);

  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const blocking = await page.evaluate(() => [...document.scripts].filter(s => s.src && !s.async && !s.defer && s.type !== 'module').length);
  const after = await counters(cdp);

  // What the load did, before the cycles add maps, images and jumps of the clock.
  const p = await page.evaluate(() => window.__perf);
  const line = `e2e budget: load ${loadMs} ms, longest event ${Math.round(p.longest)} ms, `
    + `${p.frames} long animation frames (longest ${Math.round(p.longestFrame)} ms), `
    + `nodes ${after.nodes}, listeners ${after.listeners}, requests ${requests}, brotli ${Object.entries(bytes).sort().map(([t, n]) => `${t} ${n}`).join(' ')}`;
  // The warning first: it must reach the summary when an assertion below fails. Never a failure itself.
  console.log(line);
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`);

  const measured = { bytes, requests, blockingScripts: blocking, nodes: after.nodes, listeners: after.listeners };
  console.log('e2e budget measure: ' + JSON.stringify(measured));
  for (const [t, ceiling] of Object.entries(budget.bytes)) over(`compressed ${t} bytes`, bytes[t] || 0, ceiling);
  expect(Object.keys(bytes).filter(t => !(t in budget.bytes)), 'a type of file with no ceiling in budget.json').toEqual([]);
  over('requests to site/', requests, budget.requests);
  over('blocking scripts', blocking, budget.blockingScripts);
  over('DOM nodes after load', after.nodes, budget.nodes);
  over('event listeners after load', after.listeners, budget.listeners);

  const { button } = await firstTier(page);
  const series = [];
  for (let i = 1; i <= CYCLES; i++) {
    await wake(page, 3 * MIN);
    await hidden(page, wvw, MIN);
    await visible(page);
    await openMap(page, wvw, button);
    await page.keyboard.press('Escape');
    await expect(page.locator('.info-popover')).toHaveCount(0);
    await wvw.settle();
    series.push(await counters(cdp));
  }
  console.log('e2e budget cycles: ' + series.map(s => `${s.nodes}/${s.listeners}`).join(' '));
  // A count may jump for one cycle and come back; a leak raises the floor. So the
  // lowest count of cycles 16-20 is held against the lowest of cycles 2-6.
  for (const k of ['nodes', 'listeners']) {
    const floor = (from, to) => Math.min(...series.slice(from - 1, to).map(s => s[k]));
    const early = floor(2, 6), late = floor(CYCLES - 4, CYCLES);
    expect(late, `${k}: lowest of cycles ${CYCLES - 4}-${CYCLES} is ${late}, lowest of cycles 2-6 was ${early} (+${TOLERANCE[k]} tolerated); `
      + `series ${series.map(s => s[k]).join(' ')}; something grows with each cycle`).toBeLessThanOrEqual(early + TOLERANCE[k]);
  }

});
