'use strict';
// LAB (never merged). The 95-0 lab, round 2: the middle of the page as the owner kept it (setup 4 of
// round 1), every open choice a box or a radio in the panel's "Fine-tune" group, the recommendation
// on by default. Loaded just before js/boot.js, after the lab-*.js it draws with (check-structure
// wants boot.js last). Everything goes through textContent.

const LAB_KEY = 'wvw-lab-v1';
const LAB_VERSION = 2;          // bump when the defaults change: older saved choices are dropped
const LAB_ITEMS = [
  { type: 'section', label: 'Fine-tune' },
  { type: 'radio', key: 'order', label: 'Order', value: 'shn',
    options: { shn: 'Search · Highlights · News', snh: 'Search · News · Highlights', hsn: 'Highlights · Search · News' } },
  { type: 'check', key: 'newsLow', label: 'Phones: news below the standings', on: false },
  { type: 'radio', key: 'searchBar', label: 'Search bar', value: 'panel',
    options: { panel: 'Panel like the others', bare: 'Bare bar', shield: 'Shield button' } },
  { type: 'radio', key: 'recent', label: 'Recent guilds', value: 'list',
    options: { list: 'Suggestions while typing', chips: 'Chips under the bar' } },
  { type: 'radio', key: 'answer', label: 'Answer card', value: 'banner',
    options: { banner: 'Team banner', matchup: 'Matchup', bigtier: 'Big tier' } },
  { type: 'radio', key: 'effect', label: 'Check effect', value: 'aimed',
    options: { aimed: 'Aimed at the answer, page still', today: 'Today’s, page still', simple: 'Simple: sparks + sheen' } },
  { type: 'radio', key: 'tierTag', label: 'Tier tag', value: 'chip', options: { chip: 'Chip', plain: 'Plain text' } },
  { type: 'check', key: 'ownIcon', label: 'Our icon in the news header, not "[[ ]]"', on: true },
  { type: 'check', key: 'profIcon', label: 'Profession icon beside buffs and nerfs', on: true },
  { type: 'section', label: 'Simulate a new update' },
  { type: 'button', label: 'Balance only', run: () => { labSimNews('balance'); labStatus('Example update: balance only.'); } },
  { type: 'button', label: 'Rules only', run: () => { labSimNews('rule'); labStatus('Example update: rules only.'); } },
  { type: 'button', label: 'New map, beta until a date', run: () => { labSimNews('map'); labStatus('Example update: a new map in beta.'); } },
  { type: 'button', label: 'Lines without a sure type', run: () => { labSimNews('unsure'); labStatus('Example update: lines with no label.'); } },
  { type: 'button', label: 'Back to the real notes', run: () => { labSimNews(null); labStatus('The real notes.'); } },
];

// ---- the middle -----------------------------------------------------------------------------
const LAB_SUBTITLE = 'Type your guild’s name to see which WvW team it landed on after the relink, with its tier and the teams it faces. For NA and EU.';
const LAB_NARROW = '(max-width: 1399px)';
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
  search.querySelector('.ls-btn').prepend(runBtn);
  const tiles = labEl('div', 'lab-mid-tiles');
  tiles.id = 'labTiles';
  const news = labEl('div', 'lab-mid-news');
  news.id = 'labNews';
  labMid.append(search, tiles, news);
  sub.after(labMid);
  // Where the news goes on a narrow screen with "Phones: news below the standings": after both rails.
  const low = labEl('div', 'lab-news-low');
  low.id = 'labNewsLow';
  document.getElementById('page').appendChild(low);
  if (typeof matchMedia === 'function') matchMedia(LAB_NARROW).addEventListener('change', labPlaceParts);
  labPaintRecent();
}
function labPlaceParts() {
  if (!labMid) return;
  const by = { s: labMid.querySelector('.ls-search'), h: document.getElementById('labTiles'), n: document.getElementById('labNews') };
  const low = labPrefs.newsLow && typeof matchMedia === 'function' && matchMedia(LAB_NARROW).matches;
  for (const k of labPrefs.order) {
    if (k === 'n' && low) document.getElementById('labNewsLow').appendChild(by.n);
    else labMid.appendChild(by[k]);
  }
}
function labPaintTiles() {
  const box = document.getElementById('labTiles');
  if (!box) return;
  box.textContent = '';
  box.appendChild(labTilesPanel());
}
function labPaintNews() {
  const box = document.getElementById('labNews');
  if (!box) return;
  box.textContent = '';
  box.appendChild(labNewsPanel({ ownIcon: labPrefs.ownIcon, profIcon: labPrefs.profIcon }));
}
// The standings hook: fresh cards lose the mark, so it is painted (or watched for) again; the tiles read the new data.
function labAfterStandings() {
  if (typeof document.querySelector !== 'function' || !labMid) return;
  labWatchMark();
  labPaintTiles();
}

function labRepaint() {
  if (!labMid) return;
  const html = document.documentElement;
  html.classList.toggle('lab-aim', labPrefs.effect === 'aimed');
  html.classList.toggle('lab-still', labPrefs.effect !== 'today');
  labPlaceParts();
  labPaintSearchBar();
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
        r.addEventListener('change', () => { if (r.checked) { labPrefs[it.key] = k; labChanged(); } });
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
