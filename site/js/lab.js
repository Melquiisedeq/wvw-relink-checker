'use strict';
// LAB (never merged). The 95-0 lab, round 10: the middle of the page as the owner kept it (his round 1 to 4
// choices fixed), every open choice a box or a radio in the panel's "Fine-tune" group, the recommendation
// on by default. Loaded just before js/boot.js, after the lab-*.js it draws with (check-structure
// wants boot.js last). Everything goes through textContent.

const LAB_KEY = 'wvw-lab-v1';
const LAB_VERSION = 19;          // bump when the defaults change: older saved choices are dropped
// Round 16: the Closest match's barTop, with round 10's "a" and round 9 to compare, an icon for its title and how
// the scales move.
const LAB_CLOSE_OPTS = {
  barTop: '“+18 VP” and “+23 VP” over the bar’s ends',
  a: 'Round 10 (a)',
  today: 'Round 9: the week only',
};
const LAB_SETUPS = {
  barTop: { label: LAB_CLOSE_OPTS.barTop, closest: 'barTop', frame: 'a', icon: 'scales', motion: 'tip' },
  a: { label: LAB_CLOSE_OPTS.a, closest: 'a', frame: 'a', icon: 'none' },
  today: { label: LAB_CLOSE_OPTS.today, closest: 'today', frame: 'today', icon: 'none' },
};
const LAB_ITEMS = [
  { type: 'radio', key: 'setup', label: 'Setup', value: 'barTop',
    options: Object.fromEntries(Object.entries(LAB_SETUPS).map(([k, x]) => [k, x.label])),
    apply: (k) => { labPrefs.closest = LAB_SETUPS[k].closest; labPrefs.frame = LAB_SETUPS[k].frame; labPrefs.closeIcon = LAB_SETUPS[k].icon; labPrefs.scalesMotion = LAB_SETUPS[k].motion || 'tip'; } },
  { type: 'section', label: 'Fine-tune' },
  { type: 'radio', key: 'closest', label: 'Closest match', value: 'barTop', options: LAB_CLOSE_OPTS },
  { type: 'radio', key: 'closeIcon', label: 'Closest match icon', value: 'scales', options: {
    scales: 'Scales, the pans almost level',
    stopwatch: 'A stopwatch',
    flag: 'A chequered finish flag',
    shields: 'Two shields face to face',
    none: 'No icon' } },
  { type: 'radio', key: 'scalesMotion', label: 'Scales motion', value: 'tip', options: {
    tip: 'Tip: on the swords’ beat the beam dips toward the favourite and back',
    sway: 'Sway: a slow, steady rock to both sides',
    weigh: 'Weigh: every 5.6 s the pans swing, then settle toward the favourite',
    still: 'Still: leaning toward the favourite' } },
  { type: 'radio', key: 'frame', label: 'Frame of the middle panels', value: 'a', options: {
    today: 'Today: dark fill, no shadow',
    a: 'A · dark fill + the columns’ border, rules and shadows',
    d: 'D · A + light from the top',
    b: 'B · glass like the columns (costly: blur on all three)',
    c: 'C · A, glass on the highlights only' } },
  { type: 'check', key: 'oldShine', label: 'Old shine (background-position)', on: false, cls: true },
  { type: 'check', key: 'newsLow', label: 'Phones: news below the standings', on: false },
  { type: 'check', key: 'ownIcon', label: 'Our icon in the news header, not "[[ ]]"', on: true },
  { type: 'check', key: 'profIcon', label: 'Profession icon beside buffs and nerfs', on: true },
  { type: 'section', label: 'Simulate a new update' },
  { type: 'button', label: 'Balance only', run: () => { labSimNews('balance'); labStatus('Example update: balance only.'); } },
  { type: 'button', label: 'Rules only', run: () => { labSimNews('rule'); labStatus('Example update: rules only.'); } },
  { type: 'button', label: 'New map, beta until a date', run: () => { labSimNews('map'); labStatus('Example update: a new map in beta.'); } },
  { type: 'button', label: 'Lines without a sure type', run: () => { labSimNews('unsure'); labStatus('Example update: lines with no label.'); } },
  { type: 'button', label: 'Back to the real notes', run: () => { labSimNews(null); labStatus('The real notes.'); } },
  { type: 'section', label: 'Simulate the Closest match' },
  { type: 'button', label: 'Simulate: the second passes the first if it ended now', run: () => { labPassSim = true; labPaintTiles(); labStatus('Simulated, made-up numbers: the second team leads the skirmish and would pass the first if it ended now.'); } },
  { type: 'button', label: 'Simulate: last minutes', run: () => { labLastSim = true; labPaintTiles(); labStatus('Simulated, made-up time: 3 minutes left in the skirmish.'); } },
  { type: 'button', label: 'Back to live', run: () => { labPassSim = false; labLastSim = false; labPaintTiles(); labStatus('The live skirmish.'); } },
  { type: 'section', label: 'Simulate a changed VP table' },
  { type: 'button', label: 'The game changed its VP table', run: () => { labVpWrong = true; labPaintTiles(); labStatus('Simulated: the table no longer adds up to the week, so the Closest match shows the week’s totals and the skirmish leader, no “+N”.'); } },
  { type: 'button', label: 'Back to the real table', run: () => { labVpWrong = false; labPaintTiles(); labStatus('The real VP table.'); } },
  { type: 'section', label: 'Simulate long team names' },
  { type: 'button', label: 'Long names on the Closest match', run: () => { labLongNames = true; labPaintTiles(); labStatus('Simulated: the two longest team names on the Closest match.'); } },
  { type: 'button', label: 'Back to the real names', run: () => { labLongNames = false; labPaintTiles(); labStatus('The real team names.'); } },
];

// ---- the middle -----------------------------------------------------------------------------
const LAB_SUBTITLE = 'Type your guild’s name to see which WvW team it landed on after the relink, with its tier and the teams it faces. For NA and EU.';
const LAB_NARROW = '(max-width: 1399px)';
let labMid = null;
const LAB_SUB_IN = 'See which team your guild landed on after the relink, its tier and the teams it faces. NA and EU.';
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
  search.id = 'labSearch';
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
  // The columns' swap (js/standings.js) sets data-rail-first: the highlights follow the region put first,
  // over a pick on their own switch.
  if (typeof MutationObserver === 'function') new MutationObserver(() => { labRegionPick = null; labPaintTiles(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-rail-first'] });
  labPaintRecent();
}
// The order is fixed (highlights, search, news); only where the news goes moves.
function labPlaceParts() {
  if (!labMid) return;
  const parts = { s: document.getElementById('labSearch'), h: document.getElementById('labTiles'), n: document.getElementById('labNews') };
  const low = labPrefs.newsLow && typeof matchMedia === 'function' && matchMedia(LAB_NARROW).matches;
  labMid.append(parts.h, parts.s);
  (low ? document.getElementById('labNewsLow') : labMid).appendChild(parts.n);
  // The line under the title speaks of the search: inside its panel, under the panel's heading.
  const sub = document.querySelector('main .subtitle');
  if (sub && !sub.classList.contains('lab-sub-in')) {
    sub.classList.add('lab-sub-in');
    sub.textContent = LAB_SUB_IN;
    parts.s.querySelector('.ls-head').after(sub);
  }
}
let labHotKey = '';
const labHotSig = () => { const f = labHot(); return f ? `${f.m.id}|${f.type}|${Math.round(f.n)}|${f.calm ? 'calm' : 'lit'}` : ''; };
function labPaintTiles() {
  const box = document.getElementById('labTiles');
  if (!box) return;
  labHotKey = labHotSig();
  box.textContent = '';
  box.appendChild(labTilesPanel());
}
// The kill readings land after the standings, and js/maps-early.js repaints the swords' badges from them
// (once, then every 30 s): the tiles follow when the Hottest fight it would pick has changed.
function labFollowBadges() {
  if (typeof paintMapBadges !== 'function') return;
  const own = paintMapBadges;
  paintMapBadges = function labBadges(...args) {
    own(...args);
    if (labHotSig() !== labHotKey) labPaintTiles();
  };
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
  labPlaceParts();
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
        r.addEventListener('change', () => { if (r.checked) { labPrefs[it.key] = k; if (it.apply) it.apply(k); labChanged(); } });
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
  document.documentElement.dataset.labSetup = labPrefs.setup;
  for (const f of Object.keys(LAB_ITEMS.find((it) => it.key === 'frame').options)) {
    document.documentElement.classList.toggle(`lab-frame-${f}`, labPrefs.frame === f);
  }
}

if (typeof document.querySelector === 'function' && typeof document.createElement === 'function' && document.body
  && typeof document.body.appendChild === 'function') {
  labMountMiddle();
  labFollowBadges();
  labPanel = labBuildPanel();
  labPaintPanel();
  labRepaint();
}
