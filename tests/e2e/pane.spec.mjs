// The column beside the map: three tabs, Board,
// Captures and Objective, over one pane that keeps its size. The board stands
// still for 6 s and its box hugs its rows; a marker opens the Objective tab
// without the popover or the map moving on any frame; the captures are the
// body's own, in the 30 min up to its newest, and a row lights its objective on
// its map; beside the map every box ends above the map's bottom, stacked under
// it every tab ends on the same line, the map on top and still; fifteen
// switches change nothing. A map tab change keeps the board on the freshest
// body. At 1280 and 360 px.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { phone, frame, load, firstTier, openMap, keptMatch } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
test.describe.configure({ timeout: 90 * 1000 });

const POP = '.info-popover';
const OWNERS = ['Red', 'Blue', 'Green'];
const tab = (page, key) => page.locator(`${POP} .wvw-subtab[data-pane="${key}"]`);
const activePane = page => page.locator(`${POP} .wvw-subtab.is-active`);

// Everything the pane shows and where, read at once.
const state = page => page.evaluate(() => {
  const p = document.querySelector('.info-popover');
  const r = e => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) }; };
  const shown = [...p.querySelectorAll('.wvw-pane > *')].filter(e => getComputedStyle(e).display !== 'none');
  const board = p.querySelector('.wvw-board');
  return {
    tabs: [...p.querySelectorAll('.wvw-subtab')].map(b => ({ text: b.textContent, on: b.classList.contains('is-active'), off: b.disabled })),
    shown: shown.map(e => e.className.split(' ')[0]), box: shown[0] ? r(shown[0]) : null,
    pop: r(p), plot: r(p.querySelector('.wvw-plot-wrap')), tabsBar: r(p.querySelector('.wvw-subtabs')), pane: r(p.querySelector('.wvw-pane')),
    board: board.offsetParent ? Math.round(board.getBoundingClientRect().height) : 0,
    rows: [...board.children].reduce((n, c) => n + c.offsetHeight, 0),
    caps: [...p.querySelectorAll('.wvw-caps .wvw-cap')].map(c => c.dataset.obj),
    map: p.querySelector('.wvw-tab.is-active')?.dataset.type || '',
    lit: [...p.querySelectorAll('.wvw-marker.is-lit')].map(g => g.dataset.obj).join(),
    selected: p.querySelector('.wvw-marker.is-selected')?.dataset.obj || '' };
});
// n readings 'every' ms apart, of one field.
async function samples(page, n, every, pick) {
  const v = [];
  for (let i = 0; i < n; i++) { if (i) await page.waitForTimeout(every); v.push(pick(await state(page))); }
  return v;
}
const activeText = st => (st.tabs.find(x => x.on) || {}).text || '';

// The centre of the nth marker on the open map whose centre takes the click
// (not under a corner or the zoom), once it stands where it was a frame ago.
async function markerAt(page, n) {
  const read = () => page.evaluate(i => {
    const g = [...document.querySelectorAll('.info-popover .wvw-plot .wvw-marker')].filter(g => {
      const b = g.getBoundingClientRect(), e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!e && g.contains(e) && !e.closest('.wvw-zoom, .wvw-hud');
    })[i];
    if (!g) return null;
    const b = g.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, n);
  let last = null;
  for (let i = 0; i < 40; i++) {
    const at = await read();
    expect(at, `marker ${n} on the open map`).not.toBeNull();
    if (last && Math.abs(at.x - last.x) < 1 && Math.abs(at.y - last.y) < 1) return at;
    last = at;
    await frame(page);
  }
  return last;
}

// Pressed with every frame watched for 1.5 s after: the popover's top and
// height and the map's top, as one set of distinct readings.
async function pressMarker(page, n) {
  const at = await markerAt(page, n);
  await page.evaluate(() => {
    window.__paneSeen = new Set(); const t0 = performance.now();
    const look = () => {
      const p = document.querySelector('.info-popover'); const a = p.getBoundingClientRect(), m = p.querySelector('.wvw-plot-wrap').getBoundingClientRect();
      __paneSeen.add(Math.round(a.top) + ',' + Math.round(a.height) + ',' + Math.round(m.top));
      if (performance.now() - t0 < 1500) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(1600);
  return page.evaluate(() => [...window.__paneSeen]);
}

for (const width of [1280, 360]) {
  const stacked = width <= 760;
  test.describe(`map pane, ${width} px`, () => {
    // The map of the first tier open at `width`, its tabs and board drawn.
    async function opened(page, wvw) {
      await load(page, wvw);
      if (width < 600) await phone(page, width);
      await frame(page);
      const tier = await firstTier(page);
      await openMap(page, wvw, tier.button);
      await expect(page.locator(`${POP} .wvw-subtab`).first()).toBeAttached();
      await expect(page.locator(`${POP} .wvw-board-row`).first()).toBeAttached();
      await wvw.settle();
      await frame(page);
      return tier;
    }
    // The captures the list must show, worked out here from the same body.
    async function captures(page, tier) {
      const before = await keptMatch(page, tier.id);
      const flips = before.maps.flatMap(m => m.objectives.map(o => ({ id: o.id, type: o.type, owner: o.owner, map: m.type, at: Date.parse(o.last_flipped) })));
      const newest = Math.max(...flips.map(o => o.at).filter(Number.isFinite));
      const want = flips.filter(o => ['Camp', 'Tower', 'Keep', 'Castle'].includes(o.type) && OWNERS.includes(o.owner)
        && o.at <= newest && newest - o.at <= 30 * 60000).sort((a, b) => (b.at - a.at) || a.id.localeCompare(b.id));
      expect(want.length, 'the recording has a capture in its last 30 min to list').toBeGreaterThan(0);
      return want;
    }

    test('three tabs in order, the objective off until one is picked; the board stands still for 6 s and hugs its rows', async ({ page, wvw }) => {
      const tier = await opened(page, wvw);
      const want = await captures(page, tier);
      let st = await state(page);
      expect(st.tabs.map(x => x.text.replace(/ \(\d+\)$/, '')).join(), 'the tabs').toBe('Board,Captures,Objective');
      expect(activeText(st) === 'Board' && st.tabs[2].off && !st.tabs[0].off && !st.tabs[1].off, `on opening ${JSON.stringify(st.tabs)}`).toBe(true);
      expect(st.tabs[1].text, 'the Captures tab').toBe(`Captures (${want.length})`);
      // Standing still: the page sizes the board once; sized again, it grows.
      const boardH = await samples(page, 6, 1000, x => `${x.board}/${x.pop.height}`);
      expect(new Set(boardH).size, `the board (height/popover) moved over 6 s: ${boardH.join(' ')}`).toBe(1);
      st = await state(page);
      expect(st.board - st.rows, `the board is ${st.board} px for ${st.rows} px of rows`).toBeLessThan(40);
      // Beside the map the pane itself shrinks to the box it holds.
      if (!stacked) expect(st.pane.height - st.box.height, `the pane is ${st.pane.height} px for a box of ${st.box.height} px`).toBeLessThan(40);
    });

    test('a marker opens the Objective tab and nothing moves; back to the board; the captures; where each tab ends', async ({ page, wvw }) => {
      const tier = await opened(page, wvw);
      const want = await captures(page, tier);
      const home = (await state(page)).map;
      let st = await state(page);
      const popH = st.pop.height, board0 = st.board, ends = { board: st.box && st.box.bottom };
      const pane0 = st.pane.bottom;

      // A marker: the Objective tab opens by itself, nothing moves on any frame.
      const seen = await pressMarker(page, 3);
      expect(seen.length, `picking an objective moved the popover or the map: ${seen.join(' ; ')}`).toBe(1);
      await expect(activePane(page), 'the Objective tab opened by the marker').toHaveAttribute('data-pane', 'objective');
      const det = await samples(page, 4, 500, x => `${x.box && x.box.height}/${x.pop.height}`);
      expect(new Set(det).size, `the objective (height/popover) moved: ${det.join(' ')}`).toBe(1);
      st = await state(page);
      expect(JSON.stringify(st.shown) === '["wvw-detail"]' && !st.tabs[2].off, `on Objective the pane shows ${JSON.stringify(st.shown)}`).toBe(true);
      expect(Math.abs(st.pop.height - popH), `the popover went from ${popH} to ${st.pop.height} px on opening an objective`).toBeLessThanOrEqual(4);
      ends.objective = st.box && st.box.bottom;

      // Back to the board: the same board.
      await tab(page, 'board').click();
      await frame(page);
      const back = await samples(page, 3, 500, x => x.board);
      expect(new Set(back).size === 1 && Math.abs(back[0] - board0) <= 2, `the board came back ${back.join(',')} px, was ${board0}`).toBe(true);

      // Captures: the body's own, still.
      await tab(page, 'captures').click();
      await frame(page);
      st = await state(page);
      const ids = want.slice(0, 40).map(o => o.id);
      expect(st.caps, `the captures listed ${st.caps.length}, wanted ${ids.length}`).toEqual(ids);
      const capsH = await samples(page, 3, 500, x => x.box && x.box.height);
      expect(new Set(capsH).size, `the captures moved: ${capsH.join(',')}`).toBe(1);
      ends.captures = (await state(page)).box?.bottom;
      // A capture on this map lights its objective, the list staying.
      const here = want.find(o => o.map === home);
      const picked = (await state(page)).selected;
      if (here) {
        await page.locator(`${POP} .wvw-cap[data-obj="${here.id}"]`).click();
        await expect.poll(async () => (await state(page)).lit, { message: `${here.id} lit by its capture` }).toBe(here.id);
        st = await state(page);
        expect(activeText(st).startsWith('Captures') && st.selected === picked, `a capture's row left the tab on "${activeText(st)}", selected "${st.selected}" (was "${picked}")`).toBe(true);
      }
      // One on another map opens that map's tab and lights it there.
      const away = width === 1280 && want.find(o => o.map !== home);
      if (away) {
        await page.locator(`${POP} .wvw-cap[data-obj="${away.id}"]`).click();
        await expect(page.locator(`${POP} .wvw-tab.is-active`)).toHaveAttribute('data-type', away.map);
        await expect.poll(async () => (await state(page)).lit, { message: `${away.map} open, ${away.id} lit` }).toBe(away.id);
        await expect(activePane(page), 'the captures still shown').toHaveAttribute('data-pane', 'captures');
        await wvw.settle();
        await page.locator(`${POP} .wvw-tab[data-type="${home}"]`).click();
        await expect(page.locator(`${POP} .wvw-tab.is-active`)).toHaveAttribute('data-type', home);
        await expect(page.locator(`${POP} .wvw-plot g[role='button']`).first()).toBeAttached();
        await wvw.settle();
      }

      // Where each tab ends: under the map, one line; beside it, above the map's bottom.
      await tab(page, 'board').click();
      await frame(page);
      st = await state(page);
      if (stacked) {
        const lines = Object.values(ends);
        expect(st.pane.bottom === pane0 && !lines.some(b => !b || b > st.pane.bottom), `the tabs end at ${JSON.stringify(ends)}, the pane at ${st.pane.bottom} (was ${pane0})`).toBe(true);
      } else {
        expect(Object.values(ends).some(b => !b || b > st.plot.bottom + 1), `the tabs end at ${JSON.stringify(ends)}, past the map's bottom ${st.plot.bottom}`).toBe(false);
      }
    });

    if (!stacked) test('the opening stamp the game puts on a whole map is no capture, per map; an empty body lists none and logs nothing', async ({ page, wvw }) => {
      const tier = await opened(page, wvw);
      const kept = await keptMatch(page, tier.id);
      const route = await answer(page, tier.url, kept);
      const CAP = ['Camp', 'Tower', 'Keep', 'Castle'];
      const base = await page.evaluate(() => Date.now()) - 60000;
      const at = ms => new Date(base - ms).toISOString();
      const [m0, m1, m2, m3] = kept.maps;
      expect(kept.maps.length, 'maps in the body').toBeGreaterThanOrEqual(4);
      const split = m => ({ cap: m.objectives.filter(o => CAP.includes(o.type)), non: m.objectives.filter(o => !CAP.includes(o.type)) });
      const S = [m0, m1, m2, m3].map(split);
      for (const g of S) { expect(g.cap.length, 'capturable').toBeGreaterThanOrEqual(6); expect(g.non.length, 'the rest').toBeGreaterThanOrEqual(3); }
      const H = 3600000, M = 60000;
      const want = [];
      // Every objective of the map on one second, the newest of all: the opening, nothing to list.
      for (const o of m0.objectives) { o.last_flipped = at(M); if (CAP.includes(o.type)) o.owner = 'Red'; }
      // The stamp older than the newest capture and inside its 30 min: the rest of the map's
      // objectives, and two owned capturables, carry it; five real captures come after it.
      S[1].non.forEach(o => { o.last_flipped = at(2 * H + 20 * M); });
      S[1].cap.forEach((o, k) => {
        o.owner = k < 7 ? 'Red' : 'Neutral';
        o.last_flipped = at(k < 5 ? 2 * H - k * 20000 : k < 7 ? 2 * H + 20 * M : 2 * H - 100000 - k * 1000);
        if (k < 5) want.push(o.id);
      });
      // Two captures on the oldest second are real: under three they are no stamp.
      S[2].non.forEach((o, j) => { o.last_flipped = at(2 * H - 120000 - j * 1000); });
      S[2].cap.forEach((o, k) => { o.owner = k < 3 ? 'Red' : 'Neutral'; o.last_flipped = at(k < 2 ? 2 * H + 10 * M : k === 2 ? 2 * H + 5 * M : 2 * H - 130000 - k * 1000); if (k < 3) want.push(o.id); });
      // The map's stamp on its other objectives is older than three captures that share a second: those are captures.
      S[3].non.forEach(o => { o.last_flipped = at(2 * H + 20 * M); });
      S[3].cap.forEach((o, k) => { o.owner = k < 3 ? 'Red' : 'Neutral'; o.last_flipped = at(k < 3 ? 2 * H + 9 * M : 2 * H + 5 * M - k * 1000); if (k < 3) want.push(o.id); });
      for (const m of kept.maps.slice(4)) for (const o of m.objectives) o.last_flipped = at(9 * H);
      await wvw.skew(31000);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await tab(page, 'captures').click();
      await expect(tab(page, 'captures')).toHaveText(`Captures (${want.length})`);
      expect(want.length).toBe(11);
      expect((await state(page)).caps.slice().sort(), 'only the real captures').toEqual(want.slice().sort());
      // The same match with no objectives yet.
      for (const m of kept.maps) m.objectives = [];
      await wvw.skew(31000);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(tab(page, 'captures')).toHaveText('Captures (0)');
      await expect(page.locator(`${POP} .wvw-caps .wvw-caps-none`)).toHaveText('No recent captures.');
      expect(route, 'the route is still ours').toBeTruthy();
    });

    test('over 40 captures the list ends with how many older ones it leaves out, and no line at 40 or fewer', async ({ page, wvw }) => {
      const tier = await opened(page, wvw);
      const kept = await keptMatch(page, tier.id);
      const pool = kept.maps.flatMap(m => m.objectives).filter(o => ['Camp', 'Tower', 'Keep', 'Castle'].includes(o.type) && OWNERS.includes(o.owner));
      expect(pool.length, 'the recording has at least 43 capturable objectives').toBeGreaterThan(42);
      const route = await answer(page, tier.url, kept);
      // The newest `n` objectives flipped 30 s apart, the rest long before.
      // The same instants every time, so only the count outside differs between two lists.
      let base = null;
      const setTo = async n => {
        await wvw.skew(31000);
        base ??= await page.evaluate(() => Date.now()) - 60000;
        for (const o of kept.maps.flatMap(m => m.objectives)) if (!pool.includes(o)) o.last_flipped = new Date(base - 5 * 3600000).toISOString();
        pool.forEach((o, i) => { o.last_flipped = new Date(base - (i < n ? i * 30000 : 3 * 3600000 + i * 1000)).toISOString(); });
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(tab(page, 'captures')).toHaveText(`Captures (${n})`);
      };
      const more = page.locator(`${POP} .wvw-caps .wvw-caps-more`);
      await tab(page, 'captures').click();
      for (const [n, text] of [[40, null], [43, '3 older captures not listed.'], [41, '1 older capture not listed.'], [40, null]]) {
        await setTo(n);
        await expect(page.locator(`${POP} .wvw-caps .wvw-cap`), `${n} captures: rows`).toHaveCount(Math.min(n, 40));
        if (text) await expect(more, `${n} captures: the last line`).toHaveText(text);
        else await expect(more, `${n} captures: no last line`).toHaveCount(0);
      }
      route.off();
    });

    test('a map tab change with an objective picked puts the pane back on the board and switches the Objective tab off', async ({ page, wvw }) => {
      await opened(page, wvw);
      await pressMarker(page, 3);
      await expect(activePane(page), 'the Objective tab after the marker').toHaveAttribute('data-pane', 'objective');
      await page.locator(`${POP} .wvw-tab:not(.is-active)`).first().click();
      await expect(activePane(page), 'the pane after a map tab change').toHaveAttribute('data-pane', 'board');
      await expect(tab(page, 'objective')).toBeDisabled();
      expect((await state(page)).shown, 'the box shown').toEqual(['wvw-board']);
    });

    test('the pane is given its height, and a stretched map does not resize it on the next refresh', async ({ page, wvw }) => {
      const tier = await opened(page, wvw);
      const paneH = () => page.evaluate(() => document.querySelector('.info-popover .wvw-side').style.getPropertyValue('--pane-h'));
      const h0 = await paneH();
      expect(h0, 'the pane height the page sets').toMatch(/^\d+px$/);
      await tab(page, 'captures').click();
      await frame(page);
      const st = await state(page);
      if (stacked) expect(st.pane.height, 'the stacked pane is as tall as it was given').toBe(parseInt(h0, 10));
      else expect(Math.abs(st.box.bottom - st.plot.bottom), `a long list ends at the map's bottom (${st.box.bottom} / ${st.plot.bottom})`).toBeLessThanOrEqual(6);
      // The drawing moves under the open pane, as a late image or font would move it: not measured again.
      await page.evaluate(() => { document.querySelector('.info-popover .wvw-plot-wrap').style.paddingTop = '90px'; });
      await answer(page, tier.url, await keptMatch(page, tier.id));
      await wvw.skew(31000);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await wvw.settle();
      await frame(page);
      expect(await paneH(), 'the pane height after a refresh').toBe(h0);
    });

    test('three objectives picked in turn, then fifteen switches: the board and the popover as they were', async ({ page, wvw }) => {
      await opened(page, wvw);
      let st = await state(page);
      const popH = st.pop.height, board0 = st.board;
      for (const n of [2, 6, 10]) {
        const moved = await pressMarker(page, n);
        expect(moved.length, `picking marker ${n} moved the popover or the map: ${moved.join(' ; ')}`).toBe(1);
      }
      await expect(activePane(page), 'the Objective tab after the markers').toHaveAttribute('data-pane', 'objective');
      // On a phone the map on top, its top the same in every tab, the tabs and pane under it.
      const seenBoard = new Set(), seenPop = new Set(), mapTops = new Set();
      for (let i = 0; i < 5; i++) {
        for (const key of ['objective', 'captures', 'board']) {
          await tab(page, key).click();
          await expect(activePane(page)).toHaveAttribute('data-pane', key);
          await frame(page);
          st = await state(page);
          seenPop.add(st.pop.height);
          if (key === 'board') seenBoard.add(st.board);
          if (stacked) {
            mapTops.add(st.plot.top);
            expect(st.tabsBar.top > st.plot.bottom && st.box && st.box.top > st.tabsBar.bottom,
              `on ${key} the map is not on top (map ${st.plot.top}-${st.plot.bottom}, tabs ${st.tabsBar.top}, pane ${st.box && st.box.top})`).toBeTruthy();
          }
        }
      }
      expect(seenBoard.size === 1 && Math.abs([...seenBoard][0] - board0) <= 2 && ![...seenPop].some(h => Math.abs(h - popH) > 4),
        `over 15 switches the board read ${[...seenBoard]} (was ${board0}), the popover ${[...seenPop]} (was ${popH})`).toBe(true);
      if (stacked) expect(mapTops.size, `the map moved with the tabs: tops ${[...mapTops]}`).toBe(1);
    });

    if (!stacked) {
      test('a refresh moves the board; a map tab change keeps it there', async ({ page, wvw }) => {
        const tier = await opened(page, wvw);
        const home = (await state(page)).map;
        const kept = await keptMatch(page, tier.id);
        const flip = kept.maps.flatMap(m => m.objectives).find(o => o.type === 'Camp' && OWNERS.includes(o.owner));
        expect(flip, 'a camp to hand over').toBeTruthy();
        const boardText = () => page.locator(`${POP} .wvw-board`).textContent();
        const was = await boardText();
        for (const m of kept.maps) for (const o of m.objectives) if (o.id === flip.id) o.owner = OWNERS[(OWNERS.indexOf(o.owner) + 1) % 3];
        kept.scores.red += 1;
        await answer(page, tier.url, kept);
        await wvw.skew(31000);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(boardText, { message: 'the board repainted by the refresh' }).not.toBe(was);
        await wvw.settle();
        const now = await boardText();
        const other = kept.maps.map(m => m.type).find(type => type !== home);
        await page.locator(`${POP} .wvw-tab[data-type="${other}"]`).click();
        await expect(page.locator(`${POP} .wvw-tab.is-active`)).toHaveAttribute('data-type', other);
        await expect(page.locator(`${POP} .wvw-plot g[role='button']`).first()).toBeAttached();
        await wvw.settle();
        expect(await boardText(), `a map tab change put the board back, the refresh had "${now.slice(0, 80)}"`).toBe(now);
      });
    }
  });
}

test.describe('objective panel across a refresh', () => {
  async function pick(page, wvw) {
    await load(page, wvw);
    const tier = await firstTier(page);
    await openMap(page, wvw, tier.button);
    await page.locator(`${POP} .wvw-plot g[role='button']`).first().click();
    await expect(page.locator(`${POP} .wvw-detail-name`)).toBeVisible();
    await wvw.settle();
    return tier;
  }
  const select = (page, sel) => page.evaluate((s) => {
    const r = document.createRange();
    r.selectNodeContents(document.querySelector(s));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return getSelection().toString();
  }, sel);
  const refresh = async (page, wvw, ms = 31000) => {
    await wvw.skew(ms);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1500);
    await wvw.settle();
  };

  test('a refresh that changes nothing in the objective keeps the text the reader selected', async ({ page, wvw }) => {
    await pick(page, wvw);
    const picked = await select(page, `${POP} .wvw-detail-name`);
    expect(picked.length).toBeGreaterThan(0);
    await refresh(page, wvw);
    expect(await page.evaluate(() => getSelection().toString())).toBe(picked);
  });

  test('the "For" age keeps counting in place while the rest of the panel stays', async ({ page, wvw }) => {
    await pick(page, wvw);
    const age = () => page.locator(`${POP} .wvw-detail .wvw-ago`).textContent();
    const was = await age();
    const picked = await select(page, `${POP} .wvw-detail-name`);
    await refresh(page, wvw, 150000);
    expect(await age()).not.toBe(was);
    expect(await page.evaluate(() => getSelection().toString())).toBe(picked);
  });

  test('the same objective picked again after a tab change is drawn again', async ({ page, wvw }) => {
    const tier = await pick(page, wvw);
    const home = await page.locator(`${POP} .wvw-tab.is-active`).getAttribute('data-type');
    const other = (await keptMatch(page, tier.id)).maps.map(m => m.type).find(type => type !== home);
    await page.locator(`${POP} .wvw-tab[data-type="${other}"]`).click();
    await expect(page.locator(`${POP} .wvw-tab.is-active`)).toHaveAttribute('data-type', other);
    await page.locator(`${POP} .wvw-tab[data-type="${home}"]`).click();
    await expect(page.locator(`${POP} .wvw-tab.is-active`)).toHaveAttribute('data-type', home);
    await expect(page.locator(`${POP} .wvw-detail-name`)).toHaveCount(0);
    await page.locator(`${POP} .wvw-plot g[role='button']`).first().click();
    await expect(page.locator(`${POP} .wvw-detail-name`)).toBeVisible();
  });

  test('a tactic the catalogue lacks is named once its lookup lands', async ({ page, wvw }) => {
    const tier = await pick(page, wvw);
    const id = await page.locator(`${POP} .wvw-detail`).getAttribute('data-showing');
    await page.route('**/v2/guild/upgrades?ids=999001', route => route.fulfill({
      status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify([{ id: 999001, name: 'Probe Tactic', description: '', icon: '', costs: [{ name: 'Probe Tactic' }] }]),
    }));
    const kept = await keptMatch(page, tier.id);
    for (const m of kept.maps) for (const o of m.objectives) if (String(o.id) === id) o.guild_upgrades = [999001];
    await answer(page, tier.url, kept);
    await refresh(page, wvw);
    await expect(page.locator(`${POP} .wvw-detail .wvw-upgrades li`)).toHaveText('Probe Tactic');
  });

  test('a refresh that hands the objective to another team repaints the panel', async ({ page, wvw }) => {
    const tier = await pick(page, wvw);
    const id = await page.locator(`${POP} .wvw-detail`).getAttribute('data-showing');
    const team = () => page.locator(`${POP} .wvw-detail dl > div:has(dt:text-is("Team")) dd`).textContent();
    const was = await team();
    const kept = await keptMatch(page, tier.id);
    for (const m of kept.maps) for (const o of m.objectives) if (String(o.id) === id) o.owner = OWNERS[(OWNERS.indexOf(o.owner) + 1) % 3];
    await answer(page, tier.url, kept);
    await refresh(page, wvw);
    expect(await team()).not.toBe(was);
  });
});
