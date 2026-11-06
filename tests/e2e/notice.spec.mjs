// The teams notice: a Check across it reads the new guild table, not the kept
// one (the notice raised the way the page raises it); and in the rebuild window
// the page asks /api/relink on every second one-minute tick, a hidden tab at most
// once in ten minutes; a notice that goes up in a hidden tab marks its title and
// icon until the tab is seen or the notice goes.
import { test, expect } from './support/fixtures.mjs';
import { answer, fail } from './support/faults.mjs';
import { hidden, visible } from './support/scenarios.mjs';
import { check, raiseNotice, recordedJson } from './support/steps.mjs';

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
  await raiseNotice(page);
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
  const NOTICE_TITLE = '\u{1F514} New teams are out!';
  const FLIP = 2000;

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

  test('after /api/relink fails for five minutes, the notice is up within two minutes of it answering', async ({ page, wvw }) => {
    const cell = await relinkWindow(page, wvw);
    await page.route('**/api/relink', route => route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ window: cell.windowId, published: 5 }) }));
    const down = await fail(page, wvw, /\/api\/relink$/);
    let sheetReads = 0;
    await page.route(/^https:\/\/docs\.google\.com\/spreadsheets\//, route => { sheetReads++; return route.fulfill({
      status: 200, contentType: 'text/csv', headers: { 'Access-Control-Allow-Origin': '*' }, body: `"${cell.windowId}:0"` }); });
    for (let m = 0; m < 5; m++) { await page.clock.fastForward(MIN); await quiet(); }
    expect(down.reads, '/api/relink asked again while down').toBeGreaterThanOrEqual(2);
    expect(sheetReads, 'the sheet read once in ten minutes').toBe(1);
    await expect(page.locator('#teamsNotice')).toBeHidden();
    down.off();
    for (let m = 0; m < 2; m++) { await page.clock.fastForward(MIN); await quiet(); }
    await expect(page.locator('#teamsNotice'), 'two minutes after /api/relink answers')
      .toHaveAttribute('data-window', String(cell.windowId));
  });

  test('a tab shown again asks and draws at once, and flicking it does not multiply the reads', async ({ page, wvw }) => {
    const cell = await relinkWindow(page, wvw);
    await hidden(page, wvw, 0);
    for (let m = 0; m < 3; m++) { await page.clock.fastForward(MIN); await quiet(); }
    const before = cell.reads;
    await visible(page);
    await expect.poll(() => cell.reads, { message: 'one ask for the return' }).toBe(before + 1);
    await quiet();
    for (let i = 0; i < 5; i++) { await hidden(page, wvw, 0); await visible(page); }
    await quiet();
    expect(cell.reads, 'flicking the tab inside the TTL reads nothing more').toBe(before + 1);

    cell.published = 5;
    await hidden(page, wvw, 0);
    for (let m = 0; m < 2; m++) { await page.clock.fastForward(MIN); await quiet(); }
    await expect(page.locator('#teamsNotice')).toBeHidden();
    await visible(page);
    await expect(page.locator('#teamsNotice'), 'shown, no tick').toHaveAttribute('data-window', String(cell.windowId));
  });

  test('a tab shown again within the timers\' refresh shows the countdown of the new instant, with no tick', async ({ page, wvw }) => {
    const cell = await relinkWindow(page, wvw);
    const times = () => page.locator('#relinkBanner .time').allTextContents();
    const sleep = async ms => {
      await hidden(page, wvw, 0);
      await page.clock.setSystemTime(new Date(await page.evaluate(ms => Date.now() + ms, ms)));
      await quiet();
    };
    // Half an hour before NA's assignment, shown once: the timers are read afresh.
    await sleep(cell.windowId * 1000 - 30.5 * MIN - await page.evaluate(() => Date.now()));
    await visible(page);
    await expect.poll(times).toContain('30m');
    await quiet();
    const was = await times();
    // Four minutes more, inside the timers' and the standings' refresh: only the redraw on show can change them.
    await sleep(4 * MIN);
    expect(await times(), 'a hidden tab draws nothing by itself').toEqual(was);
    await visible(page);
    expect(await times(), 'shown: the countdown of the new instant, before any read answers').toContain('26m');
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
    expect(await tab(page), 'the notice went up hidden').toEqual({ title: NOTICE_TITLE, icons: MARKED_ICONS });

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
      expect(await tab(page), 'the notice went up hidden').toEqual({ title: NOTICE_TITLE, icons: MARKED_ICONS });
    };

    await raise();
    const assigned = await page.evaluate(() => assignNA);
    await page.evaluate(() => { assignNA = Date.now() - 1000; updateRelinkBanner(); });
    await expect(page.locator('#teamsNotice')).toBeHidden();
    expect(await tab(page), 'the window over: the title and the icons back').toEqual(was);
    await clockStopped(page, was);

    await page.evaluate(t => { assignNA = t; }, assigned);
    await raise();
    await page.locator('.teams-notice-close').click();
    await expect(page.locator('#teamsNotice')).toBeHidden();
    expect(await tab(page), 'dismissed: the title and the icons back').toEqual(was);
    await clockStopped(page, was);
  });

  // Three flips (odd, so a clock still running would leave the other title) with no page error
  // (a clock left running after the mark is gone throws instead of flipping).
  async function clockStopped(page, was) {
    const errors = [];
    const onError = e => errors.push(e.message);
    page.on('pageerror', onError);
    for (let i = 0; i < 3; i++) await page.clock.fastForward(FLIP);
    page.off('pageerror', onError);
    expect((await tab(page)).title, 'the clock stopped').toBe(was.title);
    expect(errors, 'nothing ran after the mark went').toEqual([]);
  }

  // Raises the notice in a hidden tab; returns the tab as it was.
  async function raiseHidden(page, wvw, cell) {
    const was = await tab(page);
    await hidden(page, wvw, 0);
    cell.published = 5;
    await page.evaluate(() => { relinkStateAt = 0; updateRelinkBanner(); });
    await expect(page.locator('#teamsNotice')).toBeVisible();
    return was;
  }

  test('the dot is inserted after the old icons are gone, and the originals return after the dot is gone', async ({ page, wvw }) => {
    const cell = await relinkWindow(page, wvw);
    await page.evaluate(() => {
      // The records are replayed in order, so `others` is what was in the document at that insertion.
      window.iconLog = [];
      const isIcon = n => n.nodeType === 1 && n.matches('link[rel~="icon"]');
      const present = new Set(document.querySelectorAll('link[rel~="icon"]'));
      const hrefs = () => [...present].map(l => l.getAttribute('href'));
      new MutationObserver(records => {
        for (const r of records) {
          if (r.type === 'attributes' && isIcon(r.target)) window.iconLog.push({ op: 'href', href: r.target.getAttribute('href') });
          for (const n of r.removedNodes) if (isIcon(n)) { present.delete(n); window.iconLog.push({ op: 'remove', href: n.getAttribute('href') }); }
          for (const n of r.addedNodes) if (isIcon(n)) { window.iconLog.push({ op: 'insert', href: n.getAttribute('href'), others: hrefs() }); present.add(n); }
        }
      }).observe(document.head, { childList: true, attributes: true, attributeFilter: ['href'], subtree: true });
    });
    await raiseHidden(page, wvw, cell);
    const marked = await page.evaluate(() => window.iconLog.splice(0));
    const last = marked[marked.length - 1];
    expect(last, 'marking ends on an insertion').toMatchObject({ op: 'insert', href: 'assets/favicon-dot.png' });
    expect(last.others, 'no other icon in the document when the dot goes in').toEqual([]);

    await visible(page);
    const unmarked = await page.evaluate(() => window.iconLog.splice(0));
    const end = unmarked[unmarked.length - 1];
    expect(end.op, 'unmarking ends on an insertion').toBe('insert');
    expect(end.href, 'of an original icon').not.toBe('assets/favicon-dot.png');
    expect(end.others, 'the dot already gone').not.toContain('assets/favicon-dot.png');
    expect(unmarked.find(e => e.op === 'remove' && e.href === 'assets/favicon-dot.png'), 'the dot was removed').toBeTruthy();
  });

  test('a marked tab alternates its title every two seconds until it is seen', async ({ page, wvw }) => {
    const cell = await relinkWindow(page, wvw);
    await page.clock.pauseAt(await wvw.now() + 1000); // no real second slips a flip in between
    const was = await raiseHidden(page, wvw, cell);
    expect((await tab(page)).title).toBe(NOTICE_TITLE);
    await page.clock.fastForward(FLIP);
    expect((await tab(page)).title).toBe(was.title);
    await page.clock.fastForward(FLIP);
    expect((await tab(page)).title).toBe(NOTICE_TITLE);
    await page.clock.fastForward(FLIP);
    expect((await tab(page)).title).toBe(was.title);

    await visible(page);
    expect((await tab(page)).title).toBe(was.title);
    await clockStopped(page, was);
  });

  test('a marked tab keeps one fixed title for those who asked for reduced motion', async ({ page, wvw }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const cell = await relinkWindow(page, wvw);
    const was = await raiseHidden(page, wvw, cell);
    const fixed = NOTICE_TITLE + ' \u2014 ' + was.title;
    expect((await tab(page)).title).toBe(fixed);
    for (let i = 0; i < 4; i++) await page.clock.fastForward(FLIP);
    expect((await tab(page)).title, 'no alternating').toBe(fixed);
    await visible(page);
    expect((await tab(page)).title).toBe(was.title);
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
