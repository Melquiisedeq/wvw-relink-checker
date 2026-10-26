// A new score on a board of the same shape is written into the cards on the
// page (renderStandingsRegion, patchStandingsRegion): the cards, their badges
// and the "Synced" dot stay the same elements, only the numbers that moved
// flash, a side that overtakes is moved rather than built again, and every
// popover button opens on the new body. A board of another shape is built
// again.
import { test, expect } from './support/fixtures.mjs';
import { FOCUS } from './support/scenarios.mjs';
import { load, serveList } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });

const COLORS = ['red', 'blue', 'green'];

// Every body on show, as copies, and the colours of FOCUS by rank.
const board = page => page.evaluate(id => {
  const list = [...matchDataCache.values()].map(m => JSON.parse(JSON.stringify(m)));
  const rank = rankMatchByVictoryPoints(matchDataCache.get(id));
  return { list, byRank: Object.keys(rank).sort((a, b) => rank[a] - rank[b]) };
}, FOCUS);

// Marks every card, badge and the live dots, so a later look can tell the
// same element from a new one.
const mark = page => page.evaluate(() => {
  let n = 0;
  for (const el of document.querySelectorAll('.standing-side, .rank-badge, .tier-map-btn, .standings-status .live-dot')) el.__mark = ++n;
  return n;
});

const look = page => page.evaluate(id => {
  const all = [...document.querySelectorAll('.standing-side, .rank-badge, .tier-map-btn, .standings-status .live-dot')];
  const card = document.querySelector(`.standing-match[data-match-id="${id}"]`);
  const colorOf = el => ['red', 'blue', 'green'].find(c => el.closest('.standing-side').classList.contains('side-' + c));
  return {
    total: all.length,
    unmarked: all.filter(el => !el.__mark).length,
    order: [...card.querySelectorAll('.standing-side')].map(s => ['red', 'blue', 'green'].find(c => s.classList.contains('side-' + c))),
    badges: Object.fromEntries([...card.querySelectorAll('.standing-side')].map(s => [colorOf(s), s.querySelector('.rank-badge').textContent])),
    flashed: [...document.querySelectorAll('.value-changed')].map(el =>
      `${el.closest('.standing-match').dataset.matchId} ${colorOf(el)} ${el.closest('.standing-vp') ? 'vp' : 'skirmish'}`).sort(),
    pulsed: [...document.querySelectorAll('.standing-side.side-pulse')].map(s => `${s.closest('.standing-match').dataset.matchId} ${colorOf(s)}`).sort(),
    mapBody: tierMapButtons.get(card.querySelector('.tier-map-btn')).match.victory_points,
  };
}, FOCUS);

// The width transitions running on a side's skirmish bar, read in the task
// that repainted the board.
const repaint = (page, color) => page.evaluate(async ([id, c]) => {
  await loadStandings();
  const fill = document.querySelector(`.standing-match[data-match-id="${id}"] .side-${c} .skirmish-bar-fill`);
  return fill.getAnimations().filter(a => a.transitionProperty === 'width').length;
}, [FOCUS, color]);

test.describe('a new score on the same board', () => {
  // Without moveBefore (Firefox, Safari) a card moved by insertBefore loses its
  // style, and the bar's transition needs one to start from.
  for (const move of ['moveBefore', 'insertBefore']) test(`is written into the cards that are there (${move})`, async ({ page, wvw }) => {
    if (move === 'insertBefore') await page.addInitScript(() => { delete Element.prototype.moveBefore; });
    await load(page, wvw);
    const { list, byRank: [first, second, third] } = await board(page);
    const focus = list.find(m => m.id === FOCUS);
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

    const before = await mark(page);
    await serveList(page, list);
    const moving = await repaint(page, second);
    const after = await look(page);

    expect(after.total, 'as many cards, badges, map buttons and dots as before').toBe(before);
    expect(after.unmarked, 'none of them a new element').toBe(0);
    expect(after.order, 'the side that overtook moved up').toEqual([second, first, third]);
    expect(after.badges).toEqual({ [second]: '1', [first]: '2', [third]: '3' });
    expect(after.flashed, 'only the numbers that changed flash').toEqual(
      [`${FOCUS} ${first} vp`, `${FOCUS} ${second} vp`, `${FOCUS} ${third} skirmish`].sort());
    expect(after.pulsed).toEqual(COLORS.map(c => `${FOCUS} ${c}`).sort());
    await expect(page.locator('.delta'), 'one delta per number that changed').toHaveCount(3);
    expect((await page.locator('.delta').allTextContents()).sort()).toEqual(['+1', `+${rise.toLocaleString('en-US')}`, `+${lead.toLocaleString('en-US')}`].sort());
    expect(after.mapBody, 'the map button holds the new body').toEqual(vp);
    expect(moving, 'the bar of the side that moved travels to its new width').toBe(1);

    // The Activity button of the side that fought opens on the new body.
    const side = page.locator(`.standing-match[data-match-id="${FOCUS}"] .standing-side.side-${first}`);
    await side.locator('.activity-info-btn').click();
    await expect(page.locator('.info-popover .pop-figure').first()).toContainText(kills.toLocaleString('en-US'));

    // The flash ends and takes its class with it: the next score flashes only what moves then.
    await expect(page.locator('.value-changed')).toHaveCount(0, { timeout: 4000 });
    await wvw.settle();
  });

  test('of another shape is built again', async ({ page, wvw }) => {
    await load(page, wvw);
    const { list } = await board(page);
    // Two teams of FOCUS trade colours: no card on the page is theirs any more.
    const focus = list.find(m => m.id === FOCUS);
    for (const key of ['all_worlds', 'worlds']) [focus[key].red, focus[key].blue] = [focus[key].blue, focus[key].red];
    focus.kills.red = Number(focus.kills.red) + 1;
    const blueName = await page.locator(`.standing-match[data-match-id="${FOCUS}"] .side-blue .standing-side-name`).textContent();
    await mark(page);
    await serveList(page, list);
    await page.evaluate(() => loadStandings());
    const fresh = await page.evaluate(() => [...document.querySelectorAll('#standingsGridNA .standing-side')].every(el => !el.__mark));
    expect(fresh, 'every NA card built again').toBe(true);
    await expect(page.locator(`.standing-match[data-match-id="${FOCUS}"] .side-red .standing-side-name`)).toHaveText(blueName);
    await wvw.settle();
  });
});
