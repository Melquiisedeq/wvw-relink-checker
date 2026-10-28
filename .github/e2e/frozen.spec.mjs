// A match the API answers from a server group behind (gw2.olderPool): a body
// older than the one the page already holds must change nothing - not the
// map, not the standings, not the fight log - and costs no re-read: the same
// group would repeat it, so our copy (/api/latest) is asked instead, once.
// Then the match turns to its next week (gw2.newWeek), a body that is older by
// no counter, and it replaces the kept one.
import { test, expect } from './support/fixtures.mjs';
import { gw2 } from './support/gw2.mjs';
import { matchReads } from './support/steps.mjs';
import { FOCUS, MIN, weekTurnBehind } from './support/scenarios.mjs';

test.use({
  viewport: { width: 1280, height: 800 },
  // Opened on minute 12, an even one: the newest body. From minute 13 (odd)
  // the older group, 10 min behind, answers every match URL (/api/latest down:
  // only the page's own guard stands between the older group and the screen).
  timeline: gw2.match(FOCUS).advance(12).pageOpens().latestStatus(503).olderPool(10).advance(4).newWeek(),
});

const GAME = 'https://api.guildwars2.com/v2/wvw/matches?';
const PLOT = ".info-popover .wvw-plot g[role='button']";

test('a body behind the kept one changes nothing, and the next week replaces it', async ({ page, wvw }) => {
  const asked = matchReads(page);
  const copyReads = [];
  page.on('request', r => { if (/\/api\/latest$/.test(r.url())) copyReads.push(r.url()); });
  await page.goto(wvw.url);
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await wvw.settle();
  // The markers' age tiers move with the clock the test jumps, so they are left out.
  const mapState = () => page.evaluate(() => JSON.stringify({
    owners: [...document.querySelectorAll('.info-popover .wvw-plot [class*="own-"]:not(.wvw-marker)')].map(e => e.getAttribute('class')),
    board: document.querySelector('.info-popover .wvw-board')?.textContent || '',
    bar: [...document.querySelectorAll('.info-popover .wvw-scorebar-seg')].map(e => e.getAttribute('style')) }));
  const openMap = async () => {
    await page.locator('.tier-map-btn').first().click();
    await expect(page.locator(PLOT).first()).toBeAttached();
    await wvw.settle();
  };
  const closeMap = async () => {
    await page.locator('.info-popover .info-popover-close').click();
    await expect(page.locator('.info-popover')).toHaveCount(0);
  };
  const grid = () => page.evaluate(() => document.getElementById('standingsGridNA').textContent);
  const fightLog = () => page.evaluate(id => (JSON.parse(localStorage.getItem('wvw-fight-v1') || '{}')[id] || [])
    .map(s => Object.values(s.n).reduce((a, b) => a + b, 0)), FOCUS);

  await openMap();
  const mapBefore = await mapState();
  await closeMap();
  await page.evaluate('loadStandings()');
  await wvw.settle();
  const gridBefore = await grid();
  // Older than the log's one-minute gap, so a behind reading would be kept.
  await page.evaluate(id => { const log = JSON.parse(localStorage.getItem('wvw-fight-v1') || '{}');
    for (const s of log[id] || []) s.at -= 120000;
    localStorage.setItem('wvw-fight-v1', JSON.stringify(log)); }, FOCUS);
  const logBefore = await fightLog();

  // Minute 13: the older group answers.
  const at = (min, sec = 5) => wvw.recordedAt + min * MIN + sec * 1000;
  expect(await wvw.now(), 'the page still in minute 12').toBeLessThan(at(13, 0));
  await wvw.skew(at(13) - await wvw.now());
  const before = asked.length;
  const copyBefore = copyReads.length;
  await openMap();
  expect(await mapState(), 'the map repainted from the older answer').toBe(mapBefore);
  const mapReads = asked.slice(before).filter(u => u === GAME + 'id=' + FOCUS);
  expect(mapReads.length, 'map pulls of the match, no re-read').toBe(1);
  await closeMap();

  const idsBefore = asked.length;
  await page.evaluate('loadStandings()');
  await wvw.settle();
  expect(await grid(), 'the standings repainted from the older answer').toBe(gridBefore);
  const logAfter = await fightLog();
  expect(logAfter.some(n => n < Math.max(...logBefore, 0)), `the fight log took an older reading (${logAfter.join(' ')})`).toBe(false);
  const urls = asked.slice(idsBefore);
  const reread = urls.filter(u => u.startsWith(GAME + 'ids=') && u !== GAME + 'ids=all');
  expect(urls.filter(u => u === GAME + 'ids=all'), 'reads of ids=all').toHaveLength(1);
  expect(reread, 're-reads by id').toEqual([]);
  expect(copyReads.length - copyBefore, 'reads of /api/latest since minute 13: the map asked, the standings within LATEST_GAP_MS did not').toBe(1);

  // The next week: a body with every counter at zero must still replace it.
  let turn = Math.ceil((wvw.recordedAt + wvw.timeline.end + MIN) / MIN) * MIN;
  if (Math.floor((turn - wvw.recordedAt) / MIN) % 2) turn += MIN;   // an even minute: the newest body
  await wvw.skew(turn - await wvw.now() + 5000);
  await page.evaluate('loadStandings()');
  await wvw.settle();
  const start = wvw.timeline.body(FOCUS, turn - wvw.recordedAt + 5000).start_time;
  expect(await page.evaluate(id => matchDataCache.get(id)?.start_time, FOCUS), 'the kept body after the week turned').toBe(start);
});

// The week turned and the page read it in an even minute; in the next, odd,
// the older group answers with the week that ended. Unlike a body behind in
// its own week, this one is read again, twice at once, and the map stays on
// the new week.
test.describe('the older group serves last week after the turn', () => {
  test.use({ timeline: weekTurnBehind(10, 6) });
  test('the map pull is read again twice and keeps the new week', async ({ page, wvw }) => {
    const asked = matchReads(page);
    await page.goto(wvw.url);
    await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
    await wvw.settle();
    let turn = Math.ceil((wvw.recordedAt + wvw.timeline.end - 6 * MIN) / MIN) * MIN;
    if (Math.floor((turn - wvw.recordedAt) / MIN) % 2) turn += MIN;   // an even minute: the newest body
    await wvw.skew(turn - await wvw.now() + 5000);
    await page.evaluate('loadStandings()');
    await wvw.settle();
    const start = wvw.timeline.body(FOCUS, turn - wvw.recordedAt + 5000).start_time;
    expect(await page.evaluate(id => matchDataCache.get(id)?.start_time, FOCUS), 'the new week is kept').toBe(start);

    await wvw.skew(MIN);   // an odd minute: the older group, last week's body
    const before = asked.length;
    await page.locator('.tier-map-btn').first().click();
    await expect(page.locator(PLOT).first()).toBeAttached();
    await wvw.settle();
    const mapReads = asked.slice(before).filter(u => u === GAME + 'id=' + FOCUS);
    expect(mapReads.length, 'the pull and its two re-reads').toBe(3);
    expect(await page.evaluate(id => newestMatches.get(id)?.match.start_time, FOCUS), 'what the map pull kept is the new week').toBe(start);
  });
});
