import { test, expect } from './support/fixtures.mjs';
import { hold } from './support/faults.mjs';
import { load } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const TIERS = '#standingsGridNA > .standing-match';

// Scripts run in order and the page is usable before the last one: with one
// held, Escape, a resize, the Check button, Ctrl+Enter and a click must raise
// nothing (the fixture fails the test on an exception), and the page must work
// once it is let go.
for (const script of ['maps-early.js', 'trebuchet.js', 'boot.js']) {
  test(`early actions with ${script} held`, async ({ page, wvw }) => {
    const release = await hold(page, wvw.url + 'js/' + script);
    await page.goto(wvw.url, { waitUntil: 'commit' });
    await expect.poll(() => release.reads > 0, { message: 'the request being held' }).toBe(true);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('resize'));
      if (window.visualViewport) window.visualViewport.dispatchEvent(new Event('resize'));
      document.getElementById('guildInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX: 50, clientY: 50 }));
    });
    await page.locator('#runBtn').click();
    await page.waitForTimeout(200);   // a throw is reported late
    release();
    await page.waitForLoadState('load');
    await expect(page.locator(TIERS)).toHaveCount(wvw.tiers.NA);
    await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
    await wvw.settle();
    expect(await page.evaluate(() => !document.getElementById('runBtn').disabled && !document.querySelector('#statusMsg .spinner')),
      'the Check button left disabled').toBe(true);
  });
}
