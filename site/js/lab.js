'use strict';
// LAB (never merged). The 95-0 lab: the middle of the page in five ready setups (search and answer,
// the found card's mark, highlights, news), picked in the "Lab" panel. Loaded just before js/boot.js,
// after the lab-*.js it draws with (check-structure wants boot.js last). Everything goes through textContent.

const LAB_KEY = 'wvw-lab-v1';
const LAB_VERSION = 1;          // bump when the defaults change: older saved choices are dropped
// search A line, B card, C the standings answer; mark blink, sheen (+ ring), here; tiles A board,
// B duel, C pills; news A ledger, B lead + grid, C timeline, R = C under B's lead, M = A, 3 items.
const LAB_SETUPS = {
  1: { label: '1 · Plain', search: 'A', mark: 'blink', tiles: 'A', news: 'A' },
  2: { label: '2 · Card', search: 'B', mark: 'sheen', tiles: 'B', news: 'B' },
  3: { label: '3 · The standings answer', search: 'C', mark: 'here', tiles: 'C', news: 'C' },
  4: { label: '4 · Recommended', search: 'B', mark: 'sheen', tiles: 'A', news: 'R', ownIcon: true, profIcon: true },
  5: { label: '5 · Phone-minimal', search: 'A', mark: 'blink', tiles: 'C', news: 'M' },
};
const LAB_ITEMS = [
  { type: 'section', label: 'Setup' },
  { type: 'radio', key: 'setup', label: 'Setup', options: Object.fromEntries(Object.entries(LAB_SETUPS).map(([k, s]) => [k, s.label])), value: '1',
    // A setup brings its own fine-tune defaults.
    then: (p) => { p.ownIcon = !!LAB_SETUPS[p.setup].ownIcon; p.profIcon = !!LAB_SETUPS[p.setup].profIcon; } },
  { type: 'section', label: 'Fine-tune' },
  { type: 'check', key: 'ownIcon', label: 'Our icon in the news header, not "[[ ]]"', on: false },
  { type: 'check', key: 'profIcon', label: 'Profession icon beside buffs and nerfs', on: false },
  { type: 'section', label: 'Simulate a new update' },
  { type: 'button', label: 'Balance only', run: () => { labSimNews('balance'); labStatus('Example update: balance only.'); } },
  { type: 'button', label: 'Rules only', run: () => { labSimNews('rule'); labStatus('Example update: rules only.'); } },
  { type: 'button', label: 'New map, beta until a date', run: () => { labSimNews('map'); labStatus('Example update: a new map in beta.'); } },
  { type: 'button', label: 'Lines without a sure type', run: () => { labSimNews('unsure'); labStatus('Example update: lines with no label.'); } },
  { type: 'button', label: 'Back to the real notes', run: () => { labSimNews(null); labStatus('The real notes.'); } },
];

const labSetup = () => LAB_SETUPS[labPrefs.setup] || LAB_SETUPS[1];

// ---- the middle -----------------------------------------------------------------------------
const LAB_SUBTITLE = 'Type your guild’s name to see which WvW team it landed on after the relink, with its tier and the teams it faces. For NA and EU.';
let labMid = null;
function labMountMiddle() {
  const sub = document.querySelector('main .subtitle');
  if (!sub || typeof guildInput === 'undefined') return;
  document.documentElement.classList.add('lab-mid-on');
  sub.textContent = LAB_SUBTITLE;
  const old = guildInput.closest('.card');
  if (old) old.classList.add('lab-old-search');
  labMid = labEl('div', 'lab-mid');
  labMid.id = 'labMid';
  const search = labBuildSearch();
  search.querySelector('.ls-row').appendChild(runBtn);
  const tiles = labEl('div', 'lab-mid-tiles');
  tiles.id = 'labTiles';
  const news = labEl('div', 'lab-mid-news');
  news.id = 'labNews';
  labMid.append(search, tiles, news);
  sub.after(labMid);
  labPaintRecent();
}
function labPaintTiles() {
  const box = document.getElementById('labTiles');
  if (!box) return;
  box.textContent = '';
  box.appendChild(labTilesPanel(labSetup().tiles));
}
function labPaintNews() {
  const box = document.getElementById('labNews');
  if (!box) return;
  box.textContent = '';
  box.appendChild(labNewsPanel(labSetup().news, { ownIcon: labPrefs.ownIcon, profIcon: labPrefs.profIcon }));
}
// The standings hook: fresh cards lose the mark, so it is painted again; the tiles read the new data.
function labAfterStandings() {
  if (typeof document.querySelector !== 'function' || !labMid) return;
  labPaintMark(false);
  labPaintTiles();
}

function labRepaint() {
  if (!labMid) return;
  document.documentElement.dataset.labSetup = labPrefs.setup;
  if (labS.mark) labS.mark.kind = labSetup().mark;
  labPaintAnswer();
  labPaintTiles();
  labPaintNews();
}

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
      if (it.type === 'check') p[it.key] = typeof v[it.key] === 'boolean' ? v[it.key] : !!(LAB_SETUPS[p.setup] || {})[it.key];
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
  // The site's map pop-over marks every other child of <body> inert while it is open, the
  // panel included: a press then falls through to the backdrop and closes the pop-over.
  if (typeof MutationObserver === 'function') new MutationObserver(() => { if (root.inert) root.inert = false; })
    .observe(root, { attributes: true, attributeFilter: ['inert'] });
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
      const fs = labEl('fieldset', 'lab-radios lab-radios-block');
      fs.appendChild(labEl('legend', null, it.label));
      for (const [k, text] of Object.entries(it.options)) {
        const rl = labEl('label');
        const r = labEl('input');
        r.type = 'radio';
        r.name = `lab-${it.key}`;
        r.value = k;
        r.addEventListener('change', () => { if (r.checked) { labPrefs[it.key] = k; if (it.then) it.then(labPrefs); labChanged(); } });
        rl.append(r, ` ${text}`);
        fs.appendChild(rl);
      }
      body.appendChild(fs);
    }
  }
  const status = labEl('p', 'lab-status');
  status.setAttribute('role', 'status');
  body.appendChild(status);
  root.append(body, toggle);
  // Out of the Tab order: un-inerted, the panel would be a way out of the map window's focus trap (keys.spec).
  if (typeof root.querySelectorAll === 'function') for (const c of root.querySelectorAll('button, input')) c.tabIndex = -1;
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
  for (const it of LAB_ITEMS) if (it.cls) document.documentElement.classList.toggle(`lab-${it.key}`, !!labPrefs[it.key]);
}

if (typeof document.querySelector === 'function' && typeof document.createElement === 'function' && document.body
  && typeof document.body.appendChild === 'function') {
  labMountMiddle();
  labPanel = labBuildPanel();
  labPaintPanel();
  labRepaint();
}
