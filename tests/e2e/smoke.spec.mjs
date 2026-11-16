// The page loads, at a desktop and at a phone width, with every tier the
// recording holds in both regions, and nothing the browser objects to (the
// `wvw` fixture fails the test on an exception, a console error or a CSP
// violation).
import { test, expect } from './support/fixtures.mjs';
import { load } from './support/steps.mjs';

for (const width of [1280, 360]) {
  test(`loads at ${width} px with every tier`, async ({ page, wvw }) => {
    expect(wvw.tiers.NA * wvw.tiers.EU, 'tiers in the recording').toBeGreaterThan(0);
    await page.setViewportSize({ width, height: 900 });
    await load(page, wvw);
  });
}
