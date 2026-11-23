// Each row of the Captures tab carries its map's mark: the map name on a tint
// of the map's colour, EBG neutral and the three borderlands one colour each,
// four distinct backgrounds, at 1280 and 390 px.
import { test, expect } from './support/fixtures.mjs';
import { phone, load, firstTier } from './support/steps.mjs';

const POP = '.info-popover';
const MAPS = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];

for (const width of [1280, 390]) {
  test(`every capture row wears its map's colour at ${width} px`, async ({ page, wvw }) => {
    await page.setViewportSize({ width, height: 800 });
    await load(page, wvw);
    if (width < 700) await phone(page, width);
    const { button } = await firstTier(page);
    await button.click();
    await page.locator(`${POP} .wvw-subtab[data-pane="captures"]`).click();
    await expect(page.locator(`${POP} .wvw-cap`).first()).toBeAttached();
    const rows = await page.locator(`${POP} .wvw-cap`).evaluateAll(els => els.map(e => ({
      map: e.dataset.map, bg: getComputedStyle(e.querySelector('.wvw-cap-map')).backgroundColor,
    })));
    const byMap = {};
    for (const r of rows) (byMap[r.map] ||= new Set()).add(r.bg);
    for (const m of MAPS) {
      expect(byMap[m], `a capture on ${m}`).toBeDefined();
      expect(byMap[m].size, `${m}: one background on every row`).toBe(1);
      expect(byMap[m].values().next().value, `${m} has a tint`).not.toBe('rgba(0, 0, 0, 0)');
    }
    const all = MAPS.map(m => [...byMap[m]][0]);
    expect(new Set(all).size, `four maps, four backgrounds: ${all.join(' | ')}`).toBe(4);
    // Each borderland's tint leans to its own channel; EBG's to none.
    const rgb = (bg) => bg.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lean = { RedHome: 0, GreenHome: 1, BlueHome: 2 };
    for (const [m, i] of Object.entries(lean)) {
      const c = rgb(all[MAPS.indexOf(m)]);
      expect(Math.max(...c), `${m}: ${c}`).toBe(c[i]);
    }
    const ebg = rgb(all[0]);
    expect(Math.max(...ebg) - Math.min(...ebg), `Center is grey: ${ebg}`).toBeLessThan(30);
  });
}
