// Dragging the map: one pointer slides the picture already drawn (a transform on the svg) and the viewBox is
// set on release, or mid-drag when the margin painted past the box runs out; two fingers pinch from the
// settled picture, and the finger a pinch leaves slides again. Every gesture ends with the ground grabbed still
// under the finger, and a pinch zoomed about the middle of the two fingers.
import { test, expect } from './support/fixtures.mjs';
import { load, firstTier, openMap } from './support/steps.mjs';

const POP = '.info-popover';

async function map(page, wvw) {
  await load(page, wvw);
  await openMap(page, wvw, (await firstTier(page)).button);
}

// Touch pointers dispatched on what lies under them, as a finger's would be. Installed once per page as
// window.fingers; each step returns the viewBox (rounded) and whether a transform is on the svg.
const install = page => page.evaluate(() => {
  const wrap = document.querySelector('.info-popover .wvw-plot-wrap');
  const svg = wrap.querySelector('svg');
  const ev = (type, id, x, y, primary) => {
    const hit = document.elementFromPoint(x, y);
    const t = hit && wrap.contains(hit) && !hit.closest('.wvw-marker, .wvw-zoom, .wvw-hud, .wvw-hud-note') ? hit : svg;
    t.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', isPrimary: primary, bubbles: true, cancelable: true, composed: true }));
  };
  const pos = {};
  const prim = {};
  const tick = () => new Promise(ok => setTimeout(ok, 0));
  const r = wrap.getBoundingClientRect();
  window.fingers = {
    cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height,
    state: () => ({ vb: svg.getAttribute('viewBox').split(/[ ,]+/).map(n => Math.round(+n)).join(' '), moved: !!svg.style.transform }),
    down: (id, x, y, p) => { pos[id] = [x, y]; prim[id] = p; ev('pointerdown', id, x, y, p); },
    move: async (moves, steps = 8, each) => {
      const from = Object.fromEntries(Object.keys(moves).map(id => [id, pos[id]]));
      for (let s = 1; s <= steps; s++) {
        for (const [id, [tx, ty]] of Object.entries(moves)) {
          const [fx, fy] = from[id];
          pos[id] = [fx + (tx - fx) * s / steps, fy + (ty - fy) * s / steps];
          ev('pointermove', +id, pos[id][0], pos[id][1], prim[id]);
        }
        if (each) each(s);
        await tick();
      }
    },
    up: id => { ev('pointerup', id, pos[id][0], pos[id][1], prim[id]); delete pos[id]; },
  };
});

const zoomIn = async (page, n) => {
  for (let i = 0; i < n; i++) await page.locator(`${POP} .wvw-zoom button[aria-label="Zoom in"]`).click();
};

test.describe('a finger drag', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('slides the drawn map while it moves and sets the viewBox under the finger on release', async ({ page, wvw }) => {
    // A short window: the svg is wider than the map it draws, and `meet` leaves a band each side.
    await page.setViewportSize({ width: 1280, height: 600 });
    await map(page, wvw);
    await zoomIn(page, 3);
    await install(page);
    const r = await page.evaluate(async () => {
      const f = window.fingers;
      const svg = document.querySelector('.info-popover .wvw-plot');
      const ground = (x, y) => { const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse()); return [p.x, p.y]; };
      const screen = ([x, y]) => { const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()); return [p.x, p.y]; };
      const box = svg.getBoundingClientRect();
      // The bands `meet` leaves beside the drawn map show the ground past the view, parked: the slide must
      // paint them too, and the strip it uncovers at the edge.
      const m = svg.getScreenCTM();
      const band = { left: m.e + m.a * svg.viewBox.baseVal.x - box.left, top: m.f + m.d * svg.viewBox.baseVal.y - box.top };
      // How far past the parked box the sliding svg leaves no paint: its moved box grown by its clip-path.
      const unpainted = () => {
        const b = svg.getBoundingClientRect();
        const c = getComputedStyle(svg).clipPath;
        const v = c === 'none' ? [-1e5] : c.match(/-?[\d.]+(?=px)|\b0(?=\W)/g).map(Number);
        // Overflow not visible clips the svg at its own box as well.
        const own = getComputedStyle(svg).overflow === 'visible' ? -Infinity : 0;
        const [t, rt = t, bt = t, l = rt] = v.map(n => Math.max(n, own));
        return Math.max(0, (b.left + l) - box.left, box.right - (b.right - rt), (b.top + t) - box.top, box.bottom - (b.bottom - bt));
      };
      const mark = [...svg.querySelectorAll('.wvw-marker')].find(g => { const b = g.getBoundingClientRect(); return Math.abs(b.left - f.cx) < 150 && Math.abs(b.top - f.cy) < 150; });
      const at = () => { const b = mark.getBoundingClientRect(); return [b.left, b.top]; };
      const before = f.state();
      const grabbed = ground(f.cx, f.cy);
      const to = [f.cx + 70.3, f.cy - 40.4];
      f.down(1, f.cx, f.cy, true);
      await f.move({ 1: to });
      const mid = f.state();
      const gap = unpainted();
      const shift = svg.style.transform;
      const held = at();
      f.up(1);
      const placed = at();
      return { before, mid, after: f.state(), style: svg.getAttribute('style'), cls: svg.getAttribute('class'), at: screen(grabbed), to,
        band, gap, shift, jump: Math.abs(placed[0] - held[0]) + Math.abs(placed[1] - held[1]) };
    });
    expect(Math.max(r.band.left, r.band.top), 'a band beside the map at this size').toBeGreaterThan(2);
    expect(r.gap, 'px of the map\'s box the sliding svg leaves unpainted').toBe(0);
    expect(r.shift, 'the slide in whole pixels').toMatch(/^translate\(-?\d+px, -?\d+px\)$/);
    expect(r.jump, 'px a marker moves when the finger lifts').toBeLessThanOrEqual(0.02);
    expect(r.mid.vb, 'the viewBox while the finger moves').toBe(r.before.vb);
    expect(r.mid.moved, 'a transform on the svg while the finger moves').toBe(true);
    expect(r.after.vb, 'the viewBox after the release').not.toBe(r.before.vb);
    expect(r.after.moved, 'no transform after the release').toBe(false);
    expect(r.style, 'no style left on the svg').toBeNull();
    expect(r.cls, 'the sliding class gone').not.toContain('is-sliding');
    expect(Math.abs(r.at[0] - r.to[0]) + Math.abs(r.at[1] - r.to[1]), 'the grabbed ground under the finger').toBeLessThanOrEqual(1);
    await wvw.settle();
  });

  test('a long drag sets the viewBox once mid-way, and the map never jumps from under the finger', async ({ page, wvw }) => {
    await map(page, wvw);
    await zoomIn(page, 3);
    await install(page);
    const r = await page.evaluate(async () => {
      const f = window.fingers;
      const svg = document.querySelector('.info-popover .wvw-plot');
      const marks = [...svg.querySelectorAll('.wvw-marker')];
      const centre = m => { const b = m.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; };
      // The marker nearest the middle: it travels with the finger.
      const mark = marks.sort((a, b) => Math.hypot(...centre(a).map((v, i) => v - [f.cx, f.cy][i])) - Math.hypot(...centre(b).map((v, i) => v - [f.cx, f.cy][i])))[0];
      const start = centre(mark);
      const dx = -0.6 * f.w;
      const steps = [];
      f.down(1, f.cx, f.cy, true);
      await f.move({ 1: [f.cx + dx, f.cy] }, 24, s => {
        const c = centre(mark);
        steps.push({ ...f.state(), off: Math.abs(c[0] - start[0] - dx * s / 24) + Math.abs(c[1] - start[1]) });
      });
      const first = steps[0].vb;
      f.up(1);
      const c = centre(mark);
      return { steps, first, after: f.state(), end: Math.abs(c[0] - start[0] - dx) + Math.abs(c[1] - start[1]) };
    });
    const sets = r.steps.filter((s, i) => i && s.vb !== r.steps[i - 1].vb).length;
    expect(sets, `viewBox changes while the finger moves (${r.steps.map(s => s.vb).join(' | ')})`).toBe(1);
    expect(r.steps.every(s => s.moved || s.vb !== r.first), 'a transform on every step that has not set the viewBox').toBe(true);
    expect(Math.max(...r.steps.map(s => s.off)), 'px the marker strays from the finger').toBeLessThanOrEqual(1);
    expect(r.after.moved, 'no transform after the release').toBe(false);
    expect(r.end, 'px the marker strays after the release').toBeLessThanOrEqual(1);
    await wvw.settle();
  });
});

// The viewBox after each gesture, rounded to whole units: the grabbed ground under the finger, a pinch about the
// middle of the fingers.
const GESTURES = {
  390: ['10088 13927 880 855', '9904 13795 880 855', '9719 13901 880 855', '9497 13544 1614 1567', '9787 13400 1614 1567'],
  1280: ['10088 13927 880 855', '9986 13854 880 855', '9884 13912 880 855', '9597 13556 1614 1567', '9757 13476 1614 1567'],
};
for (const width of [390, 1280]) {
  test.describe(`pinch and drag at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });
    test('a pinch, its finger left dragging, a drag, a drag joined by a second finger: each ends with the grabbed ground under the finger', async ({ page, wvw }) => {
      await map(page, wvw);
      await install(page);
      const r = await page.evaluate(async () => {
        const f = window.fingers;
        const { cx, cy } = f;
        const out = {};
        f.down(1, cx - 30, cy, true); f.down(2, cx + 30, cy, false);
        await f.move({ 1: [cx - 110, cy], 2: [cx + 110, cy] });
        out.pinch = f.state();
        f.up(2);
        await f.move({ 1: [cx - 40, cy + 50] });
        out.leftMid = f.state();
        f.up(1);
        out.left = f.state();
        f.down(3, cx, cy, true);
        await f.move({ 3: [cx + 70, cy - 40] });
        out.dragMid = f.state();
        f.up(3);
        out.drag = f.state();
        f.down(4, cx, cy, true);
        await f.move({ 4: [cx - 50, cy] });
        f.down(5, cx + 60, cy, false);
        await f.move({ 4: [cx - 30, cy], 5: [cx + 30, cy] });
        out.pinchMid = f.state();
        f.up(4); f.up(5);
        out.dragPinch = f.state();
        f.down(6, cx, cy, true);
        await f.move({ 6: [cx - 60, cy + 30] });
        f.up(6);
        out.drag2 = f.state();
        return out;
      });
      expect([r.pinch, r.left, r.drag, r.dragPinch, r.drag2].map(s => s.vb), 'the viewBox after each gesture').toEqual(GESTURES[width]);
      expect(r.pinch.moved, 'a pinch draws each move: no transform').toBe(false);
      expect(r.leftMid.moved, 'the finger a pinch leaves slides the map').toBe(true);
      expect(r.leftMid.vb, 'and leaves the viewBox where the pinch set it').toBe(r.pinch.vb);
      expect(r.dragMid.moved, 'a drag slides the map').toBe(true);
      expect(r.pinchMid.moved, 'a second finger settles the slide: the pinch draws').toBe(false);
      for (const k of ['left', 'drag', 'dragPinch', 'drag2']) expect(r[k].moved, `${k}: no transform after the release`).toBe(false);
      await wvw.settle();
    });
  });
}
