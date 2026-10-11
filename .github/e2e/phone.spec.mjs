// The page on a phone's screen (the protocol's device override, mobile on, from
// support/steps.mjs): the map board and its targets at 320 and 360 px, the
// alliances popover back at a wide width, and the result table inside its card.
import { test, expect } from './support/fixtures.mjs';
import { phone, search } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const opened = async (page, wvw) => {
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
  await wvw.settle();
};

// The team names get room back, the map's tabs and zoom buttons are 34 px
// targets, the map's popover has no shrink button.
for (const width of [320, 360]) {
  test(`phone board, ${width} px`, async ({ page, wvw }) => {
    await opened(page, wvw);
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
        tabs: small('.wvw-tab'), zoom: small('.wvw-zoom button'), shrink: !!pop.querySelector('.info-popover-expand'), close: !!pop.querySelector('.info-popover-close') };
    });
    // Names still end in an ellipsis when long; what counts is the room they
    // get: 16 px at 320 and 53 px at 360 before the board gave it back.
    expect(m.room, 'px of room the team names get').toBeGreaterThanOrEqual(width === 320 ? 30 : 65);
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
  await opened(page, wvw);
  await page.locator('.server-guilds-btn').first().click();
  await expect(page.locator('.info-popover .info-popover-body').first()).toBeAttached();
  await expect(page.locator('.info-popover .info-popover-expand'), 'the alliances popover lost its expand button').toBeAttached();
  await page.locator('.info-popover .info-popover-close').click();
  await expect(page.locator('.info-popover')).toHaveCount(0);
});

// No column cut off, nothing past the screen.
test('the result table stays inside its card at 320 and 390 px', async ({ page, wvw }) => {
  await opened(page, wvw);
  await search(page, wvw.guilds);
  const tagLine = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('#resultCard .tag')].map(t => Math.round(t.getBoundingClientRect().height))));
  for (const width of [320, 390]) {
    const cdp = await phone(page, width, { exact: false });
    await wvw.settle();
    const fit = await page.evaluate(() => {
      const card = document.getElementById('resultCard');
      const cells = [...card.querySelectorAll('th, td, .server-cell, .server-cell *')];
      return { scroll: card.scrollWidth - card.clientWidth,
        past: Math.max(0, ...cells.map(c => Math.round(c.getBoundingClientRect().right - innerWidth))),
        beyond: Math.max(0, ...cells.map(c => Math.round(c.getBoundingClientRect().right - card.getBoundingClientRect().right))),
        tags: [...document.querySelectorAll('#resultCard .tag')].map(t => Math.round(t.getBoundingClientRect().height)) };
    });
    expect(fit.tags.filter(h => h > tagLine), `${width} px: tags wider than one line (heights ${JSON.stringify(fit.tags)}, one line is ${tagLine}px)`).toEqual([]);
    expect({ scroll: fit.scroll, past: fit.past, beyond: fit.beyond }, `${width} px: px the table overflows its card, px past the screen, px a cell past the card's edge`)
      .toEqual({ scroll: 0, past: 0, beyond: 0 });
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }
});
