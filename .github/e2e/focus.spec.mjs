// The board picks what the map lights: a
// team's row, a type's column (the Darken focus: the picked markers marked
// is-lit, the rest darkened), the label "<Colour> only ✕" in place of "Objectives
// held", the row picked and the team's segment of the bar glowing. Enter on the
// board picks too; Esc and the ✕ let go, the popover staying open. A 30 s repaint
// that moves an owner keeps the pick on every frame. And where the pick lands
// when the map in view holds none of it, applied at the click only, one case per
// rule, counted from the body the page holds, the way the page counts: (1) the
// view holds some: stays. (2) one other map holds some: goes there. (3) several
// do: goes to the one with most (a tie: tab order), the note names the rest and
// its button goes there. (4) no map holds any: nothing darkens and the note says
// so. At 1280 and 360 px.
import { test, expect } from './support/fixtures.mjs';
import { answer } from './support/faults.mjs';
import { phone, frame, load, firstTier, openMap, keptMatch } from './support/steps.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
test.describe.configure({ timeout: 60 * 1000 });

const WORD = { red: 'Red', blue: 'Blue', green: 'Green' };
const POP = '.info-popover';
const ROW = `${POP} .wvw-board-row[data-focus-color]`;

// The map of the first tier open at `width`, its board drawn.
async function opened(page, wvw, width) {
  await load(page, wvw);
  if (width < 600) await phone(page, width);
  const tier = await firstTier(page);
  await openMap(page, wvw, tier.button);
  await expect(page.locator(ROW).first()).toBeAttached();
  await wvw.settle();
  return tier;
}

// Everything the focus shows, read at once.
const state = page => page.evaluate(() => {
  const pop = document.querySelector('.info-popover');
  const own = g => ([...g.classList].find(c => c.startsWith('own-')) || '').slice(4);
  const wrap = pop.querySelector('.wvw-plot-wrap');
  const head = pop.querySelector('.wvw-board-head');
  return {
    focused: pop.querySelector('.wvw-plot').classList.contains('is-focused'),
    veil: !!pop.querySelector('.wvw-focus-veil'),
    marks: [...pop.querySelectorAll('.wvw-marker')].map(g => ({ id: g.dataset.obj, own: own(g),
      type: objectiveCatalogue.get(g.dataset.obj)?.type || '', lit: g.classList.contains('is-lit') })),
    label: head.querySelector('.wvw-board-team').textContent,
    rows: [...pop.querySelectorAll('.wvw-board-row.is-picked')].map(r => r.dataset.focusColor || 'head'),
    pressed: [...pop.querySelectorAll('.wvw-board [aria-pressed="true"]')].map(e => (e.closest('[data-focus-color]')?.dataset.focusColor || '') + '/' + (e.dataset.focusType || '')),
    cols: [...head.querySelectorAll('.is-picked')].map(e => e.dataset.focusType),
    team: wrap.dataset.focusTeam || '',
    bar: Object.fromEntries([...wrap.querySelectorAll('.wvw-scorebar-seg')].map(s => [own(s), getComputedStyle(s).filter])) };
});

// Lit exactly where want(marker) holds, the rest not, and at least one lit.
function litCheck(st, want, what) {
  const wrong = st.marks.filter(m => m.lit !== want(m));
  expect(wrong.length ? `${wrong.length} marker(s) lit wrong, e.g. ${JSON.stringify(wrong[0])}` : st.marks.some(m => m.lit) ? 'ok' : 'nothing lit', `${what}: lit`).toBe('ok');
  expect(st.focused && st.veil, `${what}: the map is not darkened (is-focused ${st.focused}, veil ${st.veil})`).toBe(true);
}

async function cleared(page, what) {
  const st = await state(page);
  expect(st.marks.some(m => m.lit) || st.focused || st.veil || st.rows.length || st.cols.length || st.team || !/^(Objectives held|Held)$/.test(st.label),
    `${what} left ${JSON.stringify({ lit: st.marks.filter(m => m.lit).length, focused: st.focused, rows: st.rows, cols: st.cols, team: st.team, label: st.label })}`).toBeFalsy();
  expect(await page.locator(POP).count(), `${what} closed the popover`).toBe(1);
}

const colorOf = page => page.locator(ROW).first().getAttribute('data-focus-color');

for (const width of [1280, 360]) {
  test.describe(`map focus, ${width} px`, () => {
    test("a team's row lights its objectives, the label, the row and the bar", async ({ page, wvw }) => {
      await opened(page, wvw, width);
      const color = await colorOf(page);
      await page.locator(ROW).first().locator('.wvw-board-team').click();
      await expect(page.locator(`${POP} .wvw-plot`)).toHaveClass(/is-focused/);
      // The bar eases over .2 s; a side scoring nothing on this map has no segment.
      await expect.poll(() => page.evaluate(c => { const s = document.querySelector(`.info-popover .wvw-scorebar-seg.own-${c}`);
        return !s || /brightness\(1\.35\)/.test(getComputedStyle(s).filter); }, color), { message: `the ${color} segment of the bar lit` }).toBe(true);
      await page.waitForTimeout(300);
      const st = await state(page);
      litCheck(st, m => m.own === color, `${WORD[color]} picked`);
      expect(st.label, 'the label').toBe(`${WORD[color]} only✕`);
      expect([st.rows, st.pressed], 'picked rows and pressed').toEqual([[color], [`${color}/`]]);
      expect(st.team, "the map's bar follows").toBe(color);
      for (const [c, f] of Object.entries(st.bar)) {
        expect(f, `the bar's ${c} segment`).toMatch(c === color ? /brightness\(1\.35\)/ : /brightness\(0\.5\)/);
      }
      expect(color in st.bar, `the bar has no ${color} segment to light`).toBe(true);
    });

    test("a type's column lights the towers, whoever holds them; Esc lets go, the popover open", async ({ page, wvw }) => {
      await opened(page, wvw, width);
      const col = page.locator(`${POP} .wvw-board-head [data-focus-type="Tower"]`);
      await col.click();
      await expect(col).toHaveClass(/is-picked/);
      const st = await state(page);
      litCheck(st, m => m.type === 'Tower', 'Tower picked');
      expect([st.label, st.rows, st.team], 'on Tower the label, rows and bar').toEqual(['Towers only✕', [], '']);
      await page.keyboard.press('Escape');
      await expect(page.locator(`${POP} .wvw-plot`)).not.toHaveClass(/is-focused/);
      await cleared(page, 'Esc');
    });

    test("Enter on a team's name picks it; the ✕ lets go", async ({ page, wvw }) => {
      await opened(page, wvw, width);
      const row = page.locator(ROW).first();
      await row.locator('.wvw-board-team').focus();
      await page.keyboard.press('Enter');
      await expect(row).toHaveClass(/is-picked/);
      await page.locator(`${POP} .wvw-focus-pill`).click();
      await expect(page.locator(`${POP} .wvw-focus-pill`)).toHaveCount(0);
      await cleared(page, 'the ✕');
    });

    if (width === 1280) {
      test("a repaint that hands one of the team's objectives to the next side keeps the pick on every frame", async ({ page, wvw }) => {
        const tier = await opened(page, wvw, width);
        const color = await colorOf(page);
        const row = page.locator(ROW).first();
        await row.locator('.wvw-board-team').click();
        await expect(row).toHaveClass(/is-picked/);
        const drawn = (await state(page)).marks.filter(m => m.lit && ['Camp', 'Tower', 'Keep'].includes(m.type)).map(m => m.id);
        const kept = await keptMatch(page, tier.id);
        const flip = kept.maps.flatMap(m => m.objectives).filter(o => drawn.includes(o.id) && /^\d+-\d+$/.test(o.id))
          .sort((a, b) => !!a.claimed_by - !!b.claimed_by)[0];
        expect(flip, `a camp, tower or keep of ${color} to hand over`).toBeTruthy();
        const next = { red: 'Blue', blue: 'Green', green: 'Red' }[color];
        for (const m of kept.maps) for (const o of m.objectives) if (o.id === flip.id) o.owner = next;
        kept.scores.red += 1;
        await answer(page, tier.url, kept);
        await page.evaluate(() => {
          window.__focusFrames = []; window.__focusWatch = true;
          (function look() {
            if (!window.__focusWatch) return;
            const p = document.querySelector('.info-popover');
            __focusFrames.push(!!p && p.querySelector('.wvw-plot').classList.contains('is-focused')
              && !!p.querySelector('.wvw-focus-pill') && !!p.querySelector('.wvw-board-row.is-picked'));
            requestAnimationFrame(look);
          })();
        });
        await wvw.skew(31000);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(page.locator(`${POP} .wvw-marker.own-${next.toLowerCase()}[data-obj="${flip.id}"]`), 'the handed-over objective repainted').toBeAttached();
        await frame(page);
        const frames = await page.evaluate(() => { window.__focusWatch = false; return window.__focusFrames; });
        expect(frames.length && frames.every(Boolean), `the pick was missing on ${frames.filter(f => !f).length} of ${frames.length} frames around the repaint`).toBeTruthy();
        const st = await state(page);
        litCheck(st, m => m.own === color, `${WORD[color]} picked, after the repaint`);
        expect(st.marks.find(m => m.id === flip.id)?.lit, `${flip.id}, handed to ${next}, is still lit`).toBe(false);
        expect([st.rows, st.team, st.label], 'after the repaint rows, bar, label').toEqual([[color], color, `${WORD[color]} only✕`]);
      });
    }

    // ---- Where the pick lands ------------------------------------------------
    const SEL = {
      row: c => `${POP} .wvw-board-row[data-focus-color="${c}"] .wvw-board-team`,
      cell: (c, t) => `${POP} .wvw-board-row[data-focus-color="${c}"] [data-focus-type="${t}"]`,
      col: t => `${POP} .wvw-board-head [data-focus-type="${t}"]` };
    const specs = [];
    for (const c of ['red', 'blue', 'green']) specs.push({ color: c, type: null, sel: SEL.row(c) });
    for (const t of ['Camp', 'Tower', 'Keep', 'Castle']) specs.push({ color: null, type: t, sel: SEL.col(t) });
    for (const c of ['red', 'blue', 'green']) for (const t of ['Camp', 'Tower', 'Keep', 'Castle']) specs.push({ color: c, type: t, sel: SEL.cell(c, t) });

    // The map's tabs, the objectives' catalogue and a way to count the way the page does.
    async function world(page, tier) {
      const cat = await page.evaluate(() => [...objectiveCatalogue.values()].map(m => [m.id, m.map_id, m.type]));
      const tabs = await page.evaluate(() => [...document.querySelectorAll('.info-popover .wvw-tab')].map(b => [b.dataset.type, b.textContent]));
      const order = tabs.map(t => t[0]);
      const tally = (body, spec) => Object.fromEntries(order.map(type => {
        const m = body.maps.find(x => x.type === type);
        const held = new Map((m.objectives || []).map(o => [o.id, o.owner]));
        return [type, cat.filter(([id, map, t]) => map === m.id && t !== 'Spawn'
          && (!spec.color || String(held.get(id) || 'neutral').toLowerCase() === spec.color) && (!spec.type || t === spec.type)).length];
      }));
      return { order, short: Object.fromEntries(tabs), tally, body: await keptMatch(page, tier.id) };
    }
    const active = page => page.evaluate(() => document.querySelector('.info-popover .wvw-tab.is-active')?.dataset.type || '');
    const view = page => page.evaluate(() => { const p = document.querySelector('.info-popover'); const n = p.querySelector('.wvw-focus-note');
      return { tab: p.querySelector('.wvw-tab.is-active')?.dataset.type || '', note: n ? n.textContent : '', lit: p.querySelectorAll('.wvw-marker.is-lit').length,
        veil: !!p.querySelector('.wvw-focus-veil'), pill: !!p.querySelector('.wvw-focus-pill'),
        said: p.querySelector(':scope > .sr-only[role="status"]')?.textContent || '' }; });
    const drawn = page => expect(page.locator(`${POP} .wvw-marker`).first()).toBeAttached();
    const goTab = async (page, wvw, type) => {
      if ((await active(page)) !== type) await page.locator(`${POP} .wvw-tab[data-type="${type}"]`).click();
      await expect.poll(() => active(page)).toBe(type);
      await drawn(page);
      await wvw.settle();
    };
    // Let go, start on `start`, pick `spec`, and read what the page shows.
    const pick = async (page, wvw, start, spec) => {
      if (await page.locator(`${POP} .wvw-focus-pill`).count()) await page.locator(`${POP} .wvw-focus-pill`).click();
      await goTab(page, wvw, start);
      await page.locator(spec.sel).click();
      await expect(page.locator(`${POP} .wvw-focus-pill`)).toBeAttached();
      await drawn(page);   // a map not drawn yet shows "Loading"; the pick waits for its markers
      await page.waitForTimeout(200);
      return view(page);
    };
    const label = (spec, start, to) => `${spec.color || 'any'}/${spec.type || 'any'} from ${start}${to ? ' to ' + to : ''}`;
    // The first case of each rule in the body the page holds.
    function find(w) {
      const found = { 1: null, 2: null, 3: null };
      for (const start of w.order) for (const spec of specs) {
        const n = w.tally(w.body, spec);
        const have = w.order.filter(t => n[t] > 0);
        if (!found[1] && n[start] > 0 && have.length > 1) found[1] = { start, spec, n };
        if (!found[2] && !n[start] && have.length === 1) found[2] = { start, spec, n };
        if (!found[3] && !n[start] && have.length > 1) found[3] = { start, spec, n };
      }
      return found;
    }

    test('where the pick lands, rule 1: the view holds some, it stays', async ({ page, wvw }) => {
      const w = await world(page, await opened(page, wvw, width));
      const c = find(w)[1];
      expect(c, 'the recorded body has no case for rule 1').toBeTruthy();
      const v = await pick(page, wvw, c.start, c.spec);
      expect(v.tab === c.start && v.lit && v.veil && !v.note, `rule 1 ${label(c.spec, c.start)}: ${JSON.stringify(v)}, wanted to stay with some lit and no note`).toBeTruthy();
    });

    test('where the pick lands, rule 2: one other map holds some, it goes there', async ({ page, wvw }) => {
      const w = await world(page, await opened(page, wvw, width));
      const c = find(w)[2];
      expect(c, 'the recorded body has no case for rule 2').toBeTruthy();
      const to = w.order.find(t => c.n[t] > 0);
      const v = await pick(page, wvw, c.start, c.spec);
      expect(v.tab === to && v.lit && v.veil && !v.note, `rule 2 ${label(c.spec, c.start, to)}: ${JSON.stringify(v)}, wanted the ${to} tab, some lit, no note`).toBeTruthy();
      expect(v.said, 'the switch was said in the status line').toBeTruthy();
    });

    test("where the pick lands, rule 3: several hold some, the most; the note names the rest and its button goes there", async ({ page, wvw }) => {
      const w = await world(page, await opened(page, wvw, width));
      const c = find(w)[3];
      expect(c, 'the recorded body has no case for rule 3').toBeTruthy();
      const have = w.order.filter(t => c.n[t] > 0);
      const to = have.reduce((b, t) => (c.n[t] > c.n[b] ? t : b), have[0]);
      const rest = have.filter(t => t !== to);
      const v = await pick(page, wvw, c.start, c.spec);
      const wantNote = 'also ' + rest.map(t => `${c.n[t]} on ${w.short[t]}`).join(', ');
      expect(v.tab === to && v.lit && v.veil && v.note === wantNote, `rule 3 ${label(c.spec, c.start, to)} ${JSON.stringify(c.n)}: ${JSON.stringify(v)}, wanted the ${to} tab, some lit, note "${wantNote}"`).toBeTruthy();
      expect(v.said, 'the switch was said in the status line').toBeTruthy();
      const button = page.locator(`${POP} .wvw-focus-note button`);
      expect(await button.count(), 'the note has a button').toBeGreaterThan(0);
      await button.click();
      await expect.poll(() => active(page), { message: `the note's button going to ${rest[0]}` }).toBe(rest[0]);
      await drawn(page);
      await page.waitForTimeout(200);
      const after = await view(page);
      expect(after.lit && after.pill, `after the note's button, ${JSON.stringify(after)}, wanted some lit and the pick kept`).toBeTruthy();
    });

    test('where the pick lands, rule 4: no map holds any, nothing darkens and the note says so', async ({ page, wvw }) => {
      const tier = await opened(page, wvw, width);
      const w = await world(page, tier);
      // Every castle is Blue's, so Red's castles are nowhere.
      const none = JSON.parse(JSON.stringify(w.body));
      for (const m of none.maps) for (const o of m.objectives) if (o.type === 'Castle') o.owner = 'Blue';
      none.scores.red += 5;
      const spec = { color: 'red', type: 'Castle', sel: SEL.cell('red', 'Castle') };
      expect(Object.values(w.tally(none, spec)).some(x => x), 'the made-up body still has Red castles').toBe(false);
      await page.locator(`${POP} .info-popover-close`).click();
      await expect(page.locator(POP)).toHaveCount(0);
      await answer(page, tier.url, none);
      await openMap(page, wvw, tier.button);
      await expect(page.locator(ROW).first()).toBeAttached();
      await expect.poll(() => page.evaluate(([id]) => newestMatches.get(id).match.scores.red, [tier.id]), { message: 'the made-up body taken' }).toBeGreaterThanOrEqual(none.scores.red);
      await page.waitForTimeout(400);
      const start = w.order[w.order.length - 1];
      const v = await pick(page, wvw, start, spec);
      expect(v.tab === start && !v.veil && !v.lit && v.pill && v.note === 'None on any map right now',
        `rule 4 ${label(spec, start)}: ${JSON.stringify(v)}, wanted to stay, nothing darkened, note "None on any map right now"`).toBeTruthy();
      await expect(page.locator(`${POP} .wvw-plot`), 'the map is darkened').not.toHaveClass(/is-focused/);
    });
  });
}
