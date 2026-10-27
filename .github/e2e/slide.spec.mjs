// A side that overtakes another in a tier: the cards slide to their new places in
// SWAP_MS (js/panels.js, slideRun), the climber over the side it passes, and
// nothing of the slide is left behind when it ends. Reduced motion does not stop
// it: it runs once and ends.
import { test, expect } from './support/fixtures.mjs';
import { FOCUS } from './support/scenarios.mjs';
import { load, serveList } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });

const CARDS = `.standing-match[data-match-id="${FOCUS}"] > .standing-side`;

// The tier's bodies as copies, and the colours of FOCUS by rank.
const board = page => page.evaluate(id => {
  const list = [...matchDataCache.values()].map(m => JSON.parse(JSON.stringify(m)));
  const rank = rankMatchByVictoryPoints(matchDataCache.get(id));
  return { list, byRank: Object.keys(rank).sort((a, b) => rank[a] - rank[b]) };
}, FOCUS);

// The side that is ahead of `other` by one victory point.
const overtake = (list, ahead, other) => {
  const vp = list.find(m => m.id === FOCUS).victory_points;
  vp[ahead] = Number(vp[other]) + 1;
};

// Reads the page in the task that repaints it: the animations of transform on
// the cards of the tier, and where each card is drawn.
const repaint = (page, freeze = false) => page.evaluate(async ([id, freeze]) => {
  const cards = () => [...document.querySelectorAll(`.standing-match[data-match-id="${id}"] > .standing-side`)];
  const colorOf = el => ['red', 'blue', 'green'].find(c => el.classList.contains('side-' + c));
  const slides = () => cards().filter(s => s.getAnimations().some(a => !a.animationName
    && a.effect.getKeyframes().some(k => k.transform && k.transform !== 'none'))).map(colorOf);
  // The centre: a card in the middle of its climb is scaled about it.
  const drawn = () => Object.fromEntries(cards().map(s => { const r = s.getBoundingClientRect(); return [colorOf(s), r.top + r.height / 2]; }));
  // Held still, so the time the request takes does not move the cards it is compared with.
  if (freeze) {
    const held = document.getAnimations().filter(a => !a.animationName);
    held.forEach(a => a.pause());
    await Promise.all(held.map(a => a.ready));
  }
  const was = drawn();
  const wasOrder = cards().map(colorOf);
  await loadStandings();
  const elsewhere = [...document.querySelectorAll('.standing-side')]
    .filter(s => s.closest('.standing-match').dataset.matchId !== id && s.getAnimations().some(a => !a.animationName)).length;
  return { was, wasOrder, now: drawn(), slides: slides().sort(), order: cards().map(colorOf), elsewhere };
}, [FOCUS, freeze]);

const rest = page => page.evaluate(id => {
  const cards = [...document.querySelectorAll(`.standing-match[data-match-id="${id}"] > .standing-side`)];
  return {
    order: cards.map(s => ['red', 'blue', 'green'].find(c => s.classList.contains('side-' + c))),
    transforms: cards.map(s => getComputedStyle(s).transform),
    opacities: cards.map(s => getComputedStyle(s).opacity),
    left: document.querySelectorAll('.slide-over, .slide-under, .slide-shadow, .slide-host').length,
    running: document.getAnimations().filter(a => !a.animationName && a.effect.target && a.effect.target.closest('.standing-match')).length,
  };
}, FOCUS);

const ended = async page => {
  await expect.poll(() => rest(page).then(r => r.running), { timeout: 3000 }).toBe(0);
  return rest(page);
};

test.describe('a side overtakes in a tier', () => {
  for (const move of ['moveBefore', 'insertBefore']) {
    test(`the cards slide to their new places and leave nothing behind (${move})`, async ({ page, wvw }) => {
      if (move === 'insertBefore') await page.addInitScript(() => { delete Element.prototype.moveBefore; });
      await load(page, wvw);
      const { list, byRank: [first, second, third] } = await board(page);
      overtake(list, second, first);
      await serveList(page, list);
      const r = await repaint(page);

      expect(r.wasOrder).toEqual([first, second, third]);
      expect(r.order, 'the side that overtook moved up').toEqual([second, first, third]);
      expect(r.slides, 'the two that changed places slide, the one that stayed does not').toEqual([first, second].sort());
      expect(r.elsewhere, 'no card of another tier is touched').toBe(0);
      // The first frame still shows every card where it was.
      for (const c of [first, second, third]) expect(Math.abs(r.now[c] - r.was[c]), c).toBeLessThan(1);

      const mid = await page.evaluate(() => {
        return { shadow: document.querySelectorAll('.slide-shadow').length, over: document.querySelectorAll('.slide-over').length, under: document.querySelectorAll('.slide-under').length };
      }, FOCUS);
      expect(mid).toMatchObject({ shadow: 1, over: 1, under: 1 });

      const end = await ended(page);
      expect(end.order).toEqual([second, first, third]);
      expect(end.transforms, 'every card back to no transform').toEqual(['none', 'none', 'none']);
      expect(end.opacities).toEqual(['1', '1', '1']);
      expect(end.left, 'no class, shadow layer or host left').toBe(0);
      await wvw.settle();
    });
  }

  test('lasts as long as the columns take to swap', async ({ page, wvw }) => {
    await load(page, wvw);
    const { list, byRank: [first, second] } = await board(page);
    overtake(list, second, first);
    await serveList(page, list);
    const ms = await page.evaluate(async ([id, c]) => {
      await loadStandings();
      const card = document.querySelector(`.standing-match[data-match-id="${id}"] > .side-${c}`);
      const a = card.getAnimations().find(x => !x.animationName);
      return [a.effect.getTiming().duration, SWAP_MS];
    }, [FOCUS, second]);
    expect(ms[0]).toBe(ms[1]);
  });

  test('plays under reduced motion too', async ({ page, wvw }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await load(page, wvw);
    const { list, byRank: [first, second] } = await board(page);
    overtake(list, second, first);
    await serveList(page, list);
    expect((await repaint(page)).slides).toHaveLength(2);
    await ended(page);
  });

  test('a second score in the middle of the slide starts from where the cards are drawn and ends in place', async ({ page, wvw }) => {
    await load(page, wvw);
    const { list, byRank: [first, second, third] } = await board(page);
    overtake(list, second, first);
    await serveList(page, list);
    await repaint(page);
    await expect.poll(() => page.evaluate(() => document.getAnimations()
      .some(a => !a.animationName && a.effect.target.classList.contains('standing-side') && a.currentTime > 250 && a.currentTime < SWAP_MS))).toBe(true);

    // The first takes the lead back, now: the cards turn round where they are.
    const back = JSON.parse(JSON.stringify(list));
    overtake(back, first, second);
    await page.unroute(/^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=/);
    await serveList(page, back);
    const r = await repaint(page, true);
    expect(r.wasOrder).toEqual([second, first, third]);
    expect(r.order).toEqual([first, second, third]);
    for (const c of [first, second, third]) expect(Math.abs(r.now[c] - r.was[c]), `${c} drawn where it was: ${JSON.stringify([r.was, r.now])}`).toBeLessThan(1);
    expect(r.slides).toEqual([first, second].sort());

    const end = await ended(page);
    expect(end.order).toEqual([first, second, third]);
    expect(end.transforms).toEqual(['none', 'none', 'none']);
    expect(end.opacities).toEqual(['1', '1', '1']);
    expect(end.left).toBe(0);
    await wvw.settle();
  });

  test('a delta born over a card that slides goes with it', async ({ page, wvw }) => {
    await load(page, wvw);
    const { list, byRank: [first, second] } = await board(page);
    overtake(list, second, first);
    await serveList(page, list);
    await repaint(page);
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('body > .delta')]
      .some(t => t.getAnimations().some(a => !a.animationName && a.effect.getKeyframes()[1].translate !== '0 0')))).toBe(true);
    await ended(page);
  });

  test('the guild-found strip goes with its card', async ({ page, wvw }) => {
    await load(page, wvw);
    const { list, byRank: [first, second] } = await board(page);
    await page.evaluate(([id, c]) => showGuildFound(matchTeamId(matchDataCache.get(id), c), 'Found Guild'), [FOCUS, second]);
    overtake(list, second, first);
    await serveList(page, list);
    const r = await page.evaluate(async id => {
      await loadStandings();
      const strip = document.querySelector(`.standing-match[data-match-id="${id}"] > .guild-found-strip`);
      return { animated: strip.getAnimations().filter(a => !a.animationName).length, over: strip.classList.contains('slide-over') };
    }, FOCUS);
    expect(r).toEqual({ animated: 1, over: true });
    // Where the climber's strip crosses the card it overtakes, the strip is on top.
    const top = await page.evaluate(async id => {
      const box = document.querySelector(`.standing-match[data-match-id="${id}"]`);
      const held = document.getAnimations().filter(a => !a.animationName && box.contains(a.effect.target));
      held.forEach(a => { a.pause(); a.currentTime = 325; });
      await Promise.all(held.map(a => a.ready));
      box.scrollIntoView({ block: 'center', behavior: 'instant' });
      const strip = box.querySelector(':scope > .guild-found-strip').getBoundingClientRect();
      const under = box.querySelector(':scope > .slide-under.standing-side').getBoundingClientRect();
      const x = (Math.max(strip.left, under.left) + Math.min(strip.right, under.right)) / 2;
      const y = (Math.max(strip.top, under.top) + Math.min(strip.bottom, under.bottom)) / 2;
      const overlap = Math.min(strip.bottom, under.bottom) > Math.max(strip.top, under.top);
      const hit = document.elementFromPoint(x, y);
      held.forEach(a => a.finish());
      return { overlap, strip: !!(hit && hit.closest('.guild-found-strip')) };
    }, FOCUS);
    expect(top, 'the strip crosses the overtaken card and is drawn over it').toEqual({ overlap: true, strip: true });
    await ended(page);
    expect(await page.locator('.guild-found-strip').evaluate(el => getComputedStyle(el).transform)).toBe('none');
  });

  for (const width of [1280, 390, 320]) {
    test(`the climber is not cut by the tier at ${width}px`, async ({ page, wvw }) => {
      await page.setViewportSize({ width, height: 900 });
      await load(page, wvw);
      const { list, byRank: [first, second] } = await board(page);
      overtake(list, second, first);
      await serveList(page, list);
      const spare = await page.evaluate(async id => {
        await loadStandings();
        const anims = document.getAnimations().filter(a => !a.animationName && a.effect.target.closest('.standing-match'));
        anims.forEach(a => { a.pause(); a.currentTime = 325; });
        const s = document.querySelector(`.standing-match[data-match-id="${id}"] > .slide-over`);
        const r = s.getBoundingClientRect(), b = s.parentElement.getBoundingClientRect();
        const out = Math.min(r.left - b.left, b.right - r.right);
        anims.forEach(a => a.finish());
        return out;
      }, FOCUS);
      expect(spare, 'room left between the climber and the tier box at mid-slide').toBeGreaterThanOrEqual(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
});
