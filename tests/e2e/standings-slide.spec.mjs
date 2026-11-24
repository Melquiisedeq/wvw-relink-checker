// A side that overtakes another in a tier: the cards slide to their new places in
// SWAP_MS (js/panels.js, slideRun), the climber over the side it passes, and
// nothing of the slide is left behind when it ends. Reduced motion does not stop
// it: it runs once and ends.
import { test, expect } from './support/fixtures.mjs';
import { FOCUS, MIN, hidden, visible } from './support/scenarios.mjs';
import { pastEdge } from './support/edge.mjs';
import { board, load, search, serveList } from './support/steps.mjs';
import { loadNow } from './support/page.mjs';

test.use({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });

const CARDS = `.standing-match[data-match-id="${FOCUS}"] > .standing-side`;

// The side that is ahead of `other` by one victory point.
const overtakeIn = (list, id, ahead, other) => {
  const vp = list.find(m => m.id === id).victory_points;
  vp[ahead] = Number(vp[other]) + 1;
};
const overtake = (list, ahead, other) => overtakeIn(list, FOCUS, ahead, other);

// A board read repaints the tier `id`; this reads the page in the task that repaints it
// (the first in which its cards change order): the animations of transform on the
// cards of the tier, where each card is drawn, and where each was in the last frame.
// The read comes with the tab shown again after 5 min. With `now`, a load at once: hiding
// the tab stops the embers' clock, which hands a slide under way back to play out, and
// 5 min outlast the found strip.
// `spare`: the room left between the climber and the tier box with the slide held at
// 325 ms, then run out.
async function repaint(page, wvw, { freeze = false, hold = false, now = false, id = FOCUS, spare = false } = {}) {
  if (!now) await hidden(page, wvw, 5 * MIN);
  await page.evaluate(async ([id, freeze, hold, spare]) => {
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
    const wasOrder = cards().map(colorOf);
    let was = drawn(), frame = 0;
    const keep = () => { was = drawn(); frame = requestAnimationFrame(keep); };
    frame = requestAnimationFrame(keep);
    window.__repaint = null;
    new MutationObserver((_, watch) => {
      if (cards().map(colorOf).join() === wasOrder.join()) return;
      watch.disconnect();
      cancelAnimationFrame(frame);
      // After the slide's own microtask, queued by the same repaint.
      queueMicrotask(() => {
        // Stopped mid-slide in the task that started it, so a slow machine cannot run it out first.
        if (hold) document.getAnimations().filter(a => !a.animationName).forEach(a => { a.pause(); a.currentTime = 300; });
        const elsewhere = [...document.querySelectorAll('.standing-side')]
          .filter(s => s.closest('.standing-match').dataset.matchId !== id && s.getAnimations().some(a => !a.animationName)).length;
        const strip = document.querySelector(`.standing-match[data-match-id="${id}"] > .guild-found-strip`);
        let room = null;
        if (spare) {
          const anims = document.getAnimations().filter(a => !a.animationName && a.effect.target.closest('.standing-match'));
          anims.forEach(a => { a.pause(); a.currentTime = 325; });
          const s = document.querySelector(`.standing-match[data-match-id="${id}"] > .slide-over`);
          const r = s.getBoundingClientRect(), b = s.parentElement.getBoundingClientRect();
          room = Math.min(r.left - b.left, b.right - r.right);
          anims.forEach(a => a.finish());
        }
        window.__repaint = { was, wasOrder, now: drawn(), slides: slides().sort(), order: cards().map(colorOf), elsewhere,
          strip: strip && { animated: strip.getAnimations().filter(a => !a.animationName).length, over: strip.classList.contains('slide-over') },
          spare: room, duration: cards().flatMap(s => s.getAnimations()).find(a => !a.animationName)?.effect.getTiming().duration ?? null };
      });
    }).observe(document.body, { childList: true, subtree: true });
  }, [id, freeze, hold, spare]);
  if (now) await loadNow(page);
  else await visible(page);
  await page.waitForFunction(() => window.__repaint);
  return page.evaluate(() => window.__repaint);
}

const rest = (page, id = FOCUS) => page.evaluate(id => {
  const cards = [...document.querySelectorAll(`.standing-match[data-match-id="${id}"] > .standing-side`)];
  return {
    order: cards.map(s => ['red', 'blue', 'green'].find(c => s.classList.contains('side-' + c))),
    transforms: cards.map(s => getComputedStyle(s).transform),
    opacities: cards.map(s => getComputedStyle(s).opacity),
    left: document.querySelectorAll('.slide-over, .slide-under, .slide-shadow, .slide-host').length,
    running: document.getAnimations().filter(a => !a.animationName && a.effect.target && a.effect.target.closest('.standing-match')).length,
  };
}, id);

const ended = async (page, id = FOCUS) => {
  await expect.poll(() => rest(page, id).then(r => r.running), { timeout: 3000 }).toBe(0);
  return rest(page, id);
};

test.describe('a side overtakes in a tier', () => {
  for (const move of ['moveBefore', 'insertBefore']) {
    test(`the cards slide to their new places and leave nothing behind (${move})`, async ({ page, wvw }) => {
      if (move === 'insertBefore') await page.addInitScript(() => { delete Element.prototype.moveBefore; });
      await load(page, wvw);
      const { list, byRank: [first, second, third] } = await board(page, FOCUS);
      overtake(list, second, first);
      await serveList(page, list);
      const r = await repaint(page, wvw);

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
    const { list, byRank: [first, second] } = await board(page, FOCUS);
    overtake(list, second, first);
    await serveList(page, list);
    const slide = (await repaint(page, wvw)).duration;
    await ended(page);
    // The columns swapped from the keyboard.
    await page.getByRole('button', { name: 'Swap the NA and EU columns' }).first().press('Enter');
    const swap = await page.evaluate(() => document.querySelector('.rail').getAnimations().find(a => !a.animationName)?.effect.getTiming().duration ?? null);
    expect(swap, 'the columns swapping').not.toBeNull();
    expect(slide, 'the slide, as long as the columns swap').toBe(swap);
  });

  test('plays under reduced motion too', async ({ page, wvw }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await load(page, wvw);
    const { list, byRank: [first, second] } = await board(page, FOCUS);
    overtake(list, second, first);
    await serveList(page, list);
    expect((await repaint(page, wvw)).slides).toHaveLength(2);
    await ended(page);
  });

  test('a second score in the middle of the slide starts from where the cards are drawn and ends in place', async ({ page, wvw }) => {
    await load(page, wvw);
    const { list, byRank: [first, second, third] } = await board(page, FOCUS);
    overtake(list, second, first);
    await serveList(page, list);
    expect((await repaint(page, wvw, { hold: true })).slides).toHaveLength(2);

    // The first takes the lead back, now: the cards turn round where they are.
    const back = JSON.parse(JSON.stringify(list));
    overtake(back, first, second);
    await page.unroute(/^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=/);
    await serveList(page, back);
    const r = await repaint(page, wvw, { freeze: true, now: true });
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
    const { list, byRank: [first, second] } = await board(page, FOCUS);
    overtake(list, second, first);
    await serveList(page, list);
    await repaint(page, wvw);
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('body > .delta')]
      .some(t => t.getAnimations().some(a => !a.animationName && a.effect.getKeyframes()[1].translate !== '0 0')))).toBe(true);
    await ended(page);
  });

  test('the guild-found strip goes with its card', async ({ page, wvw }) => {
    await load(page, wvw);
    // A guild found: the strip hangs from its team's card for some seconds.
    await search(page, wvw.guilds[0]);
    const strip = page.locator('.standing-match > .guild-found-strip');
    await expect(strip).toHaveCount(1);
    const id = await strip.evaluate(s => s.closest('.standing-match').dataset.matchId);
    const found = await strip.evaluate(s => ['red', 'blue', 'green'].find(c => s.previousElementSibling.classList.contains('side-' + c)));
    let { list, byRank } = await board(page, id);
    // The found side climbs: one in the lead is passed first.
    if (byRank[0] === found) {
      overtakeIn(list, id, byRank[1], found);
      await serveList(page, list);
      await repaint(page, wvw, { now: true, id });
      await ended(page, id);
      await page.unroute(/^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=/);
      ({ list, byRank } = await board(page, id));
    }
    overtakeIn(list, id, found, byRank[byRank.indexOf(found) - 1]);
    await serveList(page, list);
    const r = (await repaint(page, wvw, { now: true, id })).strip;
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
    }, id);
    expect(top, 'the strip crosses the overtaken card and is drawn over it').toEqual({ overlap: true, strip: true });
    await ended(page, id);
    expect(await page.locator('.guild-found-strip').evaluate(el => getComputedStyle(el).transform)).toBe('none');
  });

  for (const width of [1280, 390, 320]) {
    test(`the climber is not cut by the tier at ${width}px`, async ({ page, wvw }) => {
      await page.setViewportSize({ width, height: 900 });
      await load(page, wvw);
      const { list, byRank: [first, second] } = await board(page, FOCUS);
      overtake(list, second, first);
      await serveList(page, list);
      const { spare } = await repaint(page, wvw, { spare: true });
      expect(spare, 'room left between the climber and the tier box at mid-slide').toBeGreaterThanOrEqual(0);
      expect((await page.evaluate(pastEdge)).past, 'nothing past the edge at mid-slide').toEqual([]);
    });
  }
});
