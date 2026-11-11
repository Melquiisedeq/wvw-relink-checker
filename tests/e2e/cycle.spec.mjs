// The five-minute refresh (js/standings.js, loadStandings): with our copy fresh and
// holding the weeks on show, it reads nothing of the game, only the copy's summary
// when the one in hand is too old to say; with the copy old, or /api failing, it
// reads the game's list as ever.
import { test, expect } from './support/fixtures.mjs';
import { fail } from './support/faults.mjs';
import { gw2 } from './support/gw2.mjs';
import { FOCUS, MIN, copyAheadOld, livePush, playingHalfMinutes } from './support/scenarios.mjs';
import { load, matchReads, play } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, clock: 'playwright', reducedMotion: 'reduce' });
test.describe.configure({ timeout: 120 * 1000 });

const LIST = /\/wvw\/matches\?ids=all$/;
const SUMMARY = /\/api\/latest\/summary$/;
const scoreOf = page => page.evaluate(id => colorSum(matchDataCache.get(id).scores), FOCUS);

test.describe('fresh copy', () => {
  test.use({ timeline: playingHalfMinutes(14) });

  test('10 minutes of an idle tab read the summary, never the game\'s list', async ({ page, wvw }) => {
    await load(page, wvw);
    const asked = matchReads(page);
    let summaries = 0;
    page.on('request', r => { if (SUMMARY.test(r.url())) summaries++; });
    const before = await scoreOf(page);
    await play(page, 10 * MIN);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)), 'reads of ids=all after the first load').toEqual([]);
    expect(summaries, 'summary reads').toBeGreaterThan(0);
    expect(await scoreOf(page), 'the board follows the copy').toBeGreaterThan(before);
  });

  test('with /api down the cycle reads the game', async ({ page, wvw }) => {
    await load(page, wvw);
    const asked = matchReads(page);
    await fail(page, wvw, /\/api\/latest/);
    await play(page, 6 * MIN);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'reads of ids=all in 6 minutes').toBeGreaterThanOrEqual(1);
  });
});

// The summary as the Worker gives it (id -> { start, score, at }), from what the
// timeline tells now, each `at` made recent on the page's clock and `more` added to
// the focus match's score.
async function summaryNow(wvw, more = 0, atMs = undefined) {
  const told = await wvw.told();
  const at = Math.floor((atMs ?? await wvw.now()) / 1000) - 5;
  return Object.fromEntries(told.matches.map(m => [m.id, { start: m.start, score: m.score + (m.id === FOCUS ? more : 0), at }]));
}

test.describe('fresh summary, the copy not behind it', () => {
  test.use({ timeline: playingHalfMinutes(14) });

  test('a summary ahead whose copy does not answer: the cycle reads the game', async ({ page, wvw }) => {
    await load(page, wvw);
    const asked = matchReads(page);
    const sum = await summaryNow(wvw, 500);
    await page.route(SUMMARY, route => route.fulfill({ status: 200, json: sum,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }));
    await fail(page, wvw, /\/api\/latest$/);
    await page.evaluate(() => loadStandings());
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'reads of ids=all').toBeGreaterThanOrEqual(1);
  });
});

// The week turns while the summary, recent, still names the week that ended
// (the push refused, the copy a region behind): the page reads the game, which has the new one.
test.describe('the week turns', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().newWeek() });

  test('a recent summary of the old week does not hold the cycle back', async ({ page, wvw }) => {
    await load(page, wvw);
    const asked = matchReads(page);
    const was = await page.evaluate(id => matchDataCache.get(id).start_time, FOCUS);
    const turn = wvw.recordedAt + wvw.timeline.end + 3 * MIN;   // just past the NA reset, which the timeline ends a minute or two before
    const sum = await summaryNow(wvw, 0, turn);
    await wvw.skew(turn - await wvw.now());
    await page.route(SUMMARY, route => route.fulfill({ status: 200, json: sum,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }));
    await page.evaluate(() => loadStandings());
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'reads of ids=all').toBeGreaterThanOrEqual(1);
    await expect.poll(() => page.evaluate(id => matchDataCache.get(id).start_time, FOCUS), 'the week on show').not.toBe(was);
  });
});

test.describe('old copy', () => {
  test.use({ timeline: copyAheadOld(20, 30, 8) });

  test('the cycle reads the game', async ({ page, wvw }) => {
    await load(page, wvw);
    const asked = matchReads(page);
    await play(page, 6 * MIN);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'reads of ids=all in 6 minutes').toBeGreaterThanOrEqual(1);
  });
});

// The copy 2 min old at the five-minute mark (our readers stopped 3 min after the page
// opened; the game goes on): past LATEST_SUMMARY_FRESH_MS, so the cycle reads the game.
test.describe('copy 2 min old', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().advance(3, { every: 0.5 }).latestHeld(true).advance(8, { every: 0.5 }) });

  test('the cycle reads the game', async ({ page, wvw }) => {
    await load(page, wvw);
    const asked = matchReads(page);
    await play(page, 5.5 * MIN);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'reads of ids=all at the five-minute mark').toBeGreaterThanOrEqual(1);
  });
});

// The visitor's clock set 3 min back after the load: the tick at 5 min still comes (the timer
// runs on elapsed time, not the clock), and the copy, 2 min old, reads as fresh by that clock alone.
test.describe('copy old, the clock behind', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().advance(3, { every: 0.5 }).latestHeld(true).advance(8, { every: 0.5 }) });

  test('the cycle reads the game', async ({ page, wvw }) => {
    await load(page, wvw);
    await wvw.ahead(-3 * MIN);
    // The answer's Date header tells the page how far behind its clock is.
    await page.evaluate(() => fetchOwnApi(LATEST_SUMMARY_URL, 'no-store'));
    const asked = matchReads(page);
    await play(page, 5.5 * MIN);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'reads of ids=all by the cycle').toBeGreaterThanOrEqual(1);
  });
});

// A tier that failed to load: the cycle reads the game, whatever the copy says.
test.describe('a tier that failed', () => {
  test.use({ timeline: playingHalfMinutes(14) });

  test('the cycle reads the game though the copy is fresh', async ({ page, wvw }) => {
    await load(page, wvw);
    const asked = matchReads(page);
    await page.evaluate(() => loadStandings());
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)), 'reads of ids=all with every tier loaded').toEqual([]);
    await page.evaluate(() => { standingsFailed = [{ el: standingsStatusNA, label: 'live standings', region: 'NA' }]; });
    await page.evaluate(() => loadStandings());
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'reads of ids=all with a tier failed').toBeGreaterThanOrEqual(1);
  });
});

// With the push live, each message names only the matches that moved: the summary
// the page holds joins them, so the weeks on show stay known and the cycle needs no read.
test.describe('the push live, the summary not answering', () => {
  test.use({ timeline: playingHalfMinutes(14), origin: 'https://wvwrelink.com' });

  test('10 minutes of an idle tab, each push naming one match, never read the game\'s list', async ({ page, wvw }) => {
    const push = await livePush(page, wvw);
    await load(page, wvw);
    await expect.poll(() => push.open, 'the socket is open').toBe(1);
    await fail(page, wvw, SUMMARY);
    const asked = matchReads(page);
    for (let i = 0; i < 20; i++) {
      await play(page, 30 * 1000);
      const told = await wvw.told();
      await push.tell({ ...told, matches: told.matches.filter(m => m.id === FOCUS) });
    }
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)), 'reads of ids=all after the first load').toEqual([]);
  });
});

// The visitor's clock says the NA reset was 30 s ago, while the copy, held since a minute before the
// game's week turned, still has the old week as its freshest word by the servers' clock: the cycle
// must read the game, which has the new week, instead of taking the copy's board unread. The page
// opens after the EU reset (110 min in), so only NA's week is in question; the game's week ends 2 min
// before the reset the page keeps, hence a clock 2 min ahead.
test.describe('the week turned, the copy held', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(110).pageOpens().advance(472).latestHeld(true).newWeek().advance(2, { every: 0.5 }) });

  test('the cycle reads the game and the list shows the new week', async ({ page, wvw }) => {
    await load(page, wvw);
    const was = await page.evaluate(id => matchDataCache.get(id).start_time, FOCUS);
    const turn = wvw.recordedAt + wvw.timeline.end - 2 * MIN;
    const now = turn + 30 * 1000;
    expect(wvw.timeline.body(FOCUS, now - wvw.recordedAt).start_time, 'the game has the new week').not.toBe(was);
    await wvw.skew(now - await wvw.now());
    await wvw.ahead(2 * MIN);
    // The answer's Date header tells the page how far ahead its clock is.
    await page.evaluate(() => fetchOwnApi(LATEST_SUMMARY_URL, 'no-store'));
    const asked = matchReads(page);
    await page.evaluate(() => loadStandings());
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'reads of ids=all').toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(id => matchDataCache.get(id).start_time, FOCUS), 'the week on show').not.toBe(was);
  });
});
