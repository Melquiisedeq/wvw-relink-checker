// Each map tab carries its map's colour as a 2px line along its top: EBG grey,
// the borderlands red, blue and green; four tabs, four colours, at 1280 and 390 px.
// The open tab's cyan swallows those, so there the line is a darker tone of the same map.
// What is held is the relation (each map leans to its own channel, EBG is grey, the open tone is darker
// than the closed one; one colour per map on the closed tabs), not the exact colours.
import { test, expect } from './support/fixtures.mjs';
import { phone, load, firstTier } from './support/steps.mjs';

const POP = '.info-popover';
const TYPES = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];
const LEAN = { RedHome: 0, GreenHome: 1, BlueHome: 2 };
const LINE = /^(rgb\([^)]*\)) 0px 2px 0px 0px inset$/;
const rgb = c => c.match(/[\d.]+/g).slice(0, 3).map(Number);
const sum = c => rgb(c).reduce((a, b) => a + b, 0);
// A map's colour: its own channel is the largest; EBG's channels are close.
function expectColour(type, colour, what) {
  const c = rgb(colour);
  if (type in LEAN) expect(Math.max(...c), `${type} ${what}: ${c} leans to its channel`).toBe(c[LEAN[type]]);
  else expect(Math.max(...c) - Math.min(...c), `${type} ${what}: ${c} is grey`).toBeLessThan(30);
}

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
    for (const type of TYPES) {
      const tab = page.locator(`${POP} .wvw-tab[data-type="${type}"]`);
      await expect(tab, `a tab for ${type}`).toBeAttached();
      if (await tab.evaluate(el => el.classList.contains('is-active'))) continue;
      const line = (await top(type)).match(LINE);
      expect(line, `${type}: a 2px line, inset, on top (${await top(type)})`).not.toBeNull();
      seen[type] = line[1];
      expectColour(type, seen[type], 'closed');
    }
    expect(Object.keys(seen).length, 'three closed tabs at least').toBeGreaterThanOrEqual(3);
    expect(new Set(Object.values(seen)).size, 'one colour per map').toBe(Object.keys(seen).length);

    for (const type of TYPES) {
      const tab = page.locator(`${POP} .wvw-tab[data-type="${type}"]`);
      await tab.click();
      await expect(tab).toHaveClass(/is-active/);
      await page.mouse.move(0, 0);
      // The tab's colour transitions: read once its animations have finished.
      await tab.evaluate(t => Promise.all(t.getAnimations().map(a => a.finished.catch(() => {}))));
      const lineOf = async () => (await top(type)).match(LINE)?.[1] ?? null;
      await expect.poll(lineOf, `${type} open: its line`).not.toBeNull();
      if (seen[type]) expect(sum(await lineOf()), `${type} open: darker than closed`).toBeLessThan(sum(seen[type]));
      expectColour(type, await lineOf(), 'open');
      const all = await shadows(tab);
      expect(all.join('|'), 'no 1px glow left').not.toContain('rgba(255, 255, 255');
    }
  });
}
