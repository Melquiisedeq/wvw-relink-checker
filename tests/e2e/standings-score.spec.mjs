// A new score on a board of the same shape is written into the cards on the
// page (renderStandingsRegion, patchStandingsRegion): the cards, their badges
// and the "Synced" dot stay the same elements, only the numbers that moved
// flash, a side that overtakes is moved rather than built again, and every
// popover button opens on the new body. A board of another shape is built
// again.
import { test, expect } from './support/fixtures.mjs';
import { FOCUS } from './support/scenarios.mjs';
import { board, load, search, serveList } from './support/steps.mjs';
import { loadNow, logOpeningScores, mapsScriptIn } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });

const COLORS = ['red', 'blue', 'green'];

// Marks every card, badge and the live dots, so a later look can tell the
// same element from a new one.
const mark = page => page.evaluate(() => {
  let n = 0;
  for (const el of document.querySelectorAll('.standing-side, .rank-badge, .tier-map-btn, .standings-status .live-dot')) el.__mark = ++n;
  return n;
});

// Every skirmish bar added to the board, with the width it has as it enters (read before
// the frame that writes the next), and every bar that starts a width transition, each
// bar as "<match> <colour>".
async function watchBars(page) {
  const seen = { added: [], ran: [] };
  await page.exposeFunction('barAdded', (key, width) => { seen.added.push([key, width]); });
  await page.exposeFunction('barRan', key => { seen.ran.push(key); });
  await page.evaluate(() => {
    const key = el => {
      const side = el.closest('.standing-side');
      return `${side.closest('.standing-match').dataset.matchId} ${['red', 'blue', 'green'].find(c => side.classList.contains('side-' + c))}`;
    };
    new MutationObserver(records => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        for (const f of n.matches('.skirmish-bar-fill') ? [n] : n.querySelectorAll('.skirmish-bar-fill')) window.barAdded(key(f), f.style.width);
      }
    }).observe(document.body, { subtree: true, childList: true });
    document.addEventListener('transitionrun', e => {
      if (e.propertyName === 'width' && e.target.matches('.skirmish-bar-fill')) window.barRan(key(e.target));
    }, true);
  });
  return seen;
}

const look = (page, id) => page.evaluate(id => {
  const all = [...document.querySelectorAll('.standing-side, .rank-badge, .tier-map-btn, .standings-status .live-dot')];
  const card = document.querySelector(`.standing-match[data-match-id="${id}"]`);
  const colorOf = el => ['red', 'blue', 'green'].find(c => el.closest('.standing-side').classList.contains('side-' + c));
  return {
    total: all.length,
    unmarked: all.filter(el => !el.__mark).length,
    order: [...card.querySelectorAll('.standing-side')].map(s => ['red', 'blue', 'green'].find(c => s.classList.contains('side-' + c))),
    badges: Object.fromEntries([...card.querySelectorAll('.standing-side')].map(s => [colorOf(s), s.querySelector('.rank-badge').textContent])),
    badgeClasses: Object.fromEntries([...card.querySelectorAll('.standing-side')].map(s => [colorOf(s), s.querySelector('.rank-badge').className])),
    moves: Object.fromEntries([...card.querySelectorAll('.standing-side')].map(s => [colorOf(s), s.querySelector('.movement-indicator').title])),
    flashed: [...document.querySelectorAll('.value-changed')].map(el =>
      `${el.closest('.standing-match').dataset.matchId} ${colorOf(el)} ${el.closest('.standing-vp') ? 'vp' : 'skirmish'}`).sort(),
    pulsed: [...document.querySelectorAll('.standing-side.side-pulse')].map(s => `${s.closest('.standing-match').dataset.matchId} ${colorOf(s)}`).sort(),
  };
}, id);

test.describe('a new score on the same board', () => {
  // Without moveBefore (Firefox, Safari) a card moved by insertBefore loses its
  // style, and the bar's transition needs one to start from.
  for (const move of ['moveBefore', 'insertBefore']) test(`is written into the cards that are there (${move})`, async ({ page, wvw }) => {
    if (move === 'insertBefore') await page.addInitScript(() => { delete Element.prototype.moveBefore; });
    await load(page, wvw);
    // The guild-found strip hangs under the side that will move: the first guild of the
    // recording is the second of the tier it is found in.
    await search(page, wvw.guilds.slice(0, 1));
    const strip = page.locator('.guild-found-strip');
    await expect(strip).toHaveCount(1);
    const id = await strip.evaluate(s => s.closest('.standing-match').dataset.matchId);
    const { list, byRank } = await board(page, id);
    const [first, second, third] = byRank;
    expect(id, "the recording's first guild is in the last tier of NA (the premise of this test)").toBe(`1-${wvw.tiers.NA}`);
    const focus = list.find(m => m.id === id);
    const vp = focus.victory_points;
    // The second overtakes the first; the third takes the skirmish lead, so
    // every bar moves; the first fights (Activity moves, and never flashes).
    const top = Number(vp[first]);
    const rise = top + 3 - Number(vp[second]);
    vp[first] = top + 1;
    vp[second] = top + 3;
    const last = focus.skirmishes[focus.skirmishes.length - 1];
    const lead = Math.max(...COLORS.map(c => Number(last.scores[c]))) + 1000 - Number(last.scores[third]);
    last.scores[third] = Number(last.scores[third]) + lead;
    focus.scores[third] = Number(focus.scores[third]) + lead;
    focus.kills[first] = Number(focus.kills[first]) + 7;
    const kills = focus.kills[first];
    const total = COLORS.reduce((n, c) => n + Number(focus.scores[c]), 0);

    const before = await mark(page);
    const bars = await watchBars(page);
    await serveList(page, list);
    await loadNow(page);
    await expect(page.locator('.delta'), 'one delta per number that changed').toHaveCount(3);
    const after = await look(page, id);

    expect(after.total, 'as many cards, badges, map buttons and dots as before').toBe(before);
    expect(after.unmarked, 'none of them a new element').toBe(0);
    expect(after.order, 'the side that overtook moved up').toEqual([second, first, third]);
    expect(after.badges).toEqual({ [second]: '1', [first]: '2', [third]: '3' });
    expect(after.badgeClasses, 'each badge is coloured for its new rank').toEqual({
      [second]: 'rank-badge rank-1', [first]: 'rank-badge rank-2', [third]: 'rank-badge rank-3' });
    expect(after.moves, 'and each says where its rank sends it at the next reset (the last tier, where a third has nowhere lower to go)').toEqual({
      [second]: 'Moves up next reset', [first]: 'Stays in this tier next reset', [third]: 'Already the bottom tier' });
    expect(after.flashed, 'only the numbers that changed flash').toEqual(
      [`${id} ${first} vp`, `${id} ${second} vp`, `${id} ${third} skirmish`].sort());
    expect(after.pulsed).toEqual(COLORS.map(c => `${id} ${c}`).sort());
    expect((await page.locator('.delta').allTextContents()).sort()).toEqual(['+1', `+${rise.toLocaleString('en-US')}`, `+${lead.toLocaleString('en-US')}`].sort());
    await expect.poll(() => bars.ran.filter(k => k === `${id} ${second}`).length, { message: 'the bar of the side that moved travels to its new width' }).toBe(1);
    expect(await page.evaluate(([id, c]) => {
      const box = document.querySelector(`.standing-match[data-match-id="${id}"]`);
      const strips = box.querySelectorAll('.guild-found-strip');
      return strips.length === 1 && box.querySelector(`.side-${c}`).nextElementSibling === strips[0];
    }, [id, second]), 'one guild-found strip, under the side that moved').toBe(true);
    await wvw.settle();
    expect(bars.ran.filter(k => k === `${id} ${second}`), 'and travels once').toHaveLength(1);

    // The Activity button of the side that fought opens on the new body.
    const side = page.locator(`.standing-match[data-match-id="${id}"] .standing-side.side-${first}`);
    await side.locator('.activity-info-btn').click();
    await expect(page.locator('.info-popover .pop-figure').first()).toContainText(kills.toLocaleString('en-US'));
    await page.keyboard.press('Escape');
    await expect(page.locator('.info-popover')).toHaveCount(0);

    // The map button of the tier opens on the new body.
    await expect.poll(() => mapsScriptIn(page), { message: 'maps.js in' }).toBe(true);
    const opened = await logOpeningScores(page);
    await page.locator(`.standing-match[data-match-id="${id}"] .tier-map-btn`).click();
    await expect.poll(async () => (await opened())[0], { message: 'the map drawn from the new body' }).toBe(total);
    await page.keyboard.press('Escape');
    await expect(page.locator('.info-popover')).toHaveCount(0);

    // The flash ends and takes its class with it: the next score flashes only what moves then.
    await expect(page.locator('.value-changed')).toHaveCount(0, { timeout: 4000 });
    await wvw.settle();
  });

  test('of another shape is built again', async ({ page, wvw }) => {
    await load(page, wvw);
    const { list } = await board(page, FOCUS);
    // Two teams of FOCUS trade colours: no card on the page is theirs any more.
    const focus = list.find(m => m.id === FOCUS);
    for (const key of ['all_worlds', 'worlds']) [focus[key].red, focus[key].blue] = [focus[key].blue, focus[key].red];
    focus.kills.red = Number(focus.kills.red) + 1;
    // Red takes the skirmish lead, so green's bar shrinks: built again, it starts
    // from the width it had and travels to the new one.
    const last = focus.skirmishes[focus.skirmishes.length - 1];
    last.scores.red = Math.max(...COLORS.map(c => Number(last.scores[c]))) * 3 + 1000;
    const blueName = await page.locator(`.standing-match[data-match-id="${FOCUS}"] .side-blue .standing-side-name`).textContent();
    const green = `.standing-match[data-match-id="${FOCUS}"] .side-green .skirmish-bar-fill`;
    const wasWidth = await page.locator(green).evaluate(el => el.style.width);
    await mark(page);
    const bars = await watchBars(page);
    await serveList(page, list);
    await loadNow(page);
    await expect.poll(() => bars.added.some(([key]) => key === `${FOCUS} green`), { message: 'the bars built again' }).toBe(true);
    const startWidth = bars.added.find(([key]) => key === `${FOCUS} green`)[1];
    const fresh = await page.evaluate(() => [...document.querySelectorAll('#standingsGridNA .standing-side')].every(el => !el.__mark));
    expect(fresh, 'every NA card built again').toBe(true);
    expect(startWidth, "the bar built again starts at the width it had").toBe(wasWidth);
    await expect.poll(() => page.locator(green).evaluate(el => el.style.width), 'then travels to the new one').not.toBe(wasWidth);
    await expect(page.locator(`.standing-match[data-match-id="${FOCUS}"] .side-red .standing-side-name`)).toHaveText(blueName);
    await wvw.settle();
  });
});
