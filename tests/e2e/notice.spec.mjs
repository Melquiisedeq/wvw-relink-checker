// A Check before the teams notice and another after it, the guild table
// written in between: the second must read the new table, not the kept one.
// The notice is raised the way the page raises it (a relink state for this
// window, the lockout gone, the assignment ahead).
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
