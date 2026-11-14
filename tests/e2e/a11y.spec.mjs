// What a screen reader gets from the standings, the notice and the result table:
// no live region that rewrites itself between two good reads, one heading per
// tier, the side and the arrow in words, and a table that keeps its roles on a phone.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { check, phone } from './support/steps.mjs';

const ALL = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
const EU_ONLY = /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=2-[1-9](,2-[1-9])*$/;

test.use({ viewport: { width: 1280, height: 800 } });
const opened = async (page, wvw) => {
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
  await wvw.settle();
};

test('the Synced lines are not live regions; the notice stays rendered, empty, between its texts', async ({ page, wvw }) => {
  await opened(page, wvw);
  for (const r of ['NA', 'EU']) {
    const line = page.locator(`#standingsStatus${r}`);
    await expect(line).toContainText('Synced');
    await expect(line, `${r} Synced line: no role`).not.toHaveAttribute('role', /.+/);
    await expect(line, `${r} Synced line: no aria-live`).not.toHaveAttribute('aria-live', /.+/);
  }
  await page.locator('.teams-notice-close').click();
  const notice = await page.evaluate(() => {
    const n = document.getElementById('teamsNotice');
    return { display: getComputedStyle(n).display, empty: n.childNodes.length === 0, role: n.getAttribute('role'),
      border: getComputedStyle(n).borderBottomWidth, height: n.getBoundingClientRect().height };
  });
  expect(notice, 'rendered (not display:none) and empty, a live region that exists before it speaks')
    .toEqual({ display: 'block', empty: true, role: 'status', border: '0px', height: 0 });
});

test('a region that cannot load says so in its alert', async ({ page, wvw }) => {
  await answer(page, ALL, []);
  await answer(page, EU_ONLY, []);
  await page.goto(wvw.url);
  await expect(page.locator('#standingsStatusEU')).toHaveText("Couldn't load EU standings.");
  await expect(page.locator('#standingsAlertEU'), 'the live alert carries the failure').toHaveText("Couldn't load EU standings.");
  await expect(page.locator('#standingsAlertEU')).toHaveAttribute('role', 'status');
});

test('a failure first quiet, then retried, shows its Try again button', async ({ page, wvw }) => {
  await opened(page, wvw);
  await page.evaluate(() => {
    setStandingsStatus(standingsStatusEU, false, "Couldn't load EU standings.");
    paintRetryStatus(standingsStatusEU, 'Trying again soon.', 'Trying again soon.', false, false);
  });
  await expect(page.locator('#standingsAlertEU .retry-btn'), 'not left clipped by the quiet alert').toBeVisible();
});

test('one heading per tier, the side and the arrow in words', async ({ page, wvw }) => {
  await opened(page, wvw);
  for (const r of ['NA', 'EU']) {
    const heads = page.locator(`#standingsGrid${r} > .standing-match`).getByRole('heading', { level: 3 });
    await expect(heads, `${r}: a heading per tier`).toHaveCount(wvw.tiers[r]);
    await expect(heads.first()).toHaveText(/^Tier \d+$/);
  }
  const sides = await page.locator('.standing-side-top .dot').evaluateAll(d => d.map(e => e.textContent));
  expect(sides.length).toBeGreaterThan(0);
  for (const s of sides) expect(s).toMatch(/^(Red|Blue|Green) side$/);
  const arrows = await page.locator('.movement-indicator').evaluateAll(a => a.map(e => e.textContent));
  expect(arrows.length).toBeGreaterThan(0);
  for (const t of arrows) expect(t).toMatch(/Moves up next reset|Moves down next reset|Stays in this tier next reset|Already the (top|bottom) tier|Tied on VP/);
});

// Chromium keeps the table semantics under display:block, so this passes without the
// explicit roles; they are for other engines, and this only guards them.
test('the result table has four column headers at 390 px', async ({ page, wvw }) => {
  await opened(page, wvw);
  await phone(page, 390);
  await check(page, wvw, [wvw.guilds[0]]);
  await expect(page.getByRole('columnheader')).toHaveCount(4);
  await expect(page.getByRole('row').filter({ has: page.getByRole('cell') })).toHaveCount(1);
});
