'use strict';
// LAB (never merged). The E3 redesign lab: the panel, the base every design shares, and the
// hooks the site's files call. Designs A, B and C register on LAB_DESIGNS in js/lab-a.js,
// js/lab-b.js and js/lab-c.js, which load after this and before js/boot.js. A design may
// define boot(), afterStandings(gridEl, label), beforeGuildFound(teamId, guildName),
// afterBanner(bannerEl), afterRun() and afterPopoverOpen(popover, triggerEl); each runs
// after the base has done its part. Everything the page shows goes through textContent.

const LAB_KEY = 'wvw-lab-e3-v1';
const LAB_VERSION = 1;          // js/region.js reads the same key and version before first paint
const LAB_DESIGNS = {};
const LAB_H = 3600000;
const LAB_D = 24 * LAB_H;
const LAB_LOCK_SOON_MS = 10 * LAB_D;

const LAB_ITEMS = [
  { type: 'section', label: 'Design' },
  { type: 'radio', key: 'design', label: 'Design', reload: true, hideLegend: true, block: true,
    options: { today: 'Today', a: 'A · Match room', b: 'B · Buttons in view', c: 'C · Sections' }, value: 'today' },
  { type: 'section', label: 'Pieces' },
  { type: 'radio', key: 'treb', label: 'Trebuchet', reload: true, options: { keep: 'keep', remove: 'remove' }, value: 'keep' },
  { type: 'radio', key: 'copy', label: 'Copy', options: { two: 'two buttons', one: 'one button', none: 'none' }, value: 'two' },
  { type: 'radio', key: 'lockEarly', label: 'Lockout before 10 days', options: { dim: 'dim line', nothing: 'nothing' }, value: 'dim' },
  { type: 'radio', key: 'searchRelink', label: 'Search in relink week', options: { closed: 'closed', open: 'open' }, value: 'closed' },
  { type: 'note', text: 'Pieces apply to A, B and C.' },
  { type: 'section', label: 'Simulate…' },
  { type: 'button', label: 'Normal month', run: () => labSimulate('normal') },
  { type: 'button', label: 'Lockout in 10 days', run: () => labSimulate('lock10') },
  { type: 'button', label: 'Lockout in 3 days', run: () => labSimulate('lock3') },
  { type: 'button', label: 'EU reset in 2 h', run: () => labSimulate('eu2h') },
  { type: 'button', label: 'NA reset in 2 h', run: () => labSimulate('na2h') },
  { type: 'button', label: 'Relink week', run: () => labSimulate('relinkWeek') },
  { type: 'button', label: 'Rebuild (teams notice)', run: () => labSimulate('rebuild') },
  { type: 'button', label: 'Guild found in the other region', run: labSimGuildOther },
  { type: 'button', label: 'Back to live', run: labBackToLive },
];

const labEl = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const LAB_SVG_NS = 'http://www.w3.org/2000/svg';
function labIcon(paths, size) {
  const svg = document.createElementNS(LAB_SVG_NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(LAB_SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
const LAB_LENS = ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M20 20l-4-4'];
const LAB_CROSS = ['M6 6l12 12', 'M18 6L6 18'];

function labReadPrefs() {
  const p = { open: false };
  for (const it of LAB_ITEMS) if ('key' in it) p[it.key] = it.value;
  try {
    const v = JSON.parse(localStorage.getItem(LAB_KEY) || 'null');
    if (!v || v.v !== LAB_VERSION) return p;
    if (typeof v.open === 'boolean') p.open = v.open;
    for (const it of LAB_ITEMS) {
      if (it.type === 'radio' && Object.prototype.hasOwnProperty.call(it.options, v[it.key])) p[it.key] = v[it.key];
    }
  } catch { /* storage off or corrupt: the defaults */ }
  return p;
}
const labPrefs = labReadPrefs();
const labBase = labPrefs.design !== 'today';
document.documentElement.dataset.labDesign = labPrefs.design;
document.documentElement.classList.toggle('lab-base', labBase);

function labSave() {
  try { localStorage.setItem(LAB_KEY, JSON.stringify({ v: LAB_VERSION, ...labPrefs })); } catch { /* fine */ }
}

// ---- the panel ------------------------------------------------------------------
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
  toggle.addEventListener('click', () => { labPrefs.open = !labPrefs.open; labSave(); labPaintPanel(); });
  const body = labEl('div', 'lab-body');
  body.id = 'lab-body';
  const head = labEl('div', 'lab-head');
  head.append(labEl('strong', null, 'Lab'), labEl('span', 'lab-muted', ' · prototypes, preview only'));
  body.appendChild(head);
  for (const it of LAB_ITEMS) {
    if (it.type === 'section') body.appendChild(labEl('div', 'lab-section', it.label));
    if (it.type === 'note') body.appendChild(labEl('p', 'lab-note', it.text));
    if (it.type === 'button') {
      const b = labEl('button', 'lab-btn', it.label);
      b.type = 'button';
      b.addEventListener('click', it.run);
      body.appendChild(b);
    }
    if (it.type === 'radio') {
      const fs = labEl('fieldset', it.block ? 'lab-radios lab-radios-col' : 'lab-radios');
      fs.appendChild(labEl('legend', it.hideLegend ? 'lab-sr-legend' : null, it.label));
      for (const [k, text] of Object.entries(it.options)) {
        const rl = labEl('label');
        const r = labEl('input');
        r.type = 'radio';
        r.name = `lab-${it.key}`;
        r.value = k;
        r.addEventListener('change', () => {
          if (!r.checked) return;
          labPrefs[it.key] = k;
          labSave();
          if (it.reload) { location.reload(); return; }
          labPaintPanel();
          labApplyPieces();
        });
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
  for (const r of body.querySelectorAll('input[type=radio]')) r.checked = labPrefs[r.name.slice(4)] === r.value;
}

// ---- pieces -----------------------------------------------------------------------
// The trebuchet's rounds start in startCharge and land through playFinale: with the
// trebuchet removed both stand down, and the button's sparks stay.
if (labBase && labPrefs.treb === 'remove') {
  startCharge = function () {};
  playFinale = function () {};
}

let labCopyMenu = null;
function labBuildCopyOne() {
  const wrap = labEl('div', 'lab-copy-one');
  const btn = labEl('button', 'lab-copy-btn', 'Copy');
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-haspopup', 'true');
  const menu = labEl('div', 'lab-copy-menu');
  menu.hidden = true;
  const pick = (label, target) => {
    const b = labEl('button', 'lab-copy-pick', label);
    b.type = 'button';
    b.addEventListener('click', () => { labCloseCopy(); target.click(); btn.focus(); });
    return b;
  };
  menu.append(pick('In-game chat', copyChatBtn), pick('Discord', copyDiscordBtn));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) labCloseCopy(); });
  wrap.append(btn, menu);
  copyRow.prepend(wrap);
  labCopyMenu = { btn, menu };
}
function labCloseCopy() {
  if (!labCopyMenu) return;
  labCopyMenu.menu.hidden = true;
  labCopyMenu.btn.setAttribute('aria-expanded', 'false');
}

function labApplyPieces() {
  const html = document.documentElement;
  html.classList.toggle('lab-treb-remove', labBase && labPrefs.treb === 'remove');
  html.classList.toggle('lab-copy-one-on', labBase && labPrefs.copy === 'one');
  html.classList.toggle('lab-copy-none', labBase && labPrefs.copy === 'none');
  if (labBase) updateRelinkBanner();
}

// ---- the hooks ----------------------------------------------------------------------
function labCall(name, ...args) {
  if (!labBase) return undefined;
  const d = Object.prototype.hasOwnProperty.call(LAB_DESIGNS, labPrefs.design) ? LAB_DESIGNS[labPrefs.design] : null;
  const fn = d && Object.prototype.hasOwnProperty.call(d, name) ? d[name] : null;
  return typeof fn === 'function' ? fn(...args) : undefined;
}

function labBoot() {
  if (labBase) labBaseBoot();
  labCall('boot');
}
function labAfterStandings(gridEl, label) {
  labCall('afterStandings', gridEl, label);
}
function labBeforeGuildFound(teamId, guildName) {
  if (labBase) {
    labFound = { teamId, guildName };
    if (labShowOnBoard) labShowOnBoard.hidden = false;
    const region = String(teamId).startsWith('12') ? 'eu' : 'na';
    if (labNarrow() && railFirst() !== region) labSetRegion(region);
  }
  labCall('beforeGuildFound', teamId, guildName);
}
function labAfterBanner(bannerEl) {
  if (labBase) labBaseBanner(bannerEl);
  labCall('afterBanner', bannerEl);
}
function labAfterRun() {
  labCall('afterRun');
}
function labAfterPopoverOpen(popover, triggerEl) {
  labCall('afterPopoverOpen', popover, triggerEl);
}

// ---- the base: header, search panel, region switch, footer ---------------------
const LAB_NARROW_Q = window.matchMedia('(max-width: 799px)');
const labNarrow = () => LAB_NARROW_Q.matches;
let labSearchBtn = null;
let labShowOnBoard = null;
let labFound = null;          // { teamId, guildName } of the last search
let labRegionBtns = null;     // { na, eu }
let labAutoOpened = false;

function labBaseBoot() {
  const html = document.documentElement;
  const main = document.querySelector('main.wrap');

  // The header: the crest and the h1 move in from the title row (the footer's crest
  // reads the gradients inside that svg by id), and the search's way in.
  const header = labEl('header', 'lab-header');
  const inner = labEl('div', 'lab-header-inner');
  const brand = labEl('div', 'lab-brand');
  const crest = document.querySelector('.title-row svg');
  const h1 = document.querySelector('.title-row h1');
  if (crest) brand.appendChild(crest);
  if (h1) brand.appendChild(h1);
  labSearchBtn = labEl('button', 'lab-search-btn lab-tap');
  labSearchBtn.type = 'button';
  labSearchBtn.id = 'labSearchBtn';
  labSearchBtn.setAttribute('aria-controls', 'labSearch');
  labSearchBtn.setAttribute('aria-expanded', 'false');
  labSearchBtn.append(labIcon(LAB_LENS, 18), labEl('span', 'lab-search-wide', 'Find your guild…'),
    labEl('span', 'lab-search-narrow', 'Guilds'));
  labSearchBtn.addEventListener('click', () => labSearch(!html.classList.contains('lab-search-is-open'), true));
  inner.append(brand, labSearchBtn);
  header.appendChild(inner);
  relinkBanner.before(header);

  // The search panel: main.wrap itself, under the header.
  main.id = 'labSearch';
  main.classList.add('lab-search');
  main.setAttribute('aria-label', 'Find your guild');
  const bar = labEl('div', 'lab-search-head');
  const title = labEl('p', 'lab-search-title', 'Find your guild');
  labShowOnBoard = labEl('button', 'lab-show-board lab-tap', 'Show on board');
  labShowOnBoard.type = 'button';
  labShowOnBoard.hidden = true;
  labShowOnBoard.addEventListener('click', () => {
    labSearch(false, false);
    if (labFound) showGuildFound(labFound.teamId, labFound.guildName);
  });
  const close = labEl('button', 'lab-search-close lab-tap');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the search');
  close.appendChild(labIcon(LAB_CROSS, 18));
  close.addEventListener('click', () => labSearch(false, true));
  bar.append(title, labShowOnBoard, close);
  main.prepend(bar);
  header.after(main);
  main.addEventListener('keydown', (e) => { if (e.key === 'Escape') labSearch(false, true); });

  // NA | EU, under 800 px: one region at a time, the same preference as the swap.
  const page = document.getElementById('page');
  const switcher = labEl('div', 'lab-regions');
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', 'Region');
  labRegionBtns = {};
  for (const r of ['na', 'eu']) {
    const b = labEl('button', 'lab-region lab-tap');
    b.type = 'button';
    b.dataset.region = r;
    b.append(labEl('span', 'lab-region-name', r.toUpperCase()), labEl('span', 'lab-region-time'));
    b.addEventListener('click', () => labSetRegion(r));
    labRegionBtns[r] = b;
    switcher.appendChild(b);
  }
  page.prepend(switcher);
  labPaintRegions();

  // The sticky switch sits under the teams notice: its height, read when it changes.
  // The notice's height does not depend on anything below it, so this cannot feed back.
  const setNotice = () => html.style.setProperty('--lab-notice-h', `${teamsNotice.offsetHeight}px`);
  setNotice();
  if (typeof ResizeObserver === 'function') new ResizeObserver(setNotice).observe(teamsNotice);

  // The footer on one line: the fine print between the name and the links.
  const fine = document.querySelector('.gw2-band-fine');
  const links = document.querySelector('.gw2-band-links');
  if (fine && links) links.before(fine);

  if (copyRow) labBuildCopyOne();
  labApplyPieces();
  LAB_NARROW_Q.addEventListener('change', labPaintRegions);
}

function labSearch(open, moveFocus) {
  const html = document.documentElement;
  html.classList.toggle('lab-search-is-open', open);
  labSearchBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open && moveFocus) guildInput.focus({ preventScroll: !labNarrow() });
  if (!open && moveFocus) labSearchBtn.focus({ preventScroll: true });
}

function labSetRegion(r) {
  if (railFirst() === r) return;
  if (activePopover) closePopover();
  document.documentElement.dataset.railFirst = r;
  try { localStorage.setItem(RAIL_FIRST_KEY, r); } catch { /* fine */ }
  placeRails();
  updateRelinkBanner();
  labPaintRegions();
}

function labPaintRegions() {
  if (!labRegionBtns) return;
  const now = Date.now();
  const first = railFirst();
  const rebuild = relinkBanner.classList.contains('is-rebuild');
  for (const [r, at] of [['na', rebuild ? assignNA : relinkNA], ['eu', rebuild ? assignEU : relinkEU]]) {
    const b = labRegionBtns[r];
    b.setAttribute('aria-pressed', first === r ? 'true' : 'false');
    const left = at !== null ? at - now : null;
    const soon = left !== null && left > 0 && left <= RELINK_URGENT_MS;
    b.classList.toggle('is-soon', soon);
    b.querySelector('.lab-region-time').textContent = soon ? ` · ${formatCountdown(left)}` : '';
  }
}

// ---- the base: one banner ----------------------------------------------------------
// The site draws the banner; this rearranges what it drew. Info: one line. Attention
// (the lockout inside 3 days, a region inside 2 hours of its reset): amber, with the pulse.
function labBaseBanner(banner) {
  labPaintRegions();
  banner.classList.remove('lab-unified', 'lab-attn');
  if (banner.style.display === 'none') return;
  if (labPrefs.searchRelink === 'open' && !labAutoOpened
      && (banner.classList.contains('is-relink-week') || banner.classList.contains('is-rebuild'))) {
    labAutoOpened = true;
    labSearch(true, false);
  }
  if (banner.classList.contains('is-rebuild')) return;

  const inner = banner.querySelector('.relink-inner');
  if (!inner) return;
  const lock = inner.querySelector('.relink-stat--primary');
  const reset = inner.querySelector('.relink-stat:not(.relink-stat--primary)');
  const divider = inner.querySelector('.relink-divider');
  const now = Date.now();
  const lockLeft = timersLoaded && lockoutTime !== null ? lockoutTime - now : null;

  if (lock) {
    lock.classList.remove('relink-stat--primary');
    lock.classList.add('lab-lock');
    if (lockLeft !== null && lockLeft > LAB_LOCK_SOON_MS) {
      if (labPrefs.lockEarly === 'nothing') { lock.remove(); if (divider) divider.remove(); }
      else lock.classList.add('is-dim');
    } else if (lockLeft !== null && lockLeft > 0 && banner.classList.contains('is-lockout')) {
      lock.classList.add('is-attn');
    }
  }
  const unified = banner.classList.contains('is-urgent') && !banner.classList.contains('is-lockout');
  if (unified) {
    banner.classList.add('lab-unified');
    if (divider) divider.remove();
    for (const a of banner.querySelectorAll('.relink-alert')) a.remove();
    if (reset) {
      for (const s of reset.querySelectorAll('.relink-stat-value .region, .relink-stat-value .time')) {
        if (!s.classList.contains('is-now') && s.textContent.trim() !== '·') s.classList.add('lab-off');
      }
    }
  }
  if (unified || banner.classList.contains('is-lockout')) banner.classList.add('lab-attn');
}

// ---- Simulate… ------------------------------------------------------------------------
// The site's own banner with invented hours. While one is up, the page's refreshes
// leave the timers alone; "Back to live" puts the real ones back.
const LAB_RELINK_VARS = () => ({ relinkNA, relinkEU, resetNA, resetEU, liveNA, liveEU,
  lockoutTime, timersLoaded, assignNA, assignEU, relinkState, relinkStateAt, bannerMayDraw });
let labRelinkKept = null;

const labRealFromMatches = updateRelinkFromMatches;
updateRelinkFromMatches = function (naMatches, euMatches) {
  if (labRelinkKept) return;
  labRealFromMatches(naMatches, euMatches);
};
const labRealFetchTimers = fetchTimers;
fetchTimers = function () {
  if (labRelinkKept) return Promise.resolve();
  return labRealFetchTimers();
};

function labSimulate(state) {
  if (!labRelinkKept) labRelinkKept = LAB_RELINK_VARS();
  const now = Date.now() + 30000;   // half a minute ahead, so the countdowns read the round figures set here
  const M = 60000;
  timersLoaded = true;
  bannerMayDraw = true;
  liveNA = liveEU = true;
  relinkNA = now + LAB_D + 17 * LAB_H;
  relinkEU = now + LAB_D + 9 * LAB_H;
  lockoutTime = now + 18 * LAB_D + 4 * LAB_H;
  assignNA = now + 25 * LAB_D + 17 * LAB_H;
  assignEU = assignNA - 8 * LAB_H;
  if (state === 'lock10') lockoutTime = now + 9 * LAB_D + 20 * LAB_H;
  if (state === 'lock3') lockoutTime = now + 2 * LAB_D + 5 * LAB_H;
  if (state === 'eu2h') relinkEU = now + LAB_H + 52 * M;
  if (state === 'na2h') relinkNA = now + LAB_H + 52 * M;
  if (state === 'relinkWeek') {
    relinkNA = now + 4 * LAB_D + 17 * LAB_H;
    relinkEU = now + 4 * LAB_D + 9 * LAB_H;
    assignNA = relinkNA;
    assignEU = relinkEU;
    lockoutTime = now + 3 * LAB_D + 20 * LAB_H;
  }
  if (state === 'rebuild') {
    lockoutTime = now - 3 * LAB_D;
    assignNA = now + 20 * LAB_H;
    assignEU = now + 90 * M;
    relinkNA = assignNA;
    relinkEU = assignEU;
    relinkState = { window: Math.floor(assignNA / 1000), published: 1 };
    relinkStateAt = now;
  }
  resetNA = relinkNA - 7 * LAB_D;
  resetEU = relinkEU - 7 * LAB_D;
  updateRelinkBanner();
  labStatus(`Simulated: ${state} (invented times, held until Back to live).`);
}

function labBackToLive() {
  if (labRelinkKept) {
    ({ relinkNA, relinkEU, resetNA, resetEU, liveNA, liveEU, lockoutTime, timersLoaded,
      assignNA, assignEU, relinkState, relinkStateAt, bannerMayDraw } = labRelinkKept);
    labRelinkKept = null;
  }
  updateRelinkBanner();
  labStatus('Back to the live timers.');
}

function labSimGuildOther() {
  const prefix = railFirst() === 'eu' ? '1-' : '2-';
  const m = [...matchDataCache.values()].find((x) => x && typeof x.id === 'string' && x.id.startsWith(prefix) && matchIsLive(x));
  const teamId = m && matchTeamId(m, 'blue');
  if (!teamId) { labStatus('No live tier of the other region on the page yet.'); return; }
  showGuildFound(teamId, 'Lab Test Guild [LAB]');
  labStatus(`Guild found in ${prefix === '1-' ? 'NA' : 'EU'} (invented name).`);
}

labPanel = labBuildPanel();
labPaintPanel();
