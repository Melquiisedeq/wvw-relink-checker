// The relink bar and the teams notice (js/relink.js), one test per state a
// player sees, each from a new page whose timers (lockout, teamAssignment),
// matches and relink count are answered relative to the page's own clock, so
// that the states stay where they are as the recording ages.
import { test, expect } from './support/fixtures.mjs';
import { answer, fail } from './support/faults.mjs';
import { recordedJson, serveList, iso } from './support/steps.mjs';
import { HOUR, MIN } from './support/scenarios.mjs';

const GAME = 'https://api.guildwars2.com/v2/';
const DAY = 24 * HOUR;
// Past each whole minute, so the page's clock running on while a test works
// does not tip a countdown over into the minute below.
const S = 45 * 1000;

test.use({ clock: 'playwright', timezoneId: 'UTC', locale: 'en-US', viewport: { width: 1280, height: 900 } });

const banner = page => page.locator('#relinkBanner');
const notice = page => page.locator('#teamsNotice');
const titles = page => banner(page).locator('.relink-stat-title');
const alertLine = page => banner(page).locator('.relink-alert');

// The world, in milliseconds from the page's opening. A region is { start, end }
// of its matches' week, or null for none; lockout and assign are the timers'.
// `published` is what /api/relink counts for the NA assignment's window.
async function world(page, wvw, { lockout = null, assign = {}, na, eu, published = null, window = null }) {
  const at = ms => iso(wvw.opensAt + ms);
  const week = { start: -2 * DAY, end: 5 * DAY };
  const regions = { 1: na === undefined ? week : na, 2: eu === undefined ? week : eu };
  const list = recordedJson(GAME + 'wvw/matches?ids=all').filter(m => regions[m.id[0]])
    .map(m => ({ ...m, start_time: at(regions[m.id[0]].start), end_time: at(regions[m.id[0]].end) }));
  await serveList(page, list);
  await answer(page, GAME + 'wvw/timers/lockout', lockout === null ? {} : { na: at(lockout), eu: at(lockout) });
  await answer(page, GAME + 'wvw/timers/teamAssignment', {
    ...(assign.na === undefined ? {} : { na: at(assign.na) }), ...(assign.eu === undefined ? {} : { eu: at(assign.eu) }),
  });
  const windowId = window ?? Math.floor((wvw.opensAt + (assign.na ?? 0)) / 1000);
  if (published !== null) await answer(page, '**/api/relink', { window: windowId, published });
  return { at, windowId };
}

async function open(page, wvw, state) {
  const made = await world(page, wvw, state);
  await page.goto(wvw.url);
  await expect(banner(page)).toBeVisible();
  await wvw.settle();
  return made;
}

test('a normal month: Next Reset and the lockout counting, nothing shouting', async ({ page, wvw }) => {
  await open(page, wvw, { lockout: 6 * DAY + 6 * HOUR + S, assign: { na: 10 * DAY + S, eu: 10 * DAY - 8 * HOUR + S },
    na: { start: -2 * DAY, end: 3 * DAY + 3 * HOUR + S }, eu: { start: -2 * DAY, end: 3 * DAY + 3 * HOUR + S } });
  await expect(titles(page)).toHaveText(['Next Reset', 'Season Lockout']);
  await expect(banner(page).locator('.relink-stat-value').first()).toHaveText('NA 3d 3h · EU 3d 3h');
  await expect(banner(page).locator('.relink-stat-value').nth(1)).toHaveText('6d 6h');
  await expect(alertLine(page)).toHaveCount(0);
  await expect(banner(page)).not.toHaveClass(/is-(lockout|urgent|relink-week|rebuild)/);
});

test('the last week of the season: Next Relink, and the line that says so', async ({ page, wvw }) => {
  // Both regions inside the week (EU lands 8 h before NA); the lockout is
  // still beyond its 3 days.
  await open(page, wvw, { lockout: 3 * DAY + 10 * HOUR + S, assign: { na: 6 * DAY + 20 * HOUR + S, eu: 6 * DAY + 12 * HOUR + S },
    na: { start: -2 * DAY, end: 6 * DAY + 20 * HOUR + S }, eu: { start: -2 * DAY, end: 6 * DAY + 12 * HOUR + S } });
  await expect(titles(page)).toHaveText(['Next Relink', 'Season Lockout']);
  await expect(banner(page)).toHaveClass(/is-relink-week/);
  await expect(banner(page)).not.toHaveClass(/is-(lockout|urgent)/);
  await expect(alertLine(page)).toHaveText('Last week of the season. New teams at the next reset.');
});

test('EU inside the last week, NA eight hours behind: still Next Reset, no relink claim', async ({ page, wvw }) => {
  // NA's own relink is 7 d 4 h away, so nothing may say the teams are rebuilt at its next reset.
  await open(page, wvw, { lockout: 3 * DAY + 10 * HOUR + S, assign: { na: 7 * DAY + 4 * HOUR + S, eu: 6 * DAY + 20 * HOUR + S },
    na: { start: -2 * DAY, end: 6 * DAY + 20 * HOUR + S }, eu: { start: -2 * DAY, end: 6 * DAY + 20 * HOUR + S } });
  await expect(titles(page)).toHaveText(['Next Reset', 'Season Lockout']);
  await expect(banner(page)).not.toHaveClass(/is-(lockout|urgent|relink-week|rebuild)/);
  await expect(alertLine(page)).toHaveCount(0);
});

test('the lockout inside 3 days: the alert line, and the relink stands down', async ({ page, wvw }) => {
  await open(page, wvw, { lockout: 2 * DAY + 5 * HOUR + S, assign: { na: 6 * DAY + S, eu: 5 * DAY + 16 * HOUR + S },
    // NA's reset 90 min away would be a reset night on any other bar.
    na: { start: -2 * DAY, end: 90 * MIN + S }, eu: { start: -2 * DAY, end: 3 * DAY } });
  await expect(banner(page)).toHaveClass(/is-lockout/);
  await expect(banner(page)).not.toHaveClass(/is-urgent/);
  await expect(banner(page).locator('.relink-stat-value').nth(1)).toHaveText('2d 5h');
  await expect(alertLine(page)).toContainText('Set your WvW guild before the lockout');
  await expect(alertLine(page)).not.toContainText('reset night');
  await expect(titles(page).nth(1).locator('svg'), 'the warning on the lockout').toHaveCount(1);
});

test('reset night in one region only: its name in the line, its time lit', async ({ page, wvw }) => {
  const lockout = 6 * DAY;
  const assign = { na: 10 * DAY, eu: 10 * DAY };
  const near = { start: -2 * DAY, end: 1 * HOUR + 50 * MIN + S };
  const far = { start: -2 * DAY, end: 2 * HOUR + 10 * MIN + S };
  await open(page, wvw, { lockout, assign, na: near, eu: far });
  await expect(banner(page)).toHaveClass(/is-urgent/);
  await expect(alertLine(page)).toContainText('NA reset night.');
  await expect(alertLine(page)).not.toContainText('EU');
  await expect(banner(page).locator('.time.is-now')).toHaveText('1h 50m');
  await expect(banner(page).locator('.time').nth(1)).toHaveText('2h 10m');
});

test('reset night in the other region only', async ({ page, wvw }) => {
  await open(page, wvw, { lockout: 6 * DAY, assign: { na: 10 * DAY, eu: 10 * DAY },
    na: { start: -2 * DAY, end: 2 * HOUR + 10 * MIN + S }, eu: { start: -2 * DAY, end: 1 * HOUR + 50 * MIN + S } });
  await expect(alertLine(page)).toContainText('EU reset night.');
  await expect(alertLine(page)).not.toContainText('NA');
});

test('reset night in both regions names both', async ({ page, wvw }) => {
  await open(page, wvw, { lockout: 6 * DAY, assign: { na: 10 * DAY, eu: 10 * DAY },
    na: { start: -2 * DAY, end: 1 * HOUR + S }, eu: { start: -2 * DAY, end: 1 * HOUR + S } });
  await expect(alertLine(page)).toContainText('NA and EU reset night.');
  await expect(banner(page).locator('.time.is-now')).toHaveCount(2);
});

test('the reset under way, every tier still on the old week: still reset night', async ({ page, wvw }) => {
  await open(page, wvw, { lockout: 6 * DAY, assign: { na: 10 * DAY, eu: 10 * DAY },
    na: { start: -7 * DAY - 5 * MIN, end: -5 * MIN }, eu: { start: -2 * DAY, end: 3 * DAY } });
  await expect(banner(page).locator('.relink-stat-value').first()).toContainText('NA any moment now');
  await expect(banner(page)).toHaveClass(/is-urgent/);
  await expect(alertLine(page)).toContainText('NA reset night.');
});

test('a new week just published: reset night for 5 minutes, then not', async ({ page, wvw }) => {
  await open(page, wvw, { lockout: 6 * DAY, assign: { na: 10 * DAY, eu: 10 * DAY },
    na: { start: -1 * MIN, end: 7 * DAY - 1 * MIN }, eu: { start: -2 * DAY, end: 3 * DAY } });
  await expect(alertLine(page)).toContainText('NA reset night.');
  await page.clock.fastForward(6 * MIN);
  await expect(banner(page).locator('.relink-stat-value').first()).toContainText('NA 6d 23h');
  await expect(alertLine(page)).toHaveCount(0);
  await expect(banner(page)).not.toHaveClass(/is-urgent/);
});

test('the Relink bar: from the lockout to NA landing, EU done first, then gone', async ({ page, wvw }) => {
  await open(page, wvw, { lockout: -1 * HOUR, assign: { na: 2 * DAY + S, eu: 2 * DAY - 8 * HOUR + S }, published: 0 });
  await expect(banner(page)).toHaveClass(/is-rebuild/);
  await expect(banner(page).locator('.relink-word-text')).toHaveText('Relink');
  await expect(titles(page)).toHaveCount(0);
  await expect(banner(page).locator('.relink-stat-value')).toHaveText('NA 2d 0h · EU 1d 16h');
  await expect(alertLine(page)).toHaveText('New link, new enemies, and a month of good fights ahead.');

  // EU has landed, NA has not: EU says done, NA still counts.
  await page.clock.fastForward(1 * DAY + 17 * HOUR);
  await expect(banner(page).locator('.relink-stat-value')).toHaveText('NA 7h 0m · EU done');
  // The refresh the jump started must answer before the next jump: its 10 s
  // limit is a page timer, and a slow answer would fall to the unrecorded fallback.
  await wvw.settle();
  // NA lands: the bar is the ordinary one again.
  await page.clock.fastForward(7 * HOUR + 5 * MIN);
  await expect(banner(page)).not.toHaveClass(/is-rebuild/);
  await expect(banner(page).locator('.relink-word-text')).toHaveCount(0);
  await expect(titles(page).first()).toHaveText('Next Reset');
  await expect(banner(page).locator('.relink-stat-value').last()).toHaveText('Locked until relink');
});

test('the Relink bar is not up while the lockout is still ahead', async ({ page, wvw }) => {
  await open(page, wvw, { lockout: 1 * MIN + S, assign: { na: 3 * DAY + 18 * HOUR, eu: 3 * DAY + 10 * HOUR } });
  await expect(banner(page)).not.toHaveClass(/is-rebuild/);
  await expect(titles(page).last()).toHaveText('Season Lockout');
  await page.clock.fastForward(2 * MIN);
  await expect(banner(page)).toHaveClass(/is-rebuild/);
});

for (const failing of ['NA', 'EU']) {
  test(`${failing} failing a refresh keeps its countdown going`, async ({ page, wvw }) => {
    await open(page, wvw, { lockout: 6 * DAY, assign: { na: 10 * DAY, eu: 10 * DAY },
      na: { start: -2 * DAY, end: 5 * HOUR + S }, eu: { start: -2 * DAY, end: 5 * HOUR + S } });
    const value = banner(page).locator('.relink-stat-value').first();
    await expect(value).toHaveText('NA 5h 0m · EU 5h 0m');
    // The next refresh: the whole list does not answer, the list of ids does,
    // and one region's matches fail.
    await fail(page, wvw, /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=all$/);
    const region = await fail(page, wvw, failing === 'NA' ? /matches\?ids=1-/ : /matches\?ids=2-/);
    for (const left of ['4h 54m', '4h 48m']) {
      await wvw.settle();   // what the last jump started (a retry's reads included) answers before this one
      const had = region.reads;
      await page.clock.fastForward(5 * MIN);
      await expect.poll(() => region.reads, { message: `the refresh reading ${failing}'s matches` }).toBeGreaterThan(had);
      await wvw.settle();
      // The bar is drawn on the minute: this tick is the first after the refresh answered.
      await page.clock.fastForward(MIN);
      await expect(value).toHaveText(`NA ${left} · EU ${left}`);
    }
  });
}

test('a region with no clock says unknown and the other counts', async ({ page, wvw }) => {
  await open(page, wvw, { lockout: 6 * DAY, assign: { na: 10 * DAY }, na: { start: -2 * DAY, end: 3 * DAY + S }, eu: null });
  await expect(banner(page).locator('.relink-stat-value').first()).toHaveText('NA 3d 0h · EU unknown');
  await expect(alertLine(page)).toHaveCount(0);
});

test('no clock anywhere: no bar', async ({ page, wvw }) => {
  await world(page, wvw, { na: null, eu: null });
  await answer(page, GAME + 'wvw/matches', []);
  await page.goto(wvw.url);
  await wvw.settle();
  await expect(banner(page)).toBeHidden();
  // The lockout turns up on the next timers refresh: the bar was down for want of data.
  await answer(page, GAME + 'wvw/timers/lockout', { na: iso(wvw.opensAt + 6 * DAY) });
  await page.clock.fastForward(10 * MIN);
  await expect(titles(page)).toHaveText(['Season Lockout']);
});

// The rebuilding state the notice lives in: the lockout shut, NA's teams ahead.
const rebuilding = { lockout: -1 * HOUR, assign: { na: 2 * DAY, eu: 2 * DAY - 8 * HOUR } };

test('the teams notice goes up once the sheet says the new table is out', async ({ page, wvw }) => {
  const { windowId } = await open(page, wvw, { ...rebuilding, published: 7 });
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toHaveAttribute('data-window', String(windowId));
  await expect(notice(page)).toContainText('The new teams are out.');
  await expect(notice(page).locator('.teams-notice-spoken')).toHaveText('guild list shield');
});

test('the teams notice stays down while nothing is published', async ({ page, wvw }) => {
  await open(page, wvw, { ...rebuilding, published: 0 });
  await expect(banner(page)).toHaveClass(/is-rebuild/);
  await expect(notice(page)).toBeHidden();
});

test('the teams notice stays down for another window\'s count', async ({ page, wvw }) => {
  const last = Math.floor((wvw.opensAt + rebuilding.assign.na) / 1000) - 30 * 24 * 3600;
  await open(page, wvw, { ...rebuilding, published: 7, window: last });
  await expect(banner(page)).toHaveClass(/is-rebuild/);
  await expect(notice(page)).toBeHidden();
});

test('dismissing the teams notice keeps it dismissed over a reload', async ({ page, wvw }) => {
  await open(page, wvw, { ...rebuilding, published: 7 });
  await expect(notice(page)).toBeVisible();
  await notice(page).getByRole('button', { name: 'Dismiss this notice' }).click();
  await expect(notice(page)).toBeHidden();
  await page.reload();
  await expect(banner(page)).toHaveClass(/is-rebuild/);
  await wvw.settle();
  await expect(notice(page)).toBeHidden();
});

test('the teams notice goes down with the Relink bar when NA lands', async ({ page, wvw }) => {
  await open(page, wvw, { lockout: -1 * HOUR, assign: { na: 5 * MIN + S, eu: -3 * HOUR }, published: 3 });
  await expect(notice(page)).toBeVisible();
  await page.clock.fastForward(6 * MIN);
  await expect(banner(page)).not.toHaveClass(/is-rebuild/);
  await expect(notice(page)).toBeHidden();
});

test('without /api/relink the sheet raises the teams notice', async ({ page, wvw }) => {
  const down = await fail(page, wvw, /\/api\/relink$/);
  const windowId = Math.floor((wvw.opensAt + rebuilding.assign.na) / 1000);
  await answer(page, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/gviz\/tq\?.*sheet=relink/, `${windowId}:5`);
  await open(page, wvw, rebuilding);
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toHaveAttribute('data-window', String(windowId));
  expect(down.reads, 'the own API tried first').toBeGreaterThan(0);
});

// Friday 18:00 UTC, EU's weekly reset, with the game's API not having the new week yet.
// NA's week is still running (it resets at 02:00 UTC), so its countdown goes on.
async function resetMinute(page, wvw, now) {
  const t = Date.parse(now), reset = Date.parse('2026-10-23T18:00:00Z');
  await page.clock.setSystemTime(t);
  const old = { start: reset - 7 * DAY, end: reset };
  const newer = { start: reset, end: reset + 7 * DAY };
  const naWeek = { start: Date.parse('2026-10-17T02:00:00Z'), end: Date.parse('2026-10-24T02:00:00Z') };
  const list = (eu, euWeek) => recordedJson(GAME + 'wvw/matches?ids=all')
    .filter(m => m.id[0] === '1' || eu(m))
    .map(m => { const w = m.id[0] === '1' ? naWeek : euWeek(m); return { ...m, start_time: iso(w.start), end_time: iso(w.end) }; });
  await answer(page, GAME + 'wvw/timers/lockout', {});
  await answer(page, GAME + 'wvw/timers/teamAssignment', {});
  return { old, newer, list };
}
const euStatus = page => page.locator('.standings-card:has(#standingsAlertEU)');
const counter = page => banner(page).locator('.relink-stat-value').first();

const euButton = page => euStatus(page).locator('.retry-btn');
const resetWords = 'Weekly reset · new matchups arriving';

// One page through EU's reset minutes, from 18:00:30 on, each phase a different way the
// game's API can fail to have the new week: the whole API 503 (the id list fails, so both
// columns fail), then only the EU matches 503 (a region's read fails, null), then an
// answer with no EU matches in it (empty), then a partial one (tier 1 on the new week).
// None may say unknown or an error for EU, and none shows its "Try again" button.
test('the EU reset minute says resetting through a 503, an empty answer and a partial one', async ({ page, wvw }) => {
  test.setTimeout(90 * 1000);
  // The extra tries wait 5 s and then 15 s, which keeps the phases inside the 15 minutes.
  await page.addInitScript(() => { Math.random = () => 0; });
  const { old, newer, list } = await resetMinute(page, wvw, '2026-10-23T18:00:30Z');
  // The week before was loaded: EU's matches still carry the old week, which has ended.
  let served = await serveList(page, list(() => true, () => old));
  await page.goto(wvw.url);
  await wvw.settle();
  await expect(counter(page)).toHaveText('NA 7h 59m · EU resetting');
  const calm = async () => {
    await wvw.settle();
    await expect(counter(page)).toHaveText(/EU resetting/);
    await expect(euStatus(page)).toContainText(resetWords);
    await expect(euStatus(page)).not.toContainText(/Couldn't load|unknown/);
    await expect(euButton(page), 'no Try again beside a note that is not an error').toBeHidden();
    await expect(banner(page)).not.toContainText('unknown');
  };
  // Phase 1: the whole game API answers 503.
  const down = await fail(page, wvw, /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches/);
  await page.clock.fastForward(5 * MIN + 20 * 1000);
  await expect.poll(() => down.reads, { message: 'the refresh failing' }).toBeGreaterThan(0);
  await calm();
  down.off();
  // Phase 2: the list of ids answers, and only the reads of EU's matches 503.
  const all = await fail(page, wvw, /matches\?ids=all$/);
  const eu = await fail(page, wvw, /matches\?ids=2-/);
  await page.clock.fastForward(10 * 1000);
  await expect.poll(() => eu.reads, { message: 'the refresh reading EU' }).toBeGreaterThan(0);
  await calm();
  all.off(); eu.off(); served.off();
  // Phase 3: the answer has no EU matches in it.
  served = await serveList(page, list(() => false, () => old));
  await page.clock.fastForward(20 * 1000);
  await calm();
  await expect(page.locator('#standingsGridEU > .standing-match'), 'last week\'s tiers stay up').toHaveCount(wvw.tiers.EU);
  await expect(page.locator('#standingsGridEU'), "the line-up note").toContainText("Last week's line-up");
  // Phase 4: tier 1 on the new week, the rest still on the old.
  served.off();
  await serveList(page, list(() => true, m => (m.id === '2-1' ? newer : old)));
  await page.clock.fastForward(5 * MIN + 20 * 1000);
  await wvw.settle();
  await expect(counter(page)).toHaveText(/EU 6d 23h/);
  await expect(euStatus(page)).not.toContainText(/Couldn't load|unknown|Weekly reset/);
});

test('past the reset window the error is the usual one', async ({ page, wvw }) => {
  const { old, list } = await resetMinute(page, wvw, '2026-10-23T18:20:30Z');
  await serveList(page, list(() => false, () => old));
  await fail(page, wvw, /matches\?ids=all$/);
  await fail(page, wvw, /matches\?ids=2-/);
  await page.goto(wvw.url);
  await wvw.settle();
  await expect(counter(page)).toHaveText('NA 7h 39m · EU unknown');
  await expect(euStatus(page)).toContainText(/Couldn't load standings\. Trying again in/);
  await expect(page.locator('body')).not.toContainText(resetWords);
  await expect(euButton(page), 'the usual Try again button').toBeVisible();
});
