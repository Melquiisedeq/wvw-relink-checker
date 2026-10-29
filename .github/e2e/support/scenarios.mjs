// Named states of the world and of the tab, for the time tests. The timelines
// (support/gw2.mjs) go to the `wvw` fixture with test.use({ timeline }); the
// tab's moves take the page.
//
//   test.use({ timeline: frozen(40), clock: 'playwright' });
//   ... await hidden(page, wvw, 2 * HOUR); await visible(page);
import { gw2 } from './gw2.mjs';
import { recording } from './recordings.mjs';

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

// The visitor's whole group `lag` minutes behind on every read for `min`
// minutes of play, /api/latest up with the newest: a page opened (or
// reloaded) gets a body behind first and the newer one only from the copy.
export const copyBehindAll = (lag = 10, min = 30, id) =>
  opened(id).olderPool(lag, { every: true }).advance(min);

// The week turns (counters at zero) and the group `lag` minutes behind, in
// every second minute, serves the week that ended: /api/latest down, so only
// the page's own guard stands between that body and the screen.
export const weekTurnBehind = (lag = 10, min = 6, id) =>
  opened(id).latestStatus(503).newWeek().olderPool(lag).advance(min);

// Our copy ahead of the visitor's group, and old: 40 min of play, then our
// readers stop (/api/latest keeps that moment's bodies, /api/kills its lines)
// while every read of the visitor's lands on a group `lag` minutes behind; the
// page opens `age` minutes later and plays `min` more, its own reads behind
// the copy all along.
export const copyAheadOld = (age = 20, lag = 30, min = 8, id) => {
  if (!(age + min < lag)) throw new Error('scenarios: copyAheadOld needs age + min < lag');
  return gw2.match(id ?? FOCUS).advance(40).latestHeld(true).olderPool(lag, { every: true }).advance(age).pageOpens().advance(min);
};

// A skirmish ends while the tab is away: `min` minutes of play from the opening
// carry the match past its next two-hour mark (the recording's is 105 min
// after it), and a server group `lag` minutes behind answers every second
// minute from the opening on. A tab back in an odd minute just past the mark
// gets the older group's body - risen, but from before the mark, with the
// victory points of before - while /api/latest holds the newest.
export const skirmishAway = (min = 100, lag = 5, id) => opened(id).olderPool(lag).advance(min);

// The game goes on while its API answers `code` for `min` minutes, after 4 of
// play, then 12 more with the API back.
export const apiDown = (min = 10, code = 503, id) =>
  opened(id).advance(4).status(code).advance(min).status(null).advance(12);

// The visitor's server group down (or their IP refused, `code` 429) for `min`
// minutes, after 4 of play, then 12 more with it back; our readers, on the
// other group, go on, so /api/latest and /api/kills stay current.
export const visitorDown = (min = 10, code = 503, id) =>
  opened(id).advance(4).status(code, { visitor: true }).advance(min).status(null).advance(12);

// The game goes on and its API answers, but /api/kills gets no rows for `gap`
// minutes (our readers stopped): `before` minutes of play, the gap, `after`
// more, and the page opens then, with no log of its own to fill the hole.
export const killsGap = (gap = 12, before = 6, after = 2, id) =>
  gw2.match(id ?? FOCUS).advance(before).killHistory(false).advance(gap).killHistory(true).advance(after).pageOpens().advance(2);

// A busy match whose kills the API publishes in steps: every `step` minutes
// the step's kills land at once on EBG (`pace` a minute), while the score
// rises every minute, for `min` minutes after the opening. `lag`: the
// visitor's whole server group that many minutes behind, so every step
// reaches the page through /api/latest.
export const killSteps = (step = 7, pace = 12, min = 42, lag = 0, id) => {
  let tl = opened(id);
  if (lag) tl = tl.olderPool(lag, { every: true });
  for (let done = 0; done < min; done += step) {
    tl = tl.advance(1, { kills: { Center: pace * step } });
    if (step > 1) tl = tl.advance(step - 1, { kills: {} });
  }
  return tl;
};

// `min` minutes of play with `flips` objectives changing hands, from the moment
// the page opens: what a tab away for that long comes back to.
export const missed = (min = 5, flips = 3, id) => opened(id).advance(min, { flips });

// The same, with the API answering the same body for the last `stopped` minutes
// of the absence: the body a tab comes back to is that old.
export const missedStopped = (min = 67, flips = 6, stopped = 23, id) => missed(min, flips, id).freeze(stopped);

// The world as of an absolute instant (`iso`, UTC) instead of minutes after the
// recording: the recorded weeks rolled over to the one that holds it, twelve
// minutes of a fight ending at most a minute before it. The fixture installs
// the page's clock there; a test that needs the instant to the second sets it
// itself (page.clock.setSystemTime) before opening the page. Weeks turn at
// their ends, so an instant such as a reset is served as the new week.
export const at = (iso, id = FOCUS) => {
  const t = Date.parse(iso) - recording().recordedAt;
  if (!(t > 12 * MIN)) throw new Error(`scenarios: ${iso} is not 12 minutes after the recording`);
  return gw2.match(id).freeze(Math.floor(t / MIN) - 12).advance(12).pageOpens();
};

// ---- the kill history ------------------------------------------------
// One line per match the page holds (it must be loaded), the match `id` last
// seen `age` ms ago and the others `othersAge`, each with the kills of the body
// the page keeps: a body ahead of its line is not dated by it (js/api.js,
// ageFirstSightFromHistory). The same lines for /api/kills ({ rows }) and for
// the kills sheet (as CSV).
export const killRows = (page, id, age, othersAge = MIN) =>
  page.evaluate(([target, a, b]) => [...newestMatches.entries()].map(([k, kept]) => {
    const n = fightTotals(kept.match);
    return [Date.now() - (k === target ? a : b), k, ...KILLS_MAP_ORDER.map(t => n[t] || 0)];
  }), [id, age, othersAge]);

// ---- the tab ---------------------------------------------------------
// A hidden tab cannot be had for real in a test browser (headless, Xvfb,
// another tab on top, setWebLifecycleState frozen: the timers go on). What the page reads is simulated: document.visibilityState and
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

// The tab goes away for `ms` and comes back. `wvw` is anything with skew(ms)
// (the fixture's). With `othersSeen`, the matches but FOCUS are marked as seen
// rising at the return: only FOCUS plays in this world, in the game all nine move.
// A tab already hidden (opened in the background) is not hidden again.
export async function awayAndBack(page, wvw, ms, { othersSeen = false } = {}) {
  if (await page.evaluate(() => document.hidden)) await wvw.skew(ms);
  else await hidden(page, wvw, ms);
  if (othersSeen) await page.evaluate(id => { for (const [k, kept] of newestMatches) if (k !== id) kept.at = Date.now(); }, FOCUS);
  await visible(page);
}

// A laptop waking after `ms`: the clock jumps and every timer due fires once
// (page.clock.fastForward). Needs the fixture's clock: 'playwright'.
export async function wake(page, ms) {
  await page.clock.fastForward(ms);
}
