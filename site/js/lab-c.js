'use strict';
// LAB (never merged). Design C, Sections: the page as tabs (Standings, Maps, Guilds), the
// address following them (#standings, #maps, #guilds) so Back changes the tab. Maps shows a
// tier's live maps docked in the page: the site's own maps popover, opened from a tier chip
// and moved out of its modal, with the four maps drawn 2x2 beside its side panel when wide.

const LABC_TABS = ['standings', 'maps', 'guilds'];
const LABC_QUAD_Q = window.matchMedia('(min-width: 1000px)');
const LABC_ICON = {
  standings: ['M5 6h3', 'M11 6h8', 'M5 12h3', 'M11 12h8', 'M5 18h3', 'M11 18h5'],
  maps: ['M3 6.5 9 3l6 3.5 6-3.5v14.5l-6 3.5-6-3.5-6 3.5Z', 'M9 3v14.5', 'M15 6.5V21'],
  guilds: ['M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z', 'M20 20l-4-4'],
  stats: ['M4 4v16h16', 'M8 15l3.5-4 3 2.5L19 8'],
};

const labc = {
  tab: 'standings',
  nav: null,
  tabBtns: {},
  maps: null,          // the Maps section
  seg: {},             // NA | EU in the Maps section
  chipRow: null,
  chips: new Map(),    // match id -> chip button (kept: the open popover is tied to its trigger)
  body: null,
  quad: null,
  host: null,
  empty: null,
  region: null,
  tier: null,          // match id
  docked: null,        // the maps popover living in the Maps section
  dockedMatch: null,
  cells: new Map(),    // map type -> stage wrap, in the 2x2
  painted: null,       // the match body the 2x2 last painted
  quadSeq: 0,
  tick: 0,
  closedByHand: false,
};

const labcHtml = () => document.documentElement;

// ---- tabs and the address --------------------------------------------------------
function labcTabFromHash() {
  const h = location.hash.replace('#', '');
  return LABC_TABS.includes(h) ? h : null;
}

function labcSetTab(tab, push) {
  if (!LABC_TABS.includes(tab)) tab = 'standings';
  const changed = labc.tab !== tab;
  if (changed && activePopover && activePopover !== labc.docked) closePopover();
  labc.tab = tab;
  labcHtml().dataset.labcTab = tab;
  for (const [k, b] of Object.entries(labc.tabBtns)) {
    if (k === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  if (push && location.hash !== `#${tab}`) history.pushState({ labc: tab }, '', `#${tab}`);
  if (tab === 'maps') {
    labc.closedByHand = false;
    labcOpenMaps();
  } else {
    labcCloseMaps();
  }
  if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
}

function labcBuildNav() {
  const nav = labEl('nav', 'labc-tabs');
  nav.setAttribute('aria-label', 'Sections');
  const items = [['standings', 'Standings'], ['maps', 'Maps'], ['guilds', 'Guilds']];
  for (const [key, text] of items) {
    const b = labEl('button', 'labc-tab lab-tap');
    b.type = 'button';
    b.dataset.tab = key;
    b.append(labIcon(LABC_ICON[key], 20), labEl('span', 'labc-tab-label', text));
    b.addEventListener('click', () => labcSetTab(key, true));
    labc.tabBtns[key] = b;
    nav.appendChild(b);
  }
  const stats = labEl('button', 'labc-tab is-later');
  stats.type = 'button';
  stats.disabled = true;
  stats.title = 'Stats come in E4';
  stats.append(labIcon(LABC_ICON.stats, 20), labEl('span', 'labc-tab-label', 'Stats'), labEl('span', 'labc-soon', 'E4'));
  nav.appendChild(stats);
  // A tab is not a click outside the open maps: picking Maps again must not close them.
  nav.addEventListener('click', (e) => e.stopPropagation());
  return nav;
}

// One nav: in the header from 800 px, a bar at the bottom of the window under it.
function labcPlaceNav() {
  const inner = document.querySelector('.lab-header-inner');
  if (labNarrow()) document.body.appendChild(labc.nav);
  else if (inner) inner.appendChild(labc.nav);
}

// ---- Standings: the compact board ------------------------------------------------
function labcCompact(gridEl) {
  for (const card of gridEl.querySelectorAll('.standing-match')) {
    const title = card.querySelector('.standing-match-title');
    if (!title || title.querySelector('.labc-tier-maps')) continue;
    const id = card.dataset.matchId;
    const go = labEl('button', 'labc-tier-maps lab-tap lab-more', 'Maps');
    go.type = 'button';
    const tierText = (title.firstElementChild && title.firstElementChild.textContent) || 'tier';
    go.setAttribute('aria-label', `${tierText} maps`);
    go.addEventListener('click', (e) => {
      e.stopPropagation(); // the maps it opens are not a click outside them
      labc.region = String(id).startsWith('2-') ? 'eu' : 'na';
      labc.tier = id;
      labcSetTab('maps', true);
    });
    const cols = labEl('span', 'labc-cols');
    cols.setAttribute('aria-hidden', 'true');
    cols.append(labEl('span', 'labc-col-vp', 'VP'), labEl('span', 'labc-col-sk', 'Skirmish'));
    title.append(go, cols);
  }
}

// ---- Maps: the pick and the docked popover ---------------------------------------
function labcRegionMatches(region) {
  const prefix = region === 'eu' ? '2-' : '1-';
  const tierOf = (m) => Number(String(m.id).split('-')[1]) || 0;
  return [...matchDataCache.values()]
    .filter((m) => m && typeof m.id === 'string' && m.id.startsWith(prefix))
    .sort((a, b) => tierOf(a) - tierOf(b));
}

function labcBuildMaps() {
  const sec = labEl('section', 'labc-maps');
  sec.id = 'labcMaps';
  sec.setAttribute('aria-label', 'Maps');
  const pick = labEl('div', 'labc-pick');
  const seg = labEl('div', 'labc-seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Region');
  for (const r of ['na', 'eu']) {
    const b = labEl('button', 'labc-seg-btn lab-tap', r.toUpperCase());
    b.type = 'button';
    b.addEventListener('click', () => {
      if (labc.region === r) return;
      labc.region = r;
      labc.tier = null;
      labc.closedByHand = false;
      labcOpenMaps();
    });
    labc.seg[r] = b;
    seg.appendChild(b);
  }
  const tiers = labEl('div', 'labc-tiers');
  tiers.setAttribute('role', 'group');
  tiers.setAttribute('aria-label', 'Tier');
  tiers.appendChild(labEl('span', 'labc-tiers-label', 'Tier'));
  labc.chipRow = labEl('div', 'labc-chips');
  tiers.appendChild(labc.chipRow);
  pick.append(seg, tiers);

  labc.body = labEl('div', 'labc-maps-body');
  labc.quad = labEl('div', 'labc-quad');
  labc.host = labEl('div', 'labc-host');
  labc.body.append(labc.quad, labc.host);

  labc.empty = labEl('div', 'labc-maps-empty');
  sec.append(pick, labc.body, labc.empty);
  // The maps stay open while they are read: a click in here is not a click outside the popover.
  sec.addEventListener('click', (e) => e.stopPropagation());
  return sec;
}

function labcChip(match) {
  let chip = labc.chips.get(match.id);
  if (!chip) {
    const n = String(match.id).split('-')[1] || '?';
    chip = labEl('button', 'labc-chip lab-tap', n);
    chip.type = 'button';
    chip.dataset.matchId = match.id;
    chip.setAttribute('aria-label', `${match.id.startsWith('2-') ? 'EU' : 'NA'} Tier ${n}`);
    chip.addEventListener('click', () => {
      labc.tier = match.id;
      labc.closedByHand = false;
      labcOpenMaps();
    });
    labc.chips.set(match.id, chip);
  }
  return chip;
}

function labcPaintPick() {
  if (!labc.maps) return;
  if (!labc.region) labc.region = railFirst() === 'eu' ? 'eu' : 'na';
  for (const r of ['na', 'eu']) labc.seg[r].setAttribute('aria-pressed', labc.region === r ? 'true' : 'false');
  const list = labcRegionMatches(labc.region);
  if (list.length && !list.some((m) => m.id === labc.tier)) labc.tier = list[0].id;
  const want = list.map(labcChip);
  const now = [...labc.chipRow.children];
  if (want.length !== now.length || want.some((c, i) => c !== now[i])) labc.chipRow.replaceChildren(...want);
  for (const c of want) c.setAttribute('aria-pressed', c.dataset.matchId === labc.tier ? 'true' : 'false');
  return list;
}

function labcSay(text, withButton) {
  labc.empty.textContent = '';
  labc.empty.hidden = !text;
  if (!text) return;
  labc.empty.appendChild(labEl('p', 'labc-maps-note', text));
  if (withButton) {
    const b = labEl('button', 'labc-open lab-tap', 'Show the maps');
    b.type = 'button';
    b.addEventListener('click', () => { labc.closedByHand = false; labcOpenMaps(); });
    labc.empty.appendChild(b);
  }
}

function labcOpenMaps() {
  if (labc.tab !== 'maps') return;
  const list = labcPaintPick() || [];
  const match = list.find((m) => m.id === labc.tier);
  if (!match) {
    if (labc.docked && labc.docked.isConnected) closePopover();
    labcSay('Loading the standings…', false);
    return;
  }
  const chip = labcChip(match);
  if (labc.docked && labc.docked.isConnected && activeTrigger === chip) return;
  labcSay('', false);
  const n = String(match.id).split('-')[1] || '?';
  // toggleTierMaps opens the site's maps popover; labAfterPopoverOpen docks it here.
  toggleTierMaps(match, match.id.startsWith('2-') ? 'EU' : 'NA', n, chip);
  if (!labc.tick) labc.tick = setInterval(labcTick, 1000);
}

function labcCloseMaps() {
  if (labc.docked && labc.docked.isConnected && activePopover === labc.docked) closePopover();
  labcUndock();
}

function labcUndock() {
  labc.docked = null;
  labc.dockedMatch = null;
  labc.cells.clear();
  labc.painted = null;
  labc.quadSeq++;
  labc.quad.textContent = '';
  labc.body.classList.remove('is-quad');
  clearInterval(labc.tick);
  labc.tick = 0;
}

// After the opening's synchronous part: setPopoverExpanded puts its backdrop before the popover
// in <body>, so the popover is still there when it does.
function labcDock(popover, chip) {
  queueMicrotask(() => {
    if (activePopover === popover) labcDockNow(popover, chip);
  });
}

function labcDockNow(popover, chip) {
  const match = matchDataCache.get(chip.dataset.matchId);
  const hadFocus = document.activeElement === popover;
  popover.classList.add('labc-docked');
  labc.host.appendChild(popover);
  if (hadFocus) popover.focus({ preventScroll: true });
  labc.docked = popover;
  labc.dockedMatch = match;
  labcBuildQuad();
}

// The 2x2: buildMapStage once per map, from what the site already fetched for the open popover
// (the outlines and the catalogue are cached); kept live by labcTick from the newest body the page
// holds, which the open popover's own poll keeps current. Without all four, the popover shows whole.
async function labcBuildQuad() {
  const seq = ++labc.quadSeq;
  labc.cells.clear();
  labc.painted = null;
  labc.quad.textContent = '';
  labc.body.classList.remove('is-quad');
  if (!LABC_QUAD_Q.matches || !labc.dockedMatch) return;
  try {
    if (typeof buildMapStage !== 'function') await loadMapsScript();
    const body = newestBodyOf(labc.dockedMatch);
    const maps = MAP_PANEL_ORDER.map((t) => (body.maps || []).find((m) => m.type === t)).filter(Boolean);
    if (!maps.length) return;
    const catalogue = await getObjectiveCatalogue();
    const sectors = await Promise.all(maps.map((m) => getSectors(m.id).catch(() => [])));
    if (seq !== labc.quadSeq) return;
    const cells = [];
    for (let i = 0; i < maps.length; i++) {
      const m = maps[i];
      if (!sectors[i] || !sectors[i].length) return;
      const wrap = buildMapStage(body, m, sectors[i], catalogue, (p) => labcPick(m.type, p));
      if (!wrap) return;
      const sb = buildScoreBar(m, matchIsLive(body));
      if (sb) wrap.appendChild(sb);
      const cell = labEl('figure', 'labc-cell');
      cell.dataset.type = m.type;
      cell.appendChild(wrap);
      cell.appendChild(labEl('figcaption', 'labc-cell-name', MAP_PANEL_NAME[m.type] || m.type));
      labc.cells.set(m.type, wrap);
      cells.push(cell);
    }
    labc.quad.replaceChildren(...cells);
    labc.painted = body;
    labc.body.classList.add('is-quad');
    labcSizeSide();
  } catch {
    labc.body.classList.remove('is-quad');
  }
}

// A marker picked on the 2x2: the same pick in the site's own map (hidden beside it), so its side
// panel shows the objective, follows it live, and keeps its own rules about the pick.
function labcPick(type, p) {
  const pop = labc.docked;
  if (!pop) return;
  const tab = [...pop.querySelectorAll('.wvw-tab')].find((b) => b.dataset.type === type);
  if (tab && !tab.classList.contains('is-active')) tab.click();
  let tries = 0;
  const select = () => {
    const node = [...pop.querySelectorAll('.wvw-plot [data-obj]')].find((g) => g.dataset.obj === p.meta.id);
    if (node) node.dispatchEvent(new MouseEvent('click'));
    else if (++tries < 20) setTimeout(select, 100);
  };
  select();
}

function labcSizeSide() {
  if (!labc.body.classList.contains('is-quad')) return;
  const h = Math.round(labc.quad.getBoundingClientRect().height);
  if (h > 0) labc.body.style.setProperty('--labc-quad-h', `${h}px`);
}

function labcTick() {
  if (labc.tab !== 'maps') return;
  if (labc.docked && !labc.docked.isConnected) {
    // Closed by Escape: say so, and wait for a hand to open it again.
    labcUndock();
    labc.closedByHand = true;
    labcPaintPick();
    labcSay('The maps are closed.', true);
    return;
  }
  if (!labc.docked || !labc.cells.size) return;
  const body = newestBodyOf(labc.dockedMatch);
  if (body === labc.painted) return;
  labc.painted = body;
  const live = matchIsLive(body);
  for (const [type, wrap] of labc.cells) {
    const m = (body.maps || []).find((x) => x.type === type);
    if (!m) continue;
    wrap.applyLive(m, live);
    wrap.ringChanged();
    const old = wrap.querySelector('.wvw-scorebar');
    const sb = buildScoreBar(m, live);
    if (old) old.remove();
    if (sb) wrap.appendChild(sb);
  }
}

// ---- Guilds: the base's search panel, as a tab -----------------------------------
function labcBootGuilds() {
  if (!labShowOnBoard) return;
  // Before the base's own handler, which closes the panel and lets the site mark the team.
  labShowOnBoard.classList.add('lab-more');
  labShowOnBoard.addEventListener('click', () => labcSetTab('standings', true), true);
}

// ---- the hooks -------------------------------------------------------------------
LAB_DESIGNS.c = {
  boot() {
    const html = labcHtml();
    html.classList.add('labc');
    labc.nav = labcBuildNav();
    labcPlaceNav();
    LAB_NARROW_Q.addEventListener('change', labcPlaceNav);
    labc.maps = labcBuildMaps();
    document.getElementById('page').after(labc.maps);
    labcBootGuilds();
    LABC_QUAD_Q.addEventListener('change', () => { if (labc.docked) labcBuildQuad(); });
    window.addEventListener('resize', labcSizeSide);
    window.addEventListener('popstate', () => labcSetTab(labcTabFromHash() || 'standings', false));
    labcSetTab(labcTabFromHash() || 'standings', false);
  },
  afterStandings(gridEl) {
    labcCompact(gridEl);
    if (labc.tab !== 'maps') return;
    if (!labc.docked && !labc.closedByHand) labcOpenMaps();
    else labcPaintPick();
  },
  afterBanner() {
    // The base opens its search in relink week; here the search is the Guilds tab.
    const html = labcHtml();
    if (!html.classList.contains('lab-search-is-open')) return;
    html.classList.remove('lab-search-is-open');
    if (!labcTabFromHash() && labc.tab === 'standings') labcSetTab('guilds', false);
  },
  afterPopoverOpen(popover, triggerEl) {
    if (triggerEl && triggerEl.classList.contains('labc-chip') && labc.tab === 'maps') labcDock(popover, triggerEl);
  },
};
