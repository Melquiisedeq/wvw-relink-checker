// The teams notice: a Check across it reads the new guild table, not the kept
// one (the notice raised the way the page raises it); and in the rebuild window
// the page asks /api/relink on every second one-minute tick.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { check, recordedJson } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const GAME = 'https://api.guildwars2.com/v2/';

test('the Check after the teams notice reads the new guild table', async ({ page, wvw }) => {
  expect(wvw.guilds.length).toBeGreaterThanOrEqual(2);
  const tables = {};
  for (const r of ['na', 'eu']) tables[r] = { url: GAME + 'wvw/guilds/' + r, body: recordedJson(GAME + 'wvw/guilds/' + r) };
  const where = wvw.guilds.slice(0, 2).map(name => {
    const gid = recordedJson(`${GAME}guild/search?name=${encodeURIComponent(name)}`)[0];
    const r = ['na', 'eu'].find(x => gid && Object.hasOwn(tables[x].body, gid));
    expect(r, `${name} in a recorded guild table`).toBeTruthy();
    return { gid, r };
  });
  const was = tables[where[0].r].body[where[0].gid];
  const next = tables[where[1].r].body[where[1].gid];
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await wvw.settle();
  const nameOf = t => page.evaluate(i => getTeamName(i), t);
  const [wasName, nextName] = [await nameOf(was), await nameOf(next)];
  expect(wasName, 'the two guilds\' teams share a name').not.toBe(nextName);
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#resultBody tr')].map(tr => tr.querySelector('.server-cell')?.textContent ?? null));

  await page.evaluate('wvwMapCache = null');
  await check(page, wvw, [wvw.guilds[0]]);
  expect(String((await rows())[0]), 'the first Check').toContain(wasName);

  // The table is rewritten, then the notice goes up.
  const moved = structuredClone(tables[where[0].r].body);
  moved[where[0].gid] = next;
  await answer(page, tables[where[0].r].url, moved);
  await page.evaluate(() => {
    const win = 1900000000;
    lockoutTime = Date.now() - 60000; assignNA = win * 1000;
    relinkState = { window: win, published: 1 }; relinkStateAt = Date.now();
    localStorage.removeItem('wvw-relink-checker:teams-notice');
    updateRelinkBanner();
  });
  await expect(page.locator('#teamsNotice')).toHaveAttribute('data-window', '1900000000');
  await check(page, wvw, [wvw.guilds[0]]);
  expect(String((await rows())[0]), `after the notice, wanted the new team (the kept table has "${wasName}")`).toContain(nextName);
});

test.describe('the notice on the one-minute tick', () => {
  test.use({ clock: 'playwright', timezoneId: 'UTC', locale: 'en-US' });
  const DAY = 24 * 3600 * 1000, MIN = 60 * 1000;

  test('in the window the notice arrives within two minutes of the cell changing, with no reload', async ({ page, wvw }) => {
    const at = ms => new Date(wvw.opensAt + ms).toISOString().replace('.000Z', 'Z');
    const list = recordedJson(GAME + 'wvw/matches?ids=all').map(m => ({
      ...m, start_time: at(-2 * DAY), end_time: at(5 * DAY) }));
    await answer(page, GAME + 'wvw/matches?ids=all', list);
    await answer(page, GAME + 'wvw/timers/lockout', { na: at(-3600000), eu: at(-3600000) });
    await answer(page, GAME + 'wvw/timers/teamAssignment', { na: at(2 * DAY), eu: at(2 * DAY - 8 * 3600000) });
    const windowId = Math.floor((wvw.opensAt + 2 * DAY) / 1000);
    let reads = 0, published = 0;
    await page.route('**/api/relink', async route => {
      reads++;
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ window: windowId, published }) });
    });
    await page.goto(wvw.url);
    await expect(page.locator('#relinkBanner')).toHaveClass(/is-rebuild/);
    await wvw.settle();
    await expect(page.locator('#teamsNotice')).toBeHidden();
    const first = reads;
    expect(first, 'asked once on opening').toBeGreaterThan(0);

    // Ticks of a minute: one ask every second tick, and a changed cell is seen at the next ask.
    const quiet = () => new Promise(r => setTimeout(r, 300));
    await page.clock.fastForward(MIN);
    await quiet();
    expect(reads, 'tick 1: the kept answer').toBe(first);
    await page.clock.fastForward(MIN);
    await expect.poll(() => reads, { message: 'tick 2: asks again' }).toBe(first + 1);
    await quiet(); // the answer lands before the clock moves on
    published = 5;
    await page.clock.fastForward(MIN);
    await quiet();
    expect(reads, 'tick 3: the kept answer').toBe(first + 1);
    await expect(page.locator('#teamsNotice')).toBeHidden();
    await page.clock.fastForward(MIN);
    await expect(page.locator('#teamsNotice'), 'tick 4: the new cell').toHaveAttribute('data-window', String(windowId));
    expect(reads).toBe(first + 2);
  });
});
