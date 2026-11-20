// js/maps.js, the drawing code, is not in index.html: js/maps-early.js asks for
// it as the first standings are drawn, without waiting for the browser to be
// idle, or at the first click on a map button. Here: it is asked for after the
// board and not before; a standings refresh or a click while it is still
// downloading asks for nothing more, and the click opens the map when it lands;
// a download that fails says so and its "Try again" opens the map.
import { test, expect } from './support/fixtures.mjs';
import { abort, fail, hold } from './support/faults.mjs';
import { load, firstTier, recordedJson, serveList } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 } });
const PLOT = ".info-popover .wvw-plot g[role='button']";

test('maps.js is asked for as the board is drawn, not before and not at idle', async ({ page, wvw }) => {
  await page.addInitScript(() => {
    // The ember canvas keeps the browser busy: an idle callback may never run.
    window.requestIdleCallback = () => 0;
    // Mutation records come in the order the page made them: the board's first
    // tier and the <script> for maps.js, whichever was inserted first.
    window.__order = [];
    const mo = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (r.target.id === 'standingsGridNA' && n.classList.contains('standing-match') && !window.__order.includes('board')) window.__order.push('board');
        if (n.tagName === 'SCRIPT' && /\/js\/maps\.js$/.test(n.src)) window.__order.push('maps');
      }
    });
    mo.observe(document, { childList: true, subtree: true });
  });
  await load(page, wvw);
  const requests = () => page.evaluate(() =>
    performance.getEntriesByType('resource').filter(r => new URL(r.name).pathname === '/js/maps.js').length);
  await expect.poll(requests, { message: 'maps.js asked for after the board, with no idle callback' }).toBeGreaterThan(0);
  expect(await requests(), 'one request for maps.js').toBe(1);
  expect(await page.evaluate(() => window.__order), 'maps.js inserted after the board, once').toEqual(['board', 'maps']);
});

test('a refresh or a click while maps.js is still downloading asks for nothing more, and the map opens when it lands', async ({ page, wvw }) => {
  const release = await hold(page, wvw.url + 'js/maps.js');
  // Not load(): the held script keeps the load event and the network busy.
  await page.goto(wvw.url, { waitUntil: 'commit' });
  await expect(page.locator('#standingsGridNA > .standing-match')).toHaveCount(wvw.tiers.NA);
  await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
  await expect.poll(() => release.reads, { message: 'the board asked for maps.js' }).toBe(1);
  expect(await page.evaluate(() => refreshStandings()), 'the standings redrawn, not skipped').not.toBe(false);
  await page.locator('.tier-map-btn').first().click();
  await expect(page.locator('.info-popover'), 'the popover opens at once, loading').toContainText('Loading maps');
  expect(release.reads, 'the refresh and the click joined the request in flight').toBe(1);
  await expect(page.locator(PLOT)).toHaveCount(0);
  release();
  await expect(page.locator(PLOT).first(), 'the map drawn once maps.js landed').toBeAttached();
  await wvw.settle();
  expect(release.reads, 'one request for maps.js').toBe(1);
});

test('a failed download of maps.js says so, and "Try again" opens the map', async ({ page, wvw }) => {
  // The first read is the board's, failing in silence; the second is the click's.
  const cut = await abort(page, wvw, /\/js\/maps\.js$/, { first: 2 });
  await load(page, wvw);
  await expect.poll(() => cut.reads, { message: 'the board asked for maps.js' }).toBe(1);
  await page.locator('.tier-map-btn').first().click();
  const pop = page.locator('.info-popover');
  await expect(pop).toContainText("Couldn't load the maps right now.");
  expect(cut.reads, 'the click asked again after the failed download').toBe(2);
  await pop.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator(PLOT).first(), 'the map drawn after trying again').toBeAttached();
  await wvw.settle();
});

test('closed and opened again while maps.js downloads: one fill, into the open popover', async ({ page, wvw }) => {
  // maps.js served held, with fillTierMaps wrapped to log each popover it fills.
  let go;
  const gate = new Promise(ok => { go = ok; });
  await page.route(wvw.url + 'js/maps.js', async route => {
    await gate;
    const res = await route.fetch();
    const spy = '\n;(() => { const fill = fillTierMaps; window.__fills = [];' +
      ' fillTierMaps = function (p, ...rest) { window.__fills.push(p === activePopover); return fill.call(this, p, ...rest); }; })();\n';
    await route.fulfill({ response: res, body: (await res.text()) + spy });
  });
  await page.goto(wvw.url, { waitUntil: 'commit' });
  const btn = page.locator('.tier-map-btn').first();
  await btn.click();
  await expect(page.locator('.info-popover')).toContainText('Loading maps');
  await page.keyboard.press('Escape');
  await expect(page.locator('.info-popover')).toHaveCount(0);
  await btn.click();
  await expect(page.locator('.info-popover')).toContainText('Loading maps');
  go();
  await expect(page.locator(PLOT).first(), 'the map drawn once maps.js landed').toBeAttached();
  await wvw.settle();
  expect(await page.evaluate(() => window.__fills), 'fills, each true if into the open popover').toEqual([true]);
});

test('closed and opened again while the catalogue downloads: only the open popover is filled', async ({ page, wvw }) => {
  await load(page, wvw);
  await expect.poll(() => page.evaluate(() => typeof fillTierMaps === 'function'), { message: 'maps.js in' }).toBe(true);
  // The catalogue held, and each popover that is filled logged.
  await page.evaluate(() => {
    let go;
    const gate = new Promise(ok => { go = ok; });
    window.__release = go;
    window.__fills = [];
    const catalogue = getObjectiveCatalogue;
    getObjectiveCatalogue = async () => { await gate; return catalogue(); };
    const fill = renderTierMapsContent;
    renderTierMapsContent = function (p, ...rest) { window.__fills.push(p === activePopover); return fill.call(this, p, ...rest); };
  });
  const btn = page.locator('.tier-map-btn').first();
  await btn.click();
  await expect(page.locator('.info-popover')).toContainText('Loading maps');
  await page.keyboard.press('Escape');
  await expect(page.locator('.info-popover')).toHaveCount(0);
  await btn.click();
  await expect(page.locator('.info-popover')).toContainText('Loading maps');
  await page.evaluate(() => window.__release());
  await expect(page.locator(PLOT).first(), 'the map drawn').toBeAttached();
  await wvw.settle();
  expect(await page.evaluate(() => window.__fills), 'fills, each true if into the open popover').toEqual([true]);
});

test('a late answer of a map closed and reopened by the same button does not take the reopening back', async ({ page, wvw }) => {
  await load(page, wvw);
  const t = await firstTier(page);
  const rec = recordedJson(t.url);
  const sum = m => ['red', 'blue', 'green'].reduce((n, c) => n + Number(m.scores[c]), 0);
  const bump = n => ({ ...rec, scores: { ...rec.scores, red: Number(rec.scores.red) + n } });
  // Each read of the tier's match held, then answered: the first opening's one
  // point up, the reopening's five, any later one five.
  const gates = [];
  await page.route(t.url, async route => {
    const k = gates.length;
    let go;
    gates.push({ release: new Promise(ok => { go = ok; }), go });
    if (k < 2) await gates[k].release;
    await route.fulfill({ status: 200, body: JSON.stringify(bump(k === 0 ? 1 : 5)),
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  });
  // /api/latest held until the end: the first opening's read waits it out.
  let latestGo;
  const latestHeld = new Promise(ok => { latestGo = ok; });
  let latestReads = 0;
  await page.route(/\/api\/latest$/, async route => {
    latestReads++;
    await latestHeld;
    await route.fulfill({ status: 200, body: '{"at":0,"matches":[]}',
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  });
  await expect.poll(() => page.evaluate(() => typeof fillTierMaps === 'function'), { message: 'maps.js in' }).toBe(true);
  await page.evaluate(() => {
    window.__opened = [];
    const fill = renderTierMapsContent;
    renderTierMapsContent = function (p, m, ...rest) { window.__opened.push(colorSum(m.scores)); return fill.call(this, p, m, ...rest); };
  });
  // The match quiet long enough that the opening's read asks /api/latest beside it.
  await wvw.skew(100000);
  const kept = () => page.evaluate(id => colorSum(newestMatches.get(id).match.scores), t.id);

  await t.button.click();
  await expect(page.locator(PLOT).first()).toBeAttached();
  await expect.poll(() => gates.length, { message: 'the first opening read the match' }).toBe(1);
  await expect.poll(() => latestReads, { message: 'the first opening asked /api/latest' }).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.info-popover')).toHaveCount(0);
  await t.button.click();
  await expect(page.locator(PLOT).first()).toBeAttached();
  await expect.poll(() => gates.length, { message: 'the reopening read the match' }).toBe(2);
  // The first opening's answer lands and waits on /api/latest; the reopening's,
  // higher, lands inside that wait.
  gates[0].go();
  await expect.poll(kept).toBe(sum(rec) + 1);
  gates[1].go();
  await expect.poll(kept).toBe(sum(rec) + 5);
  await expect.poll(() => page.evaluate(() => freshRecall.data && colorSum(freshRecall.data.scores)),
    { message: 'the reopening\'s answer recalled' }).toBe(sum(rec) + 5);
  // Past the 1.2 s the first opening's read waits for /api/latest.
  await page.waitForTimeout(2000);
  latestGo();
  await wvw.settle();
  expect.soft(await page.evaluate(() => colorSum(freshRecall.data.scores)), 'the recall after the late answer').toBe(sum(rec) + 5);
  await page.keyboard.press('Escape');
  await t.button.click();
  await expect(page.locator(PLOT).first()).toBeAttached();
  await wvw.settle();
  expect(await page.evaluate(() => window.__opened), 'the score each opening painted from').toEqual([sum(rec), sum(rec), sum(rec) + 5]);
});

test('a list read waiting on /api/latest hands out the newer body that landed meanwhile', async ({ page, wvw }) => {
  await load(page, wvw);
  const t = await firstTier(page);
  const rec = recordedJson(t.url);
  const sum = m => ['red', 'blue', 'green'].reduce((n, c) => n + Number(m.scores[c]), 0);
  const newer = { ...rec, scores: { ...rec.scores, red: Number(rec.scores.red) + 5 } };
  let latestGo;
  const latestHeld = new Promise(ok => { latestGo = ok; });
  let latestReads = 0;
  await page.route(/\/api\/latest$/, async route => {
    latestReads++;
    await latestHeld;
    await route.fulfill({ status: 200, body: '{"at":0,"matches":[]}',
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  });
  // The game's list answers with the older body.
  await serveList(page, [rec]);
  await wvw.skew(100000);
  const list = page.evaluate(({ id }) => fetchMatches(`${API_BASE}/wvw/matches?ids=${id}`, 8000, ['1'])
    .then(l => l.map(m => colorSum(m.scores))), { id: t.id });
  await expect.poll(() => latestReads, { message: 'the list read asked /api/latest' }).toBe(1);
  // A newer body of the same match lands inside the wait.
  await page.evaluate(m => { keepNewestMatch(m); }, newer);
  const scores = await list;
  latestGo();
  expect(scores, 'the score the list hands out').toEqual([sum(rec) + 5]);
});

// A map whose outline is not in the static pack asks the API for it; when that fails the tab says so,
// and picking the tab again, with the API back, asks again and draws.
const SECTORS = /\/maps\/\d+\/sectors/;
const POP = '.info-popover';
const MSG = `${POP} .wvw-stage-msg`;
const PICKED = `${POP} .wvw-tab.is-active`;

async function withoutPackedSectors(page) {
  await page.route(/\/js\/wvw-static\.js$/, async route => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()) + '\nWVW_STATIC.sectors = {};' });
  });
}

test('a tab whose outline failed asks again when it is picked next, once per visit', async ({ page, wvw }) => {
  await withoutPackedSectors(page);
  const down = await fail(page, wvw, SECTORS);
  await load(page, wvw);
  const { button } = await firstTier(page);
  await button.click();
  const home = await page.locator(PICKED).getAttribute('data-type');
  await expect(page.locator(MSG), 'the opening tab, its outline down').toHaveText("Couldn't load this map right now.", { timeout: 15000 });
  const awayType = await page.locator(`${POP} .wvw-tab:not(.is-active)`).first().getAttribute('data-type');
  const away = page.locator(`${POP} .wvw-tab[data-type="${awayType}"]`);
  // A tab left before its answer shows is owed the same new ask on its next visit.
  const thirdType = await page.locator(`${POP} .wvw-tab:not(.is-active)`).nth(1).getAttribute('data-type');
  // Both picks in one task: the first tab's answer can only land after it was left.
  await page.evaluate(([x, y]) => {
    document.querySelector(`.info-popover .wvw-tab[data-type="${x}"]`).click();
    document.querySelector(`.info-popover .wvw-tab[data-type="${y}"]`).click();
  }, [awayType, thirdType]);
  await expect(page.locator(MSG)).toHaveText("Couldn't load this map right now.", { timeout: 15000 });
  // Every read in flight has given up before the count is taken.
  await expect.poll(async () => { const n = down.reads; await page.waitForTimeout(2500); return down.reads === n ? n : -1; },
    { timeout: 30000, intervals: [0] }).not.toBe(-1);
  const left = down.reads;
  await away.click();
  await expect(page.locator(MSG)).toHaveText("Couldn't load this map right now.", { timeout: 15000 });
  expect(down.reads, 'a tab left before its answer showed asks again on return').toBeGreaterThan(left);
  await expect(page.locator(MSG), 'another tab, its outline down').toHaveText("Couldn't load this map right now.", { timeout: 15000 });
  // Still down: coming back asks once more and says so again.
  const before = down.reads;
  await page.locator(`${POP} .wvw-tab[data-type="${home}"]`).click();
  await expect(page.locator(MSG)).toHaveText("Couldn't load this map right now.", { timeout: 15000 });
  expect(down.reads, 'the visit asked again').toBeGreaterThan(before);
  await wvw.settle();
  const after = down.reads;
  await page.waitForTimeout(1500);
  expect(down.reads, 'nothing asks in a loop').toBe(after);

  down.off();
  await away.click();
  await expect(page.locator(`${POP} .wvw-plot g[role='button']`).first(), `${awayType} drawn once the API is back`).toBeAttached();
  await expect(page.locator(MSG)).toHaveCount(0);
  await page.locator(`${POP} .wvw-tab[data-type="${home}"]`).click();
  await expect(page.locator(`${POP} .wvw-plot g[role='button']`).first(), `${home} drawn, the tab the map opened on`).toBeAttached();
  await expect(page.locator(MSG)).toHaveCount(0);
});

test('a capture on a map whose outline failed opens it and lights the objective once the API is back', async ({ page, wvw }) => {
  await withoutPackedSectors(page);
  const down = await fail(page, wvw, SECTORS);
  await load(page, wvw);
  const { button } = await firstTier(page);
  await button.click();
  const home = await page.locator(PICKED).getAttribute('data-type');
  await expect(page.locator(MSG)).toHaveText("Couldn't load this map right now.", { timeout: 15000 });
  await page.locator(`${POP} .wvw-subtab[data-pane="captures"]`).click();
  const row = page.locator(`${POP} .wvw-cap:not([data-map="${home}"])`).first();
  await expect(row, 'a capture on another map').toBeAttached();
  const obj = await row.getAttribute('data-obj');
  const map = await row.getAttribute('data-map');
  await row.click();
  await expect(page.locator(PICKED)).toHaveAttribute('data-type', map);
  await expect(page.locator(MSG), 'that map, its outline down').toHaveText("Couldn't load this map right now.", { timeout: 15000 });
  await page.locator(`${POP} .wvw-tab[data-type="${home}"]`).click();
  await expect(page.locator(MSG)).toHaveText("Couldn't load this map right now.", { timeout: 15000 });
  down.off();
  await row.click();
  await expect(page.locator(PICKED)).toHaveAttribute('data-type', map);
  await expect(page.locator(`${POP} .wvw-marker.is-lit`), `${obj} lit on the map that failed before`).toHaveAttribute('data-obj', obj);
});

test('the first visit to a tab whose opening read failed asks again; the opening tab does not ask twice', async ({ page, wvw }) => {
  await withoutPackedSectors(page);
  const down = await fail(page, wvw, SECTORS);
  const per = new Map();
  page.on('request', r => { const m = /\/maps\/(\d+)\/sectors/.exec(r.url()); if (m) per.set(m[1], (per.get(m[1]) || 0) + 1); });
  await load(page, wvw);
  const { button } = await firstTier(page);
  await button.click();
  await expect(page.locator(MSG)).toHaveText("Couldn't load this map right now.", { timeout: 15000 });
  await expect.poll(async () => { const n = down.reads; await page.waitForTimeout(2500); return down.reads === n ? n : -1; },
    { timeout: 30000, intervals: [0] }).not.toBe(-1);
  const counts = [...per.values()];
  expect(counts.length, 'one outline read per map').toBeGreaterThan(1);
  expect(new Set(counts).size, `the opening tab read as often as a tab nobody opened: ${counts}`).toBe(1);

  down.off();
  const away = page.locator(`${POP} .wvw-tab:not(.is-active)`).first();
  await away.click();
  await expect(page.locator(`${POP} .wvw-plot g[role='button']`).first(), 'the first visit, the API back').toBeAttached();
  await expect(page.locator(MSG)).toHaveCount(0);
});
