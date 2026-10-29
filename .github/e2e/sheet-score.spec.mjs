// With /api/kills out the kill history is the sheet, whose eighth column holds the
// score sum of each line. A body whose time is only a first sight is dated by the
// oldest line of its week with the same sum; with no such line it keeps its time.
import { test, expect } from './support/fixtures.mjs';
import { fail } from './support/faults.mjs';
import { firstTier, load } from './support/steps.mjs';
import { MIN, killRows } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

// Lines for the match, [age in minutes, delta of the score sum from the body's], oldest first.
async function sheetAge(page, wvw, lines, bodyAge = 0) {
  let target;
  let sum;
  await page.route(/^https:\/\/docs\.google\.com\/spreadsheets\/.*sheet=kills/, async route => {
    const row = (await killRows(page, target, 0)).find(r => r[1] === target);
    const start = await page.evaluate(id => Date.parse(newestMatches.get(id).match.start_time), target);
    const now = await page.evaluate(() => Date.now());
    const body = lines.map(([age, delta]) => [now - age * MIN, ...row.slice(1), start, sum + delta].join(',')).join('\n');
    await route.fulfill({ status: 200, contentType: 'text/csv', body, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await load(page, wvw);
  const tier = await firstTier(page);
  target = tier.id;
  sum = await page.evaluate(id => colorSum(newestMatches.get(id).match.scores), target);
  const down = await fail(page, wvw, /^http:\/\/127\.0\.0\.1:\d+\/api\/kills$/);
  await page.evaluate(async bodyAge => {
    for (const k of newestMatches.values()) { k.rose = false; k.at = Date.now() - bodyAge; }
    killSheetAt = 0;
    await getKillSheet();
  }, bodyAge * MIN);
  expect(down.reads, 'reads of /api/kills that failed').toBeGreaterThan(0);
  return page.evaluate(id => Date.now() - newestMatches.get(id).at, target);
}

test('/api/kills down: the corner takes the time of the oldest sheet line with the body\'s score sum', async ({ page, wvw }) => {
  // The 30-min line is behind the body; the 20 and 10-min lines equal it; the 1-min line equals it too: the newest, which must lose.
  const age = await sheetAge(page, wvw, [[30, -5], [20, 0], [10, 0], [1, 0]]);
  expect(age, 'the body dated by the oldest equal line, not the newer one').toBeGreaterThanOrEqual(20 * MIN);
  expect(age, 'and not by the line behind it').toBeLessThan(25 * MIN);
});

test('/api/kills down: no sheet line with the body\'s score sum leaves its time as it was', async ({ page, wvw }) => {
  const age = await sheetAge(page, wvw, [[30, -5], [20, -3], [1, -1]]);
  expect(age, 'the body keeps its first-sight time').toBeLessThan(MIN);
});

test('/api/kills down: a body already dated before the equal sheet line does not move to it', async ({ page, wvw }) => {
  const age = await sheetAge(page, wvw, [[30, -5], [20, 0], [1, 0]], 25);
  expect(age, 'the body keeps its older time').toBeGreaterThanOrEqual(25 * MIN);
  expect(age, 'and is not dated further back').toBeLessThan(26 * MIN);
});
