// Nothing past the screen's edge: the page at 320, 360 and 390 px, in five
// fonts, at rest, after a guild search, and with a tier's map open.
//
// The viewport is a plain narrow window, not a phone's (support/steps.mjs,
// phone()): a mobile viewport widens itself to fit whatever sticks out, so
// innerWidth no longer says the page is too wide and the defect hides.
// The font is swapped for the whole page by a constructed style sheet added here (the CSP refuses a <style> tag); the
// font each row asked for is confirmed as the one Chrome painted with (the
// named one is among the fonts painted; serif and monospace differ from the
// default's).
// One page per width and font goes through the three states, so a failure
// names the state it was in.
import { test, expect } from './support/fixtures.mjs';
import { pastEdge } from './support/edge.mjs';
import { openMap, search } from './support/steps.mjs';

const WIDTHS = [320, 360, 390];
const FONTS = [
  { name: 'default', css: '' },
  { name: 'DejaVu Sans', css: "'DejaVu Sans'", painted: 'DejaVu Sans' },
  { name: 'serif', css: 'serif' },
  { name: 'monospace', css: 'monospace' },
];

// The finale of a check shakes the page (.struck, translate up to 9 px) and
// drops the panels in (.deploying): measured then, the page is wider than it
// is. Quiet is: the charge gone (it goes at the hit), the shake and the drop
// over, the overlay not playing.
const quiet = page => page.evaluate(() => !document.querySelector('.siege-charge')
  && !document.getElementById('page').matches('.struck, .deploying')
  && !document.querySelector('.impact-overlay.play'));

async function fits(page, wvw, what) {
  await wvw.settle();
  await expect.poll(() => quiet(page), { message: `${what}: the page still shaking or dropping its panels`, timeout: 15000 }).toBe(true);
  const m = await page.evaluate(pastEdge);
  expect(m.past, `${what}: past the edge of ${m.inner} px`).toEqual([]);
}

for (const width of WIDTHS) {
  for (const font of FONTS) {
    test(`nothing past the edge, ${width} px, ${font.name}`, async ({ page, wvw }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(wvw.url);
      await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
      await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      const painted = async () => {
        // Fonts are reported for what has been laid out and painted.
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#guildInput' });
        const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
        return fonts.map(f => f.familyName).sort();
      };
      const before = await painted();
      // A constructed sheet: the page's CSP refuses an inline <style>.
      if (font.css) {
        await page.evaluate(css => {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(`*, *::before, *::after { font-family: ${css} !important; }`);
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        }, font.css);
      }
      const families = await painted();
      if (font.painted) expect(families, `the fonts Chrome painted the page with, wanted ${font.painted}`).toContain(font.painted);
      else if (font.css) expect(families, `the fonts Chrome painted with under ${font.name}, the same as the default's`).not.toEqual(before);
      await fits(page, wvw, `${width} px, ${font.name}, at rest`);
      await search(page, wvw.guilds);
      await fits(page, wvw, `${width} px, ${font.name}, after a search`);
      await openMap(page, wvw, page.locator('.tier-map-btn').first());
      await fits(page, wvw, `${width} px, ${font.name}, map open`);
    });
  }
}

// The shake itself: .page.struck moves the page up to 9 px sideways, and the
// document must not widen while it plays (overflow-x: clip on html and body).
test('the shake does not widen the page, 320 px', async ({ page, wvw }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await wvw.settle();
  const widest = await page.evaluate(() => new Promise(resolve => {
    const el = document.getElementById('page');
    let max = 0;
    const end = performance.now() + 600;
    el.classList.add('struck');
    const tick = () => {
      max = Math.max(max, document.documentElement.scrollWidth);
      if (performance.now() < end) requestAnimationFrame(tick);
      else { el.classList.remove('struck'); resolve(max); }
    };
    tick();
  }));
  expect(widest, 'widest scrollWidth during the shake, in a 320 px window').toBeLessThanOrEqual(320);
});
