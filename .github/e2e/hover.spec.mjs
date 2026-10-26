// The first map's terrain picture is asked for when the mouse reaches a map
// button (or it takes focus), once per picture; a touch asks for nothing.
import { test, expect } from './support/fixtures.mjs';
import { load } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const PICTURE = /\/assets\/map-[a-z]+-1280\.webp$/;

async function watch(page) {
  const asked = [];
  page.on('request', (r) => { if (PICTURE.test(new URL(r.url()).pathname)) asked.push(new URL(r.url()).pathname); });
  return asked;
}

test('the mouse reaching a map button asks for the first map once, and again asks for nothing', async ({ page, wvw }) => {
  const asked = await watch(page);
  await load(page, wvw);
  await wvw.settle();
  expect(asked, 'no picture before the mouse comes').toEqual([]);
  const btn = page.locator('.tier-map-btn').first();
  await btn.hover();
  await expect.poll(() => asked.length, { message: 'the picture asked for on hover' }).toBe(1);
  await page.mouse.move(5, 5);
  await btn.hover();
  await page.locator('.tier-map-btn').nth(1).hover();
  await wvw.settle();
  expect(asked.length, 'hovering again asks for no more of the same picture').toBe(1);
  expect(new Set(asked).size, 'each picture once').toBe(asked.length);
  await btn.click();
  await expect(page.locator(".info-popover .wvw-plot g[role='button']").first()).toBeAttached();
  await expect(page.locator('.info-popover .wvw-plot image').first()).toHaveAttribute('href', asked[0].slice(1));
});

test('focus on a map button asks for the picture', async ({ page, wvw }) => {
  const asked = await watch(page);
  await load(page, wvw);
  await wvw.settle();
  await page.locator('.tier-map-btn').first().focus();
  await expect.poll(() => asked.length, { message: 'the picture asked for on focus' }).toBe(1);
});

test('a touch pointerover on a map button asks for nothing', async ({ page, wvw }) => {
  const asked = await watch(page);
  await load(page, wvw);
  await wvw.settle();
  await page.locator('.tier-map-btn').first().evaluate((b) => {
    b.dispatchEvent(new PointerEvent('pointerover', { pointerType: 'touch', bubbles: true }));
  });
  await page.waitForTimeout(500);
  expect(asked, 'a touch asks for no picture').toEqual([]);
});

test('with Save-Data on, hover and focus ask for nothing before the click', async ({ page, wvw }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' }, configurable: true });
  });
  const asked = await watch(page);
  await load(page, wvw);
  await wvw.settle();
  const btn = page.locator('.tier-map-btn').first();
  await btn.hover();
  await btn.focus();
  await page.waitForTimeout(500);
  expect(asked, 'Save-Data: no picture before the click').toEqual([]);
});
