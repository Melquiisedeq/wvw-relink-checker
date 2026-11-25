// The page on a phone's screen (the protocol's device override, mobile on, from
// support/steps.mjs): the map board and its targets at 320 and 360 px, the
// alliances popover back at a wide width, the result table inside its card, and
// the Activity popover through a pinch zoom.
import { test, expect } from './support/fixtures.mjs';
import { load, phone, search } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

// The team names get room back, the map's tabs and zoom buttons are 34 px
// targets, the map's popover has no shrink button.
for (const width of [320, 360]) {
  test(`phone board, ${width} px`, async ({ page, wvw }) => {
    await load(page, wvw);
    await phone(page, width);
    await wvw.settle();
    await page.locator('.tier-map-btn').first().click();
    await expect(page.locator('.info-popover .wvw-board-row[data-focus-color]').first(), 'the board').toBeAttached();
    await expect(page.locator('.info-popover .wvw-zoom button').first(), 'the zoom buttons').toBeAttached();
    await wvw.settle();
    const m = await page.evaluate(() => {
      const pop = document.querySelector('.info-popover');
      const names = [...pop.querySelectorAll('.wvw-board-row[data-focus-color] .wvw-board-team')];
      const small = sel => [...pop.querySelectorAll(sel)].map(e => { const b = e.getBoundingClientRect(); return Math.round(Math.min(b.width, b.height)); });
      return { names: names.length, room: Math.min(...names.map(n => n.clientWidth)),
        head: pop.querySelector('.wvw-board-head .wvw-board-team').textContent,
        slack: [...pop.querySelectorAll('.wvw-board-row[data-focus-color]')].map(r => {
          const n = r.querySelector('.wvw-board-team').getBoundingClientRect(), c = r.querySelector('.wvw-board-counts').getBoundingClientRect();
          return { gap: Math.round(c.left - n.right), counts: Math.round(c.left) };
        }),
        tabs: small('.wvw-tab'), zoom: small('.wvw-zoom button'), shrink: !!pop.querySelector('.info-popover-expand'), close: !!pop.querySelector('.info-popover-close') };
    });
    // Names still end in an ellipsis when long; what counts is the room they
    // get: 16 px at 320 and 53 px at 360 before the board gave it back.
    expect(m.room, 'px of room the team names get').toBeGreaterThanOrEqual(width === 320 ? 30 : 65);
    // The name takes the free width, so the numbers stand in one column down the rows.
    expect(m.slack.length, 'rows').toBeGreaterThan(0);
    expect(m.slack.filter(r => r.gap > 10 || r.counts !== m.slack[0].counts), `${width} px: rows whose numbers are not at the name's edge or in line (${JSON.stringify(m.slack)})`).toEqual([]);
    expect(m.head, 'the board header').toBe('Held');
    expect(m.tabs.length && m.zoom.length && m.tabs.every(h => h >= 34) && m.zoom.every(h => h >= 34),
      `tabs ${JSON.stringify(m.tabs)} and zoom ${JSON.stringify(m.zoom)} should all be 34 px or more`).toBe(true);
    expect(m.shrink, 'the map popover has a shrink button').toBe(false);
    expect(m.close, 'the map popover has a close button').toBe(true);
    await page.locator('.info-popover .info-popover-close').click();
    await expect(page.locator('.info-popover')).toHaveCount(0);
  });
}

// The alliances popover keeps its own expand button, at a wide width.
test('the alliances popover keeps its expand button', async ({ page, wvw }) => {
  await load(page, wvw);
  await page.locator('.server-guilds-btn').first().click();
  await expect(page.locator('.info-popover .info-popover-body').first()).toBeAttached();
  await expect(page.locator('.info-popover .info-popover-expand'), 'the alliances popover lost its expand button').toBeAttached();
  await page.locator('.info-popover .info-popover-close').click();
  await expect(page.locator('.info-popover')).toHaveCount(0);
});

async function zoomedActivityPopover(page, wvw) {
  await load(page, wvw);
  const cdp = await phone(page, 360);
  await wvw.settle();
  const btn = page.locator('.activity-btn').first();
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await expect(page.locator('.info-popover')).toHaveCount(1);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => visualViewport.width)).toBe(180);
  await page.waitForTimeout(300);
  return cdp;
}

test('the activity popover stays open through a pinch zoom', async ({ page, wvw }) => {
  const cdp = await zoomedActivityPopover(page, wvw);
  await expect(page.locator('.info-popover')).toHaveCount(1);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 });
  await expect.poll(() => page.evaluate(() => visualViewport.scale)).toBe(1.5);
  await page.waitForTimeout(300);
  await expect(page.locator('.info-popover')).toHaveCount(1);
  // An event with nothing changed (the size must have been stored at the zoom).
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(100);
  await expect(page.locator('.info-popover')).toHaveCount(1);
});

test('the activity popover still closes on a real screen change after a zoom', async ({ page, wvw }) => {
  await zoomedActivityPopover(page, wvw);
  await expect(page.locator('.info-popover')).toHaveCount(1);
  await phone(page, 320, { height: 1200 });
  await expect(page.locator('.info-popover')).toHaveCount(0);
});

test('the activity popover closes when a rotation changes the zoom too', async ({ page, wvw }) => {
  const cdp = await zoomedActivityPopover(page, wvw);
  await Promise.all([
    cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 }),
    phone(page, 320, { height: 1200 }),
  ]);
  await expect(page.locator('.info-popover')).toHaveCount(0);
});

test('the activity popover stays open when only the visual viewport shrinks at a held zoom', async ({ page, wvw }) => {
  await zoomedActivityPopover(page, wvw);
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { get: () => 300 });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(100);
  await expect(page.locator('.info-popover')).toHaveCount(1);
});

// The browser's address bar going away on a scroll changes the height only.
test('the activity popover stays open, inside the screen, when the visible height loses 60 px', async ({ page, wvw }) => {
  await load(page, wvw);
  await phone(page, 360, { height: 700 });
  await wvw.settle();
  // The first icon far enough down the page to be scrolled to 650 px: the popover sits above it
  // and is lower than the shrunk window.
  const far = await page.evaluate(() => [...document.querySelectorAll('.activity-btn')].findIndex(b => b.getBoundingClientRect().top + scrollY > 700));
  const btn = page.locator('.activity-btn').nth(far);
  await btn.evaluate(b => window.scrollTo(0, b.getBoundingClientRect().top + scrollY - 650));
  await wvw.settle();
  expect(await btn.evaluate(b => b.getBoundingClientRect().top), 'the icon low on the screen').toBeGreaterThan(600);
  await btn.click();
  await expect(page.locator('.info-popover')).toHaveCount(1);
  expect(await page.evaluate(() => document.querySelector('.info-popover').getBoundingClientRect().bottom), 'open lower than the shrunk window').toBeGreaterThan(640);
  // The visual viewport alone, as the address bar going shrinks it: no scroll event
  // comes with it to move the popover.
  await page.evaluate(() => {
    Object.defineProperty(visualViewport, 'height', { get: () => 640 });
    visualViewport.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(300);
  await expect(page.locator('.info-popover'), 'a height change leaves it open').toHaveCount(1);
  const r = await page.evaluate(() => { const b = document.querySelector('.info-popover').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, vh: visualViewport.height }; });
  expect(r.top).toBeGreaterThanOrEqual(0);
  expect(r.bottom).toBeLessThanOrEqual(r.vh);
});
