// Moves several specs make the same way. Nothing here asserts a rule of its
// own beyond "the thing a visitor waits for appeared".
import { expect } from '@playwright/test';
import { recording } from './recordings.mjs';
import { boardBodies } from './page.mjs';

// A phone's screen at `width`, with the protocol's device override, mobile on.
// A page wider than the screen makes the layout widen to fit and innerWidth then differs: `exact` (default) says so, for the steps that
// check the width first; the others only measure.
export async function phone(page, width, { exact = true, height = 800 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
  if (!exact) return cdp;
  const inner = () => page.evaluate(() => innerWidth);
  try {
    await expect.poll(inner, { timeout: 5000 }).toBe(width);
  } catch {
    const why = await page.evaluate(w => {
      const past = [...document.querySelectorAll('body *')].filter(e => {
        const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        return r.width && r.right > w + 0.5 && cs.position !== 'fixed' && cs.display !== 'none'
          && ![...e.children].some(c => c.getBoundingClientRect().right > w + 0.5);
      }).slice(0, 6).map(e => e.tagName + '.' + String(e.className?.baseVal ?? e.className).split(' ').slice(0, 2).join('.'));
      return `innerWidth ${innerWidth}, page ${document.documentElement.scrollWidth} px wide; past ${w}: ${past.join(' | ') || 'none'}`;
    }, width);
    throw new Error(`a ${width} px phone got a wider layout: ${why}`);
  }
  return cdp;
}

// The guild search, typed as a visitor does, to the end: the answer up and the button
// back. Watches the standings meanwhile, so that the strip cannot be missed between two looks.
export async function search(page, name) {
  await page.evaluate(() => {
    window.__found = { strip: null, gone: false };
    new MutationObserver(() => {
      const f = window.__found;
      const s = document.querySelector('.guild-found-strip');
      if (s) { f.strip = s.textContent; f.gone = false; }
      else if (f.strip) f.gone = true;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  await page.getByRole('combobox', { name: 'Guild name, exactly as in game' }).focus();
  await page.keyboard.insertText(name);
  await page.getByRole('button', { name: 'Check' }).click();
  await answered(page);
}

// The answer to a search: its card or what went wrong, and Check back.
export async function answered(page) {
  await expect(page.locator('#searchAnswer .search-card, #searchAnswer .search-err')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#runBtn')).toBeEnabled();
}

// A body the recording holds, parsed: what a test bends into a state of its own.
export function recordedJson(url) {
  const e = recording().entries.get(url);
  if (!e) throw new Error(`steps: ${url} is not in the recording`);
  return JSON.parse(Buffer.from(e[2], e[3] ? 'base64' : 'utf8').toString('utf8'));
}

// Every address the page asks of the game's matches API from now on, in order.
export function matchReads(page) {
  const asked = [];
  page.on('request', r => { if (r.url().startsWith('https://api.guildwars2.com/v2/wvw/matches?')) asked.push(r.url()); });
  return asked;
}

// The game's list of matches as `list` says, by ids=all and by any ids=<some>
// (filtered from it, as the game would), until off(). A read by id that is
// answered from the recording instead would hand the page a live body the
// list was made to lack.
export async function serveList(page, list) {
  const state = { reads: 0, on: true, off() { state.on = false; } };
  await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=/, async route => {
    if (!state.on || route.request().method() !== 'GET') return route.fallback();
    state.reads++;
    const want = route.request().url().split('ids=')[1];
    const body = want === 'all' ? list : list.filter(m => want.split(',').includes(m.id));
    await route.fulfill({ status: 200, body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  });
  return state;
}

// A Check of `name`, to its answer.
export async function check(page, wvw, name) {
  await page.getByRole('combobox', { name: 'Guild name, exactly as in game' }).fill(name);
  await page.getByRole('button', { name: 'Check' }).click();
  await answered(page);
  await wvw.settle();
}

// The page opened with every tier of both regions up and nothing in flight.
export async function load(page, wvw) {
  expect(wvw.tiers.NA * wvw.tiers.EU, 'tiers in the recording, both regions').toBeGreaterThan(0);
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
  await wvw.settle();
}

// A tier's map button and the match it is about (default: the first tier).
export async function firstTier(page, button = page.locator('.tier-map-btn').first()) {
  const label = await button.getAttribute('aria-label');
  const t = /\b(NA|EU) Tier (\d+)/.exec(label || '');
  expect(t, `a tier map button to read a match from ("${label}")`).not.toBeNull();
  const id = `${t[1] === 'NA' ? 1 : 2}-${t[2]}`;
  return { button, label, id, url: 'https://api.guildwars2.com/v2/wvw/matches?id=' + id };
}

// The map opened, its objectives drawn and the page quiet.
export async function openMap(page, wvw, button) {
  await button.click();
  await expect(page.locator(".info-popover .wvw-plot g[role='button']").first()).toBeAttached();
  await wvw.settle();
}

// Time passes with the tab asking again: the focus pull.
export async function later(page, wvw, ms) {
  await wvw.skew(ms);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await wvw.settle();
}

// The page's clock (clock: 'playwright') run `ms` in steps of 3 s, under
// OWN_API_TIMEOUT_MS (js/config.js), each answer given its moment to land.
// `using`: a scroll each step, a visitor at the page (the peek's fastest pace).
// `push`: support/scenarios.mjs's livePush, each new version told as the Worker does.
export async function play(page, ms, { using = false, push = null } = {}) {
  for (let t = 0; t < ms; t += 3000) {
    if (using) await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
    if (push) await push.sync();
    await page.clock.runFor(Math.min(3000, ms - t));
    await page.waitForTimeout(40);
  }
}

// Every body on show, as copies, and the colours of `id` by rank: victory points,
// then score, then red, blue, green. Worked out here, not asked of the page, so
// a wrong rule on the page cannot agree with itself.
export const board = async (page, id) => {
  const list = await boardBodies(page);
  const m = list.find(x => x.id === id);
  const n = (o, c) => Number(o?.[c] ?? 0);
  const byRank = ['red', 'blue', 'green']
    .sort((a, b) => (n(m.victory_points, b) - n(m.victory_points, a)) || (n(m.scores, b) - n(m.scores, a)));
  return { list, byRank };
};

// Two animation frames: what a repaint scheduled has been drawn.
export const frame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

// `n` animation frames: the clock had its chances to draw or to play something again.
export const frames = (page, n) => page.evaluate(k => new Promise(done => {
  const step = () => (--k ? requestAnimationFrame(step) : done());
  requestAnimationFrame(step);
}), n);

// An ISO time without a trailing .000; other milliseconds stay (support/gw2.mjs has the game's whole-second form).
export const iso = t => new Date(t).toISOString().replace('.000Z', 'Z');

// Tab from where focus is until `selector` holds the focus: a person's way there.
export async function tabTo(page, selector, what) {
  for (let i = 0; i < 80; i++) {
    if (await page.evaluate(sel => !!document.activeElement?.matches(sel), selector)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${what}`);
}

// The first tier's map open at `width` (a phone's screen under 600), its board drawn and the page quiet; returns the tier.
export async function boardOpen(page, wvw, width = 1280) {
  await load(page, wvw);
  if (width < 600) await phone(page, width);
  const tier = await firstTier(page);
  await openMap(page, wvw, tier.button);
  await expect(page.locator('.info-popover .wvw-board-row[data-focus-color]').first()).toBeAttached();
  await wvw.settle();
  return tier;
}

// The loading indicators: the embers' clock moves them like every looping animation, and hands them back to CSS under reduced motion and in a hidden tab (js/boot.js).
export const LOADERS = '.spinner, .btn-pips';

// The infinite animations on the page, `loaders` or the rest, over `ms`: how many
// moved on and how many stood still (each by its currentTime), and which of the
// rest are still left running on CSS at the end (the clock pauses the ones it moves).
// It asks for frames while it waits: with the embers stopped, a headless page draws
// none, and an animation started meanwhile stays pending at 0.
export function looping(page, { ms = 400, loaders = false } = {}) {
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

