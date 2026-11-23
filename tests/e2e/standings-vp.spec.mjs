import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { FOCUS, MIN, awayAndBack, playing, skirmishAway } from './support/scenarios.mjs';
import { load } from './support/steps.mjs';
import { loadNow } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

// A refresh that moves one side's VP pulses the edge of that side's card and no
// other. Nothing removes the class (js/standings.js), so it is read right after
// the refresh, with no clock to race. The match is the playing one:
// the recording's own week is over, and its cards show last week's line-up.
test.describe('a side\'s VP moves on a refresh', () => {
  test.use({ timeline: playing(10) });
  test('that side\'s card pulses and the others do not', async ({ page, wvw }) => {
    await page.goto(wvw.url);
    const sides = page.locator(`.standing-match[data-match-id="${FOCUS}"] .standing-side`);
    await expect(sides).toHaveCount(3);
    await wvw.settle();
    const pulsing = () => sides.evaluateAll(els => els.filter(e => e.classList.contains('side-pulse'))
      .map(e => ['red', 'blue', 'green'].find(c => e.classList.contains('side-' + c))));
    const url = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
    const list = await page.evaluate(async u => (await fetch(u)).json(), url);
    const mine = list.find(m => m.id === FOCUS);
    mine.victory_points.red += 7;
    await answer(page, /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=/, url => {
      const want = new URL(url).searchParams.get('ids');
      const ids = want === 'all' ? null : want.split(',');
      return list.filter(m => !ids || ids.includes(m.id));
    }, { contentType: 'application/json' });
    expect(await pulsing(), 'cards pulsing before the refresh').toEqual([]);
    await loadNow(page, 'manual');
    await expect(page.locator(`.standing-match[data-match-id="${FOCUS}"] .side-red .standing-vp .stat-value`),
      'red VP after the refresh').toHaveText(mine.victory_points.red.toLocaleString('en-US'));
    expect(await pulsing(), 'the sides whose card pulsed after red VP moved').toEqual(['red']);
  });
});

// Only the focus match plays in this world; in the game all nine move, so the
// others are marked as seen rising at the return, as the game's answer would have them.
test.describe('a skirmish ends while the tab is away', () => {
  test.use({ timeline: skirmishAway(100, 5) });
  // `loadedHidden`: a tab opened in the background (a middle-click), hidden
  // before any script of the page runs, as support/scenarios.mjs hides it.
  for (const loadedHidden of [false, true]) test(`the VP comes back with the other numbers${loadedHidden ? ' (opened in the background)' : ''}`, async ({ page, wvw }) => {
    if (loadedHidden) {
      await page.addInitScript(() => {
        window.__visibility = 'hidden';
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__visibility });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__visibility === 'hidden' });
      });
    }
    await load(page, wvw);
    const tl = wvw.timeline;
    const back = 107.5 * MIN;
    const older = tl.body(FOCUS, back - 5 * MIN), newest = tl.body(FOCUS, back);
    expect(tl.skirmishAt(FOCUS, back - 5 * MIN), 'the state: the older group\'s body is from before the mark')
      .toBeLessThan(tl.skirmishAt(FOCUS, back));
    expect(newest.victory_points, 'the state: the mark moved the VP').not.toEqual(older.victory_points);
    const side = c => page.locator(`.standing-match[data-match-id="${FOCUS}"] .side-${c}`);
    const activity = async c => (await side(c).locator('.standing-side-stats .stat-value').nth(1).evaluate(el => el.firstChild.nodeValue)).trim();
    const before = await activity('red');
    const away = wvw.recordedAt + back - await wvw.now();
    await awayAndBack(page, wvw, away, { othersSeen: true });
    await expect.poll(() => activity('red'), 'red Activity after the return').not.toBe(before);
    await wvw.settle();
    const vp = c => side(c).locator('.standing-vp .stat-value').textContent();
    for (const c of ['red', 'blue', 'green']) {
      expect(await vp(c), `${c} VP after the return`).toBe(newest.victory_points[c].toLocaleString('en-US'));
    }
  });
});
