// /api down so that the page falls back to the sheets.
import { test, expect } from './support/fixtures.mjs';
import { answer, fail, stall } from './support/faults.mjs';
import { firstTier, later, load, openMap } from './support/steps.mjs';
import { recording } from './support/recordings.mjs';
import { allQuietNow, askKills, forgetCommunityGuilds, quietFor } from './support/page.mjs';
import { MIN, killRows, killsGap } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 } });

// Only our /api/kills out, /api/relink answering: the kill history comes from the sheet,
// and a map shows its age from it, amber, as with /api/kills.
test('only /api/kills down: the sheet still gives the history, and the map its age', async ({ page, wvw }) => {
  let target;
  const sheet = await answer(page, /^https:\/\/docs\.google\.com\/spreadsheets\/.*sheet=kills/, async () => {
    const rows = await killRows(page, target, 7 * 60000);
    return rows.map(r => r.join(',')).join('\n');
  }, { contentType: 'text/csv', noStore: false });
  const relink = [];
  page.on('response', r => { if (/^http:\/\/127\.0\.0\.1:\d+\/api\/relink$/.test(r.url())) relink.push(r.status()); });
  await load(page, wvw);
  const tier = await firstTier(page);
  target = tier.id;
  const down = await fail(page, wvw, /^http:\/\/127\.0\.0\.1:\d+\/api\/kills$/);
  await allQuietNow(page);
  await askKills(page, { stale: true });
  expect(relink, 'answers of /api/relink, which stayed up').toContain(200);
  expect(down.reads, 'reads of /api/kills that failed').toBeGreaterThan(0);
  expect(sheet.reads, 'reads of the sheet instead').toBeGreaterThan(0);
  expect(await quietFor(page, tier.id), 'the match backdated by the sheet\'s history')
    .toBeGreaterThanOrEqual(6 * 60000);
  await openMap(page, wvw, tier.button);
  await expect(page.locator('.info-popover .wvw-plot-wrap .wvw-hud-ago'), 'the map opens amber, from the sheet').toHaveText(/^⚠ data from /);
  await expect(page.locator('.info-popover .wvw-plot-wrap .wvw-hud-big')).toHaveText('–');
  await wvw.settle();
});

// Our readers stopped for 12 min while the game's API went on: a page opened
// afterwards has no log of its own, and the history has a hole in it. The corner
// names the window and the gap, and the swords still count by the pace.
test.describe('a hole in the kill history', () => {
  const BEFORE = 6, GAP = 12;
  test.use({ timeline: killsGap(GAP, BEFORE, 2), timezoneId: 'UTC', locale: 'en-US' });
  test('the corner says "data gap" with its hours and the busiest map keeps its swords', async ({ page, wvw }) => {
    // The hole runs from the last row before it (the minute before the readers stop) to the first one after it (the minute they start).
    const hhmm = ms => new Date(recording().recordedAt + ms).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
    const hours = `${hhmm((BEFORE - 1) * MIN)}–${hhmm((BEFORE + GAP) * MIN)}`;
    await load(page, wvw);
    await later(page, wvw, 2 * MIN);
    const tier = await firstTier(page);
    await openMap(page, wvw, tier.button);
    const left = page.locator('.info-popover .wvw-plot-wrap .wvw-hud-l');
    await expect(left.locator('.wvw-hud-big'), 'the kills of the window across the hole').toHaveText(/^\d+$/);
    await expect(left.locator('.wvw-hud-small').first(), 'its length').toContainText('kills in 17 min');
    await expect(left.locator('.wvw-hud-small2'), 'the gap, in two lines, with the hours the timeline gives').toHaveText(`data gap ${hours}`);
    await expect(left).not.toHaveClass(/is-dim/);
    await expect(page.locator('.info-popover .wvw-tab[data-type="Center"]'), 'the busiest map is hot').toHaveClass(/is-hot/);
    await left.locator('.wvw-hud-btn').click();
    await expect(page.locator('.info-popover .wvw-hud-note'), 'the balloon names the gap and the pace')
      .toHaveText(new RegExp(`^\\d+ kills in the 17 min up to .+\\. No kill data reached us between ${hours.replace('–', ' and ')}\\. The swords count the pace per 10 minutes\\.$`));
    await wvw.settle();
  });
});

// A sheet that never answers: the page ends the read itself at REQUEST_TIMEOUT_MS (js/config.js) and
// carries on as it does when the read fails, and the next ask reads again.
test.describe('a sheet that never answers', () => {
  test.use({ clock: 'playwright' });
  const KILLS = /^https:\/\/docs\.google\.com\/spreadsheets\/.*sheet=kills/;
  const pastDeadline = (page) => page.clock.runFor(11 * 1000);

  test('the kill history: the first read ends empty at the deadline, the next ask reads the sheet again', async ({ page, wvw }) => {
    let target;
    const sheet = await answer(page, KILLS, async () => (await killRows(page, target, 7 * MIN)).map(r => r.join(',')).join('\n'),
      { contentType: 'text/csv', noStore: false });
    const silent = await stall(page, KILLS);
    await load(page, wvw);
    target = (await firstTier(page)).id;
    await fail(page, wvw, /^http:\/\/127\.0\.0\.1:\d+\/api\/kills$/);
    let first = null;
    askKills(page, { forget: true }).then(n => { first = n; });
    await expect.poll(() => silent.reads, { message: 'the read went out and got no answer' }).toBe(1);
    await pastDeadline(page);
    await expect.poll(() => first, { message: 'the ask of the history settled once the deadline passed' }).toBe(0);
    expect(sheet.reads, 'the stalled read never reached the recording').toBe(0);
    expect(await askKills(page), 'the next ask reads the sheet again').toBeGreaterThan(0);
    expect(sheet.reads).toBe(1);
  });

  test('the community guild list: the popover says it could not load, and opens with the list the next time', async ({ page, wvw }) => {
    const silent = await stall(page, /^https:\/\/docs\.google\.com\/spreadsheets\/.*sheet=SoloGuilds/);
    await load(page, wvw);
    await forgetCommunityGuilds(page);
    const btn = page.locator('.server-guilds-btn').locator('visible=true').first();
    const body = page.locator('.info-popover--guilds');
    await btn.click();
    await expect(body).toContainText('Loading community list');
    await expect.poll(() => silent.reads, { message: 'the read went out and got no answer' }).toBe(1);
    await pastDeadline(page);
    await expect(body, 'the message once the deadline passed').toContainText("Couldn't load the community guild list right now.");
    await btn.click();
    await btn.click();
    await expect(page.locator('.info-popover--guilds .guild-line').first(), 'the next opening reads again and lists').toBeVisible();
  });
});
