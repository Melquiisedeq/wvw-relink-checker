// LAB (never merged). Two prototypes on the preview, judged on the owner's phone:
//   1. "Map drag": Today redraws the map on every move (the viewBox changes); New slides the map
//      already drawn (a transform on the <svg>, painted past its box) and sets the viewBox once, on release.
//   2. "Frame counter": frames per second and the worst frame, on screen, and a "Measure" run
//      that steps through a few states by itself and writes a table to copy.
// Hooks: js/maps.js calls labMapPan() once per map (one line). Loaded just before js/boot.js.
// Everything the page shows goes through textContent. No request leaves the page.

const LAB_KEY = 'wvw-lab-v1';
const LAB_VERSION = 12;          // bump when the defaults change: older saved choices are dropped
const LAB_ITEMS = [
  { type: 'section', label: 'Map drag' },
  { type: 'radio', key: 'drag', label: 'Drag the map', options: { today: 'Today', new: 'New' }, value: 'today' },
  { type: 'note', label: 'New moves the map already drawn while you drag, and redraws it once when you let go.' },
  { type: 'section', label: 'Frame counter' },
  { type: 'check', key: 'fps', label: 'Show the frame counter', on: false },
  { type: 'button', label: 'Measure', run: () => labMeasure() },
  { type: 'note', label: 'Measure takes about 40 s and changes the screen by itself. The numbers are for this device only.' },
  { type: 'result' },
];

function labRepaint() { labFpsShow(!!labPrefs.fps || labMeasuring); }

const labEl = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function labReadPrefs() {
  const p = { open: false };
  for (const it of LAB_ITEMS) if ('key' in it) p[it.key] = it.type === 'check' ? !!it.on : it.value;
  try {
    const v = JSON.parse(localStorage.getItem(LAB_KEY) || 'null');
    if (!v || v.v !== LAB_VERSION) return p;
    if (typeof v.open === 'boolean') p.open = v.open;
    for (const it of LAB_ITEMS) {
      if (it.type === 'check' && typeof v[it.key] === 'boolean') p[it.key] = v[it.key];
      if (it.type === 'radio' && Object.prototype.hasOwnProperty.call(it.options, v[it.key])) p[it.key] = v[it.key];
    }
  } catch { /* storage off or corrupt: the defaults */ }
  return p;
}
const labPrefs = labReadPrefs();
function labSave() {
  try { localStorage.setItem(LAB_KEY, JSON.stringify({ v: LAB_VERSION, ...labPrefs })); } catch { /* fine */ }
}
function labChanged() { labSave(); labPaintPanel(); labRepaint(); }

let labPanel = null;
function labStatus(text) {
  const s = labPanel && labPanel.querySelector('.lab-status');
  if (s) s.textContent = text;
}

function labBuildPanel() {
  const root = labEl('div', 'lab-panel');
  root.addEventListener('click', (e) => e.stopPropagation());
  const toggle = labEl('button', 'lab-toggle', 'Lab');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', 'lab-body');
  toggle.addEventListener('click', () => { labPrefs.open = !labPrefs.open; labChanged(); });
  const body = labEl('div', 'lab-body');
  body.id = 'lab-body';
  const head = labEl('div', 'lab-head');
  head.append(labEl('strong', null, 'Lab'), labEl('span', 'lab-muted', ' · prototypes, preview only'));
  body.appendChild(head);
  for (const it of LAB_ITEMS) {
    if (it.type === 'section') body.appendChild(labEl('div', 'lab-section', it.label));
    if (it.type === 'note') body.appendChild(labEl('p', 'lab-note', it.label));
    if (it.type === 'button') {
      const b = labEl('button', 'lab-btn', it.label);
      b.type = 'button';
      b.addEventListener('click', it.run);
      body.appendChild(b);
    }
    if (it.type === 'check') {
      const l = labEl('label', 'lab-check');
      const c = labEl('input');
      c.type = 'checkbox';
      c.dataset.toggle = it.key;
      c.addEventListener('change', () => { labPrefs[it.key] = c.checked; labChanged(); });
      l.append(c, ` ${it.label}`);
      body.appendChild(l);
    }
    if (it.type === 'radio') {
      const fs = labEl('fieldset', 'lab-radios');
      fs.appendChild(labEl('legend', 'lab-sr-legend', it.label));
      for (const [k, text] of Object.entries(it.options)) {
        const rl = labEl('label');
        const r = labEl('input');
        r.type = 'radio';
        r.name = `lab-${it.key}`;
        r.value = k;
        r.addEventListener('change', () => { if (r.checked) { labPrefs[it.key] = k; labChanged(); } });
        rl.append(r, ` ${text}`);
        fs.appendChild(rl);
      }
      body.appendChild(fs);
    }
    if (it.type === 'result') {
      const box = labEl('div', 'lab-result');
      box.hidden = true;
      const pre = labEl('pre', 'lab-table');
      const copy = labEl('button', 'lab-btn', 'Copy');
      copy.type = 'button';
      copy.addEventListener('click', () => labCopy(pre));
      box.append(pre, copy);
      body.appendChild(box);
    }
  }
  const status = labEl('p', 'lab-status');
  status.setAttribute('role', 'status');
  body.appendChild(status);
  root.append(body, toggle);
  document.body.appendChild(root);
  return root;
}

function labPaintPanel() {
  if (!labPanel) return;
  const body = labPanel.querySelector('.lab-body');
  const toggle = labPanel.querySelector('.lab-toggle');
  body.hidden = !labPrefs.open;
  toggle.setAttribute('aria-expanded', labPrefs.open ? 'true' : 'false');
  toggle.textContent = labPrefs.open ? 'Lab ×' : 'Lab';
  for (const c of body.querySelectorAll('input[data-toggle]')) c.checked = !!labPrefs[c.dataset.toggle];
  for (const r of body.querySelectorAll('input[type=radio]')) r.checked = labPrefs[r.name.slice(4)] === r.value;
}

// ---- 1. Map drag ---------------------------------------------------------
// labMapPan gets the map's own camera from js/maps.js: the same `view` object its handlers move, and
// its apply()/clamp(). In New, the lab's capture-phase listeners run before the site's and take the
// pointermove: `view` moves exactly as the site would move it, but the picture slides by a transform
// and the viewBox waits for the release (or for a margin to run out, in the 'margin' form).
// 'whole': the svg paints everything past its box (overflow visible), the wrap clips it, the
//          compositor rasters the tiles the drag brings into view.
// 'margin' (the default; at full zoom it rastered and painted half what 'whole' did): the same, clipped to
//          LAB_MARGIN of the box on each side; past it, one redraw mid-drag.
let labDragForm = 'margin';
const LAB_MARGIN = 0.5;
const labMaps = [];

function labMapPan(m) {
  const { wrap, svg, view } = m;
  m.pan = null;
  labMaps.push(m);
  const skip = (t) => t.closest('.wvw-marker, .wvw-zoom, .wvw-hud, .wvw-hud-note');
  // Every pointer down on the map, with where it last was: the lab slides the picture for one finger only,
  // and the site's pinch needs the true position of a finger whose moves the lab kept from it.
  const ptrs = new Map();
  let resyncing = false;
  const begin = (id, x, y) => {
    const r = svg.getBoundingClientRect();
    m.pan = {
      id,
      r,
      at: { x: view.x + ((x - r.left) / r.width) * view.w, y: view.y + ((y - r.top) / r.height) * view.h },
      live: false,
    };
  };
  wrap.addEventListener('pointerdown', (e) => {
    if (e.isPrimary) for (const [id, p] of ptrs) if (p.type === e.pointerType) ptrs.delete(id);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, held: false });
    // A second finger: the site re-anchors on the untransformed map, so the picture is settled first.
    if (m.pan) labPanCommit(m);
    if (ptrs.size > 1) {
      // The site's pinch starts from where it last saw each finger: give it the moves the lab held back.
      resyncing = true;
      for (const [id, p] of ptrs) {
        if (id === e.pointerId || !p.held) continue;
        p.held = false;
        wrap.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, clientX: p.x, clientY: p.y, pointerType: p.type, isPrimary: true, bubbles: true }));
      }
      resyncing = false;
      return;
    }
    if (labPrefs.drag !== 'new' || skip(e.target)) return;
    begin(e.pointerId, e.clientX, e.clientY);
  }, true);
  wrap.addEventListener('pointermove', (e) => {
    if (resyncing) return;
    const p = ptrs.get(e.pointerId);
    if (p) { p.x = e.clientX; p.y = e.clientY; }
    if (!m.pan || !m.pan.at || e.pointerId !== m.pan.id || ptrs.size !== 1) return;
    if (p) p.held = true;
    e.stopImmediatePropagation();
    // The trebuchet aims at the mouse from a window listener this stop would starve.
    if (e.pointerType !== 'touch') window.dispatchEvent(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY, pointerType: e.pointerType }));
    const r = m.pan.r;
    view.x = m.pan.at.x - ((e.clientX - r.left) / r.width) * view.w;
    view.y = m.pan.at.y - ((e.clientY - r.top) / r.height) * view.h;
    m.clamp();
    labPanShow(m);
  }, true);
  const end = (e) => {
    ptrs.delete(e.pointerId);
    if (m.pan) labPanCommit(m);
    // One finger left of a pinch drags on: the lab slides the picture for it from here.
    if (ptrs.size === 1 && labPrefs.drag === 'new') {
      const [[id, p]] = [...ptrs];
      p.held = false;
      begin(id, p.x, p.y);
    }
  };
  wrap.addEventListener('pointerup', end, true);
  wrap.addEventListener('pointercancel', end, true);
  // A zoom mid-drag changes the viewBox through the site's own apply(): the transform must follow it.
  wrap.addEventListener('wheel', () => { if (m.pan && m.pan.live) labPanCommit(m, true); }, { capture: true, passive: true });
  // So does a data refresh (applyLive calls apply()): recompute the offset before the frame is drawn.
  new MutationObserver(() => { if (m.pan && m.pan.live) labPanShow(m); })
    .observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
}

// The picture as drawn (viewBox) against where `view` now is: the difference, in CSS pixels.
function labPanShow(m) {
  const { svg, view } = m;
  const vb = svg.viewBox.baseVal;
  const r = m.pan.r;
  // The picture's scale and, when the box is wider or taller than the map (max-height:70vh), the empty
  // bands beside it: preserveAspectRatio centres the map, and those bands must stay empty while it slides.
  const fit = Math.min(r.width / vb.width, r.height / vb.height);
  const bx = (r.width - vb.width * fit) / 2;
  const by = (r.height - vb.height * fit) / 2;
  // Without bands, each axis's own ratio: the ones the site's handler uses, so the release matches Today.
  const banded = bx > 0.5 || by > 0.5;
  const kx = banded ? fit : r.width / vb.width;
  const ky = banded ? fit : r.height / vb.height;
  // Whole device pixels, so the layer is never resampled between two; `view` is nudged to match, so the
  // release lands exactly where the picture already is.
  const dpr = window.devicePixelRatio || 1;
  let px = Math.round((vb.x - view.x) * kx * dpr) / dpr;
  let py = Math.round((vb.y - view.y) * ky * dpr) / dpr;
  view.x = vb.x - px / kx;
  view.y = vb.y - py / ky;
  if (!m.pan.live) {
    if (!px && !py) return;   // nothing moved (the whole map in view, or a still finger): no layer
    m.pan.live = true;
    svg.classList.add('lab-pan-live');
    m.pan.redraws = 0;
  }
  const mx = r.width * LAB_MARGIN;
  const my = r.height * LAB_MARGIN;
  if (labDragForm === 'margin' && (Math.abs(px) > mx * 0.9 || Math.abs(py) > my * 0.9)) {
    m.apply();
    m.pan.redraws++;
    px = 0; py = 0;
  }
  if (banded || labDragForm === 'margin') {
    const floorX = labDragForm === 'margin' ? -mx : -Infinity;
    const floorY = labDragForm === 'margin' ? -my : -Infinity;
    const side = (band, shift, floor) => (band > 0.5 ? band + shift : Math.max(floor, -1e5));
    const t = Math.max(floorY, side(by, -py, floorY));
    const b = Math.max(floorY, side(by, py, floorY));
    const l = Math.max(floorX, side(bx, -px, floorX));
    const rr = Math.max(floorX, side(bx, px, floorX));
    svg.style.clipPath = `inset(${t}px ${rr}px ${b}px ${l}px)`;
  }
  svg.style.transform = `translate(${px}px, ${py}px)`;
}

// Settle: the viewBox where the picture already is, the transform gone, in one task (one frame).
function labPanCommit(m, keep) {
  const { svg } = m;
  if (m.pan && m.pan.live) {
    m.apply();
    svg.style.transform = '';
    svg.style.clipPath = '';
    if (!svg.getAttribute('style')) svg.removeAttribute('style');
    svg.classList.remove('lab-pan-live');
    m.pan.live = false;
  }
  if (!keep) m.pan = null;
  else m.pan.r = svg.getBoundingClientRect();
}

function labSetDrag(mode) { labPrefs.drag = mode === 'new' ? 'new' : 'today'; labChanged(); }

// ---- 2. Frame counter ------------------------------------------------------
// From requestAnimationFrame stamps. "Normal" is this screen's own interval (60, 90, 120 Hz...): the 10th
// percentile of the recent ones; a long frame is one over 1.5 times it.
const labFrames = { t: [], last: 0, raf: 0, box: null, shown: false, tick: 0 };
function labFpsLoop(now) {
  if (labFrames.last) labFrames.t.push([now, now - labFrames.last]);
  labFrames.last = now;
  while (labFrames.t.length && now - labFrames.t[0][0] > 10000) labFrames.t.shift();
  if (labFrames.box && now - labFrames.tick > 500) { labFrames.tick = now; labFrames.box.textContent = labFpsText(labFpsStats(2000, now)); }
  labFrames.raf = requestAnimationFrame(labFpsLoop);
}
function labFpsRun(on) {
  if (on && !labFrames.raf) { labFrames.last = 0; labFrames.raf = requestAnimationFrame(labFpsLoop); }
  if (!on && labFrames.raf) { cancelAnimationFrame(labFrames.raf); labFrames.raf = 0; labFrames.t.length = 0; }
}
function labNormal() {
  const d = labFrames.t.map((x) => x[1]).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length * 0.1)] : 16.7;
}
function labFpsStats(ms, now, from) {
  const end = now || performance.now();
  const start = from || end - ms;
  const ds = labFrames.t.filter((x) => x[0] > start && x[0] <= end).map((x) => x[1]);
  const normal = labNormal();
  const span = ds.reduce((s, d) => s + d, 0) || 1;
  return {
    fps: ds.length ? Math.round((ds.length * 1000) / span) : 0,
    worst: ds.length ? Math.round(Math.max(...ds)) : 0,
    long: ds.filter((d) => d > normal * 1.5).length,
    frames: ds.length,
    normal,
  };
}
const labFpsText = (s) => `${s.fps} fps · worst ${s.worst} ms`;
function labFpsShow(on) {
  labFpsRun(on);
  if (on && !labFrames.box) {
    labFrames.box = labEl('div', 'lab-fps', '…');
    labFrames.box.setAttribute('aria-hidden', 'true');
    document.body.appendChild(labFrames.box);
  }
  if (labFrames.box) labFrames.box.hidden = !(labPrefs.fps || labMeasuring);
}

// ---- Measure ---------------------------------------------------------------
let labMeasuring = false;
const labWait = (ms) => new Promise((r) => setTimeout(r, ms));
const LAB_SETTLE_MS = 1000;
const LAB_STATE_MS = 4000;

function labOpenMap() {
  return labMaps.filter((m) => m.wrap.isConnected && m.wrap.getClientRects().length).pop() || null;
}
async function labEnsureMap() {
  if (labOpenMap()) return labOpenMap();
  const btn = document.querySelector('.tier-map-btn');
  if (!btn) return null;
  btn.click();
  for (let i = 0; i < 50 && !labOpenMap(); i++) await labWait(200);
  return labOpenMap();
}

// The lab's own drag: the view swings round an ellipse, as a finger would move it, for `ms`.
function labSwing(m, mode, ms) {
  return new Promise((done) => {
    const { view } = m;
    const span = { x: (m.fullW - view.w) * 0.35, y: (m.fullH - view.h) * 0.35 };
    const c = { x: m.minX + (m.fullW - view.w) / 2, y: m.minY + (m.fullH - view.h) / 2 };
    if (mode === 'new') m.pan = { r: m.svg.getBoundingClientRect(), at: null, live: false };
    const t0 = performance.now();
    const step = (now) => {
      const a = ((now - t0) / 1500) * Math.PI * 2;
      view.x = c.x + span.x * Math.sin(a);
      view.y = c.y + span.y * Math.sin(a * 0.5);
      m.clamp();
      if (mode === 'new') labPanShow(m); else m.apply();
      if (now - t0 < ms) requestAnimationFrame(step);
      else { if (mode === 'new') labPanCommit(m); done(); }
    };
    requestAnimationFrame(step);
  });
}

const LAB_STATES = [
  { name: 'page', label: '1 page as it is' },
  { name: 'noblur', label: '2 page, cards not blurred', cls: 'lab-m-cards' },
  { name: 'map', label: '3 map open, still', map: true },
  { name: 'noveil', label: '4 map, backdrop not blurred', map: true, cls: 'lab-m-veil' },
  { name: 'noshadow', label: '5 map, no blur, no shadow', map: true, cls: 'lab-m-veil lab-m-shadow' },
  { name: 'today', label: '6 map drag: Today', map: true, drag: 'today' },
  { name: 'new', label: '7 map drag: New', map: true, drag: 'new' },
];

async function labMeasure() {
  if (labMeasuring) return;
  labMeasuring = true;
  labRepaint();
  const box = labPanel.querySelector('.lab-result');
  box.hidden = true;
  const html = document.documentElement;
  const rows = [];
  let saved = null;
  let m = null;
  try {
    if (labOpenMap() && typeof closePopover === 'function') closePopover();
    await labWait(LAB_SETTLE_MS);
    for (const st of LAB_STATES) {
      labStatus(`Measuring ${st.label}…`);
      if (st.map && !m) {
        m = await labEnsureMap();
        if (!m) { rows.push([st.label, 'no map: open one first']); break; }
        saved = { x: m.view.x, y: m.view.y, w: m.view.w, h: m.view.h };
      }
      if (st.drag && m.view.w > m.fullW * 0.6) {
        m.view.w = m.fullW * 0.5; m.view.h = m.fullH * 0.5;
        m.clamp(); m.apply();
      }
      if (st.cls) html.classList.add(...st.cls.split(' '));
      await labWait(LAB_SETTLE_MS);
      const from = performance.now();
      if (st.drag) await labSwing(m, st.drag, LAB_STATE_MS);
      else await labWait(LAB_STATE_MS);
      const s = labFpsStats(0, performance.now(), from);
      rows.push([st.label, s]);
      if (st.cls) html.classList.remove(...st.cls.split(' '));
    }
  } catch (err) {
    rows.push(['stopped', String(err && err.message || err).slice(0, 80)]);
  } finally {
    html.classList.remove('lab-m-cards', 'lab-m-veil', 'lab-m-shadow');
    if (m && saved && m.wrap.isConnected) { Object.assign(m.view, saved); m.apply(); }
    labMeasuring = false;
    labRepaint();
  }
  const pre = box.querySelector('.lab-table');
  pre.textContent = labTable(rows);
  box.hidden = false;
  labStatus('Done. Tap Copy and paste it in the chat.');
}

function labTable(rows) {
  const ua = navigator.userAgent
    .replace(/^Mozilla\/5\.0 /, '').replace(/AppleWebKit\/[\d.]+ \(KHTML, like Gecko\) ?/, '')
    .replace(/\s+/g, ' ').trim().slice(0, 140);
  const dpr = Math.round((window.devicePixelRatio || 1) * 100) / 100;
  const normal = labNormal();
  const lines = [
    'wvwrelink lab: frame test',
    `device: ${ua}`,
    `screen ${screen.width}x${screen.height} @${dpr}x, window ${window.innerWidth}x${window.innerHeight}`,
    `normal frame ${normal.toFixed(1)} ms (~${Math.round(1000 / normal)} Hz); long = over ${(normal * 1.5).toFixed(0)} ms`,
    '',
    `${'state'.padEnd(29)}${'fps'.padStart(4)}${'worst'.padStart(7)}${'long'.padStart(6)}`,
  ];
  for (const [label, s] of rows) {
    if (typeof s === 'string') { lines.push(`${label.padEnd(29)}${s}`); continue; }
    lines.push(`${label.padEnd(29)}${String(s.fps).padStart(4)}${`${s.worst}ms`.padStart(7)}${String(s.long).padStart(6)}`);
  }
  return lines.join('\n');
}

function labCopy(pre) {
  const text = pre.textContent;
  const fallback = () => {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    labStatus('Copy did not work here: the text is selected, copy it by hand.');
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => labStatus('Copied.'), fallback);
  } else fallback();
}

labPanel = labBuildPanel();
labPaintPanel();
labRepaint();
