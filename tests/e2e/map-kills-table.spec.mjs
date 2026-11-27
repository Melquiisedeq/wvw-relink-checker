// The table's swords with no map open: hours of a fight with the tab visible, and a tab hidden for hours that
// comes back. Only the kill history dates a reading of this page's past, and readings past three hours leave
// the count: the table asks for it again on its own, never with the tab hidden.
import { test, expect } from './support/fixtures.mjs';
import { abort, fail, hold } from './support/faults.mjs';
import { load } from './support/steps.mjs';
import { FOCUS, HOUR, MIN, hidden, missed, visible } from './support/scenarios.mjs';

test.describe.configure({ timeout: 4 * 60 * 1000 });
test.use({ clock: 'playwright', viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });

const HISTORY = /^http:\/\/127\.0\.0\.1:\d+\/api\/kills/;
const SHEET = /^https:\/\/docs\.google\.com\/spreadsheets\/.*sheet=kills/;
const TIER = `NA Tier ${FOCUS.split('-')[1]}`;
// The tier's map button names its busiest map only while the swords are lit (js/maps-early.js, paintMapBadge).
const SWORDS = page => page.getByRole('button', { name: new RegExp(`${TIER} — busiest: `) });
// Each read of the kill history, stamped with the minute of the jump it went out in.
const historyReads = (page, played) => {
  const at = [];
  page.on('request', r => { if (HISTORY.test(r.url())) at.push(played.min); });
  return at;
};
// `min` minutes of the page's clock, one jump a minute, nothing in flight before each.
const pass = async (page, wvw, played, min) => {
  for (let i = 0; i < min; i++) {
    await wvw.settle();
    played.min++;
    await page.clock.fastForward(MIN);
  }
  await wvw.settle();
};

test.describe('a fight on the focus match all along', () => {
  test.use({ timeline: missed(270, 30) });

  test('four hours visible with no map open: the swords stay lit, the history read at most once in five minutes', async ({ page, wvw }) => {
    const played = { min: 0 };
    const reads = historyReads(page, played);
    await load(page, wvw);
    await expect(SWORDS(page), 'the state: the swords at the opening').toHaveCount(1);
    await pass(page, wvw, played, 4 * 60);
    await expect(SWORDS(page), 'four hours on, the fight still on').toHaveCount(1);
    const gaps = reads.slice(1).map((m, i) => m - reads[i]);
    expect(gaps.filter(g => g < 5), `never two reads under five minutes apart (reads at ${reads.join(', ')} min)`).toEqual([]);
    expect(reads.length, 'at most 12 reads an hour').toBeLessThanOrEqual(1 + 4 * 12);
  });

  test('hidden for hours: no read of the history while hidden; back, one read lights the swords at once', async ({ page, wvw }) => {
    const played = { min: 0 };
    const reads = historyReads(page, played);
    await load(page, wvw);
    await expect(SWORDS(page), 'the state: the swords at the opening').toHaveCount(1);
    const before = reads.length;
    await hidden(page, wvw, 0);
    await pass(page, wvw, played, 60);
    expect(reads.length, 'no read in an hour hidden').toBe(before);
    await hidden(page, wvw, 3 * HOUR);
    await pass(page, wvw, played, 1);
    await expect(SWORDS(page), 'the state: past three hours, the readings in hand too old').toHaveCount(0);
    expect(reads.length, 'still no read while hidden').toBe(before);
    // The return's read held until whatever else the return repaints has landed: only its own answer lights them.
    const release = await hold(page, HISTORY);
    await visible(page);
    await expect.poll(() => release.reads, { message: 'the state: the return reads the history' }).toBe(1);
    await page.waitForTimeout(1000);
    await expect(SWORDS(page), 'the state: still dark while the read is out').toHaveCount(0);
    release();
    await wvw.settle();
    await expect(SWORDS(page), 'back: lit by the read of the return, before the next repaint').toHaveCount(1, { timeout: 3000 });
    expect(reads.length, 'one read for the return').toBe(before + 1);
  });

  // A failed read leaves the copy in hand as old as it was: the wait counts from the ask, not the answer.
  test('the history out: asked again no sooner than every five minutes', async ({ page, wvw }) => {
    const played = { min: 0 };
    const reads = historyReads(page, played);
    await load(page, wvw);
    await fail(page, wvw, HISTORY);
    await abort(page, wvw, SHEET);
    await pass(page, wvw, played, 30);
    // A read's own tries go out in the same minute: one ask a minute at most.
    const asks = [...new Set(reads)];
    const gaps = asks.slice(1).map((m, i) => m - asks[i]);
    expect(asks.length, 'the state: asked again while out').toBeGreaterThan(1);
    expect(gaps.filter(g => g < 5), `never two asks under five minutes apart (asks at ${asks.join(', ')} min)`).toEqual([]);
  });
});
