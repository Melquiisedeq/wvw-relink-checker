// The teams notice (js/relink.js), one test per state a
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

// The rebuilding state the notice lives in: the lockout shut, NA's teams ahead.
const rebuilding = { lockout: -1 * HOUR, assign: { na: 2 * DAY, eu: 2 * DAY - 8 * HOUR } };

test('the teams notice goes up once the sheet says the new table is out', async ({ page, wvw }) => {
  const { windowId } = await open(page, wvw, { ...rebuilding, published: 7 });
  await expect(notice(page)).toBeVisible();
  await expect(notice(page)).toHaveAttribute('data-window', String(windowId));
  await expect(notice(page)).toContainText('The new teams are out.');
  await expect(notice(page).locator('.teams-notice-spoken')).toHaveText('guild list shield');
});

// Nothing published stays down too: notice-teams-check.spec.mjs's relinkWindow asserts the notice hidden in the rebuild before any count.
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
