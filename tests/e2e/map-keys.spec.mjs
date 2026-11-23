// The map and the page by hand: a marker and the board answer Tab, Enter and
// Space.
import { test, expect } from './support/fixtures.mjs';
import { boardOpen, load, openMap, tabTo } from './support/steps.mjs';
import { FOCUS, MIN, hidden, missed, visible } from './support/scenarios.mjs';

test.use({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
test.describe.configure({ timeout: 60 * 1000 });

const POP = '.info-popover';
const MARKER = `${POP} .wvw-plot g[role='button']`;
const ROW = `${POP} .wvw-board-row[data-focus-color]`;

// Whether the page took each Enter and Space for itself (kept them from also
// scrolling or clicking): the keys it called preventDefault() on, in order.
const watchKeys = page => page.evaluate(() => {
  window.__taken = [];
  const real = Event.prototype.preventDefault;
  Event.prototype.preventDefault = function () {
    if (this.type === 'keydown' && (this.key === 'Enter' || this.key === ' ')) window.__taken.push(this.key);
    return real.call(this);
  };
});
const taken = page => page.evaluate(() => window.__taken);
const selected = page => page.$$eval(`${POP} .is-selected`, gs => gs.map(g => g.dataset.obj));
const heading = page => page.locator(`${POP} .wvw-detail`).textContent();

test.describe('keyboard on the map', () => {
  test('a marker: Tab reaches it, Enter and Space pick it, other keys do not', async ({ page, wvw }) => {
    await boardOpen(page, wvw);
    await page.locator(POP).focus();
    await tabTo(page, MARKER.replace(`${POP} `, ''), 'a marker');
    expect(await selected(page), 'nothing picked before a key').toEqual([]);
    await page.keyboard.press('a');
    await page.keyboard.press('Shift');
    expect(await selected(page), 'a letter picks nothing').toEqual([]);

    const first = await page.evaluate(() => document.activeElement.dataset.obj);
    await watchKeys(page);
    await page.keyboard.press('Enter');
    expect(await selected(page), 'Enter picks the focused marker').toEqual([first]);
    const named = await heading(page);
    expect(named.trim().length, 'the objective panel filled in').toBeGreaterThan(0);

    await page.keyboard.press('Tab');
    const second = await page.evaluate(() => document.activeElement.dataset.obj);
    expect(second, 'Tab moved on to another marker').toBeTruthy();
    expect(second).not.toBe(first);
    const scrolled = await page.evaluate(() => scrollY);
    await page.keyboard.press(' ');
    expect(await selected(page), 'Space picks the focused marker, and only it').toEqual([second]);
    expect(await heading(page), 'the panel follows the new pick').not.toBe(named);
    expect(await page.evaluate(() => scrollY), 'Space does not scroll the page').toBe(scrolled);
    expect(await taken(page), 'Enter and Space on a marker are the page\'s, not the browser\'s').toEqual(['Enter', ' ']);
  });

  for (const key of ['Enter', ' ']) {
    test(`the board: ${key === ' ' ? 'Space' : key} on a team's name picks it, again lets go`, async ({ page, wvw }) => {
      await boardOpen(page, wvw);
      const row = page.locator(ROW).first();
      await page.locator(POP).focus();
      await tabTo(page, '.wvw-board-row[data-focus-color] .wvw-board-team', 'a team name on the board');
      await page.keyboard.press('x');
      await expect(row, 'a letter picks nothing').not.toHaveClass(/is-picked/);
      await watchKeys(page);
      await page.keyboard.press(key);
      expect(await taken(page), 'the key is the page\'s, not the browser\'s').toEqual([key]);
      await expect(row).toHaveClass(/is-picked/);
      await expect(page.locator(`${POP} .wvw-plot`)).toHaveClass(/is-focused/);
      await page.keyboard.press(key);
      await expect(row).not.toHaveClass(/is-picked/);
      await expect(page.locator(`${POP} .wvw-plot`)).not.toHaveClass(/is-focused/);
    });
  }
});

test.describe('the map window is modal', () => {
  const where = page => page.evaluate(() => {
    const a = document.activeElement;
    return a === document.body ? 'body' : a.closest('.info-popover') ? 'window' : `outside: ${a.tagName}#${a.id}.${a.className}`;
  });

  test('Tab and Shift+Tab stay in the window; closing gives the page its focus back; the open tab says so', async ({ page, wvw }) => {
    const tier = await boardOpen(page, wvw);
    await expect(page.locator(POP)).toHaveAttribute('aria-modal', 'true');
    const current = () => page.$$eval(`${POP} .wvw-tab`, bs => bs.map(b => [b.classList.contains('is-active'), b.getAttribute('aria-current')]));
    const check = async why => {
      const tabs = await current();
      expect(tabs.length, 'map tabs').toBeGreaterThan(1);
      for (const [active, attr] of tabs) expect(attr, why).toBe(active ? 'true' : null);
    };
    await check('aria-current marks only the open tab');

    // The first and last tabbable of the window, one step outward each.
    const edge = (which, key) => page.evaluate(([which, key]) => {
      const win = document.querySelector('.info-popover');
      const all = [...win.querySelectorAll('button, [href], input, select, textarea, [tabindex]')].filter(e => e.tabIndex >= 0 && !e.disabled && e.offsetParent !== null);
      all[which === 'first' ? 0 : all.length - 1].focus();
      return key;
    }, [which, key]);
    await edge('first', 'Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    expect(await where(page), 'Shift+Tab from the first stays in').not.toMatch(/^outside/);
    await edge('last', 'Tab');
    await page.keyboard.press('Tab');
    expect(await where(page), 'Tab from the last stays in').not.toMatch(/^outside/);

    await page.locator(POP).focus();
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press(key);
        expect(await where(page), `${key} press ${i + 1} stays in the window`).not.toMatch(/^outside/);
      }
    }

    await page.locator(`${POP} .wvw-tab:not(.is-active)`).first().click();
    await check('aria-current moves with the tab');

    await page.keyboard.press('Escape');
    await expect(page.locator(POP)).toHaveCount(0);
    await expect(tier.button, 'focus goes back to the maps button').toBeFocused();
    expect(await page.evaluate(() => [...document.body.children].filter(e => e.inert).length), 'nothing stays inert').toBe(0);
    await page.keyboard.press('Tab');
    expect(await where(page), 'the page takes focus again').toMatch(/^outside/);
  });
});

test.describe('focus follows a pick made from the right-hand column', () => {
  test.use({ timeline: missed(150, 30) });
  const where = page => page.evaluate(() => {
    const a = document.activeElement;
    return a === document.body ? 'body' : a.closest('.info-popover') ? `window ${a.className}` : 'outside';
  });

  test('a name or chip of another map, by Enter: focus stays in the window; Escape gives it to the maps button', async ({ page, wvw }) => {
    await load(page, wvw);
    await hidden(page, wvw, 25 * MIN);
    await visible(page);
    const button = page.locator(`.tier-map-btn[aria-label*="NA Tier ${FOCUS.split('-')[1]}"]`);
    await openMap(page, wvw, button);
    const head = page.locator(`${POP} .wvw-missed:not(.is-leaving) .wvw-missed-head`);
    await expect(head).toBeAttached();
    if (await head.getAttribute('aria-expanded') === 'false') await head.click();
    // The block rebuilds itself when folded and opened by key: the head keeps the focus.
    await tabTo(page, `${POP} .wvw-missed-head`, 'the block head');
    await page.keyboard.press('Enter');
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(head, 'the head keeps the focus when the block rebuilds').toBeFocused();
    await page.keyboard.press('Enter');
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await expect(head).toBeFocused();
    // Name and chip of another map, each by Enter: the redraw gives the row
    // new classes (it is this map's now) and the focus must follow the item.
    for (const [sel, what] of [['.wvw-missed-mapname', 'the name of another map'], ['.wvw-chip:not(.wvw-chip-more)', 'a chip of another map']]) {
      const item = `${POP} .wvw-missed-row.is-other ${sel}`;
      await page.locator(`${POP} .wvw-tab:not(.is-active)`).first().click();
      await expect(page.locator(item).first()).toBeAttached();
      const was = await page.locator(`${POP} .wvw-tab.is-active`).getAttribute('data-type');
      await tabTo(page, item, what);
      await page.keyboard.press('Enter');
      await expect(page.locator(`${POP} .wvw-tab.is-active`)).not.toHaveAttribute('data-type', was);
      await expect.poll(() => page.evaluate(s => !!document.activeElement.closest('.info-popover') && document.activeElement.matches(s), sel),
        { message: `focus stays on ${what} after the map changes` }).toBe(true);
    }
    // Focus left on <body> by anything that rebuilt its holder: closing still hands it back.
    await page.evaluate(() => document.activeElement.blur());
    expect(await where(page)).toBe('body');
    await page.keyboard.press('Escape');
    await expect(page.locator(POP)).toHaveCount(0);
    await expect(button, 'Escape gives the focus to the maps button').toBeFocused();
  });
});

test.describe('a popover that leaves the page live', () => {
  const BUTTON = '.icon-btn.activity-btn';

  test('a click on empty page closes it without pulling focus back; Escape still gives it back', async ({ page, wvw }) => {
    await load(page, wvw);
    const button = page.locator(BUTTON).first();
    await button.click();
    await expect(page.locator(POP)).toBeVisible();
    // An empty part of the page: the click puts the focus on <body> before the document sees it.
    await page.mouse.click(2, 2);
    await expect(page.locator(POP)).toHaveCount(0);
    await expect(button, 'a click elsewhere does not pull focus to the button').not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body), 'focus rests where the click put it').toBe(true);

    await button.click();
    await expect(page.locator(POP)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(POP)).toHaveCount(0);
    await expect(button, 'Escape gives the focus back').toBeFocused();
  });

  test('the map window holds the page: a click outside it gives the focus back to the maps button', async ({ page, wvw }) => {
    const tier = await boardOpen(page, wvw);
    await page.mouse.click(2, 2);
    await expect(page.locator(POP)).toHaveCount(0);
    await expect(tier.button, 'the page was held, so the focus goes back').toBeFocused();
  });

  test('the expanded guilds list holds the page: a click on its backdrop gives the focus back to the icon', async ({ page, wvw }) => {
    await load(page, wvw);
    const button = page.locator('.server-guilds-btn').locator('visible=true').first();
    await button.click();
    await expect(page.locator(`${POP} .info-popover-body`).first()).toBeAttached();
    await page.locator(`${POP} .info-popover-expand`).click();
    await expect(page.locator('.info-popover-backdrop')).toHaveCount(1);
    await page.mouse.click(2, 2);
    await expect(page.locator(POP)).toHaveCount(0);
    await expect(button, 'the page was held, so the focus goes back').toBeFocused();
  });
});

test.describe('the zoomed map follows the keyboard focus', () => {
  const WRAP = `${POP} .wvw-plot-wrap`;
  const state = page => page.evaluate(sel => {
    const w = document.querySelector(sel);
    return { box: w.querySelector('.wvw-plot').getAttribute('viewBox'), scroll: w.scrollTop + w.scrollLeft, page: scrollY };
  }, WRAP);
  // Which sides of the map the focused marker is cut by: left, right, top, bottom.
  const cuts = page => page.evaluate(sel => {
    const w = document.querySelector(sel).getBoundingClientRect();
    const r = document.activeElement.getBoundingClientRect();
    return [r.left < w.left, r.right > w.right, r.top < w.top, r.bottom > w.bottom];
  }, WRAP);
  const zoom3 = async page => {
    for (let i = 0; i < 4; i++) await page.locator(`${POP} .wvw-zoom button[aria-label='Zoom in']`).click();
    await page.mouse.move(5, 5);
  };
  // Markers whose middle is between `lo` and `hi` of the map's half-size from its middle, at the current view.
  const band = (page, lo, hi) => page.evaluate(([sel, lo, hi]) => {
    const w = document.querySelector(sel).getBoundingClientRect();
    const cx = w.left + w.width / 2;
    const cy = w.top + w.height / 2;
    return [...document.querySelectorAll(`${sel} g[role='button']`)].map((g, i) => {
      const r = g.getBoundingClientRect();
      const d = Math.max(Math.abs(r.left + r.width / 2 - cx) / (w.width / 2), Math.abs(r.top + r.height / 2 - cy) / (w.height / 2));
      return { i, d, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }).filter(m => m.d >= lo && m.d <= hi);
  }, [WRAP, lo, hi]);
  // A marker whose whole box sits inside the map's rectangle shrunk by 15% of its width (the view's edge zone is 10%), off the middle.
  const inSight = page => page.evaluate(sel => {
    const w = document.querySelector(sel).getBoundingClientRect();
    const e = w.width * 0.15;
    return [...document.querySelectorAll(`${sel} g[role='button']`)].findIndex((g) => {
      const r = g.getBoundingClientRect();
      return r.left >= w.left + e && r.right <= w.right - e && r.top >= w.top + e && r.bottom <= w.bottom - e
        && Math.abs(r.left + r.width / 2 - w.left - w.width / 2) > 20;
    });
  }, WRAP);
  const firstMarkerThenTab = async page => {
    await page.locator(MARKER).first().focus();
    await page.keyboard.press('Tab');
  };

  // Every map of the tier: the borderlands draw bigger markers against a smaller view than the eternal one.
  for (const tab of [0, 1, 2, 3]) {
    test(`Tab to a marker out of sight or cut by the edge brings it whole into the map, map ${tab + 1}`, async ({ page, wvw }) => {
      await boardOpen(page, wvw);
      await page.locator(`${POP} .wvw-tab`).nth(tab).click();
      await expect(page.locator(`${POP} .wvw-tab`).nth(tab)).toHaveClass(/is-active/);
      const full = await state(page);
      await firstMarkerThenTab(page);
      expect((await state(page)).box, 'no zoom: the view stays').toBe(full.box);

      await zoom3(page);
      await page.locator(MARKER).first().focus();
      const start = await state(page);
      const [fx, fy, fw, fh] = full.box.split(' ').map(Number);
      let moved = 0;
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        if (!await page.evaluate(() => !!document.activeElement?.matches("g[role='button']"))) break;
        const now = await state(page);
        const [x, y, w, h] = now.box.split(' ').map(Number);
        // A marker on the rim of the map is cut by the rim itself: only where the view is stopped by the map's edge.
        const rim = [x <= fx + 1e-6, x + w >= fx + fw - 1e-6, y <= fy + 1e-6, y + h >= fy + fh - 1e-6];
        const cut = await cuts(page);
        expect(cut.map((c, k) => c && !rim[k]), 'the focused marker is whole inside the map').toEqual([false, false, false, false]);
        expect([x >= fx - 1e-6, y >= fy - 1e-6, x + w <= fx + fw + 1e-6, y + h <= fy + fh + 1e-6], 'the view stays on the map').toEqual([true, true, true, true]);
        expect(now.scroll, 'the wrap is not scrolled').toBe(0);
        expect(now.page, 'the page does not jump').toBe(start.page);
        if (now.box !== start.box) moved++;
      }
      expect(moved, 'some marker was out of sight and the view followed').toBeGreaterThan(0);
    });
  }

  test('the window getting its focus back does not pull the view to the marker still focused', async ({ page, wvw }) => {
    await boardOpen(page, wvw);
    await zoom3(page);
    await firstMarkerThenTab(page);
    // Drag the focused marker towards the edge: it stays focused, the view moves away from it.
    const m = (await band(page, 0, 0.2))[0];
    const half = await page.locator(WRAP).evaluate(w => w.getBoundingClientRect().width / 2);
    await page.mouse.move(m.x, m.y);
    await page.mouse.down();
    await page.mouse.move(m.x + half * 0.4, m.y, { steps: 5 });
    await page.mouse.move(m.x + half * 0.9, m.y, { steps: 5 });
    await page.mouse.up();
    const panned = (await state(page)).box;
    expect(await page.evaluate(() => document.activeElement.matches("g[role='button']")), 'still focused').toBe(true);
    // What Chromium does on regaining the window's focus: focusin on the element that still holds it.
    await page.evaluate(() => document.activeElement.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect((await state(page)).box).toBe(panned);
  });

  test('a marker already in sight does not move the view', async ({ page, wvw }) => {
    await boardOpen(page, wvw);
    await zoom3(page);
    await firstMarkerThenTab(page);
    await page.locator(`${POP} .wvw-zoom button[aria-label='Zoom out']`).click();
    const seen = await inSight(page);
    expect(seen, 'a marker in sight, off the middle').toBeGreaterThanOrEqual(0);
    const before = await state(page);
    await page.keyboard.press('Shift');
    await page.evaluate(([sel, i]) => document.querySelectorAll(`${sel} g[role='button']`)[i].focus(), [WRAP, seen]);
    expect((await state(page)).box).toBe(before.box);
  });

  test('a drag from a marker and a click on it, against the edge, do not move the view; the keyboard does', async ({ page, wvw }) => {
    await boardOpen(page, wvw);
    await zoom3(page);
    await firstMarkerThenTab(page);
    const start = (await state(page)).box;
    // Drag the centred marker towards the map's right edge: the view moves and the marker ends whole in the view, but inside the edge zone.
    const m = (await band(page, 0, 0.2))[0];
    expect(m, 'the centred marker').toBeTruthy();
    const half = await page.locator(WRAP).evaluate(w => w.getBoundingClientRect().width / 2);
    await page.mouse.move(m.x, m.y);
    await page.mouse.down();
    await page.mouse.move(m.x + half * 0.3, m.y, { steps: 5 });
    await page.mouse.move(m.x + half * 0.7, m.y, { steps: 5 });
    await page.mouse.up();
    const dragged = (await state(page)).box;
    expect(dragged, 'the drag moved the view').not.toBe(start);
    await page.evaluate(() => document.activeElement.blur());
    const edge = (await band(page, 0.6, 0.85)).find(c => c.i === m.i);
    expect(edge, 'a marker against the edge').toBeTruthy();
    await page.mouse.click(edge.x, edge.y);
    expect((await state(page)).box, 'neither the drag nor the click follows the focus').toBe(dragged);
    // The same marker, focused by a script after a key (the keyboard's :focus-visible), is brought in from the edge.
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Shift');
    await page.evaluate(([sel, i]) => document.querySelectorAll(`${sel} g[role='button']`)[i].focus(), [WRAP, edge.i]);
    expect((await state(page)).box, 'a keyboard focus brings a marker against the edge in').not.toBe(dragged);
  });
});
