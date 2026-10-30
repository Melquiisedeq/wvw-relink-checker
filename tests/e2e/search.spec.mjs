// The guild search: a name per region, the team it landed on found and named,
// the strip that leaves by itself; the cache of what a lookup answered; the
// limit of names.
import { test, expect } from './support/fixtures.mjs';
import { fail, answer } from './support/faults.mjs';
import { search } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const GAME = /^https:\/\/api\.guildwars2\.com\/v2\/guild\//;
const opened = async (page, wvw) => {
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match').first()).toBeVisible();
  await wvw.settle();
};

// The team the first guild landed on: its card blinks, the page brings it into
// view, a strip names the guild, and the strip leaves by itself.
test('guild found: the card blinks, the strip names the guild and leaves', async ({ page, wvw }) => {
  expect(wvw.guilds.length, 'guilds in the recording').toBeGreaterThanOrEqual(2);
  await opened(page, wvw);
  await search(page, wvw.guilds);
  await expect.poll(() => page.evaluate(() => window.__found.flash && !!window.__found.strip),
    { message: "the found team's card blinking and the strip appearing" }).toBe(true);
  const named = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#resultBody tr')].find(r => r.querySelector('.server-cell'));
    return tr ? tr.cells[0].textContent : null;
  });
  const said = await page.evaluate(() => window.__found.strip);
  expect(named, 'a result row with a team').not.toBeNull();
  expect(said.toLowerCase()).toBe(`${named} · from your search`.toLowerCase());
  await expect.poll(() => page.evaluate(() => {
    const s = document.querySelector('.guild-found-strip');
    if (!s) return true;
    const b = s.previousElementSibling.getBoundingClientRect();
    return b.top >= 0 && b.bottom <= innerHeight;
  }), { message: "the found team's card in view" }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__found.gone && !document.querySelector('.guild-found-flash, .guild-found-strip')),
    { message: 'the strip leaving by itself', timeout: 20000 }).toBe(true);
  await wvw.settle();
});

// A guild lookup answered 429 (after its retries) says nothing about the guild:
// the next Check asks again. A 404 is a definite answer and is kept.
test('a 429 is not kept against a guild, a 404 is', async ({ page, wvw }) => {
  await opened(page, wvw);
  const id = 'ZZZZ-CHECK-PAGE-GUILD';
  const url = `https://api.guildwars2.com/v2/guild/${id}`;
  const ask = id => getGuildInfo(id).then(g => 'ok ' + g.name, e => 'err ' + e.status);
  wvw.allowLog(GAME);
  const busy = await fail(page, wvw, url, 429);
  expect(await page.evaluate(ask, id), 'the 429 lookup').toBe('err 429');
  expect(await page.evaluate(id => guildNameCache.has(id), id), 'a 429 kept in guildNameCache').toBe(false);
  busy.off();
  const found = await answer(page, url, { id, name: 'Check Page Guild', tag: 'CPG', emblem: null });
  expect(await page.evaluate(ask, id), 'the lookup after the 429').toBe('ok Check Page Guild');
  found.off();
  await page.evaluate(id => guildNameCache.delete(id), id);

  const gone = await fail(page, wvw, url, 404);
  await page.evaluate(ask, id);
  await page.evaluate(ask, id);
  expect(gone.reads, 'times a 404 was asked in two lookups (kept: 1)').toBe(1);
  gone.off();
  await wvw.settle();
});

// A refresh that skips (a popover open) returns false and the scheduler does
// not count it, so a focus return right after runs it; one that ran is counted,
// so the same return does not.
test('a skipped refresh does not spend its turn', async ({ page, wvw }) => {
  await opened(page, wvw);
  expect(await page.evaluate(async () => { activeTrigger = document.body; const r = await refreshStandings(); activeTrigger = null; return r; }),
    'refreshStandings with a popover open returned').toBe(false);
  const sched = await page.evaluate(() => new Promise(res => {
    const out = {};
    for (const [k, ret] of [['skipped', false], ['ran', true]]) {
      out[k] = 0;
      schedulePeriodicRefresh(async () => { out[k]++; return ret; }, 2000);
    }
    setTimeout(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      setTimeout(() => res(out), 300);
    }, 2300);
  }));
  expect(sched.skipped, 'a skipped run over a tick and a focus return (counted: 1)').toBe(2);
  expect(sched.ran, 'a run that did its work over a tick and a focus return').toBe(1);
});

// A pasted list of more than MAX_ENTRIES distinct names asks for the first
// MAX_ENTRIES only, and says so; exactly MAX_ENTRIES says nothing. Every search
// answers 404 on purpose, so only the asking is counted.
for (const over of [true, false]) {
  test(`guild limit: ${over ? 'one name over the limit says so' : 'exactly the limit says nothing'}`, async ({ page, wvw }) => {
    await opened(page, wvw);
    const max = await page.evaluate(() => MAX_ENTRIES);
    const count = over ? max + 1 : max;
    const searches = await fail(page, wvw, /^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/, 404);
    wvw.allowLog(GAME);
    const names = Array.from({ length: count }, (_, i) => `Check Page Limit ${i + 1}`);
    await page.locator('#guildInput').fill(names.join('\n'));
    await page.locator('#runBtn').click();
    await expect(page.locator('#statusMsg')).toHaveText(/^Done/, { timeout: 30000 });
    await expect(page.locator('#runBtn')).toBeEnabled();
    const said = await page.locator('#statusMsg').textContent();
    expect(searches.reads, `${count} names asked searches`).toBe(max);
    expect(said.includes(`Only the first ${max} guilds were checked.`), `${count} names gave status "${said}"`).toBe(over);
    await wvw.settle();
  });
}
