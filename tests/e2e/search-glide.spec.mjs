import { test, expect } from './support/fixtures.mjs';
import { frame, load, search } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });

// ---- the page travelling to the found card, and the visitor stopping it ---------
// A guild found below the fold: the page glides to its card. A wheel, a touch, a
// key or a click while it glides gives the page back where it is. The card is held from that
// moment: its blink may have ended before the page is looked at again. The first
// scroll event after the card starts blinking is the page on its way, and the
// visitor acts right there, so the glide is cut mid-way every time.
for (const kind of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
  test.describe(`${kind} while the page glides to the found guild's card`, () => {
    test.use({ viewport: { width: 1280, height: 420 } });

    test('the page stops where it is, the card still out of view', async ({ page, wvw }) => {
      await load(page, wvw);
      await page.evaluate(kind => {
        window.__cut = null;
        window.addEventListener('scroll', () => {
          if (window.__cut !== null || !document.querySelector('.guild-found-flash')) return;
          window.__cut = window.scrollY;
          window.__card = document.querySelector('.guild-found-flash');
          window.dispatchEvent(new Event(kind));
        }, { passive: true });
      }, kind);
      await search(page, [wvw.guilds[0]]);
      await expect.poll(() => page.evaluate(() => window.__cut), { message: 'the page on its way to the card' }).not.toBeNull();
      const cut = await page.evaluate(() => window.__cut);
      // A glide to a card ~1600 px down takes far longer than these frames (90 is a second and a half at 60 Hz).
      // Frames are the wait: the glide moves on them, and a frame count does not depend on the clock.
    await page.evaluate(n => new Promise(done => { const tick = () => (--n > 0 ? requestAnimationFrame(tick) : done()); tick(); }), 90);
      const end = await page.evaluate(() => ({ y: window.scrollY, top: window.__card.getBoundingClientRect().top, h: innerHeight }));
      expect(end.y, `the page went on from ${cut} px after the ${kind}`).toBe(cut);
      expect(end.top, 'the found card, its top (px) below the window').toBeGreaterThan(end.h);
      await wvw.settle();
    });
  });
}
