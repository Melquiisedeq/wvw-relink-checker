// Moves several specs make the same way. Nothing here asserts a rule of its
// own beyond "the thing a visitor waits for appeared".
import { expect } from '@playwright/test';
import { recording } from './recordings.mjs';

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

// The guild search, typed as a visitor does, to the end: "Done", the rows, the
// match panels, the button back. Watches the standings meanwhile, so that the
// blink and the strip cannot be missed between two looks.
export async function search(page, names) {
  await page.evaluate(() => {
    window.__found = { flash: false, strip: null, gone: false };
    new MutationObserver(() => {
      const f = window.__found;
      if (document.querySelector('.guild-found-flash')) f.flash = true;
      const s = document.querySelector('.guild-found-strip');
      if (s) { f.strip = s.textContent; f.gone = false; }
      else if (f.strip) f.gone = true;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  await page.locator('#guildInput').focus();
  await page.keyboard.insertText(names.join('\n'));
  await page.locator('#runBtn').click();
  await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 15000 });
  await expect(page.locator('#resultBody tr').first()).toBeVisible();
  await expect(page.locator('#matchPanelsContainer > *').first()).toBeAttached();
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

// A Check of `names`, to "Done": the result rows' dots.
export async function check(page, wvw, names) {
  await page.evaluate(v => { document.getElementById('guildInput').value = v; }, names.join('\n'));
  await page.locator('#runBtn').click();
  await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 15000 });
  await expect(page.locator('#runBtn')).toBeEnabled();
  await wvw.settle();
}

// The page opened with every tier of both regions up and nothing in flight.
export async function load(page, wvw) {
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

// The match a page keeps for a tier, as a copy, its score last rising now.
export function keptMatch(page, id) {
  return page.evaluate(i => { const k = newestMatches.get(i); k.at = Date.now(); return JSON.parse(JSON.stringify(k.match)); }, id);
}

// Two animation frames: what a repaint scheduled has been drawn.
export const frame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

// An ISO time without a trailing .000; other milliseconds stay (support/gw2.mjs has the game's whole-second form).
export const iso = t => new Date(t).toISOString().replace('.000Z', 'Z');
