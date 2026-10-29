// An open map and our copy (/api/latest): the copy is read when the summary
// (/api/latest/summary, which the peek reads about once a minute) shows the
// map's match further along than the page holds, and then at once. With the
// visitor's whole group behind (copyBehindAll), each new body of the copy
// reaches the map within 35 s of being written, a copy that answers late
// included, the copy read once per minute mark; with the group in step (playing), the game's own answer is as far
// along as the summary and the copy is not read at all.
import { test, expect } from './support/fixtures.mjs';
import { fail } from './support/faults.mjs';
import { FOCUS, MIN, copyBehindAll, playing } from './support/scenarios.mjs';

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
// new body of the copy on the map within 35 s of its minute mark, and the
// copy reads. `refused`: every match read of the game's fails from the open map on;
// `within`: how soon after its minute mark a new body is on the map.
async function behindWatched(page, wvw, { refused = false, within = 35 * 1000 } = {}) {
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
  // timed by the sample after it, a settle later: reads a minute apart can show
  // up a STEP and a settle or two (2 s at most) short of it, 55 s apart.
  const when = samples.filter((s, i) => s.copies > (i ? samples[i - 1].copies : 0)).map(s => s.t - t0);
  const close = when.filter((t, i) => i && t - when[i - 1] < MIN - STEP - 2000);
  expect(close, `reads of /api/latest under 55 s apart (all at ${when.map(t => Math.round(t / 1000)).join(' ')} s into the watch)`).toEqual([]);
  expect(copies.length, 'reads of /api/latest, a new body of the copy each minute').toBeGreaterThanOrEqual(minutes - 1);
}

test.describe("the visitor's whole group behind", () => {
  test.use({ timeline: copyBehindAll(10, 30) });

  const title = 'each new body of the copy is on the map within 35 s; once the summary is read, the copy reads are 55 s apart or more';
  test(title, async ({ page, wvw }) => { await behindWatched(page, wvw); });

  // Past LATEST_WAIT_MS (js/api.js) the map's read paints the game's body;
  // the copy, when it lands, makes the map read again (offerLate).
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
  test('each new body of the copy is on the map within 40 s; the copy reads are 55 s apart or more', async ({ page, wvw }) => {
    await behindWatched(page, wvw, { refused: true, within: 40 * 1000 });
  });

  // The map's read again, once the late copy lands (offerLate), first waits
  // out the game's refusals and their retries (js/api.js, fetchJson).
  test(`a copy that answers in 2 s: each new body of the copy is on the map within 45 s; the copy reads are 55 s apart or more`, async ({ page, wvw }) => {
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
