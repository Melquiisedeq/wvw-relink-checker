'use strict';
// LAB (never merged). The highlights panel, from the page's own live data (newestMatches and the kill
// readings of js/maps-early.js): no request of its own. Only the region the page puts first
// (data-rail-first, js/region.js): the Hottest fight and the Busiest map side by side, the Closest match
// under them, and the week's leaders one at a time in a box of their own below. Team names are strangers'
// text: textContent only.

const LAB_MIN = 60000;
const labNow = () => (typeof steadyNow === 'function' ? steadyNow() : Date.now());
const labNum = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const labRegion = (id) => (String(id).charAt(0) === '1' ? 'NA' : 'EU');
// The region the page puts first (railFirst, js/dom.js): the only one the highlights cover.
const labRegionFirst = () => (typeof railFirst === 'function' ? railFirst() : 'na').toUpperCase();
const labCap = (c) => c.charAt(0).toUpperCase() + c.slice(1);

function labKept() {
  if (typeof newestMatches === 'undefined') return [];
  return [...newestMatches.values()]
    .filter((k) => k && k.match && typeof k.match.id === 'string' && Array.isArray(k.match.maps))
    .filter((k) => labRegion(k.match.id) === labRegionFirst())
    .sort((a, b) => (a.match.id < b.match.id ? -1 : 1));
}
function labTeamName(m, color) {
  const id = typeof matchTeamId === 'function' ? matchTeamId(m, color) : null;
  return id ? getTeamName(id) : labCap(color);
}
function labTeams(m) {
  return COLORS.map((c) => ({
    color: c, name: labTeamName(m, c),
    vp: Number((m.victory_points || {})[c]) || 0,
    score: Number((m.scores || {})[c]) || 0,
    kills: Number((m.kills || {})[c]) || 0,
  }));
}

// The live map's own pick (hotMapOf, js/maps-early.js) on every running match: the map whose swords are
// lit with the most kills per 10 min. The data holds the three teams' kills together per map, not each
// team's over a window, so the number is the map's and the three teams are named alike.
function labHot() {
  if (typeof hotMapOf !== 'function') return null;
  let best = null;
  for (const k of labKept()) {
    let v;
    try { v = hotMapOf(k.match); } catch { continue; }
    if (!v || !v.hot || !v.rates) continue;
    const n = v.rates.per.get(v.hot) || 0;
    if (!best || n > best.n) best = { m: k.match, type: v.hot, n, silence: v.view.silence };
  }
  return best;
}
// Objectives that changed hands in the last 2 h, per map: what stands in for a fight with no readings. An
// objective's owner now is the team that took it last, and an objective taken twice counts once: the API
// keeps only its last flip.
function labFlips() {
  const t = labNow();
  const out = [];
  for (const k of labKept()) {
    const m = k.match;
    const week = Date.parse(m.start_time) || 0;
    for (const map of m.maps) {
      const by = { red: 0, blue: 0, green: 0 };
      let n = 0;
      let last = null;
      for (const o of map.objectives || []) {
        const at = Date.parse(o && o.last_flipped);
        if (!Number.isFinite(at) || o.type === 'Ruins' || o.type === 'Spawn' || at > t || t - at > 2 * 60 * LAB_MIN || at <= week + LAB_MIN) continue;
        const c = String(o.owner || '').toLowerCase();
        if (!(c in by)) continue;
        by[c] += 1;
        n += 1;
        if (!last || at > last.at) last = { at, type: o.type, color: c };
      }
      if (n) out.push({ m, type: map.type, n, by, last });
    }
  }
  return out.sort((a, b) => b.n - a.n);
}
function labClosest() {
  let best = null;
  for (const k of labKept()) {
    const r = labTeams(k.match).sort((a, b) => b.vp - a.vp || b.score - a.score);
    const gap = r[0].vp - r[1].vp;
    if (!best || gap < best.gap) best = { m: k.match, gap, a: r[0], b: r[1] };
  }
  return best;
}
// Points per tick: what each colour's objectives are worth now, summed over the maps (tallyMaps, js/maps.js).
function labPpt(m) {
  const by = { red: 0, blue: 0, green: 0 };
  if (typeof matchIsLive === 'function' && !matchIsLive(m)) return by;
  for (const map of m.maps || []) {
    for (const ob of (map && map.objectives) || []) {
      const c = String(ob.owner || '').toLowerCase();
      if (c in by) by[c] += Number(ob.points_tick || 0);
    }
  }
  return by;
}
// The K/D leader needs this many deaths in the week: a team that has barely played is no record. Not
// shown: every team past the first hours of a week is far over it.
const LAB_KD_MIN_DEATHS = 500;
// The site's own marks, one per measure: the map's swords for kills, the card's Activity bolt
// (js/stat-popovers.js), the score-trend line (js/stat-popovers.js) for the points that feed the score,
// the card's own "VP" label for VP, and K/D as the card writes it.
const LAB_BOLT = ['M13 2 L4 14 h6 l-1 8 l9 -12 h-6 Z'];
const LAB_TREND = ['M3 17 L9 10 L14 14 L21 5'];
function labLeaders() {
  const rows = [];
  for (const k of labKept()) {
    const m = k.match;
    const ppt = labPpt(m);
    for (const c of COLORS) {
      rows.push({ m, color: c, name: labTeamName(m, c), ppt: ppt[c],
        kills: Number((m.kills || {})[c]) || 0, deaths: Number((m.deaths || {})[c]) || 0,
        vp: Number((m.victory_points || {})[c]) || 0 });
    }
  }
  const top = (f, ok = () => true) => rows.filter(ok).reduce((b, r) => (!b || f(r) > f(b) ? r : b), null);
  const list = [
    { label: 'Most kills', icon: () => labImg('Event_Swords', 'lt-ic lt-ic-img', 16), r: top((r) => r.kills), big: (r) => labNum(r.kills), unit: 'kills', period: 'this week' },
    { label: 'Most VP', icon: () => labIconOf('VP'), r: top((r) => r.vp), big: (r) => labNum(r.vp), unit: 'VP', period: 'this week' },
    { label: 'Highest PPT', icon: () => labIcon(LAB_TREND, 'lt-ic lt-ic-svg'), r: top((r) => r.ppt), big: (r) => labNum(r.ppt), unit: 'points per tick', period: 'now' },
    { label: 'Most active', icon: () => labIcon(LAB_BOLT, 'lt-ic lt-ic-svg'), r: top((r) => r.kills + r.deaths), big: (r) => labNum(r.kills + r.deaths), unit: 'kills + deaths', period: 'this week' },
    { label: 'Best K/D', kd: true, r: top((r) => r.kills / r.deaths, (r) => r.deaths >= LAB_KD_MIN_DEATHS),
      big: (r) => (r.kills / r.deaths).toFixed(2), unit: 'kills per death', period: 'this week' },
  ];
  return list.filter((x) => x.r && (x.unit === 'VP' || x.r.kills + x.r.deaths + x.r.ppt > 0));
}

// Opens the live map of a match on one of its tabs by pressing the match's own "Live maps" button: the map
// then sits where it always does. The tab waits in labMapWant until js/maps.js hands over its goTo.
let labMapWant = null;
function labOpenMap(matchId, type) {
  if (typeof tierMapButtons === 'undefined') return;
  labMapWant = type ? { matchId, type } : null;
  for (const btn of document.querySelectorAll('.tier-map-btn')) {
    const it = tierMapButtons.get(btn);
    if (it && it.match && it.match.id === matchId) { btn.click(); return; }
  }
  labMapWant = null;
}
// The js/maps.js hook, once the opening tab is up: goTo(type) shows a tab.
function labMapOpened(matchId, goTo) {
  const want = labMapWant;
  labMapWant = null;
  if (!want || want.matchId !== matchId || typeof goTo !== 'function') return;
  try { goTo(want.type, null, false); } catch { /* the map is already up */ }
}

function labDot(color) { return labEl('span', `lab-dot lab-dot-${color}`); }
function labTeamText(name, color) {
  const s = labEl('span', 'lab-team');
  s.append(labDot(color), labEl('span', null, name));
  return s;
}
function labImg(file, cls, size) {
  const img = labEl('img', cls);
  img.src = `assets/icons/${file}.webp`;
  img.alt = '';
  img.width = size;
  img.height = size;
  return img;
}
// strikeSwords (js/maps.js) copied: js/maps.js loads with the first map, the highlights before it. Its
// css (.wvw-clash*) is in css/maps.css, loaded from the start.
function labClash() {
  const wrap = labEl('span', 'lt-clash');
  const box = labEl('span', 'wvw-clash');
  box.append(labImg('Event_Swords_back', 'wvw-clash-sword is-back', 14), labImg('Event_Swords_up', 'wvw-clash-sword is-up', 14),
    labEl('span', 'wvw-clash-flash'), labEl('span', 'wvw-clash-shine'));
  for (let i = 0; i < 5; i++) box.appendChild(labEl('span', `wvw-clash-spark wvw-clash-spark-${i}`));
  wrap.appendChild(box);
  return wrap;
}
function labIconOf(kind, color) {
  if (kind === 'VP') return labEl('span', 'lt-ic lt-ic-vp', 'VP');
  return labImg(`Event_${kind}${COLORS.includes(color) ? `_${color}` : ''}`, 'lt-ic lt-ic-img', 16);
}
const labTierNo = (id) => String(id).split('-')[1] || '?';
const labTierTag = (id) => `${labRegion(id)} · T${labTierNo(id)}`;
// The region is in the panel's title: the chip names the tier alone.
const labChipOf = (id) => labEl('span', 'lt-tier', `T${labTierNo(id)}`);

// One tile: the icon and what it counts in the top row with the tier's chip in the far corner, then what
// the tile builds. A tile with t.go is a button.
function labTile(t) {
  const el = labEl(t.go ? 'button' : 'div', `lt-tile${t.cls ? ` ${t.cls}` : ''}`);
  if (t.go) {
    el.type = 'button';
    el.setAttribute('aria-label', t.aria);
    // Kept from the document: the press that opens the map would otherwise reach the map's outside-click close.
    el.addEventListener('click', (e) => { e.stopPropagation(); t.go(); });
  }
  const top = labEl('span', 'lt-top');
  const label = labEl('span', 'lt-label');
  if (t.icon) label.appendChild(t.icon);
  label.appendChild(labEl('span', null, t.label));
  top.append(label, t.chip);
  el.appendChild(top);
  for (const n of t.body) el.appendChild(n);
  return el;
}
function labBig(num, unit) {
  const big = labEl('span', 'lt-big');
  big.append(labEl('span', 'lt-num', num), labEl('span', 'lt-unit', unit));
  return big;
}
const LAB_MAP_LONG = { Center: 'Eternal Battlegrounds', RedHome: 'Red Borderlands', BlueHome: 'Blue Borderlands', GreenHome: 'Green Borderlands' };

// The map's capture ring (.wvw-ring in css/maps.css) round an objective's marker: the Busiest map's motion,
// as the swords are the Hottest fight's. "slow": one ping every 4 s; "once": one ping when the tile first
// shows and when its count changes (a repaint with the same count plays nothing); "still": none.
let labBusyShown = '';
function labPulse(type, color, key) {
  const motion = labPrefs.busyMotion;
  const fresh = key !== labBusyShown;
  labBusyShown = key;
  const wrap = labEl('span', 'lt-pulse');
  if (motion === 'slow' || (motion === 'once' && fresh)) wrap.appendChild(labEl('span', `lt-pulse-ring lt-pulse-${motion}`));
  wrap.appendChild(labIconOf(type, color));
  return wrap;
}
function labFightTile(f, solo) {
  const teams = labEl('span', 'lt-teams');
  for (const c of COLORS) teams.appendChild(labTeamText(labTeamName(f.m, c), c));
  const where = LAB_MAP_LONG[f.type] || f.type;
  const when = f.silence > 3 * LAB_MIN ? `last kill ${labSpan(f.silence)} ago` : 'now';
  return labTile({ cls: `lt-hot${solo ? ' lt-solo' : ''}`, icon: labClash(), label: 'Hottest fight', chip: labChipOf(f.m.id),
    body: [labBig(labNum(f.n), 'kills / 10 min'), labEl('span', 'lt-map', `${where} · ${when}`), teams],
    go: () => labOpenMap(f.m.id, f.type),
    aria: `Hottest fight, ${labTierTag(f.m.id)}: ${labNum(f.n)} kills per 10 minutes on ${where}, ${when}. Open the live map on it` });
}
// Who holds what was taken, as a bar and three counts in the teams' colours.
function labBusyTile(flip, solo) {
  const where = LAB_MAP_LONG[flip.type] || flip.type;
  const order = COLORS.slice().sort((a, b) => flip.by[b] - flip.by[a]);
  const bar = labEl('span', 'lt-split');
  for (const c of order) {
    if (!flip.by[c]) continue;
    const seg = labEl('span', `lt-seg lab-dot-${c}`);
    seg.style.flexGrow = String(flip.by[c]);
    bar.appendChild(seg);
  }
  const teams = labEl('span', 'lt-takers');
  for (const c of order) {
    const row = labEl('span', `lt-taker side-${c}`);
    row.append(labTeamText(labTeamName(flip.m, c), c), labEl('b', 'lt-taker-n', String(flip.by[c])));
    teams.appendChild(row);
  }
  const said = order.map((c) => `${labTeamName(flip.m, c)} ${flip.by[c]}`).join(', ');
  const icon = labPulse(flip.last.type, flip.last.color, `${flip.m.id}|${flip.type}|${flip.n}`);
  return labTile({ cls: `lt-busy${solo ? ' lt-solo' : ''}`, icon, label: 'Busiest map', chip: labChipOf(flip.m.id),
    body: [labBig(String(flip.n), flip.n === 1 ? 'objective taken' : 'objectives taken'), labEl('span', 'lt-map', `${where} · last 2 h`), bar, teams],
    go: () => labOpenMap(flip.m.id, flip.type),
    aria: `Busiest map, ${labTierTag(flip.m.id)}: ${flip.n} objectives taken in the last 2 hours on ${where}, held now by ${said}. Open the live map on it` });
}
// The fight and the busiest map, side by side; either alone takes the row. "The next busiest map" skips
// the fight's own map.
function labTopTiles() {
  const f = labHot();
  const flips = labFlips();
  const flip = f && labPrefs.busySame === 'next' ? flips.find((x) => !(x.m.id === f.m.id && x.type === f.type)) : flips[0];
  const both = !!(f && flip);
  return [f && labFightTile(f, !both), flip && labBusyTile(flip, !both)].filter(Boolean);
}
function labClosestTile() {
  const c = labClosest();
  if (!c) return null;
  const total = c.a.vp + c.b.vp;
  const bar = labEl('span', 'lt-split');
  for (const x of [c.a, c.b]) {
    const seg = labEl('span', `lt-seg lab-dot-${x.color}`);
    seg.style.flexGrow = String(total ? x.vp / total : 0.5);
    bar.appendChild(seg);
  }
  const rows = labEl('span', 'lt-vprows');
  for (const x of [c.a, c.b]) {
    const row = labEl('span', 'lt-vprow');
    const vp = labEl('span', 'lt-vp', labNum(x.vp));
    vp.appendChild(labEl('span', 'stat-label', ' VP'));
    row.append(labTeamText(x.name, x.color), vp);
    rows.appendChild(row);
  }
  return labTile({ cls: 'lt-close', label: 'Closest match', chip: labChipOf(c.m.id),
    body: [labBig(labNum(c.gap), 'VP apart'), bar, rows, labEl('span', 'lt-line', 'Top two · this week')],
    go: () => labGoToTier([c.a.name, c.b.name]),
    aria: `Closest match, ${labTierTag(c.m.id)}: ${c.a.name} ${labNum(c.a.vp)} VP and ${c.b.name} ${labNum(c.b.vp)} VP, ${labNum(c.gap)} apart this week. Show them in the standings` });
}

// ---- the week's leaders: one at a time every LAB_ROT_MS in a box under the tiles, with a pause button
// first in the Tab order; the pointer over it, the focus in it, a touch on it or reduced motion stop it ----
const LAB_ROT_MS = 5000;
const labRot = { idx: 0, timer: 0, hover: false, focus: false, paused: false, n: 0 };
const labStill = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const labLeadersSaid = (list) => list.map((x) => `${x.label}, ${x.period}: ${x.r.name}, ${x.big(x.r)} ${x.unit}, ${labTierTag(x.r.m.id)}.`).join(' ');
function labRotShow(i) {
  const box = document.querySelector('.lt-rot');
  if (!box) return;
  labRot.idx = i;
  box.querySelectorAll('.lt-slide').forEach((s, k) => s.classList.toggle('is-on', k === i));
  box.querySelectorAll('.lt-pip').forEach((b, k) => b.setAttribute('aria-pressed', k === i ? 'true' : 'false'));
}
function labRotTick() {
  if (labRot.paused || labRot.hover || labRot.focus || document.hidden || labStill() || labRot.n < 2) return;
  labRotShow((labRot.idx + 1) % labRot.n);
}
function labRotPaint(b = document.querySelector('.lt-rot-pause')) {
  if (!b) return;
  const stopped = labRot.paused || labStill();
  b.setAttribute('aria-label', stopped ? 'Play the leaders' : 'Pause the leaders');
  b.textContent = '';
  b.appendChild(labIcon(stopped ? ['M8 6l10 6-10 6Z'] : ['M8 6v12', 'M16 6v12'], 'lt-rot-svg'));
}
// One metric: its mark and what it measures with the tier's chip, then the team in its colour and the number big.
// K/D is written as the card writes it: "K/D" before the number, the number green above 1 and red below.
function labLeaderSlide(x, on) {
  const s = labEl('div', `lt-slide${on ? ' is-on' : ''}`);
  const top = labEl('span', 'lt-top');
  const label = labEl('span', 'lt-label');
  if (x.icon) label.appendChild(x.icon());
  label.appendChild(labEl('span', null, `${x.label} · ${x.period}`));
  top.append(label, labChipOf(x.r.m.id));
  const who = labEl('span', `lt-rot-row side-${x.r.color}`);
  const name = labTeamText(x.r.name, x.r.color);
  name.classList.add('lt-rot-team');
  let big;
  if (x.kd) {
    big = labEl('span', 'lt-big lt-kd');
    const n = labEl('span', 'lt-num', x.big(x.r));
    if (x.r.kills !== x.r.deaths) n.classList.add(x.r.kills > x.r.deaths ? 'kd-good' : 'kd-bad');
    big.append(labEl('span', 'stat-label', 'K/D'), n);
  } else {
    big = labBig(x.big(x.r), x.unit);
  }
  who.append(name, big);
  s.append(top, who);
  return s;
}
function labLeadersBox(list) {
  if (!list.length) return null;
  labRot.n = list.length;
  if (labRot.idx >= list.length || labStill()) labRot.idx = 0;
  const box = labEl('section', 'lt-tile lt-rot');
  box.setAttribute('aria-roledescription', 'carousel');
  box.setAttribute('aria-label', 'Leaders this week');
  const head = labEl('div', 'lt-rot-head');
  head.append(labEl('span', null, 'Leaders'), labEl('span', 'lt-rot-note', 'All tiers'));
  const pause = labEl('button', 'lt-rot-pause');
  pause.type = 'button';
  pause.addEventListener('click', () => { labRot.paused = !labRot.paused; labRotPaint(); });
  const slides = labEl('div', 'lt-slides');
  slides.setAttribute('aria-hidden', 'true');
  list.forEach((x, k) => slides.appendChild(labLeaderSlide(x, k === labRot.idx)));
  const pips = labEl('div', 'lt-pips');
  list.forEach((x, k) => {
    const b = labEl('button', 'lt-pip');
    b.type = 'button';
    b.setAttribute('aria-label', x.label);
    b.setAttribute('aria-pressed', k === labRot.idx ? 'true' : 'false');
    b.addEventListener('click', () => labRotShow(k));
    pips.appendChild(b);
  });
  box.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') labRot.hover = true; });
  box.addEventListener('pointerleave', () => { labRot.hover = false; });
  // A touch has no hover to end: it stops the turning as the button does.
  box.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && !labRot.paused) { labRot.paused = true; labRotPaint(); } });
  box.addEventListener('focusin', () => { labRot.focus = true; });
  box.addEventListener('focusout', () => { labRot.focus = false; });
  // The pause button first in the box, so first in the Tab order.
  const ctl = labEl('div', 'lt-rot-ctl');
  ctl.append(pause, pips);
  box.append(head, labEl('span', 'sr-only', labLeadersSaid(list)), slides, ctl);
  labRotPaint(pause);
  if (!labRot.timer) labRot.timer = setInterval(labRotTick, LAB_ROT_MS);
  return box;
}

function labTilesPanel() {
  const region = labRegionFirst();
  const panel = labEl('section', 'lt-panel');
  panel.setAttribute('aria-label', `Highlights, ${region}`);
  panel.appendChild(labEl('div', 'lt-head', `Highlights · ${region}`));
  const grid = labEl('div', 'lt-grid');
  for (const t of [...labTopTiles(), labClosestTile()].filter(Boolean)) grid.appendChild(t);
  panel.appendChild(grid);
  const leaders = labLeadersBox(labLeaders());
  if (leaders) panel.appendChild(leaders);
  return panel;
}
