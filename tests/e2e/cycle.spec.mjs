// The five-minute refresh (js/standings.js, loadStandings): with our copy fresh and
// holding the weeks on show, it reads of the game only the matches whose own `at` is
// old, and the copy's summary when the one in hand is too old to say; with the copy
// old, or /api failing, it reads the game's list as ever.
import { test, expect } from './support/fixtures.mjs';
import { answer, fail } from './support/faults.mjs';
import { gw2 } from './support/gw2.mjs';
import { FOCUS, MIN, copyAheadOld, livePush, playingHalfMinutes } from './support/scenarios.mjs';
import { load, matchReads, play } from './support/steps.mjs';
import { aheadOfGameAndSummary, boardBodies, loadNow, loadSettled, markNaStandingsFailed, readSummaryNow, scoreOf, weekOf } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 }, clock: 'playwright', reducedMotion: 'reduce' });
test.describe.configure({ timeout: 120 * 1000 });

const LIST = /\/wvw\/matches\?ids=all$/;
const SUMMARY = /\/api\/latest\/summary$/;

test.describe('fresh copy', () => {
  test.use({ timeline: playingHalfMinutes(14) });

  test('10 minutes of an idle tab read the summary, never the game\'s list', async ({ page, wvw }) => {
    await load(page, wvw);
    const asked = matchReads(page);
    let summaries = 0;
    page.on('request', r => { if (SUMMARY.test(r.url())) summaries++; });
    const before = await scoreOf(page, FOCUS);
    await play(page, 10 * MIN);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)), 'reads of ids=all after the first load').toEqual([]);
    expect(summaries, 'summary reads').toBeGreaterThan(0);
    expect(await scoreOf(page, FOCUS), 'the board follows the copy').toBeGreaterThan(before);
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

// Only the focus match plays in the factory, so the copy's `at` of the other eight is old
// while the focus's is new: the cycle draws from the copy and asks the game for those eight, once.
const OTHERS = /\/wvw\/matches\?ids=(?!all$)/;
const idsOf = u => decodeURIComponent(new URL(u).searchParams.get('ids')).split(',');

test.describe('one match standing still in the copy', () => {
  test.use({ timeline: playingHalfMinutes(14) });

  test('the cycle asks the game for the stalled matches only, in one read', async ({ page, wvw }) => {
    await load(page, wvw);
    const asked = matchReads(page);
    const all = (await boardBodies(page)).map(m => m.id).sort();
    const before = await scoreOf(page, FOCUS);
    await play(page, 6 * MIN);
    await wvw.settle();
    const reads = asked.filter(u => OTHERS.test(u));
    expect(reads.length, 'reads by id in 6 minutes').toBe(1);
    expect(idsOf(reads[0]).sort(), 'the stalled matches').toEqual(all.filter(id => id !== FOCUS));
    expect(asked.filter(u => LIST.test(u)), 'reads of ids=all').toEqual([]);
    expect(await scoreOf(page, FOCUS), 'the board follows the copy').toBeGreaterThan(before);
  });

  test('one cycle reads the copy exactly once, though the game\'s answer and the summary both ask', async ({ page, wvw }) => {
    await load(page, wvw);
    await play(page, 3 * MIN);
    await wvw.settle();
    // A kept body further along than the game's own: its answer is behind, which asks the copy by itself.
    await aheadOfGameAndSummary(page, FOCUS);
    const copies = [];
    page.on('request', r => { if (/\/api\/latest$/.test(r.url())) copies.push(r.url()); });
    await loadNow(page);
    await loadSettled(page);
    await wvw.settle();
    expect(copies.length, 'reads of the copy in one cycle').toBe(1);
  });

  test('that read failing is silence: the copy draws the board', async ({ page, wvw }) => {
    await load(page, wvw);
    const down = await fail(page, wvw, OTHERS);
    const asked = matchReads(page);
    const before = await scoreOf(page, FOCUS);
    await play(page, 6 * MIN);
    await wvw.settle();
    expect(down.reads, 'reads that failed').toBeGreaterThanOrEqual(1);
    expect(await scoreOf(page, FOCUS), 'the board follows the copy').toBeGreaterThan(before);
    expect(asked.filter(u => LIST.test(u)), 'reads of ids=all (a failed load would retry with one)').toEqual([]);
    await expect(page.locator('.standings-alert .retry-btn'), 'no failure message').toHaveCount(0);
  });

  test('a stalled match that moves in the game reaches the board, without the list', async ({ page, wvw }) => {
    await load(page, wvw);
    const bodies = await boardBodies(page);
    const moved = bodies.find(m => m.id !== FOCUS).id;
    await answer(page, OTHERS, url => idsOf(url).map(id => {
      const m = structuredClone(bodies.find(b => b.id === id));
      if (id === moved) {
        for (const k of Object.keys(m.scores)) m.scores[k] += 5000;
        for (const k of Object.keys(m.kills)) m.kills[k] += 5000;
      }
      return m;
    }), { contentType: 'application/json' });
    const asked = matchReads(page);
    const before = await scoreOf(page, moved);
    await play(page, 6 * MIN);
    await wvw.settle();
    expect(await scoreOf(page, moved), 'the game\'s newer body of the stalled match').toBeGreaterThan(before);
    expect(asked.filter(u => LIST.test(u)), 'reads of ids=all').toEqual([]);
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
    await answer(page, SUMMARY, sum);
    await fail(page, wvw, /\/api\/latest$/);
    await loadNow(page);
    await loadSettled(page);
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
    const was = (await weekOf(page, FOCUS)).list;
    const turn = wvw.recordedAt + wvw.timeline.end + 3 * MIN;   // just past the NA reset, which the timeline ends a minute or two before
    const sum = await summaryNow(wvw, 0, turn);
    await wvw.skew(turn - await wvw.now());
    await answer(page, SUMMARY, sum);
    await loadNow(page);
    await loadSettled(page);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'reads of ids=all').toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await weekOf(page, FOCUS)).list, 'the week on show').not.toBe(was);
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
    await readSummaryNow(page);
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
    await loadNow(page);
    await loadSettled(page);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)), 'reads of ids=all with every tier loaded').toEqual([]);
    await markNaStandingsFailed(page);
    await loadNow(page);
    await loadSettled(page);
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

// The servers' clock says the NA reset was 30 s ago and the game's week has turned, while the copy still
// holds the old week with a word 35 s old: the cycle reads the game, not the copy, and the list shows the new
// week. The visitor's clock is 10 min slow so that a guard read on it does not see the reset (ahead, it would
// fall in the arrival window and not fail).
test.describe('the week turned, the copy held', () => {
  test.use({ timeline: gw2.match(FOCUS).resetOnTime().advance(110).pageOpens().advance(474.5, { every: 0.5 }).latestHeld(true).newWeek().advance(2, { every: 0.5 }) });

  test('the cycle reads the game and the list shows the new week', async ({ page, wvw }) => {
    await load(page, wvw);
    const was = (await weekOf(page, FOCUS)).list;
    const turn = wvw.recordedAt + wvw.timeline.end - 2 * MIN;
    const now = turn + 30 * 1000;
    expect(wvw.timeline.body(FOCUS, now - wvw.recordedAt).start_time, 'the game has the new week').not.toBe(was);
    await wvw.skew(now - await wvw.now());
    await wvw.ahead(-10 * MIN);
    await readSummaryNow(page);
    const asked = matchReads(page);
    await loadNow(page);
    await loadSettled(page);
    await wvw.settle();
    expect(asked.filter(u => LIST.test(u)).length, 'reads of ids=all').toBeGreaterThanOrEqual(1);
    expect((await weekOf(page, FOCUS)).list, 'the week on show').not.toBe(was);
  });
});
