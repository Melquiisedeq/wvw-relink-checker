// States otherwise reached by the luck of a timer, taken here on purpose so
// that the branch behind each runs every time (the coverage sweep,
// support/coverage.mjs, lists the places that oscillated). Each test drives the
// page there with the clock (page.clock) or with a read it holds, and asserts
// what a visitor sees at the end, not that the code was passed.
import { test, expect } from './support/fixtures.mjs';
import { answer, hold } from './support/faults.mjs';
import { FOCUS, playing } from './support/scenarios.mjs';
import { check, firstTier, frame, iso, keptMatch, later, load, openMap, search } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
const NA = '#standingsGridNA > .standing-match';

const opened = async (page, wvw) => {
  await page.goto(wvw.url);
  await expect(page.locator(NA)).toHaveCount(wvw.tiers.NA);
  await expect(page.locator('#standingsGridEU > .standing-match')).toHaveCount(wvw.tiers.EU);
  await wvw.settle();
};

// The page's clock stops a moment ahead, and only runFor moves it from there. It runs by
// itself until then, so the instant asked for may already be behind it: asked again, further on.
async function pause(page, wvw) {
  for (let ahead = 100; ; ahead *= 2) {
    try { return await page.clock.pauseAt(await wvw.now() + ahead); }
    catch (e) { if (!/past/.test(String(e)) || ahead > 5000) throw e; }
  }
}

// ---- a read that outlasts its deadline ---------------------------------------
// The guild search's first read (the name's id) never answers. After the page's
// 10 s it gives up on its own and the row says why; a name that was never
// looked up does not hang the run.
test.describe('a read that never answers', () => {
  test.use({ clock: 'playwright' });

  test('the guild row says the request timed out, and the search ends', async ({ page, wvw }) => {
    await opened(page, wvw);
    await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/, () => new Promise(() => {}));
    await page.locator('#guildInput').fill('Nobody Answers Here');
    // The 10 s run from the moment the read leaves, after the page's own wait for the tables.
    const out = page.waitForRequest(/\/guild\/search\?/);
    await page.locator('#runBtn').click();
    await out;
    const row = page.locator('#resultBody tr');
    await expect(row, 'no row before the deadline').toHaveCount(0);
    await page.clock.runFor(9 * 1000);
    await expect(row, 'no row one second before the deadline').toHaveCount(0);
    await page.clock.runFor(1500);
    await expect(row.first(), 'the row after the deadline').toContainText('Request timed out');
    await page.clock.runFor(2000);
    await expect(page.locator('#statusMsg'), 'the search ended').toHaveText(/^Done/);
    await expect(page.locator('#runBtn')).toBeEnabled();
    await wvw.settle();
  });
});

// ---- the page travelling to the found card, and the visitor stopping it ---------
// A guild found below the fold: the page glides to its card. A wheel, a touch, a
// key or a click while it glides gives the page back where it is. The card is held from that
// moment: its blink may have ended before the page is looked at again. The first
// scroll event after the card starts blinking is the page on its way, and the
// visitor acts right there, so the glide is cut mid-way every time.
for (const kind of ['wheel', 'touchstart', 'keydown', 'mousedown']) {
  test.describe(`${kind} while the page glides to the found guild's card`, () => {
    test.use({ viewport: { width: 1280, height: 420 } });

    test('the page stops where it is, the card still out of view', async ({ page, wvw }) => {
      await opened(page, wvw);
      await page.evaluate(kind => {
        window.__cut = null;
        window.addEventListener('scroll', () => {
          if (window.__cut !== null || !document.querySelector('.guild-found-flash')) return;
          window.__cut = window.scrollY;
          window.__card = document.querySelector('.guild-found-flash');
          window.dispatchEvent(new Event(kind));
        }, { passive: true });
      }, kind);
      await search(page, [wvw.guilds[0]]);
      await expect.poll(() => page.evaluate(() => window.__cut), { message: 'the page on its way to the card' }).not.toBeNull();
      const cut = await page.evaluate(() => window.__cut);
      // A glide to a card ~1600 px down takes far longer than this.
      await page.waitForTimeout(1200);
      const end = await page.evaluate(() => ({ y: window.scrollY, top: window.__card.getBoundingClientRect().top, h: innerHeight }));
      expect(end.y, `the page went on from ${cut} px after the ${kind}`).toBe(cut);
      expect(end.top, 'the found card, its top (px) below the window').toBeGreaterThan(end.h);
      await wvw.settle();
    });
  });
}

// ---- the second explosion -----------------------------------------------------
// A search that finds a guild ends in the siege engine's blast: lobes, rays and
// shards thrown from the crest. They stay in the page after they fade; the next
// blast takes them out before it puts its own, so the pieces do not pile up.
test('a second search blasts again: the first one\'s lobes, rays and shards are gone', async ({ page, wvw }) => {
  await opened(page, wvw);
  const PIECES = '.blast-lobe, .blast-ray, .impact-shard';
  const count = () => page.evaluate(sel => ({
    all: document.querySelectorAll(sel).length,
    first: document.querySelectorAll(sel.split(', ').map(x => x + '[data-first]').join(', ')).length,
    lobes: document.querySelectorAll('.blast-lobe').length,
    rays: document.querySelectorAll('.blast-ray').length,
    shards: document.querySelectorAll('.impact-shard').length,
  }), PIECES);
  await search(page, [wvw.guilds[0]]);
  await expect.poll(async () => (await count()).all, { message: 'the first blast thrown' }).toBeGreaterThan(0);
  expect(await count(), 'the first blast: lobes, rays, shards').toMatchObject({ lobes: 7, rays: 12, shards: 22 });
  await page.evaluate(sel => document.querySelectorAll(sel).forEach(e => e.setAttribute('data-first', '')), PIECES);
  await check(page, wvw, [wvw.guilds[0]]);
  await expect.poll(async () => (await count()).all - (await count()).first, { message: 'the second blast thrown' }).toBeGreaterThan(0);
  expect(await count(), 'after the second blast: none of the first, one blast of each').toEqual({ all: 41, first: 0, lobes: 7, rays: 12, shards: 22 });
});

// ---- the round on the sling ----------------------------------------------------
// Check gathers a round in the sling; the finale lets it go at the top of the swing, SWING_MS
// (js/trebuchet.js) after the launch. A Check pressed inside that window takes the new round up while the old one
// is still on the sling, and the old one is let go all the same.
// The clock is held, so the window is as wide as the test wants.
test.describe('the round on the sling', () => {
  test.use({ clock: 'playwright' });

  const ROUNDS = '.siege-charge';
  async function toDone(page) {
    await page.locator('#runBtn').click();
    for (let i = 0; i < 100; i++) {
      if (/^Done/.test(await page.locator('#statusMsg').textContent())) return;
      await page.clock.runFor(100);
      await page.waitForTimeout(20);
    }
    await expect(page.locator('#statusMsg')).toHaveText(/^Done/);
  }
  // On to the launch, a few ms into the swing (SWING_MS).
  async function toSwing(page) {
    for (let i = 0; i < 100; i++) {
      if (await page.locator('#trebuchet.firing').count()) return;
      await page.clock.runFor(10);
    }
    await expect(page.locator('#trebuchet')).toHaveClass(/firing/);
  }

  test('let go at the top of the swing it flies, and is gone when it lands', async ({ page, wvw }) => {
    await opened(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await expect(page.locator(`${ROUNDS}.charging`), 'the round gathering in the sling').toHaveCount(1);
    await toSwing(page);
    await expect(page.locator(`${ROUNDS}.charging`), 'the round still in the sling, the swing under way').toHaveCount(1);
    await page.clock.runFor(200);
    await expect(page.locator(`${ROUNDS}.flying`), 'the round, let go').toHaveCount(1);
    await expect(page.locator(`${ROUNDS}.charging`)).toHaveCount(0);
    await page.clock.runFor(700);
    await expect(page.locator(ROUNDS), 'the round, landed').toHaveCount(0);
    await wvw.settle();
  });

  test('a Check pressed before the last round is let go takes up a new one beside it', async ({ page, wvw }) => {
    await opened(page, wvw);
    await page.locator('#guildInput').fill(wvw.guilds[0]);
    await pause(page, wvw);
    await toDone(page);
    await toSwing(page);
    await expect(page.locator(`${ROUNDS}.charging`), 'the first round, in the swing').toHaveCount(1);
    await page.locator('#runBtn').click();
    await expect(page.locator(`${ROUNDS}.charging`), 'the new round and the first one, not yet let go').toHaveCount(2);
    await page.clock.runFor(300);
    await expect(page.locator(`${ROUNDS}.flying`), 'the first round, let go').toHaveCount(1);
    await expect(page.locator(`${ROUNDS}.charging`), 'the new round, still gathering').toHaveCount(1);
    await wvw.settle();
  });
});

// ---- the map's lit objective ---------------------------------------------------
const POP = '.info-popover';
const LIT = `${POP} .wvw-marker.is-lit`;
const lit = page => page.evaluate(sel => [...document.querySelectorAll(sel)].map(m => m.dataset.obj).join(), LIT);

// The first tier's map open on its Captures tab, and the capture rows of the map in view.
async function onCaptures(page, wvw) {
  await load(page, wvw);
  const tier = await firstTier(page);
  await openMap(page, wvw, tier.button);
  await page.locator(`${POP} .wvw-subtab[data-pane="captures"]`).click();
  const home = await page.locator(`${POP} .wvw-tab.is-active`).getAttribute('data-type');
  const row = page.locator(`${POP} .wvw-cap[data-map="${home}"]`).first();
  await expect(row, 'a capture on the map in view').toBeAttached();
  return { tier, row, id: await row.getAttribute('data-obj') };
}

test.describe('a capture pressed', () => {
  test.use({ clock: 'playwright' });

  test('lights its objective for 2.5 s, then the light goes out by itself', async ({ page, wvw }) => {
    const { row, id } = await onCaptures(page, wvw);
    await pause(page, wvw);
    await row.click();
    await expect.poll(() => lit(page), { message: `${id} lit by its capture` }).toBe(id);
    await page.mouse.move(1, 1);
    await page.clock.runFor(2000);
    expect(await lit(page), 'lit 2 s after the press').toBe(id);
    await page.clock.runFor(700);
    expect(await lit(page), 'lit 2.7 s after the press').toBe('');
  });
});

// A row pointed at lights its objective for as long as it is pointed at. When
// the list is rebuilt under the pointer (a capture came in) the old row is gone
// and never says it was left: the light must not stay on for a row that is not
// there. The pointer is the page's own event, from a mouse parked away from the
// popover, so that no real move lights the new rows again.
test('a capture row rebuilt under the pointer takes its light with it', async ({ page, wvw }) => {
  const { tier, row, id } = await onCaptures(page, wvw);
  await page.mouse.move(1, 1);
  const pointed = await row.elementHandle();
  await pointed.evaluate(el => el.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })));
  expect(await lit(page), 'lit while the row is pointed at').toBe(id);
  // A body with one more capture, newer than all: the list is rebuilt.
  const body = await keptMatch(page, tier.id);
  const flip = body.maps.flatMap(m => m.objectives).find(o => /^\d+-\d+$/.test(o.id) && ['Camp', 'Tower', 'Keep'].includes(o.type) && o.id !== id);
  const newest = Math.max(...body.maps.flatMap(m => m.objectives).map(o => Date.parse(o.last_flipped) || 0));
  flip.owner = flip.owner === 'Red' ? 'Blue' : 'Red';
  flip.last_flipped = new Date(newest + 60000).toISOString().replace('.000Z', 'Z');
  body.scores.red += 1;
  await answer(page, tier.url, body);
  await later(page, wvw, 31000);
  await expect(page.locator(`${POP} .wvw-cap[data-obj="${flip.id}"]`), 'the new capture on the list').toBeAttached();
  expect(await pointed.evaluate(el => el.isConnected), 'the pointed row still in the page').toBe(false);
  expect(await lit(page), 'lit after the list was rebuilt').toBe('');
});

// ---- an answer that arrives after a newer read was asked -----------------------
// The map asks again every 30 s and when the tab is back. A read held on the
// way (a slow line) is overtaken by the next one; when it lands at last, the
// map keeps what the newer read painted. The held read's body is the further
// along one (a server ahead of the others) and hands Red every camp, tower and
// keep of the map in view, so a map that painted it would show Red's share of
// the bar over the map grow past what the newer read drew.
test('a read overtaken on the way is dropped when it lands', async ({ page, wvw }) => {
  await load(page, wvw);
  const tier = await firstTier(page);
  const body = await keptMatch(page, tier.id);
  await openMap(page, wvw, tier.button);
  const type = await page.locator(`${POP} .wvw-tab.is-active`).getAttribute('data-type');
  const bent = flips => {
    const b = JSON.parse(JSON.stringify(body));
    const objectives = b.maps.find(m => m.type === type).objectives.filter(o => ['Camp', 'Tower', 'Keep'].includes(o.type) && o.owner !== 'Red');
    for (const o of objectives.slice(0, flips)) o.owner = 'Red';
    b.scores.red += flips;
    b.flipped = objectives.slice(0, flips).map(o => o.id);
    return b;
  };
  const newer = bent(1), further = bent(1000);
  // Taken by the held body alone: the tick rings it as changed hands, though nothing else of that body is painted.
  const ringed = further.flipped.filter(id => !newer.flipped.includes(id)).pop();
  const red = () => page.evaluate(() => parseFloat(document.querySelector('.info-popover .wvw-scorebar-seg.own-red').style.width));
  const before = await red();

  let reads = 0, release;
  const held = new Promise(r => { release = r; });
  const reply = (route, b) => route.fulfill({ status: 200, body: JSON.stringify(b),
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
  await page.route(tier.url, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (++reads === 1) { await held; return reply(route, further); }
    return reply(route, newer);
  });
  const catchUp = async () => {
    await wvw.skew(31000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  };
  await catchUp();
  await expect.poll(() => reads, { message: 'the first read, held' }).toBe(1);
  await catchUp();
  await expect.poll(() => red(), { message: 'the bar after the newer read' }).toBeGreaterThan(before);
  const drawn = await red();
  release();
  await expect.poll(() => page.evaluate(id => newestMatches.get(id).match.scores.red, tier.id),
    { message: 'the held read landed (the page keeps the further body)' }).toBe(further.scores.red);
  await frame(page);
  expect(await red(), 'the red share of the bar after the held read landed').toBe(drawn);
  await expect(page.locator(`${POP} .wvw-marker[data-obj="${ringed}"] .wvw-ring`), 'the ring on an objective only the held body took').toBeAttached();
  expect(await red(), 'the red share of the bar after the ring').toBe(drawn);
  await wvw.settle();
});

// ---- the one-second tick of an open map ---------------------------------------
// While a map is open a tick every second judges its corners again as the data
// ages. Before the swords are marked (the map's first read has not landed and
// 2.5 s have not passed) it repaints the corners alone; once marked it judges
// the swords, the badge and the corners together. The clock is paused so that
// the state is held for as long as the test needs, and its date is jumped past
// the 6 minutes after which the data is called stale, then one tick is run.
const swords = page => page.locator(`${POP} .wvw-tab-swords`);
const corner = page => page.locator(`${POP} .wvw-hud-r`);
const ago = page => page.locator(`${POP} .wvw-hud-ago`);

test.describe('the tick of an open map', () => {
  test.use({ clock: 'playwright' });

  // The map of a tier whose button wears the swords, opened a couple of minutes after the page
  // (a body that fresh would mark the swords on opening).
  async function opening(page, wvw, holding) {
    await load(page, wvw);
    const tier = await firstTier(page, page.locator('.tier-map-btn:has(.tier-map-badge)').first());
    await page.clock.setSystemTime(await wvw.now() + 2 * 60 * 1000);
    let release = () => {};
    if (holding) {
      release = await hold(page, tier.url);
      await pause(page, wvw);
    }
    await tier.button.click();
    await expect(page.locator(`${POP} .wvw-plot g[role='button']`).first()).toBeAttached();
    return release;
  }
  const jump = async (page, wvw, min) => {
    await page.clock.setSystemTime(await wvw.now() + min * 60 * 1000);
    await page.clock.runFor(1000);
  };

  test('before the swords are marked it repaints the corners: data too old to trust without a read leaves the screen', async ({ page, wvw }) => {
    const release = await opening(page, wvw, true);
    await expect(corner(page), 'the age corner, the map just opened').toBeVisible();
    await expect(swords(page), 'swords on a tab before any read landed').toHaveCount(0);
    await page.clock.runFor(1000);
    await expect(swords(page), 'swords on a tab after a tick, nothing marked them').toHaveCount(0);
    await jump(page, wvw, 7);
    await expect(corner(page), 'the age corner, 7 min on with the read still out').toBeHidden();
    await expect(swords(page), 'swords on a tab, nothing marked them').toHaveCount(0);
    release();
    await wvw.settle();
  });

  test('a first read that never lands: after 2.5 s the swords go up from the body the map opened with', async ({ page, wvw }) => {
    const release = await opening(page, wvw, true);
    await page.clock.runFor(1000);
    await expect(swords(page), 'swords at 1 s, the read still out').toHaveCount(0);
    await page.clock.runFor(1600);
    await expect(swords(page), 'swords at 2.6 s, the read still out').toHaveCount(1);
    release();
    await wvw.settle();
  });

  test('a map closed before the idle warm-up leaves the other terrain pictures unasked', async ({ page, wvw }) => {
    const release = await opening(page, wvw, true);
    await page.locator(`${POP} .info-popover-close`).click();
    await expect(page.locator(POP)).toHaveCount(0);
    const asked = [];
    page.on('request', r => { if (/\/assets\/map-\w+-1280\.webp$/.test(r.url())) asked.push(r.url()); });
    await page.clock.runFor(5000);
    release();
    await wvw.settle();
    expect(asked, 'terrain pictures asked after the map was closed').toEqual([]);
  });

  test('a map left open and still warms the other tabs\' pictures: lite ones, one at a time, in tab order', async ({ page, wvw }) => {
    const release = await opening(page, wvw, true);
    const tabs = await page.locator(`${POP} .wvw-tab[data-type]`).evaluateAll(els => els.map(e => e.dataset.type));
    const active = await page.locator(`${POP} .wvw-tab.is-active`).getAttribute('data-type');
    const file = { Center: 'ebg', RedHome: 'rbl', BlueHome: 'bbl', GreenHome: 'gbl' };
    const want = tabs.filter(t => t !== active).map(t => `map-${file[t]}-1280.webp`);
    expect(want.length, 'the other tabs of the map').toBe(3);
    const held = [];
    const seen = [];
    const loaded = [];
    page.on('requestfinished', r => { if (/\/assets\/map-\w+-1280\.webp$/.test(r.url())) loaded.push(r.url()); });
    await page.route(/\/assets\/map-\w+-1280\.webp$/, route => {
      const name = route.request().url().split('/').pop();
      seen.push(name);
      held.push(route);
    });
    await page.clock.runFor(5000);
    for (let i = 0; i < want.length; i++) {
      await expect.poll(() => seen.length, `pictures asked, step ${i}`).toBe(i + 1);
      // The one asked is not answered yet: the next must not have been asked beside it.
      await page.waitForTimeout(300);
      expect(seen.length, `a second picture asked while the first was still out (step ${i})`).toBe(i + 1);
      await held.shift().fallback();
    }
    await expect.poll(() => seen.length).toBe(3);
    // The last picture is in; the page's decode() of it and the queue running out follow within the wait below.
    await expect.poll(() => loaded.length, { message: 'all three pictures loaded' }).toBe(3);
    await page.waitForTimeout(300);
    expect(seen, 'lite pictures of the tabs not in view, in tab order, each once').toEqual(want);
    release();
    await wvw.settle();
  });

  test('the badges of a fresh flip count down by the second, and go when their five minutes are up', async ({ page, wvw }) => {
    await load(page, wvw);
    const tier = await firstTier(page);
    const body = await keptMatch(page, tier.id);
    const now = await wvw.now();
    // On every map, every objective flipped an hour ago but one camp flipped 280 s ago (20 s of its protection left) and one 10 s ago.
    for (const m of body.maps) {
      for (const o of m.objectives) o.last_flipped = iso(now - 60 * 60 * 1000);
      const camps = m.objectives.filter(o => o.type === 'Camp');
      camps[0].last_flipped = iso(now - 280 * 1000);
      camps[1].last_flipped = iso(now - 10 * 1000);
    }
    await answer(page, tier.url, body);
    await page.locator('.tier-map-btn').first().click();
    const badges = page.locator(`${POP} .wvw-ri`);
    const clocks = () => badges.locator('text').allTextContents();
    await expect(badges.first(), 'a fresh flip wearing its badge').toBeAttached();
    await pause(page, wvw);
    const secs = c => { const [m, s] = c.split(':').map(Number); return m * 60 + s; };
    const before = (await clocks()).map(secs);
    expect(before.length, 'badges on the map').toBeGreaterThanOrEqual(2);
    await page.clock.runFor(2000);
    const after = (await clocks()).map(secs);
    expect(after.length, 'badges two seconds on').toBe(before.length);
    expect(after[0], 'the first clock, two seconds on').toBeLessThan(before[0]);
    await page.clock.setSystemTime(await wvw.now() + 30 * 1000);
    await page.clock.runFor(1000);
    await expect(badges, 'the badge of the older flip is gone, the newer one stays').toHaveCount(before.length - 1);
    await wvw.settle();
  });

  test('once marked it judges the swords and the corners together: the swords leave, the data turns amber', async ({ page, wvw }) => {
    await opening(page, wvw, false);
    await expect(swords(page), 'swords on the busiest tab').toHaveCount(1);
    await expect(ago(page)).not.toHaveClass(/is-stale/);
    await jump(page, wvw, 7);
    await expect(swords(page), 'swords on a tab 7 min with no kills').toHaveCount(0);
    await expect(ago(page), 'the age corner, 7 min on').toHaveText(/^⚠ data from \d/);
    await expect(ago(page)).toHaveClass(/is-stale/);
    await expect(page.locator(`${POP} .wvw-hud-l`)).toContainText('⚠ data up to');
    await wvw.settle();
  });
});

// A refresh that moves one side's VP pulses the edge of that side's card and no
// other. Nothing removes the class (js/standings.js), so it is read right after
// the refresh, with no clock to race. The match is the playing one:
// the recording's own week is over, and its cards show last week's line-up.
test.describe('a side\'s VP moves on a refresh', () => {
  test.use({ timeline: playing(10) });
  test('that side\'s card pulses and the others do not', async ({ page, wvw }) => {
    await page.goto(wvw.url);
    const sides = page.locator(`.standing-match[data-match-id="${FOCUS}"] .standing-side`);
    await expect(sides).toHaveCount(3);
    await wvw.settle();
    const pulsing = () => sides.evaluateAll(els => els.filter(e => e.classList.contains('side-pulse'))
      .map(e => ['red', 'blue', 'green'].find(c => e.classList.contains('side-' + c))));
    const url = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
    const list = await page.evaluate(async u => (await fetch(u)).json(), url);
    const mine = list.find(m => m.id === FOCUS);
    mine.victory_points.red += 7;
    await page.route(/^https:\/\/api\.guildwars2\.com\/v2\/wvw\/matches\?ids=/, route => {
      const want = new URL(route.request().url()).searchParams.get('ids');
      const ids = want === 'all' ? null : want.split(',');
      return route.fulfill({ status: 200, json: list.filter(m => !ids || ids.includes(m.id)),
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    });
    expect(await pulsing(), 'cards pulsing before the refresh').toEqual([]);
    await page.evaluate(() => loadStandings());
    await expect(page.locator(`.standing-match[data-match-id="${FOCUS}"] .side-red .standing-vp .stat-value`),
      'red VP after the refresh').toHaveText(mine.victory_points.red.toLocaleString('en-US'));
    expect(await pulsing(), 'the sides whose card pulsed after red VP moved').toEqual(['red']);
  });
});
