// LAB (never merged). 61-9-0: the effects that repaint every frame, each beside a version
// that paints its glow once and animates only opacity or transform.
// Loaded just before js/boot.js. Everything the page shows goes through textContent.

const LAB_KEY = 'wvw-lab-v1';
const LAB_VERSION = 2;          // bump when the defaults change: older saved choices are dropped
const LAB_TN = { today: 'Today', new: 'New' };
// key: html.lab-<key>-new carries the choice to the CSS; run(go): the button beside it, calling
// go() when the effect starts, which starts the frame counter.
const LAB_PIECES = [
  { key: 'urgent', label: 'Relink bar, urgent (pulse)', sim: 'Simulate', run: (go) => { labRelink('urgent'); go(); }, ms: 3000 },
  { key: 'lockout', label: 'Relink bar, lockout (pulse)', sim: 'Simulate', run: (go) => { labRelink('lockout'); go(); }, ms: 3000 },
  { key: 'rings', label: 'Map rings', sim: 'Simulate', run: (go) => labSimRingsOpen(go), ms: 3000 },
  { key: 'strip', label: 'Guild found, the strip opening', sim: 'Simulate', run: (go) => { labSimGuildFound(); go(); }, ms: 3000 },
  { key: 'flash', label: 'Guild found, the card blink', sim: 'Simulate', run: (go) => { labSimGuildFound(); go(); }, ms: 3000 },
  { key: 'side', label: 'New scoreboard, the card pulse', sim: 'Simulate', run: (go) => { labSimBoard(); go(); }, ms: 3000 },
  { key: 'value', label: 'New scoreboard, the number flash', sim: 'Simulate', run: (go) => { labSimBoard(); go(); }, ms: 3000 },
];

function labRepaint() {
  const root = document.documentElement;
  for (const p of LAB_PIECES) root.classList.toggle(`lab-${p.key}-new`, labPrefs[p.key] === 'new');
  labApplyReduced();
}

const labEl = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function labReadPrefs() {
  const p = { open: false, reduced: false };
  for (const it of LAB_PIECES) p[it.key] = 'today';
  try {
    const v = JSON.parse(localStorage.getItem(LAB_KEY) || 'null');
    if (!v || v.v !== LAB_VERSION) return p;
    if (typeof v.open === 'boolean') p.open = v.open;
    if (typeof v.reduced === 'boolean') p.reduced = v.reduced;
    for (const it of LAB_PIECES) if (Object.prototype.hasOwnProperty.call(LAB_TN, v[it.key])) p[it.key] = v[it.key];
  } catch { /* storage off or corrupt: the defaults */ }
  return p;
}
const labPrefs = labReadPrefs();
function labSave() {
  try { localStorage.setItem(LAB_KEY, JSON.stringify({ v: LAB_VERSION, ...labPrefs })); } catch { /* fine */ }
}
function labChanged() { labSave(); labPaintPanel(); labRepaint(); }
function labSetAll(mode) {
  for (const p of LAB_PIECES) labPrefs[p.key] = mode;
  labChanged();
  labStatus(`Every piece: ${LAB_TN[mode]}.`);
}

let labPanel = null;
function labStatus(text) {
  const s = labPanel && labPanel.querySelector('.lab-status');
  if (s) s.textContent = text;
}

// ---- Counter: frames in the window after a Simulate, and the worst gap. Without a GPU every
// frame takes ~50 ms here; on his machine the count is what decides.
let labCountRun = 0;
function labCount(name, ms) {
  const run = ++labCountRun;
  const start = performance.now();
  let last = start, frames = 0, worst = 0;
  const loop = (t) => {
    if (run !== labCountRun) return;
    if (t - start > ms) {
      const el = labPanel && labPanel.querySelector('.lab-frames');
      if (el) el.textContent = `Last: ${name}, ${frames} frames in ${(ms / 1000).toFixed(1)} s, worst frame ${Math.round(worst)} ms.`;
      return;
    }
    frames++;
    if (t - last > worst) worst = t - last;
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
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
  head.append(labEl('strong', null, 'Lab'), labEl('span', 'lab-muted', ' · effects, preview only'));
  body.appendChild(head);
  for (const it of LAB_PIECES) {
    body.appendChild(labEl('div', 'lab-section', it.label));
    const row = labEl('div', 'lab-piece');
    const fs = labEl('fieldset', 'lab-radios');
    fs.appendChild(labEl('legend', 'lab-sr-legend', it.label));
    for (const [k, text] of Object.entries(LAB_TN)) {
      const rl = labEl('label');
      const r = labEl('input');
      r.type = 'radio';
      r.name = `lab-${it.key}`;
      r.value = k;
      r.addEventListener('change', () => { if (r.checked) { labPrefs[it.key] = k; labChanged(); } });
      rl.append(r, ` ${text}`);
      fs.appendChild(rl);
    }
    const b = labEl('button', 'lab-btn', it.sim);
    b.type = 'button';
    b.setAttribute('aria-label', `${it.sim}: ${it.label}`);
    b.addEventListener('click', () => {
      it.run(() => labCount(`${it.label} (${LAB_TN[labPrefs[it.key]]})`, it.ms));
    });
    row.append(fs, b);
    body.appendChild(row);
  }
  body.appendChild(labEl('div', 'lab-section', 'All pieces'));
  const all = labEl('div', 'lab-piece');
  for (const [k, text] of Object.entries(LAB_TN)) {
    const b = labEl('button', 'lab-btn', `All ${text}`);
    b.type = 'button';
    b.addEventListener('click', () => labSetAll(k));
    all.appendChild(b);
  }
  const back = labEl('button', 'lab-btn', 'Relink bar: back to normal');
  back.type = 'button';
  back.addEventListener('click', () => labRelinkNormal());
  body.append(all, back);
  const rl = labEl('label', 'lab-check lab-check-small');
  const rc = labEl('input');
  rc.type = 'checkbox';
  rc.dataset.toggle = 'reduced';
  rc.addEventListener('change', () => { labPrefs.reduced = rc.checked; labChanged(); });
  rl.append(rc, ' Reduce motion (as the system setting)');
  body.appendChild(rl);
  const frames = labEl('p', 'lab-frames', 'Press a Simulate: the frames it took show here.');
  frames.setAttribute('aria-live', 'polite');
  const status = labEl('p', 'lab-status');
  status.setAttribute('role', 'status');
  body.append(frames, status);
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

// ---- From the lab's efeitos.js (each site name checked with grep for this card) ----
// ---- reduced motion, emulated ---------------------------------------------------
// js/boot.js is the only script that asks: it gets an answer that also reads the
// panel's box, and hears the box change.
const LAB_REDUCED_Q = '(prefers-reduced-motion:reduce)';
const labReducedListeners = [];
const labMatchMedia = window.matchMedia.bind(window);
window.matchMedia = function (query) {
  const real = labMatchMedia(query);
  if (String(query).replace(/\s+/g, '') !== LAB_REDUCED_Q) return real;
  return {
    media: real.media,
    get matches() { return real.matches || labPrefs.reduced; },
    addEventListener(type, fn, opts) {
      if (type === 'change') labReducedListeners.push(fn);
      real.addEventListener(type, fn, opts);
    },
    removeEventListener(type, fn, opts) {
      const i = labReducedListeners.indexOf(fn);
      if (i >= 0) labReducedListeners.splice(i, 1);
      real.removeEventListener(type, fn, opts);
    },
    addListener(fn) { this.addEventListener('change', fn); },
    removeListener(fn) { this.removeEventListener('change', fn); },
  };
};
function labApplyReduced() {
  document.documentElement.classList.toggle('lab-reduced', labPrefs.reduced);
  const ev = { matches: window.matchMedia(LAB_REDUCED_Q).matches, media: '(prefers-reduced-motion: reduce)' };
  for (const fn of [...labReducedListeners]) fn(ev);
}

// ---- the simulations: the site's own functions, invented data -----------------
let labStatusEl = null;   // set once the panel exists
const labSay = (text) => { if (labStatusEl) labStatusEl.textContent = text; };
const labTimers = {};
const labLater = (key, ms, fn) => { clearTimeout(labTimers[key]); labTimers[key] = setTimeout(fn, ms); };

function labRegionMatches(prefix) {
  return [...matchDataCache.values()].filter((m) => m && typeof m.id === 'string' && m.id.startsWith(prefix));
}
const LAB_GRIDS = () => [[standingsGridNA, '1-'], [standingsGridEU, '2-']];
function labRenderReal() {
  for (const [grid, prefix] of LAB_GRIDS()) {
    const ms = labRegionMatches(prefix);
    if (ms.length) { renderStandingsRegion(grid, ms); paintGuildFound(grid, false); }
  }
}

// New scoreboard: first and second swap their victory points and everyone scores,
// rendered by the site; 10 s later the real board comes back without flashes (the
// comparison memory is put back first).
let labBoardSnap = null;
function labSimBoard() {
  if (!matchDataCache.size) { labSay('No board on the page yet.'); return; }
  if (!labBoardSnap) labBoardSnap = new Map(prevSideStats);
  const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));
  for (const [grid, prefix] of LAB_GRIDS()) {
    const fake = labRegionMatches(prefix).map((m) => {
      const c = structuredClone(m);
      if (!matchIsLive(c) || !c.victory_points) return c;
      const rank = rankMatchByVictoryPoints(c);
      const first = COLORS.find((k) => rank[k] === 1);
      const second = COLORS.find((k) => rank[k] === 2);
      const vp = c.victory_points;
      [vp[first], vp[second]] = [Number(vp[second]) || 0, Number(vp[first]) || 0];
      vp[second] += 3;
      for (const k of COLORS) if (k !== second) vp[k] = (Number(vp[k]) || 0) + (k === first ? 1 : 2);
      const last = Array.isArray(c.skirmishes) && c.skirmishes[c.skirmishes.length - 1];
      if (last && last.scores) for (const k of COLORS) last.scores[k] = (Number(last.scores[k]) || 0) + rnd(15, 140);
      return c;
    });
    if (fake.length) { renderStandingsRegion(grid, fake); paintGuildFound(grid, false); }
  }
  labSay('New scoreboard (invented), the real one back in 10 s.');
  labLater('board', 10000, () => {
    prevSideStats.clear();
    for (const [k, v] of labBoardSnap) prevSideStats.set(k, v);
    labBoardSnap = null;
    labRenderReal();
    labSay('Real scoreboard back.');
  });
}

function labSimSkeleton() {
  if (!matchDataCache.size) { labSay('No board on the page yet.'); return; }
  showStandingsSkeleton(standingsGridNA);
  showStandingsSkeleton(standingsGridEU);
  labSay('Loading skeleton for 4 s.');
  labLater('skel', 4000, () => { labRenderReal(); labSay('Scoreboard back.'); });
}

// The run's own markup for its two indicators, with what was there put back after.
let labLoaderKept = null;
function labSimLoaders() {
  if (!labLoaderKept) {
    labLoaderKept = { status: [...statusMsg.childNodes], cls: statusMsg.className,
      btn: [...runBtn.childNodes], disabled: runBtn.disabled };
  }
  const spin = document.createElement('span');
  spin.className = 'spinner';
  statusMsg.replaceChildren(spin, 'Talking to the GW2 API…');
  const pips = document.createElement('span');
  pips.className = 'btn-pips';
  pips.append(document.createElement('span'), document.createElement('span'), document.createElement('span'));
  runBtn.replaceChildren(pips);
  runBtn.disabled = true;
  labSay('Loaders for 5 s (nothing is fetched).');
  labLater('loaders', 5000, () => {
    statusMsg.replaceChildren(...labLoaderKept.status);
    statusMsg.className = labLoaderKept.cls;
    runBtn.replaceChildren(...labLoaderKept.btn);
    runBtn.disabled = labLoaderKept.disabled;
    labLoaderKept = null;
    labSay('Loaders gone.');
  });
}

function labSimGuildFound() {
  const m = labRegionMatches('1-').find(matchIsLive) || labRegionMatches('2-').find(matchIsLive);
  const teamId = m && matchTeamId(m, 'blue');
  if (!teamId) { labSay('No live tier on the page to land on.'); return; }
  showGuildFound(teamId, 'Lab Test Guild [LAB]');
  labSay('Guild found (invented name).');
}

// The run's own wind-up and finale, without the search between them.
function labSimTrebuchet() {
  sparkFromButton();
  startCharge();
  labSay('Trebuchet: the round gathers, then the crest breaks.');
  labLater('treb', 1500, playFinale);
}
function labSimEmbers() {
  spawnEmberBlast();
  labSay('Ember blast.');
}

function labSimRings() {
  const wrap = document.querySelector('.wvw-plot-wrap');
  if (!wrap || !wrap.isConnected || typeof wrap.ringChanged !== 'function' || !missedOpen) {
    labSay("Open a tier's maps first (the map button beside a tier), then press again.");
    return;
  }
  const ids = [...wrap.querySelectorAll('g[data-obj]')].map((g) => g.dataset.obj)
    .sort(() => Math.random() - .5).slice(0, 3);
  if (!ids.length) { labSay('This map has no objectives drawn yet.'); return; }
  missedRings.set(missedOpen.matchId, { ids: new Set(ids), until: Date.now() + MISSED_RING_MS });
  wrap.ringChanged();
  labSay(`Rings on ${ids.length} objectives of the open map.`);
}

// The relink bar: the timers of relink.js set to a state, drawn by updateRelinkBanner.
// The page's own refreshes put the real figures back (the matches every few minutes,
// the timers every ten).
const LAB_RELINK_VARS = () => ({ relinkNA, relinkEU, resetNA, resetEU,
  lockoutTime, timersLoaded, assignNA, assignEU, relinkState, relinkStateAt });
let labRelinkKept = null;
function labRelink(state) {
  if (!labRelinkKept) labRelinkKept = LAB_RELINK_VARS();
  const now = Date.now();
  const H = 3600000, D = 24 * H;
  timersLoaded = true;
  relinkNA = now + 4 * D; relinkEU = now + 4 * D - 8 * H;
  resetNA = now - 3 * D; resetEU = now - 3 * D - 8 * H;
  lockoutTime = now + 20 * D;
  assignNA = now + 25 * D; assignEU = now + 25 * D - 8 * H;
  if (state === 'urgent') { relinkNA = now + 90 * 60000; resetNA = now - 7 * D + 90 * 60000; }
  if (state === 'lockout') lockoutTime = now + 2 * D + 5 * H;
  if (state === 'rebuild') {
    lockoutTime = now - 3 * D;
    assignNA = now + 20 * H; assignEU = now + 90 * 60000;
    // The teams notice reads its state from a cache first: filled here, no request.
    relinkState = { window: Math.floor(assignNA / 1000), published: 1 };
    relinkStateAt = now;
  }
  updateRelinkBanner();
  labSay(`Relink bar: ${state}, until the page's next refresh.`);
}
function labRelinkTick() {
  updateRelinkBanner();
  labSay('Relink bar rebuilt, as every minute.');
}
function labRelinkNormal() {
  if (labRelinkKept) {
    ({ relinkNA, relinkEU, resetNA, resetEU, lockoutTime, timersLoaded,
      assignNA, assignEU, relinkState, relinkStateAt } = labRelinkKept);
    labRelinkKept = null;
  }
  updateRelinkBanner();
  labSay('Relink bar back to the real timers.');
}

// Leave and come back: the tab reported hidden, as switching tabs or minimising does
// (losing the focus alone stops nothing: a page on a second monitor is watched).
let labAwayTick = null;
function labSimAway() {
  if (labAwayTick) return;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
  let left = 5;
  labSay(`Away: back in ${left} s.`);
  labAwayTick = setInterval(() => {
    left--;
    if (left > 0) { labSay(`Away: back in ${left} s.`); return; }
    clearInterval(labAwayTick);
    labAwayTick = null;
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
    labSay('Back.');
  }, 1000);
}

const LAB_SIMS = [
  { label: 'New scoreboard', run: labSimBoard },
  { label: 'Relink bar: urgent', run: () => labRelink('urgent') },
  { label: 'Relink bar: lockout', run: () => labRelink('lockout') },
  { label: 'Relink bar: rebuild week', run: () => labRelink('rebuild') },
  { label: 'Rebuild tick', run: labRelinkTick },
  { label: 'Relink bar: back to normal', run: labRelinkNormal },
  { label: 'Loading skeleton', run: labSimSkeleton },
  { label: 'Loaders', run: labSimLoaders },
  { label: 'Guild found', run: labSimGuildFound },
  { label: 'Trebuchet', run: labSimTrebuchet },
  { label: 'Ember blast', run: labSimEmbers },
  { label: 'Map rings', run: labSimRings },
  { label: 'Leave and come back (5 s)', run: labSimAway },
];

// ---- The map rings, New: the SVG keeps an empty placeholder (so ringChanged still sees a
// ring there and the marker's repaint still drops it), and the rings are HTML in a fixed layer
// on <body> over the map. Inside the maps popover a transform animation, even a composited
// one, re-rasters the whole popover every frame; outside it only the rings move.
// js/maps.js arrives later (loadMapsScript): the swap is made when it has loaded.
let labMissedRingMark = null;
const labRings = new Set();   // { g, r, box, at, size }
let labRingLoop = 0;
let labRingLayer = null;
function labHookRings() {
  if (labMissedRingMark || typeof missedRingMark !== 'function') return;
  labMissedRingMark = missedRingMark;
  missedRingMark = labRingMark;
}
const labLoadMapsScript = loadMapsScript;
loadMapsScript = function () { return labLoadMapsScript.apply(this, arguments).then(labHookRings); };
function labRingMark(r, until) {
  if (labPrefs.rings !== 'new') return labMissedRingMark.apply(this, arguments);
  const g = svgEl('g', { class: 'wvw-ring' });
  setTimeout(() => g.remove(), Math.max(0, until - Date.now()) + 500);
  labRings.add({ g, r: r * 1.25, box: null, at: '', size: 0 });
  if (!labRingLoop) labRingLoop = requestAnimationFrame(labRingFrame);
  return g;
}
// Each frame: the layer on the part of the map the popover shows, each ring on its marker
// (a transform when it moves, sizes only on zoom). Writes only what changed.
function labRingFrame() {
  labRingLoop = 0;
  let clip = null;
  for (const ring of labRings) {
    const node = ring.g.parentNode;
    if (!ring.g.isConnected || !node) { if (ring.box) ring.box.remove(); labRings.delete(ring); continue; }
    const wrap = node.closest('.wvw-plot-wrap');
    const m = node.getScreenCTM && node.getScreenCTM();
    if (!wrap || !m) continue;
    if (!clip) {
      const w = wrap.getBoundingClientRect();
      const pop = wrap.closest('.info-popover');
      const p = pop ? pop.getBoundingClientRect() : w;
      const left = Math.max(w.left, p.left), top = Math.max(w.top, p.top);
      clip = { left, top, width: Math.max(0, Math.min(w.right, p.right) - left), height: Math.max(0, Math.min(w.bottom, p.bottom) - top) };
      if (!labRingLayer || !labRingLayer.isConnected) {
        labRingLayer = labEl('div', 'lab-rings');
        document.body.appendChild(labRingLayer);
      }
      const at = `${clip.left},${clip.top},${clip.width},${clip.height}`;
      if (labRingLayer.dataset.at !== at) {
        labRingLayer.dataset.at = at;
        Object.assign(labRingLayer.style, { left: `${clip.left}px`, top: `${clip.top}px`, width: `${clip.width}px`, height: `${clip.height}px` });
      }
    }
    if (!ring.box) {
      ring.box = labEl('div', 'lab-ring');
      ring.box.append(labEl('i'), labEl('i'));
      labRingLayer.appendChild(ring.box);
    }
    const at = `translate(${(m.e - clip.left).toFixed(1)}px,${(m.f - clip.top).toFixed(1)}px)`;
    if (at !== ring.at) { ring.box.style.transform = at; ring.at = at; }
    if (Math.abs(m.a - ring.size) > 1e-3) {
      ring.size = m.a;
      [3, 2].forEach((sw, i) => {
        const el = ring.box.children[i];
        const d = (2 * ring.r + sw) * m.a;
        el.style.width = el.style.height = `${d}px`;
        el.style.left = el.style.top = `${-d / 2}px`;
        el.style.borderWidth = `${sw * m.a}px`;
      });
    }
  }
  if (labRings.size) labRingLoop = requestAnimationFrame(labRingFrame);
  else if (labRingLayer) { labRingLayer.remove(); labRingLayer = null; }
}

// The site's animationend cleanup reads the animation names; the New ones have their own.
document.addEventListener('animationend', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (e.animationName === 'lab-value-flash') t.classList.remove('value-changed');
  else if (e.animationName === 'lab-side-pulse') t.classList.remove('side-pulse');
});

// The rings need an open map: opens the first tier's maps, then rings it.
function labSimRingsOpen(go = () => {}) {
  const ring = () => { labSimRings(); go(); };
  if (missedOpen && document.querySelector('.wvw-plot-wrap g[data-obj]')) { ring(); return; }
  const btn = document.querySelector('.tier-map-btn');
  if (!btn) { labSay('No tier on the page yet.'); return; }
  btn.click();
  labSay('Opening the maps…');
  const until = Date.now() + 8000;
  const wait = () => {
    if (missedOpen && document.querySelector('.wvw-plot-wrap g[data-obj]')) { setTimeout(ring, 600); return; }
    if (Date.now() < until) setTimeout(wait, 200);
    else labSay('The maps did not open.');
  };
  wait();
}

labPanel = labBuildPanel();
labStatusEl = labPanel.querySelector('.lab-status');
labPaintPanel();
labRepaint();
