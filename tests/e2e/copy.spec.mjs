// An open map and our copy (/api/latest): the copy is read when the summary
// (/api/latest/summary, which the peek reads every 30 s) shows the
// map's match further along than the page holds, and then at once. With the
// visitor's whole group behind (copyBehindAll), each new body of the copy
// reaches the map within 22 s of being written (the peek at `at` + 11 s,
// PEEK_AFTER_MS, plus a STEP and a settle), a copy that answers late
// included, the copy read once per minute mark; with the group in step (playing), the game's own answer is as far
// along as the summary and the copy is not read at all.
import { test, expect } from './support/fixtures.mjs';
import { fail } from './support/faults.mjs';
import { gw2 } from './support/gw2.mjs';
import { FOCUS, MIN, copyBehindAll, playing, visitorDown } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 }, clock: 'playwright' });
const PLOT = ".info-popover .wvw-plot g[role='button']";
const COPY = /\/api\/latest$/;
const GAME = /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches/;
const sum = m => ['red', 'blue', 'green'].reduce((n, c) => n + m.scores[c], 0);
// Under OWN_API_TIMEOUT_MS (js/config.js): a jump past it aborts a read still in flight.
const STEP = 3000;

async function mapOpen(page, wvw) {
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await wvw.settle();
  await page.locator('.tier-map-btn').first().click();
  await expect(page.locator(PLOT).first()).toBeAttached();
  await wvw.settle();
  expect(await page.evaluate(() => freshRecall && freshRecall.data && freshRecall.data.id), 'the map open is the match that plays').toBe(FOCUS);
}

// `minutes` of the page's clock in STEP jumps, each let settle: the page time
// and the score the map shows after each, and the copy reads in the span.
async function watch(page, wvw, minutes) {
  const copies = [];
  page.on('request', r => { if (COPY.test(r.url())) copies.push(r.url()); });
  const samples = [];
  for (let i = 0; i < minutes * MIN / STEP; i++) {
    await page.clock.fastForward(STEP);
    await wvw.settle();
    const [shown, held] = await page.evaluate(id => [colorSum(freshRecall.data.scores), colorSum(newestMatches.get(id).match.scores)], FOCUS);
    samples.push({ t: await wvw.now(), shown, held, copies: copies.length });
  }
  return { samples, copies };
}

// Map open, from the first summary read, 5 min watched in STEP jumps: each
// new body of the copy on the map within 22 s of its minute mark, and the
// copy reads. `refused`: every match read of the game's fails from the open map on;
// `within`: how soon after its minute mark a new body is on the map.
async function behindWatched(page, wvw, { refused = false, within = 22 * 1000 } = {}) {
  test.setTimeout(150 * 1000);   // six minutes of the page's clock, each STEP settled
  await mapOpen(page, wvw);
  if (refused) await fail(page, wvw, GAME, 429);
  // Before the first summary the map's read behind the kept body asks the
  // copy by the rule without one (js/api.js, latestWanted), under a minute
  // before the first minute mark's: the watch starts after it.
  await expect.poll(async () => { await page.clock.fastForward(STEP); await wvw.settle(); return page.evaluate(() => latestSummaryAt); },
    { message: 'the first summary read', timeout: 30 * 1000 }).toBeGreaterThan(0);
  const t0 = await wvw.now();
  const minutes = 5;
  const { samples, copies } = await watch(page, wvw, minutes);
  const end = samples.at(-1).t;
  const copyAt = t => sum(wvw.timeline.body(FOCUS, t - wvw.recordedAt));
  const late = [];
  let marks = 0;
  // The timeline moves on whole minutes after the recording.
  const first = wvw.recordedAt + Math.ceil((t0 - wvw.recordedAt) / MIN) * MIN;
  for (let m = first; m <= end - 40 * 1000; m += MIN) {
    const v = copyAt(m);
    expect(v, `the copy rises at the minute mark ${(m - wvw.recordedAt) / MIN}`).toBeGreaterThan(copyAt(m - 1));
    marks++;
    const by = key => { const s = samples.find(x => x.t >= m && x[key] >= v); return s ? s.t - m : Infinity; };
    const held = by('held'), shown = by('shown');
    if (shown > within) late.push(`${(m - wvw.recordedAt) / MIN} min: held ${held / 1000} s, shown ${shown / 1000} s`);
  }
  expect(marks, 'minute marks watched').toBeGreaterThanOrEqual(minutes - 1);
  expect(late, `new bodies of the copy on the map later than ${within / 1000} s`).toEqual([]);
  // A read is due once per minute mark (the peek, aligned to the summary's
  // `at`), but fires at the end of the jump that passes its due time, and is
  // timed by the sample after it: two reads a minute apart are seen a STEP
  // closer for each, and a refused read (a sleep per jump) moves either by a
  // STEP more, so 51 s apart is a minute's read, whatever the game answers;
  // a second read per mark would be 30 s.
  const when = samples.filter((s, i) => s.copies > (i ? samples[i - 1].copies : 0)).map(s => s.t - t0);
  const close = when.filter((t, i) => i && t - when[i - 1] < MIN - 3 * STEP);
  expect(close, `reads of /api/latest under 51 s apart (all at ${when.map(t => Math.round(t / 1000)).join(' ')} s into the watch)`).toEqual([]);
  expect(copies.length, 'reads of /api/latest, a new body of the copy each minute').toBeGreaterThanOrEqual(minutes - 1);
}

// Two reads of the open map start together (the peek's and the map's own poll
// can fall on the same moment): the first carries the copy and lands after the
// second, which has none to carry (the game refused it, or answered with the
// body kept), and its body is drawn all the same, well before the next poll.
async function twoReads(page, wvw, { refused }) {
  test.setTimeout(150 * 1000);
  await mapOpen(page, wvw);
  if (refused) await fail(page, wvw, GAME, 429);
  await expect.poll(async () => { await page.clock.fastForward(STEP); await wvw.settle(); return page.evaluate(() => latestSummaryAt); },
    { message: 'the first summary read', timeout: 30 * 1000 }).toBeGreaterThan(0);
  await page.evaluate(() => { const read = mapAhead; mapAhead = ids => { read(ids); read(ids); }; });
  // Real time, not the page's: the second read ends in this gap.
  await page.route(COPY, async route => { await new Promise(r => setTimeout(r, 150)); return route.fallback(); });
  const held = () => page.evaluate(id => colorSum(newestMatches.get(id).match.scores), FOCUS);
  const shown = () => page.evaluate(id => colorSum(freshRecall.data.scores), FOCUS);
  const before = await shown();
  await expect.poll(async () => { await page.clock.fastForward(100); await wvw.settle(); return held(); },
    { message: 'the copy kept', intervals: [20], timeout: 90 * 1000 }).toBeGreaterThan(before);
  for (let i = 0; i < 5; i++) { await page.clock.fastForward(1000); await wvw.settle(); }
  expect(await shown(), 'the copy on the map well before the next poll (30 s)').toBeGreaterThan(before);
}

test.describe("the visitor's whole group behind", () => {
  test.use({ timeline: copyBehindAll(10, 30) });

  const title = 'each new body of the copy is on the map within 22 s; once the summary is read, the copy reads are 51 s apart or more';
  test(title, async ({ page, wvw }) => { await behindWatched(page, wvw); });

  // Past LATEST_WAIT_MS (js/api.js) the map's read paints the game's body;
  // the copy, when it lands, makes the map read again (offerLate).
  test('a read of the open map that carries the new copy is painted though a second one, with the game\'s older body, painted first', async ({ page, wvw }) => {
    await twoReads(page, wvw, { refused: false });
  });

  test(`a copy that answers in 2 s: ${title}`, async ({ page, wvw }) => {
    await page.route(COPY, async route => { await new Promise(r => setTimeout(r, 2000)); return route.fallback(); });
    await behindWatched(page, wvw);
  });
});

// The visitor's reads refused (their group down, their IP barred) while our
// readers go on: the copy stands in for the game's answer, on time or late.
test.describe("the visitor's match reads refused", () => {
  test.use({ timeline: playing() });

  // The copy is asked once the game's refusals and their two retries (js/api.js, fetchJson) are spent.
  test('each new body of the copy is on the map within 40 s; the copy reads are 51 s apart or more', async ({ page, wvw }) => {
    await behindWatched(page, wvw, { refused: true, within: 40 * 1000 });
  });

  test('a read of the open map that carries the new copy is painted though a second one started with it', async ({ page, wvw }) => {
    await twoReads(page, wvw, { refused: true });
  });

  // The map's read again, once the late copy lands (offerLate), first waits
  // out the game's refusals and their retries (js/api.js, fetchJson).
  test(`a copy that answers in 2 s: each new body of the copy is on the map within 45 s; the copy reads are 51 s apart or more`, async ({ page, wvw }) => {
    await page.route(COPY, async route => { await new Promise(r => setTimeout(r, 2000)); return route.fallback(); });
    await behindWatched(page, wvw, { refused: true, within: 45 * 1000 });
  });
});

test.describe("the visitor's group in step", () => {
  test.use({ timeline: playing() });

  test('the open map never reads the copy', async ({ page, wvw }) => {
    test.setTimeout(120 * 1000);   // four minutes of the page's clock, each STEP settled
    await mapOpen(page, wvw);
    const { samples, copies } = await watch(page, wvw, 4);
    expect(samples.at(-1).shown, 'the map moved with the game').toBeGreaterThan(samples[0].shown);
    expect(copies, 'reads of /api/latest with the map open').toEqual([]);
  });
});

// The game's reads refused and our copy the only source: the list draws the
// copy when a body of it rose within 6 min (HUD_STALE_MS) of the servers' time
// (the Date of the copy's answer, whole seconds), whatever the device's clock says.
test.describe('the list drawn from the copy, by the servers\' clock', () => {
  const RETRY = '.standings-alert .retry-btn';
  const refusal = page => page.evaluate(async () => {
    try { await copyBoard(new Error('refused')); return 'drawn'; } catch (e) { return e.message; }
  });
  const scoreOf = page => page.evaluate(id => colorSum(matchDataCache.get(id).scores), FOCUS);

  test.describe('the device 7 min ahead, our copy current', () => {
    test.use({ timeline: visitorDown(20) });
    test('the list draws the copy, with no "Trying again"', async ({ page, wvw }) => {
      test.setTimeout(120 * 1000);
      await page.goto(wvw.url);
      await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
      await wvw.settle();
      await wvw.ahead(7 * MIN);
      // 4 min of play, then the visitor's reads refused: the loads at 5 and 10 min come from the copy.
      let first = 0;
      for (let i = 0; i < 7; i++) {
        await wvw.settle();
        await page.clock.fastForward(2 * MIN);
        if (i === 3) first = await scoreOf(page);
      }
      await wvw.settle();
      expect(await page.evaluate(() => peekAnchor), 'the summary was read').toBeGreaterThan(0);
      expect(await scoreOf(page), 'the list drew a body newer than the 8 min mark').toBeGreaterThan(first);
      await expect(page.locator(RETRY), 'no "Trying again"').toHaveCount(0);
    });
  });

  test.describe('our readers stopped 20 min before the page opened', () => {
    test.use({ timeline: gw2.match(FOCUS).advance(12).latestHeld(true).advance(20).pageOpens().advance(4).status(503, { visitor: true }).advance(10) });
    test('a copy that old is not drawn: "Trying again"', async ({ page, wvw }) => {
      test.setTimeout(120 * 1000);
      await page.goto(wvw.url);
      await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
      for (let i = 0; i < 3; i++) {
        await wvw.settle();
        await page.clock.fastForward(2 * MIN);
      }
      await wvw.settle();
      await expect(page.locator(RETRY).first(), 'the list\'s "Trying again"').toBeAttached();
    });
  });

  test.describe('the copy stopped', () => {
    test.use({ timeline: gw2.match(FOCUS).advance(12).pageOpens().advance(4).latestHeld(true).status(503, { visitor: true }).advance(20) });
    test('a body is drawn up to 6 min after its `at`, by the servers\' clock, and not 1 s more', async ({ page, wvw }) => {
      test.setTimeout(120 * 1000);
      await page.goto(wvw.url);
      await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
      await wvw.settle();
      await wvw.ahead(7 * MIN);
      for (let i = 0; i < 4; i++) {
        await wvw.settle();
        await page.clock.fastForward(2 * MIN);
      }
      await wvw.settle();
      // The newest body of the copy is the summary's newest `at`; the servers' time is the page's less the 7 min.
      const anchor = await page.evaluate(() => peekAnchor);
      expect(anchor, 'the summary was read').toBeGreaterThan(0);
      await page.clock.setFixedTime(anchor + 7 * MIN + 6 * MIN);
      expect(await refusal(page), 'at 6 min').toBe('drawn');
      await page.clock.setFixedTime(anchor + 7 * MIN + 6 * MIN + 999);
      expect(await refusal(page), 'at 6 min and 999 ms, the same second of the Date').toBe('drawn');
      await page.clock.setFixedTime(anchor + 7 * MIN + 6 * MIN + 1000);
      expect(await refusal(page), 'at 6 min and 1 s').toBe('refused');
    });
  });

  test.describe('no Date on the answer', () => {
    test.use({ timeline: visitorDown(20) });
    test('the device\'s own clock measures the age', async ({ page, wvw }) => {
      await page.addInitScript(() => {
        const real = fetch;
        globalThis.fetch = async (...a) => { const r = await real(...a); return new Response(await r.blob(), { status: r.status }); };
      });
      await page.goto(wvw.url);
      await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
      await wvw.settle();
      expect(await refusal(page), 'the clock right, the copy current').toBe('drawn');
      await wvw.ahead(7 * MIN);
      expect(await refusal(page), 'the clock 7 min ahead, with nothing else to measure by').toBe('refused');
    });
  });
});
