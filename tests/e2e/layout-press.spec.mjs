// A press that lands 1 px under a button's top edge does what a press in its
// middle does. A pressed button sinks 2 px, and a press on the strip it just
// left would otherwise release on whatever is behind it, losing the click.
import { test, expect } from './support/fixtures.mjs';
import { load, firstTier, openMap, frame } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ timeout: 2 * 60 * 1000 });

// The press has taken hold: the button's transitions have run their course and
// a frame has been drawn (nothing else makes the :active transform arrive).
async function sunk(page, button) {
  await button.evaluate(b => Promise.all(b.getAnimations().map(a => a.finished.catch(() => {}))));
  await frame(page);
}

// Press a button with the mouse 1 px under its top edge and release on the spot.
async function press(page, button) {
  const box = await button.boundingBox();
  const x = box.x + box.width / 2, y = box.y + 1;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await sunk(page, button);
  await page.mouse.up();
}

test("a map's tab pressed 1 px under its top edge changes the map", async ({ page, wvw }) => {
  await load(page, wvw);
  const { button } = await firstTier(page);
  await openMap(page, wvw, button);
  const tab = page.locator('.info-popover .wvw-tab[data-type="BlueHome"]');
  await expect(tab).not.toHaveClass(/is-active/);
  await press(page, tab);
  await expect(tab).toHaveClass(/is-active/);
});

test('the NA/EU swap pressed 1 px under its top edge swaps', async ({ page, wvw }) => {
  await load(page, wvw);
  const swap = page.locator('.rail-swap:visible').first();
  const before = await page.evaluate(() => document.documentElement.dataset.railFirst || '');
  await press(page, swap);
  const after = await page.evaluate(() => document.documentElement.dataset.railFirst || '');
  expect(after, 'the side that comes first after a press at the top edge').not.toBe(before);
});

// Every button of `scope` on screen: the point 1 px under its top edge, with the
// button pressed, is still the button's. The release is off the button, on the
// popover's own padding when the scope is inside one (a click there reaches the
// popover, which stays open) and on the page's corner otherwise.
async function sweep(page, scope = 'button') {
  const lost = [];
  const buttons = page.locator(scope);
  const count = await buttons.count();
  let visible = 0, covered = 0, swept = 0;
  for (let i = 0; i < count; i++) if (await buttons.nth(i).isVisible()) visible++;
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    if (!(await button.isVisible())) continue;
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    const x = box.x + box.width / 2, y = box.y + 1;
    // Covered by something else at rest (a stacked layer): not pressable there either.
    const rest = await button.evaluate((b, [px, py]) => { const e = document.elementFromPoint(px, py); return !!e && b.contains(e); }, [x, y]);
    if (!rest) { covered++; continue; }
    const away = scope === 'button' ? [2, 2] : await page.evaluate(() => {
      const r = document.querySelector('.info-popover').getBoundingClientRect();
      return [r.x + 3, r.y + 3];
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await sunk(page, button);
    const inside = await button.evaluate((b, [px, py]) => b.contains(document.elementFromPoint(px, py)), [x, y]);
    await page.mouse.move(...away);
    const bare = await page.evaluate(([px, py]) => !document.elementFromPoint(px, py)?.closest('button'), away);
    expect(bare, 'the release point is not on a button').toBe(true);
    await page.mouse.up();
    swept++;
    if (scope !== 'button') await expect(page.locator('.info-popover'), `the popover after pressing button ${i}`).toHaveCount(1);
    if (!inside) lost.push(await button.evaluate(b => b.tagName.toLowerCase() + [...b.classList].map(c => '.' + c).join('') + (b.dataset.type ? `[data-type=${b.dataset.type}]` : '')));
  }
  expect(swept + covered, 'every visible button was swept or covered').toBe(visible);
  expect(swept, 'buttons swept').toBeGreaterThan(0);
  return lost;
}

test('every visible button, pressed 1 px under its top edge, is still under the cursor', async ({ page, wvw }) => {
  test.setTimeout(5 * 60 * 1000);
  await load(page, wvw);
  expect(await sweep(page), 'buttons that left the cursor in the page').toEqual([]);
  const { button } = await firstTier(page);
  await openMap(page, wvw, button);
  expect(await sweep(page, '.info-popover button'), 'buttons that left the cursor with the map open').toEqual([]);
});
