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
import { phone, load, firstTier, openMap, keptMatch } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
test.describe.configure({ timeout: 90 * 1000 });

const POP = '.info-popover';
const OWNERS = ['Red', 'Blue', 'Green'];
const frame = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
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
      // Standing still: the board measured once, never again (it grew 2 px a second when it was).
      const boardH = await samples(page, 6, 1000, x => `${x.board}/${x.pop.height}`);
      expect(new Set(boardH).size, `the board (height/popover) moved over 6 s: ${boardH.join(' ')}`).toBe(1);
      st = await state(page);
      expect(st.board - st.rows, `the board is ${st.board} px for ${st.rows} px of rows`).toBeLessThan(40);
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
