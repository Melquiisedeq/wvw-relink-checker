// Named states of the world and of the tab, for the time tests. The timelines
// (support/gw2.mjs) go to the `wvw` fixture with test.use({ timeline }); the
// tab's moves take the page.
//
//   test.use({ timeline: frozen(40), clock: 'playwright' });
//   ... await hidden(page, wvw, 2 * HOUR); await visible(page);
import { gw2 } from './gw2.mjs';

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
// The match that plays: NA tier 1, whose recorded week runs ~9 h 40 min past
// the recording (EU's ends 1 h 43 min after it).
export const FOCUS = '1-1';

// Twelve minutes of a fight on EBG (30 kills a minute) before the page opens,
// so the kill window has a base and the swords can show on the first read.
const opened = (id = FOCUS) => gw2.match(id).advance(12).pageOpens();

// `min` minutes of play, the API answering as it goes.
export const playing = (min = 40, id) => opened(id).advance(min);

// The API answers the same body for `min` minutes, after 4 of play, then 12
// more of play.
export const frozen = (min = 40, id) => opened(id).advance(4).freeze(min).advance(12);

// A server group `lag` minutes behind answering every second minute, for
// `min` minutes of play; /api/latest down, so that only the page's own guard
// (keepNewestMatch) stands between the older group and the screen.
export const twoPools = (lag = 10, min = 30, id) => opened(id).latestStatus(503).olderPool(lag).advance(min);

// The game goes on while its API answers `code` for `min` minutes, after 4 of
// play, then 12 more with the API back.
export const apiDown = (min = 10, code = 503, id) =>
  opened(id).advance(4).status(code).advance(min).status(null).advance(12);

// `min` minutes of play with `flips` objectives changing hands, from the moment
// the page opens: what a tab away for that long comes back to.
export const missed = (min = 5, flips = 3, id) => opened(id).advance(min, { flips });

// ---- the tab ---------------------------------------------------------
// A hidden tab cannot be had for real in a test browser (measured, 10/10/2026:
// headless, Xvfb, another tab on top, setWebLifecycleState frozen - the timers
// went on). What the page reads is simulated: document.visibilityState and
// .hidden, the visibilitychange event, and the clock jumping the time away.
async function setVisibility(page, state) {
  await page.evaluate(s => {
    if (!('__visibility' in window)) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__visibility });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__visibility === 'hidden' });
    }
    window.__visibility = s;
    if (s === 'hidden') window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
    if (s === 'visible') window.dispatchEvent(new Event('focus'));
  }, state);
}

// The tab goes to the background and `ms` pass (wvw.skew: no timer fires).
export async function hidden(page, wvw, ms) {
  await setVisibility(page, 'hidden');
  await wvw.skew(ms);
}

// The tab comes back.
export async function visible(page) {
  await setVisibility(page, 'visible');
}

// A laptop waking after `ms`: the clock jumps and every timer due fires once
// (page.clock.fastForward). Needs the fixture's clock: 'playwright'.
export async function wake(page, ms) {
  await page.clock.fastForward(ms);
}
