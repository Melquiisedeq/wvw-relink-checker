// The teams notice: a Check across it reads the new guild table, not the kept
// one (the notice raised the way the page raises it); and in the rebuild window
// the page asks /api/relink on every second one-minute tick, a hidden tab at most
// once in ten minutes; a notice that goes up in a hidden tab marks its title and
// icon until the tab is seen or the notice goes.
import { test, expect } from './support/fixtures.mjs';
import { answer, fail } from './support/faults.mjs';
import { hidden, visible } from './support/scenarios.mjs';
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
  const quiet = () => new Promise(r => setTimeout(r, 300));

  // The page opened in the rebuild window (or, `open: false`, a day before the
  // lockout closes), /api/relink counted and answered with `cell.published`.
  async function relinkWindow(page, wvw, { open = true } = {}) {
    const at = ms => new Date(wvw.opensAt + ms).toISOString().replace('.000Z', 'Z');
    const list = recordedJson(GAME + 'wvw/matches?ids=all').map(m => ({
      ...m, start_time: at(-2 * DAY), end_time: at(5 * DAY) }));
    await answer(page, GAME + 'wvw/matches?ids=all', list);
    const lockout = at(open ? -3600000 : DAY);
    await answer(page, GAME + 'wvw/timers/lockout', { na: lockout, eu: lockout });
    await answer(page, GAME + 'wvw/timers/teamAssignment', { na: at(2 * DAY), eu: at(2 * DAY - 8 * 3600000) });
    const cell = { windowId: Math.floor((wvw.opensAt + 2 * DAY) / 1000), reads: 0, published: 0 };
    await page.route('**/api/relink', async route => {
      cell.reads++;
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ window: cell.windowId, published: cell.published }) });
    });
    await page.goto(wvw.url);
    if (open) await expect(page.locator('#relinkBanner')).toHaveClass(/is-rebuild/);
    await wvw.settle();
    await expect(page.locator('#teamsNotice')).toBeHidden();
    return cell;
  }
  const tab = page => page.evaluate(() => ({
    title: document.title,
    icons: [...document.querySelectorAll('link[rel="icon"]')].map(l => l.getAttribute('href')),
  }));
  // `n` one-minute ticks; the minutes in which `count()` grew, each checked ten or more apart.
  async function asksOver(page, n, count) {
    const asks = [];
    for (let m = 1; m <= n; m++) {
      const before = count();
      await page.clock.fastForward(MIN);
      await quiet();
      if (count() > before) asks.push(m);
    }
    expect(asks.length, `asks at minutes ${asks}: the hidden tab still asks`).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < asks.length; i++) {
      expect(asks[i] - asks[i - 1], `asks at minutes ${asks}: never two inside ten minutes`).toBeGreaterThanOrEqual(10);
    }
  }
  const MARKED_ICONS = ['assets/favicon-dot.png'];
  const markedTitle = title => '\u25cf New teams are out \u2014 ' + title;

  test('in the window the notice arrives within two minutes of the cell changing, with no reload', async ({ page, wvw }) => {
    const cell = await relinkWindow(page, wvw);
    const windowId = cell.windowId;
    const first = cell.reads;
    const was = await tab(page);
    expect(first, 'asked once on opening').toBeGreaterThan(0);

    // Ticks of a minute: one ask every second tick, and a changed cell is seen at the next ask.
    await page.clock.fastForward(MIN);
    await quiet();
    expect(cell.reads, 'tick 1: the kept answer').toBe(first);
    await page.clock.fastForward(MIN);
    await expect.poll(() => cell.reads, { message: 'tick 2: asks again' }).toBe(first + 1);
    await quiet(); // the answer lands before the clock moves on
    cell.published = 5;
    await page.clock.fastForward(MIN);
    await quiet();
    expect(cell.reads, 'tick 3: the kept answer').toBe(first + 1);
    await expect(page.locator('#teamsNotice')).toBeHidden();
    await page.clock.fastForward(MIN);
    await expect(page.locator('#teamsNotice'), 'tick 4: the new cell').toHaveAttribute('data-window', String(windowId));
    expect(cell.reads).toBe(first + 2);
    expect(await tab(page), 'a notice seen going up leaves the tab alone').toEqual(was);
  });

  test('a hidden tab in the window asks at most once in ten minutes, and the notice marks its title and icon until it is seen', async ({ page, wvw }) => {
    const cell = await relinkWindow(page, wvw);
    const was = await tab(page);
    expect(was.icons, 'the tab icons of index.html').toEqual(['assets/favicon-192.png', 'favicon.ico']);
    await hidden(page, wvw, 0);

    await asksOver(page, 40, () => cell.reads);
    expect(await tab(page), 'no notice, no mark').toEqual(was);

    cell.published = 5;
    for (let m = 0; m < 11 && !(await page.locator('#teamsNotice').isVisible()); m++) {
      await page.clock.fastForward(MIN);
      await quiet();
    }
    await expect(page.locator('#teamsNotice')).toHaveAttribute('data-window', String(cell.windowId));
    expect(await tab(page), 'the notice went up hidden').toEqual({ title: markedTitle(was.title), icons: MARKED_ICONS });

    await visible(page);
    expect(await tab(page), 'seen: the title and the icons back').toEqual(was);

    // Hidden again with the notice still up: it was seen, so nothing changes and nothing is asked.
    const reads = cell.reads;
    await hidden(page, wvw, 0);
    for (let m = 0; m < 12; m++) await page.clock.fastForward(MIN);
    await quiet();
    expect(await tab(page), 'the notice already seen').toEqual(was);
    expect(cell.reads, 'the notice up: no asks').toBe(reads);
  });

  test('a marked tab is put back when the notice is dismissed, and when the window ends', async ({ page, wvw }) => {
    const cell = await relinkWindow(page, wvw);
    const was = await tab(page);
    const raise = async () => {
      await hidden(page, wvw, 0);
      cell.published = 5;
      await page.evaluate(() => { relinkStateAt = 0; updateRelinkBanner(); });
      await expect(page.locator('#teamsNotice')).toBeVisible();
      expect(await tab(page), 'the notice went up hidden').toEqual({ title: markedTitle(was.title), icons: MARKED_ICONS });
    };

    await raise();
    const assigned = await page.evaluate(() => assignNA);
    await page.evaluate(() => { assignNA = Date.now() - 1000; updateRelinkBanner(); });
    await expect(page.locator('#teamsNotice')).toBeHidden();
    expect(await tab(page), 'the window over: the title and the icons back').toEqual(was);

    await page.evaluate(t => { assignNA = t; }, assigned);
    await raise();
    await page.locator('.teams-notice-close').click();
    await expect(page.locator('#teamsNotice')).toBeHidden();
    expect(await tab(page), 'dismissed: the title and the icons back').toEqual(was);
  });

  test('a hidden tab whose asks fail still asks at most once in ten minutes', async ({ page, wvw }) => {
    await relinkWindow(page, wvw);
    const own = await fail(page, wvw, /\/api\/relink$/);
    const sheet = await fail(page, wvw, /^https:\/\/docs\.google\.com\/spreadsheets\//);
    await hidden(page, wvw, 0);
    await asksOver(page, 40, () => own.reads);
    expect(sheet.reads, 'the sheet asked after each failed ask, no more').toBe(own.reads);
    await expect(page.locator('#teamsNotice')).toBeHidden();
  });

  test('a hidden tab outside the window asks nothing', async ({ page, wvw }) => {
    const cell = await relinkWindow(page, wvw, { open: false });
    expect(cell.reads, 'outside the window: no ask on opening').toBe(0);
    await hidden(page, wvw, 0);
    for (let m = 0; m < 30; m++) await page.clock.fastForward(MIN);
    await quiet();
    expect(cell.reads, 'thirty minutes hidden outside the window').toBe(0);
  });
});
