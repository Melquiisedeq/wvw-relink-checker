// "What happened" over a tier's map: the block a visitor sees after a gap (the rules
// of when one is raised are in tests/unit/page-rules.test.mjs).
//
// Block: a match answered with the same body for over 10 min while the page
// kept asking, then a body with two objectives taken (one on the open map, one
// on another) and a known number of kills more.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { phone, load, firstTier, openMap, later, keptMatch, iso, play } from './support/steps.mjs';
import { FOCUS, MIN, hidden, missed, missedBehind, missedFrozenAtTurn, missedStopped, missedWeekTurn, visible } from './support/scenarios.mjs';
import { countMissedPaints, forgetKillHistory, keptLive, logTitlesAtKillReads, missedAgainstHistory, missedFromOlderWeek, missedHeld, missedNoted, missedOverdue, missedWeekLive, scoreRoseAt, unholdMissed, weekOf } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });

// ---- The block ------------------------------------------------------------

const TABS = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];
const NAMES = { Center: 'EBG', RedHome: 'Red BL', BlueHome: 'Blue BL', GreenHome: 'Green BL' };
const OWNERS = ['Red', 'Blue', 'Green'];
const BLOCK = '.info-popover .wvw-missed:not(.is-leaving)';
// The block on show, or a note of it the page holds for `id`.
const blockOrNote = async (page, id) => await page.locator(BLOCK).count() > 0 || missedNoted(page, id);
const LIT = ".info-popover .wvw-marker.is-lit";
// The block's title as words, without the count badges riding at its end.
const titleText = (page, sel = BLOCK) => page.evaluate(s => {
  const t = document.querySelector(`${s} .wvw-missed-title`);
  return t ? [...t.childNodes].filter(n => !(n.classList && n.classList.contains('wvw-missed-counts'))).map(n => n.textContent).join('').trim() : null;
}, sel);

// The map opened on the first tier, the same body served for 700 s (over the
// 10 min a summary needs; the block must not show), then the body with an
// objective taken here and one on another map 30 min ago, and kills on both,
// served and pulled 31 s on.
async function gap(page, wvw) {
  await load(page, wvw);
  const tier = await firstTier(page);
  const before = await keptMatch(page, tier.id);
  const same = await answer(page, tier.url, before);
  await openMap(page, wvw, tier.button);
  for (let i = 0; i < 7; i++) await later(page, wvw, 100000);
  const here = await page.locator('.info-popover .wvw-tab.is-active').getAttribute('data-type');
  const other = before.maps.map(m => m.type).find(type => type !== here);
  const takeable = m => (m?.objectives || []).filter(o => ['Camp', 'Tower', 'Keep'].includes(o.type) && OWNERS.includes(o.owner) && /^\d+-\d+$/.test(o.id));
  const drawn = await page.evaluate(() => [...document.querySelectorAll('.info-popover .wvw-marker')].map(g => g.dataset.obj));
  const a = takeable(before.maps.find(m => m.type === here)).find(o => drawn.includes(o.id));
  const b = takeable(before.maps.find(m => m.type === other))[0];
  expect(a && b, `a camp, tower or keep held on ${here} and ${other} to take`).toBeTruthy();
  const after = JSON.parse(JSON.stringify(before));
  const KILLS = { [here]: ['red', 37], [other]: ['blue', 15] };
  const taken = iso(await wvw.now() - 30 * MIN);
  for (const m of after.maps) {
    for (const o of m.objectives) if (o.id === a.id || o.id === b.id) { o.owner = OWNERS[(OWNERS.indexOf(o.owner) + 1) % 3]; o.last_flipped = taken; }
    const k = KILLS[m.type];
    if (k) { m.kills[k[0]] += k[1]; after.kills[k[0]] += k[1]; }
  }
  after.scores.red += 1;
  const serve = async body => { same.off(); return answer(page, tier.url, body); };
  return { tier, before, after, same, here, other, a, b, KILLS, serve, afterTheGap: () => serve(after).then(() => later(page, wvw, 31000)) };
}

test.describe('what happened', () => {
  test('after the gap: both chips, the open map first, exactly those kills; markers, chips', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    const seen = await page.evaluate(sel => { const b = document.querySelector(sel);
      return { open: b.classList.contains('is-open'),
        top: b === b.parentElement.firstElementChild && b.parentElement.classList.contains('wvw-side'),
        chips: [...b.querySelectorAll('.wvw-chip[data-obj]')].map(c => c.dataset.obj + ' ' + c.dataset.map),
        kills: [...b.querySelectorAll('.wvw-missed-row')].map(r => r.querySelector('.wvw-missed-mapname').textContent + ' ' + (r.querySelector('.wvw-missed-kills')?.textContent || '')),
        rings: [...document.querySelectorAll('.info-popover .wvw-marker')].filter(g => g.querySelector('.wvw-ring')).map(g => g.dataset.obj) }; }, BLOCK);
    const want = {
      chips: [[g.a.id, g.here], [g.b.id, g.other]].sort((x, y) => TABS.indexOf(x[1]) - TABS.indexOf(y[1])).map(([id, ty]) => `${id} ${ty}`),
      kills: TABS.filter(ty => g.KILLS[ty]).map(ty => `${NAMES[ty]} ${g.KILLS[ty][1]} kills`), rings: [g.a.id],
    };
    seen.title = await titleText(page);
    expect(seen.title, 'the block title').toMatch(/^What happened · \S/);
    expect(seen.open && seen.top, `the block reads "${seen.title}", open ${seen.open}, at the top of the column ${seen.top}`).toBe(true);
    for (const k of Object.keys(want)) expect(seen[k], k).toEqual(want[k]);
  });

  test('over the tabs, and the board standing still beside it', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    const read = () => page.evaluate(sel => { const p = document.querySelector('.info-popover');
      return Math.round(p.querySelector('.wvw-board').getBoundingClientRect().height) + '/' + Math.round(p.getBoundingClientRect().height)
        + '/' + (document.querySelector(sel).getBoundingClientRect().bottom <= p.querySelector('.wvw-subtabs').getBoundingClientRect().top); }, BLOCK);
    const one = await read();
    await page.waitForTimeout(2500);
    const two = await read();
    expect(one.endsWith('/true'), `the board/popover/block-over-tabs read ${one}`).toBe(true);
    expect(two, 'the board stood still').toBe(one);
  });

  test('a chip of this map lights its objective alone; one of another opens that map with it selected', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    const lit = () => page.evaluate(sel => [...document.querySelectorAll(sel)].map(m => m.dataset.obj).join(), LIT);
    await page.locator(`.info-popover .wvw-chip[data-obj="${g.a.id}"]`).hover();
    await expect.poll(lit, { message: `${g.a.id} alone lit while its chip is pointed at` }).toBe(g.a.id);
    await page.mouse.move(1, 1);
    await expect.poll(lit, { message: 'nothing lit once the chip is left' }).toBe('');
    await page.locator(`.info-popover .wvw-chip[data-obj="${g.b.id}"]`).click();
    await expect(page.locator(`.info-popover .wvw-tab[data-type="${g.other}"].is-active`)).toBeAttached();
    await expect(page.locator(`.info-popover .wvw-marker.is-selected[data-obj="${g.b.id}"]`)).toBeAttached();
    await expect(page.locator('.info-popover .wvw-subtab.is-active')).toHaveAttribute('data-pane', 'objective');
    await expect.poll(lit, { message: `${g.b.id} lit a moment after its chip is pressed` }).toBe(g.b.id);
  });

  test('two badges after the title: the kills first, then the objectives, each with its icon and words', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    const badges = await page.evaluate(sel => [...document.querySelectorAll(`${sel} .wvw-missed-title .wvw-missed-counts > *`)].map(b => ({
      cls: b.className, text: b.textContent, label: b.getAttribute('aria-label'),
      icon: b.querySelector('img') ? b.querySelector('img').getAttribute('src') : b.querySelector('svg') ? 'svg' : null })), BLOCK);
    const kills = g.KILLS[g.here][1] + g.KILLS[g.other][1];
    expect(badges).toEqual([
      { cls: 'wvw-missed-count is-kills', text: String(kills), label: `${kills} kills`, icon: 'assets/icons/Event_Swords.webp' },
      { cls: 'wvw-missed-count is-objectives', text: '2', label: '2 objectives changed hands', icon: 'svg' },
    ]);
    await expect(page.locator(`${BLOCK} .wvw-missed-head`), 'no tooltip on the title').not.toHaveAttribute('title', /./);
  });

  test('a chip leaves the block open; a click on an objective of the map folds it', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    const block = page.locator(BLOCK);
    await expect(block).toHaveClass(/is-open/);
    await page.locator(`.info-popover .wvw-chip[data-obj="${g.b.id}"]`).click();
    await expect(page.locator(`.info-popover .wvw-marker.is-selected[data-obj="${g.b.id}"]`)).toBeAttached();
    await expect(block, 'open after a chip').toHaveClass(/is-open/);
    const other = await page.evaluate(id => [...document.querySelectorAll('.info-popover .wvw-marker')].map(m => m.dataset.obj).find(o => o !== id), g.b.id);
    await page.locator(`.info-popover .wvw-marker[data-obj="${other}"]`).click();
    await expect(page.locator(`.info-popover .wvw-marker.is-selected[data-obj="${other}"]`)).toBeAttached();
    await expect(block, 'folded after a click on the map').not.toHaveClass(/is-open/);
    await expect(block.locator('.wvw-chip')).toHaveCount(0);
  });

  for (const width of [1280, 390]) {
    test(`the Captures tab folds the summary only when the reader opens it, at ${width} px`, async ({ page, wvw }) => {
      const g = await gap(page, wvw);
      await g.afterTheGap();
      const block = page.locator(BLOCK);
      if (width < 700) {
        await phone(page, width);
        // The box repaints as a phone's folded one on the next second; until then it is still the wide one.
        await expect(block).not.toHaveClass(/is-open/);
      }
      const head = block.locator('.wvw-missed-head');
      const tab = name => page.locator(`.info-popover .wvw-subtab[data-pane="${name}"]`);
      const reopen = async () => {
        if (!await block.evaluate(b => b.classList.contains('is-open'))) await head.click();
        await expect(block).toHaveClass(/is-open/);
      };
      await reopen();
      await tab('board').click();
      await expect(block, 'Board leaves it open').toHaveClass(/is-open/);
      await tab('captures').click();
      await expect(block, 'folded by the click on Captures').not.toHaveClass(/is-open/);
      await expect(page.locator('.info-popover .wvw-caps .wvw-cap').first(), 'the list in view').toBeVisible();
      await reopen();
      // Two repaints of the page's own one-second timer, counted at the summary's painter.
      const paints = await countMissedPaints(page);
      await expect.poll(paints, { timeout: 10000 }).toBeGreaterThanOrEqual(2);
      await expect(block, 'open through the repaints').toHaveClass(/is-open/);
      await page.locator(`.info-popover .wvw-tab:not(.is-active)`).first().click();
      await expect(tab('captures')).toHaveClass(/is-active/);
      await expect(block, 'open after a map change').toHaveClass(/is-open/);
      await tab('captures').click();
      await expect(block, 'folded by a click on the tab already shown').not.toHaveClass(/is-open/);
    });
  }

  test('on a phone it starts folded, the title alone, and opens on a tap', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    await phone(page, 360);
    const block = page.locator(BLOCK);
    await expect(block).not.toHaveClass(/is-open/);
    await expect(block.locator('.wvw-chip')).toHaveCount(0);
    expect(await block.textContent(), 'folded, with the kills total in its title').not.toMatch(/\bkills\b/);
    await block.locator('.wvw-missed-head').click();
    await expect(block).toHaveClass(/is-open/);
    await expect(block.locator('.wvw-chip[data-obj]')).toHaveCount(2);
  });

  test('ten minutes on it is gone, and a body with only the score up raises none', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await expect(page.locator(BLOCK)).toBeAttached();
    for (let i = 0; i < 7; i++) await later(page, wvw, 100000);
    await expect(page.locator(BLOCK), 'the block ten minutes after the data came back').toHaveCount(0);
    const scoreOnly = JSON.parse(JSON.stringify(g.after));
    scoreOnly.scores.red += 1;
    await g.serve(scoreOnly);
    await later(page, wvw, 31000);
    await page.waitForTimeout(1500); // the popover's one-second repaint
    expect(await blockOrNote(page, g.tier.id),
      'a body with only the score up raised the block').toBe(false);
  });

  // The ten minutes wait for a reader who has the mouse on the block or the keyboard focus in it; a focus left
  // by a mouse click does not hold it.
  const isHeld = missedHeld;
  const overdue = missedOverdue;
  for (const how of ['mouse', 'keyboard focus']) {
    test(`the ten minutes wait for the ${how}, and the block goes once it leaves`, async ({ page, wvw }) => {
      const g = await gap(page, wvw);
      await g.afterTheGap();
      await expect(page.locator(BLOCK)).toBeAttached();
      for (let i = 0; i < 5; i++) await later(page, wvw, 100000);
      if (how === 'mouse') await page.locator(BLOCK).hover();
      else {
        await page.keyboard.press('Shift');
        await page.locator(`${BLOCK} .wvw-chip[data-obj]`).first().focus();
      }
      await isHeld(page, g.tier.id, true);
      for (let i = 0; i < 3; i++) await later(page, wvw, 100000);
      expect(await overdue(page, g.tier.id), 'the ten minutes are over').toBe(true);
      await expect(page.locator(BLOCK), `the block 14 min on, the ${how} on it`).toBeAttached();
      if (how === 'mouse') await page.mouse.move(2, 2);
      else await page.evaluate(() => document.activeElement.blur());
      await expect(page.locator(BLOCK), `the block once the ${how} left`).toHaveCount(0);
    });
  }

  test('a focus left by a mouse click on a chip does not hold the block once the mouse is away', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    for (let i = 0; i < 5; i++) await later(page, wvw, 100000);
    await page.locator(`${BLOCK} .wvw-chip[data-obj]`).first().click();
    await page.mouse.move(2, 2);
    expect(await page.evaluate(() => document.activeElement.matches('.wvw-missed *')), 'the state: the click left the focus in the block').toBe(true);
    await unholdMissed(page, g.tier.id);   // only a repaint writes it again
    await isHeld(page, g.tier.id, false);
    for (let i = 0; i < 3; i++) await later(page, wvw, 100000);
    await expect(page.locator(BLOCK), 'the block 14 min on, only a click focus in it').toHaveCount(0);
  });

  test('a week that turned takes the block at once, the mouse on it or not', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    await g.afterTheGap();
    await page.locator(BLOCK).hover();
    await isHeld(page, g.tier.id, true);
    await missedFromOlderWeek(page, g.tier.id);
    await later(page, wvw, 2000);
    await expect(page.locator(BLOCK), 'the block of an older week, the mouse on it').toHaveCount(0);
  });

  // The week of the summary ends minutes after it came, well inside the ten: the game has not published the next one,
  // so no body turns it, and the Captures tab is already empty. The block goes with the week, held or not.
  for (const mouse of [false, true]) {
    test(`a week that ended takes the block, no new week up${mouse ? ', the mouse on it' : ''}`, async ({ page, wvw }) => {
      const g = await gap(page, wvw);
      g.after.end_time = iso(await wvw.now() + 3 * MIN);
      await g.afterTheGap();
      await expect(page.locator(BLOCK), 'the summary at the return').toBeAttached();
      if (mouse) {
        await page.locator(BLOCK).hover();
        await isHeld(page, g.tier.id, true);
      }
      await later(page, wvw, 100000);
      expect(await missedWeekLive(page, g.tier.id), 'the state: the week still runs, the block stays').toBe(true);
      await later(page, wvw, 100000);
      expect(await keptLive(page, g.tier.id), 'the state: the week is over').toBe(false);
      await expect(page.locator(BLOCK), 'the block of a week that ended').toHaveCount(0);
    });
  }

  // The keyboard focus inside the block when it goes would fall to <body>: it moves to the Captures tab. A focus
  // outside the block stays where it was.
  for (const inside of [true, false]) {
    test(`a week that ended with the keyboard focus ${inside ? 'in the block: the focus goes to the Captures tab' : 'on the Board tab: the focus stays'}`, async ({ page, wvw }) => {
      const g = await gap(page, wvw);
      g.after.end_time = iso(await wvw.now() + 3 * MIN);
      await g.afterTheGap();
      await expect(page.locator(BLOCK), 'the summary at the return').toBeAttached();
      await page.keyboard.press('Shift');
      if (inside) await page.locator(`${BLOCK} .wvw-chip[data-obj]`).first().focus();
      else await page.locator('.info-popover .wvw-subtab[data-pane="board"]').focus();
      await later(page, wvw, 100000);
      await later(page, wvw, 100000);
      await expect(page.locator(BLOCK), 'the block of a week that ended').toHaveCount(0);
      await expect(page.locator(`.info-popover .wvw-subtab[data-pane="${inside ? 'captures' : 'board'}"]`)).toBeFocused();
    });
  }

  test('a week that ended with the keyboard focus in the folded block on a phone: the focus goes to the Captures tab', async ({ page, wvw }) => {
    const g = await gap(page, wvw);
    g.after.end_time = iso(await wvw.now() + 3 * MIN);
    await g.afterTheGap();
    await phone(page, 390);
    await later(page, wvw, 2000);
    await expect(page.locator(BLOCK), 'the summary at the return').toBeAttached();
    await page.keyboard.press('Shift');
    await page.locator(`${BLOCK} button`).first().focus();
    await later(page, wvw, 100000);
    await later(page, wvw, 100000);
    await expect(page.locator(BLOCK), 'the block of a week that ended').toHaveCount(0);
    const tab = page.locator('.info-popover .wvw-subtab[data-pane="captures"]');
    await expect(tab).toBeFocused();
  });
});

// ---- The block, other shapes ------------------------------------------------
// The same gap as above, made of what the test says: `flips` objectives taken
// on the open map (the first one from nobody when `fromNeutral`), `kills` more
// kills on it. The flips are stamped 30 min ago, before the gap, or 31 s from now with
// `stampNow` (the page then sees them as just made); `noHistory` clears the kept readings
// of the old total before the new body is served.
async function scene(page, wvw, { flips = 1, kills = 0, fromNeutral = false, stampNow = false, noHistory = false }) {
  await load(page, wvw);
  const tier = await firstTier(page);
  const before = await keptMatch(page, tier.id);
  await openMap(page, wvw, tier.button);
  const here = await page.locator('.info-popover .wvw-tab.is-active').getAttribute('data-type');
  const drawn = await page.evaluate(() => [...document.querySelectorAll('.info-popover .wvw-marker')].map(g => g.dataset.obj));
  const held = (before.maps.find(m => m.type === here).objectives)
    .filter(o => ['Camp', 'Tower', 'Keep'].includes(o.type) && OWNERS.includes(o.owner) && /^\d+-\d+$/.test(o.id) && drawn.includes(o.id));
  expect(held.length, `objectives held and drawn on ${here}`).toBeGreaterThanOrEqual(flips);
  const taken = held.slice(0, flips).map(o => o.id);
  if (fromNeutral) for (const o of before.maps.find(m => m.type === here).objectives) if (o.id === taken[0]) o.owner = 'Neutral';
  const same = await answer(page, tier.url, before);
  for (let i = 0; i < 7; i++) await later(page, wvw, 100000);
  const after = JSON.parse(JSON.stringify(before));
  const at = stampNow ? iso(await wvw.now() + 31000) : iso(await wvw.now() - 30 * MIN);
  const map = after.maps.find(m => m.type === here);
  for (const o of map.objectives) if (taken.includes(o.id)) {
    o.owner = fromNeutral && o.id === taken[0] ? 'Red' : OWNERS[(OWNERS.indexOf(o.owner) + 1) % 3];
    o.last_flipped = at;
  }
  if (kills) { map.kills.red += kills; after.kills.red += kills; }
  after.scores.red += 1;
  same.off();
  // No reading of the old total kept: the period's start can only be bounded.
  if (noHistory) await forgetKillHistory(page);
  await answer(page, tier.url, after);
  await later(page, wvw, 31000);
  await expect(page.locator(BLOCK)).toBeAttached();
  return { here, taken, tier };
}

test.describe('what happened, other shapes', () => {
  const kills = page => page.locator(`${BLOCK} .wvw-missed-kills`);

  test('objectives taken and no kills: the block shows the chip and no kills line', async ({ page, wvw }) => {
    const s = await scene(page, wvw, { flips: 1 });
    await expect(page.locator(`${BLOCK} .wvw-chip[data-obj="${s.taken[0]}"]`)).toBeAttached();
    await expect(kills(page)).toHaveCount(0);
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-objectives`)).toHaveText('1');
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-objectives`)).toHaveAttribute('aria-label', '1 objective changed hands');
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-kills`)).toHaveCount(0);
  });

  test('one kill and nothing taken: the block says "1 kill", singular', async ({ page, wvw }) => {
    await scene(page, wvw, { flips: 0, kills: 1 });
    await expect(kills(page)).toHaveCount(1);
    await expect(kills(page)).toHaveText('1 kill');
    await expect(kills(page)).toHaveAttribute('aria-label', /^1 kill on /);
    await expect(page.locator(`${BLOCK} .wvw-chip`)).toHaveCount(0);
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-objectives`)).toHaveCount(0);
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-kills`)).toHaveAttribute('aria-label', '1 kill');
  });

  test('two kills: "2 kills", plural', async ({ page, wvw }) => {
    await scene(page, wvw, { flips: 1, kills: 2 });
    await expect(kills(page)).toHaveText('2 kills');
    await expect(kills(page)).toHaveAttribute('aria-label', /^2 kills on /);
    await expect(page.locator(`${BLOCK} .wvw-missed-count.is-kills`)).toHaveAttribute('aria-label', '2 kills');
  });

  for (const [flips, shown, more] of [[4, 4, 0], [5, 4, 1], [6, 4, 2]]) {
    test(`${flips} objectives taken on one map: ${shown} chips${more ? `, a +${more} button` : ', no button'}`, async ({ page, wvw }) => {
      await scene(page, wvw, { flips });
      await expect(page.locator(`${BLOCK} .wvw-chip[data-obj]`)).toHaveCount(shown);
      const button = page.locator(`${BLOCK} .wvw-chip-more`);
      if (!more) { await expect(button).toHaveCount(0); return; }
      await expect(button).toHaveText(`+${more}`);
      await expect(button).toHaveAttribute('aria-label', new RegExp(`^Show ${more} more on `));
      await button.click();
      await expect(page.locator(`${BLOCK} .wvw-chip[data-obj]`)).toHaveCount(flips);
      await expect(button).toHaveCount(0);
    });
  }

  test('taken from nobody: the chip names Neutral as who held it', async ({ page, wvw }) => {
    const s = await scene(page, wvw, { flips: 2, fromNeutral: true });
    const chip = page.locator(`${BLOCK} .wvw-chip[data-obj="${s.taken[0]}"]`);
    await expect(chip).toHaveAttribute('title', /: taken by .+ from Neutral$/);
    await expect(chip).toHaveAttribute('aria-label', /from Neutral$/);
    await expect(page.locator(`${BLOCK} .wvw-chip[data-obj="${s.taken[1]}"]`)).not.toHaveAttribute('title', /from Neutral$/);
  });

  test('flips only just made, no reading of the old total kept: "since before HH:MM"', async ({ page, wvw }) => {
    await scene(page, wvw, { flips: 1, kills: 5, stampNow: true, noHistory: true });
    await expect(page.locator(`${BLOCK} .wvw-missed-time`)).toHaveText(/^since before \d{1,2}:\d{2}/);
  });

  test('flips from before the gap: the period is a range, never "since before"', async ({ page, wvw }) => {
    await scene(page, wvw, { flips: 1, kills: 5 });
    const time = await page.locator(`${BLOCK} .wvw-missed-time`).textContent();
    expect(time, 'the period').toMatch(/^\d{1,2}:\d{2}.*–.*\d{1,2}:\d{2}/);
  });
});

// ---- The period's end -------------------------------------------------------
// The tab hidden 90 min, the API stopped for the last 23: the body it comes back
// to is 23 min old, and the title ends where the data does, not where the tab did.

test.describe('what you missed, the API stopped at the end of the absence', () => {
  test.use({ timeline: missedStopped() });
  test('the period ends at the data, not at the return', async ({ page, wvw }) => {
    test.slow();
    await load(page, wvw);
    const openedAt = await wvw.now();
    await hidden(page, wvw, 90 * MIN);
    await visible(page);
    await openMap(page, wvw, page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`));
    await expect(page.locator(BLOCK)).toBeAttached();
    const title = () => titleText(page);
    const hhmm = t => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    // The kill history dates the body a moment after the block shows; the title
    // settles on the data's end, and the return's time never comes back.
    await expect.poll(title, { message: 'the title names the end of the data', timeout: 60000 }).toContain(`–${hhmm(openedAt + 67 * MIN)}`);
    expect(await title()).not.toContain(hhmm(openedAt + 90 * MIN));
  });
});

// The same absence, the API back with a higher score and nothing else new, and
// the same absence with the map already open when the tab comes back: the title
// reads the data's end as soon as it is painted and keeps it.
test.describe('what you missed, the end once the data is dated', () => {
  const TIER_BUTTON = page => page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`);
  const hhmm = t => new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const titleOf = page => titleText(page);

  test.describe('the score rises after the return', () => {
    test.use({ timeline: missedStopped().advance(5, { kills: {} }) });
    test('the end does not move later', async ({ page, wvw }) => {
    test.slow();
      await load(page, wvw);
      const openedAt = await wvw.now();
      await hidden(page, wvw, 90 * MIN);
      await visible(page);
      await openMap(page, wvw, TIER_BUTTON(page));
      await expect(page.locator(BLOCK)).toBeAttached();
      await expect.poll(() => titleOf(page), { message: 'the title at the return', timeout: 60000 }).toContain(`–${hhmm(openedAt + 67 * MIN)}`);
      await later(page, wvw, 4 * MIN);
      await page.waitForTimeout(1500);
      expect(await scoreRoseAt(page, '1-1'), 'the state: the score rose after the return').toBeGreaterThan(openedAt + 90 * MIN);
      expect(await titleOf(page), 'the title after the score rose').toContain(`–${hhmm(openedAt + 67 * MIN)}`);
    });
  });

  test.describe('the map is open at the return', () => {
    test.use({ timeline: missedStopped() });
    test('the title is the data\'s end the moment the kill history lands', async ({ page, wvw }) => {
    test.slow();
      await load(page, wvw);
      const openedAt = await wvw.now();
      await openMap(page, wvw, TIER_BUTTON(page));
      // Read the title right after the page's own handlers on each kill-history
      // read, whenever the read lands: not a time the test chooses.
      const titlesSoFar = await logTitlesAtKillReads(page);
      await hidden(page, wvw, 90 * MIN);
      await visible(page);
      await later(page, wvw, 0);
      await expect.poll(async () => (await titlesSoFar()).some(t => t), { message: 'a title after a read of the kill history', timeout: 20000 }).toBe(true);
      const titles = (await titlesSoFar()).filter(Boolean);
      expect(titles[0], 'the title when the history landed').toContain(`–${hhmm(openedAt + 67 * MIN)}`);
    });
  });
});

// ---- The same end as the map's corner -------------------------------------
// The visitor's group a minute behind (two kills on EBG a minute), the tab
// hidden 12 min: the body it comes back to is two kills behind the shared kill
// history. The summary counts to the corner's end, the newest data, whichever
// body brought it.
test.describe('what you missed, the body behind the kill history', () => {
  test.use({ timeline: missedBehind() });
  test('the summary counts to the corner\'s end, not to the body', async ({ page, wvw }) => {
    await load(page, wvw);
    await later(page, wvw, 2 * MIN);
    await hidden(page, wvw, 12 * MIN);
    await visible(page);
    await openMap(page, wvw, page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`));
    await expect(page.locator(BLOCK)).toBeAttached();
    await later(page, wvw, 0);
    await page.waitForTimeout(1500); // the popover's one-second repaint
    const seen = {
      ...await missedAgainstHistory(page, FOCUS),
      ...await page.locator(BLOCK).evaluate(box => ({
        kills: [...box.querySelectorAll('.wvw-missed-killn')].reduce((n, b) => n + Number(b.textContent), 0),
        title: [...box.querySelector('.wvw-missed-title').childNodes].filter(n => !(n.classList && n.classList.contains('wvw-missed-counts'))).map(n => n.textContent).join(''),
      })),
    };
    expect(seen.behind, 'the state: the body kept is behind the kill history').toBeGreaterThan(0);
    expect(seen.kills, 'the kills from the body before up to the newest data').toBe(seen.want);
    expect(seen.title, 'the title ends at the corner\'s time').toContain(`–${seen.end}`);
  });
});

// ---- How long an absence -----------------------------------------------------
// Play with objectives changing hands from the opening; the tab away for 9 min
// (the corner's ten minutes already cover it: nothing), for 25 min coming back
// without the focus (the block fades in all the same), or for over 2 h (the
// block comes folded, its two badges in the title, and opens on a tap).
test.describe('what you missed, by how long the tab was away', () => {
  test.use({ timeline: missed(150, 30) });
  const TIER_BUTTON = page => page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`);

  test('away 9 min: no block, though objectives changed hands', async ({ page, wvw }) => {
    await load(page, wvw);
    const from = await wvw.now();
    await hidden(page, wvw, 9 * MIN);
    await visible(page);
    const to = await wvw.now();
    expect(wvw.timeline.flipsBetween(FOCUS, from - wvw.recordedAt, to - wvw.recordedAt).length, 'the state: flips while away').toBeGreaterThan(0);
    await openMap(page, wvw, TIER_BUTTON(page));
    await later(page, wvw, 0);
    await page.waitForTimeout(1500); // the popover's one-second repaint
    expect(await blockOrNote(page, FOCUS),
      'a summary after 9 min away').toBe(false);
  });

  test('away 25 min with an objective open, back without the focus: the block shows and the objective stays', async ({ page, wvw }) => {
    await load(page, wvw);
    await openMap(page, wvw, TIER_BUTTON(page));
    await page.locator('.info-popover .wvw-plot .wvw-marker').nth(3).dispatchEvent('click');
    const detail = page.locator('.info-popover .wvw-detail');
    await expect(detail.locator('.wvw-detail-name')).toBeVisible();
    await page.evaluate(() => { document.hasFocus = () => false; });
    await hidden(page, wvw, 25 * MIN);
    await visible(page);
    await wvw.settle();
    const block = page.locator(BLOCK);
    await expect(block).toBeAttached();
    expect(await page.evaluate(() => document.hasFocus()), 'the state: the page has no focus').toBe(false);
    await expect.poll(() => block.evaluate(b => getComputedStyle(b).opacity), { message: 'the block\'s opacity', timeout: 3000 }).toBe('1');
    await expect(detail.locator('.wvw-detail-name')).toBeVisible();
    await expect(page.locator('.info-popover .wvw-subtab.is-active')).toHaveAttribute('data-pane', 'objective');
  });

  test('away over 2 h: the block comes folded with both badges, and opens on a tap', async ({ page, wvw }) => {
    test.slow();
    await load(page, wvw);
    await hidden(page, wvw, 2 * 60 * MIN + 10 * MIN);
    await visible(page);
    await openMap(page, wvw, TIER_BUTTON(page));
    const block = page.locator(BLOCK);
    await expect(block).toBeAttached();
    await expect(block).not.toHaveClass(/is-open/);
    await expect(block.locator('.wvw-missed-head')).toHaveAttribute('aria-expanded', 'false');
    await expect(block.locator('.wvw-chip')).toHaveCount(0);
    await expect(block.locator('.wvw-missed-count.is-kills')).toHaveAttribute('aria-label', /^\d+ kills$/);
    await expect(block.locator('.wvw-missed-count.is-objectives')).toHaveAttribute('aria-label', /^\d+ objectives changed hands$/);
    await block.locator('.wvw-missed-head').click();
    await expect(block).toHaveClass(/is-open/);
    await expect(block.locator('.wvw-chip[data-obj]').first()).toBeAttached();
  });
});

// ---- The week turns while the tab is away -----------------------------------
// 20 min of a fight (60 kills, six objectives flipped) end the week; the tab,
// hidden with the map open, is shown 2 min into the new one: the map is on the
// new week and nothing is said of the old. Hidden again for 20 min of the new
// week, the summary counts those 20 min alone, and the list is on the new week.
test.describe('what you missed, the week turned while the tab was away', () => {
  // The embers stand still: drawn on every step of play(), they push this test into its slow() ceiling.
  test.use({ timeline: missedWeekTurn(20, 40), clock: 'playwright', reducedMotion: 'reduce' });
  const TIER_BUTTON = page => page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`);

  test('the week on show is the new one, and the summary counts from the turn', async ({ page, wvw }) => {
    test.slow();
    await load(page, wvw);
    await openMap(page, wvw, TIER_BUTTON(page));
    const week = () => weekOf(page, FOCUS);
    const noted = () => blockOrNote(page, FOCUS);
    const old = (await week()).map;
    const end = wvw.timeline.end;
    await hidden(page, wvw, wvw.recordedAt + end - 38 * MIN - await wvw.now());
    await visible(page);
    await later(page, wvw, 0);
    await page.waitForTimeout(1500);
    const start = wvw.timeline.body(FOCUS, end).start_time;
    expect(start, 'the state: the week turned').not.toBe(old);
    expect((await week()).map, 'the map\'s week after the return').toBe(start);
    expect(await noted(), 'a summary after the week turned').toBe(false);

    // The map's next reads, inside the 2 min the return waits for a body, still say nothing.
    await play(page, 75 * 1000, { using: true });
    expect(await noted(), 'a summary on the reads after the return').toBe(false);
    const from = await wvw.now() - wvw.recordedAt;
    await hidden(page, wvw, 20 * MIN);
    await visible(page);
    await later(page, wvw, 0);
    await expect(page.locator(BLOCK)).toBeAttached();
    const to = await wvw.now() - wvw.recordedAt;
    const kills = wvw.timeline.killsByMap(FOCUS, to).Center - wvw.timeline.killsByMap(FOCUS, from).Center;
    const flips = wvw.timeline.flipsBetween(FOCUS, from, to).map(f => f.id);
    expect(kills, 'the state: kills of the new week while away').toBe(40);
    expect(flips.length, 'the state: objectives flipped while away').toBeGreaterThan(0);
    const seen = await page.evaluate(sel => ({
      chips: [...document.querySelectorAll(`${sel} .wvw-chip[data-obj]`)].map(c => c.dataset.obj),
      kills: document.querySelector(`${sel} .wvw-missed-count.is-kills`)?.getAttribute('aria-label') }), BLOCK);
    expect(seen.kills, 'kills in the summary').toBe(`${kills} kills`);
    expect(seen.chips, 'objectives in the summary').toEqual(flips);
    // The list waits behind the open map by design; closed, it reads what it owes.
    await page.keyboard.press('Escape');
    for (let i = 0; i < 6 && (await week()).list !== start; i++) {
      await play(page, 30 * 1000, { using: true });
      await wvw.settle();
    }
    expect((await week()).list, 'the list\'s week within 3 min of the map closing').toBe(start);
  });
});

// ---- A summary up when the week turns ---------------------------------------
// What the tab missed belongs to the week it was raised in: once the week turns
// it goes, though its ten minutes are not over.
test.describe('what you missed, the summary is gone once the week turns', () => {
  test.use({ clock: 'playwright', reducedMotion: 'reduce' });
  const TIER_BUTTON = page => page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`);
  const noted = async page => ({ block: await page.locator(BLOCK).count() > 0, note: await missedNoted(page, FOCUS) });

  test.describe('a return 3 min before the turn', () => {
    test.use({ timeline: missedWeekTurn(14, 40) });
    test('the tab is visible through the turn', async ({ page, wvw }) => {
      test.slow();
      await load(page, wvw);
      await openMap(page, wvw, TIER_BUTTON(page));
      await hidden(page, wvw, 12 * MIN);
      await visible(page);
      await later(page, wvw, 0);
      await expect(page.locator(BLOCK), 'the summary at the return').toBeAttached();
      const old = await weekOf(page, FOCUS).then(w => w.map);
      for (let i = 0; i < 10 && (await weekOf(page, FOCUS).then(w => w.map)) === old; i++) {
        await play(page, 30 * 1000, { using: true });
        await wvw.settle();
      }
      expect(await weekOf(page, FOCUS).then(w => w.map), 'the state: the map is on the new week').not.toBe(old);
      await play(page, 15 * 1000, { using: true });
      expect(await noted(page), 'a summary of the old week in the new one').toEqual({ block: false, note: false });
    });
  });

  test.describe('the API frozen through the gap', () => {
    test.use({ timeline: missedFrozenAtTurn() });
    test('the tab is visible through the turn', async ({ page, wvw }) => {
      test.slow();
      await load(page, wvw);
      await openMap(page, wvw, TIER_BUTTON(page));
      const week = () => weekOf(page, FOCUS).then(w => w.map);
      const old = await week();
      for (let i = 0; i < 40 && !(await noted(page)).note; i++) await play(page, 30 * 1000, { using: true });
      expect((await noted(page)).note, 'the state: a summary raised before the turn').toBe(true);
      for (let i = 0; i < 20 && (await week()) === old; i++) await play(page, 30 * 1000, { using: true });
      expect(await week(), 'the state: the map is on the new week').not.toBe(old);
      await play(page, 15 * 1000, { using: true });
      expect(await noted(page), 'a summary of the old week in the new one').toEqual({ block: false, note: false });
    });
  });
});
