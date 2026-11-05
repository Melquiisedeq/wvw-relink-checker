// The five-minute refresh (js/standings.js, loadStandings): with our copy fresh and
// holding the weeks on show, it reads nothing of the game, only the copy's summary
// when the one in hand is too old to say; with the copy old, or /api failing, it
// reads the game's list as ever.
import { test, expect } from './support/fixtures.mjs';
import { fail } from './support/faults.mjs';
import { gw2 } from './support/gw2.mjs';
import { FOCUS, MIN, copyAheadOld, playingHalfMinutes } from './support/scenarios.mjs';
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
