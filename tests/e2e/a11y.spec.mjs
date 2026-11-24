// What a screen reader gets from the standings, the notice and the result table:
// no live region that rewrites itself between two good reads, one heading per
// tier, the side and the arrow in words, and a table that keeps its roles on a phone.
import { test, expect } from './support/fixtures.mjs';
import { answer, fail } from './support/faults.mjs';
import { MIN, awayAndBack } from './support/scenarios.mjs';
import { check, load, phone } from './support/steps.mjs';

const ALL = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
const ALL_RE = /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=all$/;
const EU_ONLY = /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=2-[1-9](,2-[1-9])*$/;

test.use({ viewport: { width: 1280, height: 800 } });

test('the Synced lines are not live regions; the notice stays rendered, empty, between its texts', async ({ page, wvw }) => {
  await load(page, wvw);
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

test('the title says fan site and the footer carries the ArenaNet trademark notice', async ({ page, wvw }) => {
  await load(page, wvw);
  await expect(page).toHaveTitle(/\(Fan Site\)$/);
  await expect(page.locator('.gw2-band-fine')).toContainText('Unofficial fan site, not affiliated with or endorsed by ArenaNet.');
  await expect(page.locator('.gw2-band-fine')).toContainText(
    '© ArenaNet LLC. All rights reserved. NCSOFT, ArenaNet, Guild Wars, Guild Wars 2, GW2, Heart of Thorns, Path of Fire, End of Dragons, Secrets of the Obscure, Janthir Wilds, Visions of Eternity, and all associated logos, designs, and composite marks are trademarks or registered trademarks of NCSOFT Corporation. All other trademarks are the property of their respective owners.');
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
  // EU answers with nothing: the quiet alert, no retry planned. A return of the tab
  // then meets EU failing: the retry is planned over the quiet alert.
  const none = [await answer(page, ALL, []), await answer(page, EU_ONLY, [])];
  await page.goto(wvw.url);
  await expect(page.locator('#standingsAlertEU')).toHaveText("Couldn't load EU standings.");
  await expect(page.locator('#standingsAlertEU .retry-btn')).toHaveCount(0);
  await fail(page, wvw, ALL_RE);
  await fail(page, wvw, EU_ONLY);
  for (const n of none) n.off();
  await awayAndBack(page, wvw, 10 * MIN);
  await expect(page.locator('#standingsAlertEU'), 'the retry planned').toContainText(/Trying again in \d+ s/);
  await expect(page.locator('#standingsAlertEU .retry-btn'), 'not left clipped by the quiet alert').toBeVisible();
  // The quiet alert is a 1 px box clipped to nothing: visible only if it is not the quiet one.
  expect((await page.locator('#standingsAlertEU').boundingBox()).height, 'the alert drawn, not clipped to a pixel').toBeGreaterThan(8);
});

test('one heading per tier, the side and the arrow in words', async ({ page, wvw }) => {
  await load(page, wvw);
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
