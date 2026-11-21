// Each map tab carries its map's colour as a 2px line along its top: EBG grey,
// the borderlands red, blue and green; four tabs, four colours, at 1280 and 390 px.
// The open tab's cyan swallows those, so there the line is a darker tone of the same map.
import { test, expect } from './support/fixtures.mjs';
import { phone, load, firstTier } from './support/steps.mjs';

const POP = '.info-popover';
const CLOSED = { Center: 'rgb(195, 204, 215)', RedHome: 'rgb(225, 92, 92)', BlueHome: 'rgb(91, 143, 240)', GreenHome: 'rgb(76, 175, 125)' };
const OPEN = { Center: 'rgb(74, 85, 99)', RedHome: 'rgb(162, 42, 42)', BlueHome: 'rgb(31, 79, 181)', GreenHome: 'rgb(23, 97, 58)' };

// The tab's shadows, split at the commas outside the colours' parentheses.
const shadows = tab => tab.evaluate(el => getComputedStyle(el).boxShadow.split(/,(?![^(]*\))/).map(s => s.trim()));

for (const width of [1280, 390]) {
  test(`every map tab wears its map's colour on top at ${width} px`, async ({ page, wvw }) => {
    await page.setViewportSize({ width, height: 800 });
    await load(page, wvw);
    if (width < 700) await phone(page, width);
    const { button } = await firstTier(page);
    await button.click();
    const tabs = page.locator(`${POP} .wvw-tab`);
    await expect(tabs.first()).toBeAttached();
    const top = async type => {
      const [first] = await shadows(page.locator(`${POP} .wvw-tab[data-type="${type}"]`));
      return first;
    };
    const seen = {};
    for (const type of Object.keys(CLOSED)) {
      const tab = page.locator(`${POP} .wvw-tab[data-type="${type}"]`);
      await expect(tab, `a tab for ${type}`).toBeAttached();
      if (await tab.evaluate(el => el.classList.contains('is-active'))) continue;
      seen[type] = await top(type);
      expect(seen[type], `${type}: a 2px line of its colour, inset, on top`).toBe(`${CLOSED[type]} 0px 2px 0px 0px inset`);
    }
    expect(Object.keys(seen).length, 'three closed tabs at least').toBeGreaterThanOrEqual(3);
    expect(new Set(Object.values(seen)).size, 'one colour per map').toBe(Object.keys(seen).length);

    for (const type of Object.keys(OPEN)) {
      const tab = page.locator(`${POP} .wvw-tab[data-type="${type}"]`);
      await tab.click();
      await expect(tab).toHaveClass(/is-active/);
      await page.mouse.move(0, 0);
      await expect.poll(() => top(type), `${type} open: the dark tone`).toBe(`${OPEN[type]} 0px 2px 0px 0px inset`);
      const all = await shadows(tab);
      expect(all.join('|'), 'no 1px glow left').not.toContain('rgba(255, 255, 255');
    }
  });
}
