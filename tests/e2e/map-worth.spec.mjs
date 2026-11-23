import { test, expect } from './support/fixtures.mjs';
import { gw2 } from './support/gw2.mjs';
import { FOCUS } from './support/scenarios.mjs';
import { firstTier, load, openMap } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

const POP = '.info-popover';

// ---- what a map's objectives are worth, as the War Score pays it -------------------------------
// The score bar over a map sums what each side's objectives paid before the War Score; an objective's
// panel says "Per tick" only when it ticks (a Keep, Tower or Castle at T3); the board's PPT is every tick of a team added up, the game's own "+N".
const served = wvw => wvw.timeline.body(FOCUS, wvw.timeline.end);
const objectivesOf = (b, type) => b.maps.find(m => m.type === type).objectives;

test.describe('the score bar of a borderland', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).advance(6, { flips: 6 }).pageOpens() });
  test('each side is as wide as its share of what its objectives paid before the War Score', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    await openMap(page, wvw, tier.button);
    await page.locator(`${POP} .wvw-tab[data-type="BlueHome"]`).click();
    await expect(page.locator(`${POP} .wvw-tab.is-active[data-type="BlueHome"]`)).toBeAttached();
    await wvw.settle();
    // The tick that tier paid before the War Score; the tier is read from the capture the body serves.
    const TICK = { Camp: [2, 3, 4, 5], Tower: [4, 6, 8, 10], Keep: [8, 12, 16, 20], Castle: [12, 16, 20, 24] };
    const CAPTURE = { Camp: [2, 10, 15, 25], Tower: [25, 125, 200, 250], Keep: [100, 200, 400, 500], Castle: [200, 250, 300, 400] };
    const mine = { red: 0, blue: 0, green: 0 };
    for (const o of objectivesOf(served(wvw), 'BlueHome')) {
      if (TICK[o.type]) mine[String(o.owner).toLowerCase()] += TICK[o.type][Math.max(0, CAPTURE[o.type].indexOf(o.points_capture))];
    }
    const total = mine.red + mine.blue + mine.green;
    expect(total, 'what the map\'s objectives paid').toBeGreaterThan(0);
    const widths = await page.$$eval(`${POP} .wvw-scorebar-seg`, segs => Object.fromEntries(segs.map(s =>
      [['red', 'blue', 'green'].find(c => s.classList.contains('own-' + c)), parseFloat(s.style.width)])));
    for (const c of ['red', 'blue', 'green']) {
      expect(widths[c] ?? 0, `the ${c} segment of the bar, in percent`).toBeCloseTo(mine[c] / total * 100, 1);
    }
  });
});

test.describe('the worth of an objective and the board', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).advance(6, { flips: 4 }).pageOpens() });
  test('Per tick only where it ticks, and PPT is the sum of the ticks', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    await openMap(page, wvw, tier.button);
    const type = await page.locator(`${POP} .wvw-tab.is-active`).getAttribute('data-type');
    const body = served(wvw);
    const list = objectivesOf(body, type);
    const camp = list.find(o => o.type === 'Camp' && o.points_tick === 0);
    const keep = list.find(o => o.type === 'Keep' && o.points_tick === 10);
    expect(camp && keep, 'a camp at T0 and a keep at T3 on the map').toBeTruthy();
    const detail = page.locator(`${POP} .wvw-detail`);
    await page.locator(`${POP} .wvw-marker[data-obj="${camp.id}"]`).dispatchEvent('click');
    await expect(detail.locator('.wvw-row dt', { hasText: 'On capture' }), 'the camp\'s capture row').toBeVisible();
    await expect(detail.locator('.wvw-row dt', { hasText: 'Per tick' }), 'the camp\'s Per tick row').toHaveCount(0);
    await page.locator(`${POP} .wvw-marker[data-obj="${keep.id}"]`).dispatchEvent('click');
    await expect(detail.locator('.wvw-row:has(dt:text-is("Per tick")) dd'), 'the keep\'s Per tick').toHaveText('+10');

    for (const c of ['red', 'blue', 'green']) {
      const ticks = body.maps.flatMap(m => m.objectives).filter(o => String(o.owner).toLowerCase() === c)
        .reduce((n, o) => n + o.points_tick, 0);
      await expect(page.locator(`${POP} .wvw-board-row[data-focus-color="${c}"] .wvw-board-ppt`), `${c}'s PPT`).toHaveText(`+${ticks}`);
    }
  });
});

// A keep recorded at T3 that changes hands goes back to T0, as in the game: its capture is the T0 one and it ticks no more.
const BEFORE = gw2.match(FOCUS).advance(1);
const t3Keep = BEFORE.body(FOCUS, BEFORE.end).maps.flatMap(m => m.objectives.filter(o => o.type === 'Keep' && o.points_tick > 0).map(o => ({ id: o.id, map: m.type })))[0];
test.describe('a T3 keep that changed hands', () => {
  test.use({ timeline: gw2.match(FOCUS).advance(12).advance(4, { flips: [t3Keep.id] }).pageOpens() });
  test('is worth its T0 capture and shows no Per tick', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    await openMap(page, wvw, tier.button);
    await page.locator(`${POP} .wvw-tab[data-type="${t3Keep.map}"]`).click();
    await wvw.settle();
    const keep = objectivesOf(served(wvw), t3Keep.map).find(o => o.id === t3Keep.id);
    expect(keep.points_capture, 'the keep\'s capture as served').toBe(100);
    await page.locator(`${POP} .wvw-marker[data-obj="${t3Keep.id}"]`).dispatchEvent('click');
    await expect(page.locator(`${POP} .wvw-detail .wvw-row:has(dt:text-is("On capture")) dd`), 'the keep\'s capture on the panel').toHaveText('100');
    await expect(page.locator(`${POP} .wvw-detail .wvw-row dt`, { hasText: 'Per tick' }), 'its Per tick row').toHaveCount(0);
  });
});
