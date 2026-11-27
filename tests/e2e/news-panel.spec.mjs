// The news panel under the search: the WvW lines of the game's update notes, read from /api/notes once
// the standings are painted. Every answer here is served by the spec, shaped as the Worker serves it
// (worker/notes.mjs, publish): {v, wiki, notes: [{day, update, section, sub, text, type, hotfix, page, link}]}.
import { test, expect } from './support/fixtures.mjs';
import { pastEdge } from './support/edge.mjs';
import { iso } from './support/steps.mjs';
import { hidden, visible } from './support/scenarios.mjs';

const WIKI = 'https://wiki.guildwars2.com/wiki/';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = 864e5;

// A line as the Worker serves it, `ago` days before the page opens.
const line = (opens, ago, text, type, extra = {}) => {
  const day = iso(opens - ago * DAY).slice(0, 10);
  const d = new Date(opens - ago * DAY);
  return {
    day, update: `Update - ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`,
    section: 'World vs. World', sub: '', text, type, hotfix: false, page: `${WIKI}Game_updates/${day}`, link: null, ...extra,
  };
};
// The 12:00 UTC of the first day that is still ahead of `opens` by under a day.
const betaEnd = opens => {
  const noon = new Date(opens); noon.setUTCHours(12, 0, 0, 0);
  return noon.getTime() > opens ? noon.getTime() : noon.getTime() + DAY;
};
const untilText = end => `${MONTHS[new Date(end).getUTCMonth()]} ${new Date(end).getUTCDate()}`;
const span = ms => `${Math.floor(ms / 3600e3)}h ${Math.floor(ms / 60e3) % 60}m`;

async function serveNotes(page, body, { status = 200, reads = [] } = {}) {
  await page.route('**/api/notes', async route => {
    reads.push(Date.now());
    await route.fulfill({ status, contentType: 'application/json', body: typeof body === 'string' ? body : JSON.stringify({ v: 'a'.repeat(16), wiki: 1, notes: body }) });
  });
}
const panel = page => page.getByRole('region', { name: 'Game updates for WvW' });

// The newest map as the lead, a rule table, a nerf and a buff with their professions' icons, a fix,
// and a line the rules were not sure of.
const rich = opens => {
  const end = betaEnd(opens);
  return [
    line(opens, 2, `The new Example Borderlands map has replaced the Seared Borderlands map in WvW! The beta for this new map will run until ${untilText(end)}.`, 'event', { link: WIKI + 'Example_Borderlands' }),
    line(opens, 2, 'Fixed an issue that caused the Example Borderlands garrison gate to stay closed after a capture.', 'bug', { section: 'Bug Fixes' }),
    line(opens, 2, 'Siege golems now take part in the War Score of the objective they were built in.', null),
    line(opens, 6, 'Keep captures: 250 → 100 (T0)', 'wvw_rule'),
    line(opens, 6, 'Camp captures: 100 → 50 (T0)', 'wvw_rule'),
    line(opens, 6, 'Tower captures: 150 → 75 (T0)', 'wvw_rule'),
    line(opens, 6, 'Blazing Barrage: Reduced the power coefficient from 1.1 to 0.935 in WvW only.', 'nerf', { section: 'Profession Skills', sub: 'Tempest', link: WIKI + 'Blazing_Barrage' }),
    line(opens, 9, `Supply camps now deliver supply faster during a War Score beta until ${untilText(end)}.`, 'wvw_rule'),
    line(opens, 9, "Death's Retreat: Reduced the initiative cost from 6 to 5 in WvW only.", 'buff', { section: 'Profession Skills', sub: 'Thief' }),
    line(opens, 12, 'Keep waypoints now stay open for 30 seconds after the objective becomes contested.', 'wvw_rule'),
  ];
};

// Old enough for no lead, three days so that all show: an event, a reward, a hotfix line, a non-boolean hotfix.
const extras = opens => [
  line(opens, 50, 'Match rewards and skirmish rewards that were previously beta tested will now be fully released as well!', 'reward'),
  line(opens, 50, 'Fixed a bug that prevented players from buying Heart of Thorns items from the Heroics Notary in WvW.', 'bug', { section: 'Bug Fixes', hotfix: true }),
  line(opens, 51, 'The Example Festival returns to the Mists and unlocks a new title for every guild.', 'event'),
  line(opens, 51, 'Hot gates now stay shut for 4 seconds after a capture.', 'wvw_rule', { hotfix: 'yes' }),
  line(opens, 52, 'Odd camps now hold 7 supply more after a capture.', 'wvw_rule', { hotfix: 1 }),
];

test.describe('event, reward and hotfix', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('each is tagged, the hotfix is marked, and a hotfix that is no boolean is none', async ({ page, wvw }) => {
    await serveNotes(page, extras(wvw.opensAt));
    await page.goto(wvw.url);
    const p = panel(page);
    await expect(p).toBeVisible();
    await p.getByRole('button', { name: 'All' }).click();
    const row = t => p.locator('.news-r').filter({ hasText: t });
    await expect(row('Match rewards and skirmish').getByText('Reward', { exact: true })).toBeVisible();
    await expect(row('Example Festival').getByText('Event', { exact: true })).toBeVisible();
    const fix = row('Heroics Notary');
    await expect(fix.getByText('Fix', { exact: true })).toBeVisible();
    await expect(fix.getByText('Hotfix · wiki')).toBeVisible();
    await expect(p.getByText('Hotfix · wiki')).toHaveCount(1);
    await expect(row('Hot gates').getByText('Rule', { exact: true })).toBeVisible();
    await expect(row('Odd camps')).toBeVisible();
  });

  test('the filters: WvW keeps the event and the reward, Fixes shows the hotfix, the hotfix stays out of WvW', async ({ page, wvw }) => {
    await serveNotes(page, extras(wvw.opensAt));
    await page.goto(wvw.url);
    const p = panel(page);
    await expect(p).toBeVisible();
    await p.getByRole('button', { name: 'Fixes' }).click();
    await expect(p.getByText('Heroics Notary')).toBeVisible();
    await expect(p.getByText('Hotfix · wiki')).toBeVisible();
    await expect(p.getByText('Example Festival')).toHaveCount(0);
    await p.getByRole('button', { name: 'WvW' }).click();
    await expect(p.getByText('Heroics Notary')).toHaveCount(0);
    await expect(p.getByText('Match rewards and skirmish')).toBeVisible();
    await expect(p.getByText('Example Festival')).toBeVisible();
    await expect(p.locator('.news-lead')).toHaveCount(0);
  });

  test('an event is the lead when it is the newest, with its countdown', async ({ page, wvw }) => {
    const end = betaEnd(wvw.opensAt);
    await serveNotes(page, [
      line(wvw.opensAt, 1, `The Example Festival is on in WvW and will run until ${untilText(end)}.`, 'event'),
      line(wvw.opensAt, 1, 'Fixed a bug with the festival banner.', 'bug', { hotfix: true }),
    ]);
    await page.goto(wvw.url);
    const p = panel(page);
    await expect(p.getByText(/^\d+ \w+ · Event$/)).toBeVisible();
    await expect(p.getByText('Event ends in')).toHaveText(`Event ends in ${span(end - wvw.opensAt)}`);
    await expect(p.getByText('Hotfix · wiki')).toHaveCount(0);
  });

  test('the event of a map\'s own update is not drawn beside the map', async ({ page, wvw }) => {
    await serveNotes(page, [
      line(wvw.opensAt, 60, `The new Example Borderlands map has replaced the Seared Borderlands map in WvW! The beta for this new map will run until ${untilText(wvw.opensAt - 61 * DAY)}.`, 'event'),
      line(wvw.opensAt, 60, 'The Example Borderlands beta event begins.', 'event'),
      line(wvw.opensAt, 60, 'The Mists Festival gives every guild a banner.', 'event'),
      line(wvw.opensAt, 62, 'The Other Festival returns to the Mists.', 'event'),
    ]);
    await page.goto(wvw.url);
    const p = panel(page);
    await expect(p.getByText('The Other Festival')).toBeVisible();
    await expect(p.getByText('beta event begins')).toHaveCount(0);
    await expect(p.getByText('The Mists Festival')).toBeVisible();
    await expect(p.locator('.news-r').filter({ hasText: 'Example Borderlands map has replaced' }).getByText('Map', { exact: true })).toBeVisible();
  });

  test('a hotfix alone is never a lead', async ({ page, wvw }) => {
    await serveNotes(page, [line(wvw.opensAt, 1, 'Fixed a bug with the gates.', 'bug', { hotfix: true })]);
    await page.goto(wvw.url);
    const p = panel(page);
    await expect(p).toBeVisible();
    await expect(p.locator('.news-lead')).toHaveCount(0);
    await p.getByRole('button', { name: 'Fixes' }).click();
    await expect(p.getByText('Hotfix · wiki')).toBeVisible();
  });
});

test.describe('the panel and its lines', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('each kind of line is drawn: the lead and its countdown, the tags, the icons, the wiki link', async ({ page, wvw }) => {
    await serveNotes(page, rich(wvw.opensAt));
    await page.goto(wvw.url);
    const p = panel(page);
    await expect(p).toBeVisible();
    await expect(p.getByText('Guild Wars 2 Wiki')).toBeVisible();
    await expect(p.getByRole('link', { name: 'wiki ↗' })).toHaveAttribute('href', WIKI + 'Game_updates');
    // The lead: the newest map, its two sentences, the beta's countdown.
    await expect(p.getByRole('link', { name: 'The new Example Borderlands map has replaced the Seared Borderlands map in WvW' })).toHaveAttribute('href', WIKI + 'Example_Borderlands');
    await expect(p.getByText('Beta ends in')).toHaveText(`Beta ends in ${span(betaEnd(wvw.opensAt) - wvw.opensAt)}`);
    await expect(p.getByText(/^\d+ \w+ · New map$/)).toBeVisible();
    // The timeline: the value table as one line, a nerf with its icon, the "Until" tag.
    await expect(p.getByText('Point values')).toBeVisible();
    await expect(p.getByText('3 values changed, starting with Keep captures: 250 → 100 (T0)')).toBeVisible();
    const nerf = p.locator('.news-r').filter({ hasText: 'Blazing Barrage' });
    await expect(nerf.getByText('▼ Nerf')).toBeVisible();
    // The triangle is a drawing; the word stays for a screen reader.
    await expect(nerf.locator('.news-tag-nerf > [aria-hidden="true"]')).toHaveText('▼');
    await expect(nerf.getByText('WvW only')).toBeVisible();
    await expect(nerf.getByRole('img', { name: 'Elementalist' })).toHaveAttribute('src', /^https:\/\/render\.guildwars2\.com\/file\/[0-9A-F]+\/\d+\.png$/);
    await expect(nerf.getByRole('link', { name: 'Blazing Barrage' })).toHaveAttribute('href', WIKI + 'Blazing_Barrage');
    await expect(nerf.getByText('0.935')).toBeVisible();
    const buff = p.locator('.news-r').filter({ hasText: "Death's Retreat" });
    await expect(buff.getByText('▲ Buff')).toBeVisible();
    await expect(buff.getByRole('img', { name: 'Thief' })).toBeVisible();
    await expect(p.locator('.news-r').filter({ hasText: 'Supply camps' }).getByText(`Until ${new Date(betaEnd(wvw.opensAt)).getUTCDate()} ${MONTHS[new Date(betaEnd(wvw.opensAt)).getUTCMonth()].slice(0, 3)}`)).toBeVisible();
    await expect(p.getByText('Rule', { exact: true }).first()).toBeVisible();
    await wvw.settle();
  });

  test('the filters: WvW first, All adds the fixes and the line with no label, Fixes only the fixes', async ({ page, wvw }) => {
    await serveNotes(page, rich(wvw.opensAt));
    await page.goto(wvw.url);
    const p = panel(page);
    await expect(p).toBeVisible();
    const fixText = 'Fixed an issue that caused the Example Borderlands garrison gate';
    const bare = 'Siege golems now take part in the War Score';
    await expect(p.getByRole('button', { name: 'WvW' })).toHaveAttribute('aria-pressed', 'true');
    await expect(p.getByText(fixText)).toHaveCount(0);
    await expect(p.getByText(bare)).toHaveCount(0);
    await p.getByRole('button', { name: 'All' }).click();
    await expect(p.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    await expect(p.getByRole('button', { name: 'All' })).toBeFocused();
    await expect(p.getByText(fixText)).toBeVisible();
    // The line the rules were not sure of: as it came, with no tag.
    const row = p.locator('.news-r').filter({ hasText: bare });
    await expect(row).toBeVisible();
    await expect(row.locator('.news-tag')).toHaveCount(0);
    await expect(p.locator('.news-r').filter({ hasText: fixText }).getByText('Fix', { exact: true })).toBeVisible();
    await p.getByRole('button', { name: 'Fixes' }).click();
    await expect(p.getByText(fixText)).toBeVisible();
    await expect(p.getByText(bare)).toHaveCount(0);
    await expect(p.getByText('Blazing Barrage')).toHaveCount(0);
    await p.getByRole('button', { name: 'WvW' }).click();
    await expect(p.getByText(fixText)).toHaveCount(0);
    await wvw.settle();
  });

  test('a link that is not a page of the wiki is never an href, and the text is never markup', async ({ page, wvw }) => {
    // Two lines a day, three days: five lines, all on show.
    const old = n => 70 + Math.floor(n / 2);
    const markup = '<img src=x onerror="window.pwned=1"> Keep rule: now stricter in WvW.';
    await serveNotes(page, [
      line(wvw.opensAt, old(0), 'Waypoints now stay open for 30 seconds.', 'wvw_rule', { link: 'https://evil.example/wiki/Waypoint', page: 'https://wiki.guildwars2.com.evil.example/wiki/Game_updates/x' }),
      line(wvw.opensAt, old(1), 'Gates now stay shut for 5 seconds.', 'wvw_rule', { link: 'javascript:window.pwned=1', page: 'https://wiki.guildwars2.com@evil.example/wiki/Gate' }),
      line(wvw.opensAt, old(2), 'Walls now hold for 9 seconds.', 'wvw_rule', { link: 'http://wiki.guildwars2.com/wiki/Wall', page: `${WIKI}Game_updates/x` }),
      line(wvw.opensAt, old(3), markup, 'wvw_rule', { link: 'https://wiki.guildwars2.com/other/Path' }),
      line(wvw.opensAt, old(4), 'Keeps now hold for 12 seconds.', 'wvw_rule', { link: 'https://user:pw@wiki.guildwars2.com/wiki/Stonemist_Castle?x=1#Notes' }),
    ]);
    await page.goto(wvw.url);
    const p = panel(page);
    await expect(p).toBeVisible();
    await p.getByRole('button', { name: 'All' }).click();
    // The markup is text, shown whole.
    await expect(p.getByText('<img src=x onerror="window.pwned=1">', { exact: false })).toBeVisible();
    // No icon, no element of the answer's making.
    await expect(p.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => window.pwned)).toBeUndefined();
    const hrefs = await p.getByRole('link').evaluateAll(links => links.map(a => a.href));
    expect(hrefs.length, 'the wiki link of the header, and the line with a real link').toBeGreaterThanOrEqual(2);
    for (const h of hrefs) {
      const u = new URL(h);
      expect(u.origin, `href ${h}`).toBe('https://wiki.guildwars2.com');
      expect(u.username, `href ${h}`).toBe('');
      expect(u.pathname.startsWith('/wiki/'), `href ${h}`).toBe(true);
    }
    // A real page of the wiki is kept, rebuilt without its userinfo and query.
    await expect(p.getByRole('link', { name: 'Keeps now hold for 12 seconds.' })).toHaveAttribute('href', WIKI + 'Stonemist_Castle#Notes');
    await expect(p.getByRole('link', { name: 'Gates now stay shut for 5 seconds.' })).toHaveCount(0);
    await expect(p.getByText('Gates now stay shut for 5 seconds.')).toBeVisible();
    await wvw.settle();
  });
});

test.describe('no answer, no panel', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  for (const [what, status, body] of [
    ['a server error', 503, '{"error":"down"}'],
    ['an answer that is not JSON', 200, '<html>'],
    ['an answer with no notes', 200, '{"v":"","wiki":0,"notes":[]}'],
    ['an answer of lines out of shape', 200, '{"v":"x","wiki":0,"notes":[{"day":"yesterday","text":"x"},null,7,{"day":"2026-01-01","text":""}]}'],
  ]) {
    test(`${what}: the panel is not made, and its styles are not read`, async ({ page, wvw }) => {
      wvw.allowLog(/api\/notes/);
      const reads = [];
      const sheets = [];
      page.on('request', r => { if (r.url().endsWith('/css/news.css')) sheets.push(r.url()); });
      await serveNotes(page, body, { status, reads });
      await page.goto(wvw.url);
      await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
      await expect.poll(() => reads.length).toBe(1);
      await wvw.settle();
      await expect(panel(page)).toHaveCount(0);
      expect(sheets, 'the panel\'s styles read for nothing').toEqual([]);
    });
  }

  test('with the notes route unreachable the page still opens', async ({ page, wvw }) => {
    wvw.allowLog(/api\/notes/);
    await page.route('**/api/notes', route => route.abort('failed'));
    await page.goto(wvw.url);
    await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
    await wvw.settle();
    await expect(panel(page)).toHaveCount(0);
  });
});

test.describe('when it loads', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the notes are asked for after the standings are painted, once, and the styles come with the panel', async ({ page, wvw }) => {
    let reads = 0;
    let sheetBeforeRead = false;
    page.on('request', r => { if (r.url().endsWith('/css/news.css') && !reads) sheetBeforeRead = true; });
    await serveNotes(page, rich(wvw.opensAt));
    page.on('request', r => { if (r.url().endsWith('/api/notes')) reads++; });
    // The standings' first read is held: with the cards not on the page the notes must not be asked for.
    let release;
    const held = new Promise(r => { release = r; });
    await page.route(/api\.guildwars2\.com\/v2\/wvw\/matches/, async route => { await held; await route.fallback(); });
    await page.goto(wvw.url);
    await page.waitForTimeout(1500);
    expect(reads, 'notes asked for while the standings were still loading').toBe(0);
    release();
    await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
    await expect(panel(page)).toBeVisible();
    await wvw.settle();
    expect(reads).toBe(1);
    expect(sheetBeforeRead, 'the panel\'s styles asked for before the notes').toBe(false);
  });
});

test.describe('the clock', () => {
  test.use({ viewport: { width: 1280, height: 800 }, clock: 'playwright' });

  test('the beta countdown runs down by the minute, and the line goes back to its kind when the beta is over', async ({ page, wvw }) => {
    await serveNotes(page, rich(wvw.opensAt));
    await page.goto(wvw.url);
    const p = panel(page);
    const end = betaEnd(wvw.opensAt);
    await expect(p.getByText('Beta ends in')).toHaveText(`Beta ends in ${span(end - wvw.opensAt)}`);
    const run = async ms => { for (let t = 0; t < ms; t += 3000) await page.clock.runFor(Math.min(3000, ms - t)); };
    await run(60000);
    await expect(p.getByText('Beta ends in')).toHaveText(`Beta ends in ${span(end - wvw.opensAt - 60000)}`);
    await run(60000);
    await expect(p.getByText('Beta ends in')).toHaveText(`Beta ends in ${span(end - wvw.opensAt - 120000)}`);
    await page.clock.setSystemTime(end + 5 * 60000);
    await run(60000);
    await expect(p.getByText('Beta ends in')).toHaveCount(0);
    const supply = p.locator('.news-r').filter({ hasText: 'Supply camps' });
    await expect(supply.getByText('Rule', { exact: true })).toBeVisible();
    await expect(supply.getByText(/^Until /)).toHaveCount(0);
  });

  test('a filter button holding the focus does not stop the countdown, and keeps the focus', async ({ page, wvw }) => {
    await serveNotes(page, rich(wvw.opensAt));
    await page.goto(wvw.url);
    const p = panel(page);
    const end = betaEnd(wvw.opensAt);
    await expect(p.getByText('Beta ends in')).toBeVisible();
    await p.getByRole('button', { name: 'All' }).click();
    await expect(p.getByRole('button', { name: 'All' })).toBeFocused();
    const all = await p.getByRole('button', { name: 'All' }).elementHandle();
    for (let t = 0; t < 60000; t += 3000) await page.clock.runFor(3000);
    await expect(p.getByText('Beta ends in')).toHaveText(`Beta ends in ${span(end - wvw.opensAt - 60000)}`);
    // The same node, not one drawn again: a screen reader is not told of a new control every minute.
    expect(await page.evaluate(b => document.activeElement === b && b.isConnected, all), 'the very button still holds the focus').toBe(true);
    await expect(p.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('a beta that ends while the tab is hidden is gone from the panel when the tab is seen again', async ({ page, wvw }) => {
    await serveNotes(page, rich(wvw.opensAt));
    await page.goto(wvw.url);
    const p = panel(page);
    await expect(p.getByText('Beta ends in')).toBeVisible();
    await hidden(page, wvw, betaEnd(wvw.opensAt) - wvw.opensAt + 5 * 60000);
    for (let t = 0; t < 120000; t += 3000) await page.clock.runFor(3000);
    await visible(page);
    await expect(p.getByText('Beta ends in')).toHaveCount(0);
    await expect(p.locator('.news-r').filter({ hasText: 'Supply camps' }).getByText(/^Until /)).toHaveCount(0);
  });
});

test('a lone value row that heads the panel is titled with its before and after', async ({ page, wvw }) => {
  await serveNotes(page, [line(wvw.opensAt, 3, 'Keep captures: 250 → 100 (T0)', 'wvw_rule')]);
  await page.goto(wvw.url);
  await expect(panel(page).getByRole('link', { name: 'Keep captures: 250 → 100 (T0)' })).toBeVisible();
});

for (const width of [390, 320]) {
  test(`${width} px: the panel fits, lead and timeline both`, async ({ page, wvw }) => {
    await page.setViewportSize({ width, height: 800 });
    await serveNotes(page, rich(wvw.opensAt));
    await page.goto(wvw.url);
    const p = panel(page);
    await expect(p).toBeVisible();
    await p.getByRole('button', { name: 'All' }).click();
    await expect(p.getByText('Beta ends in')).toBeVisible();
    await wvw.settle();
    const m = await page.evaluate(pastEdge);
    expect(m.past, `past the edge of ${m.inner} px`).toEqual([]);
    const box = await p.boundingBox();
    expect(box.x + box.width, 'the panel inside the screen').toBeLessThanOrEqual(width);
  });
}
