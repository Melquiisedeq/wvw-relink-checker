'use strict';
// LAB (never merged). The highlights panel, from the page's own live data (newestMatches and the kill
// readings of js/maps-early.js): no request of its own. Up to four tiles (three, and the leaders in a strip
// of their own, with "Own strip"), each with its tier's chip in the same corner, the site's own icon for what it counts, and the colour only on what is a team's. Every
// number says its period. Team names are strangers' text: textContent only.

const LAB_MIN = 60000;
const LAB_STONEMIST = '38-9';
const labNow = () => (typeof steadyNow === 'function' ? steadyNow() : Date.now());
const labNum = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const labRegion = (id) => (String(id).charAt(0) === '1' ? 'NA' : 'EU');
const labCap = (c) => c.charAt(0).toUpperCase() + c.slice(1);

function labKept() {
  if (typeof newestMatches === 'undefined') return [];
  return [...newestMatches.values()]
    .filter((k) => k && k.match && typeof k.match.id === 'string' && Array.isArray(k.match.maps))
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
function labStonemist() {
  const t = labNow();
  let best = null;
  for (const k of labKept()) {
    const ebg = k.match.maps.find((x) => x.type === 'Center');
    const o = ebg && (ebg.objectives || []).find((x) => x.id === LAB_STONEMIST);
    if (!o) continue;
    const color = String(o.owner).toLowerCase();
    if (!COLORS.includes(color)) continue;
    const row = { m: k.match, o, color, name: labTeamName(k.match, color), held: t - Date.parse(o.last_flipped) };
    if (!best || row.held < best.held) best = row;
  }
  return best;
}
// objectiveTier's rule (js/maps.js) on the upgrade lines maps.js fetched for an open map: before the
// first opening there are none, and the lab asks for nothing of its own.
function labUpgrade(o) {
  const cat = typeof upgradeCatalogue !== 'undefined' ? upgradeCatalogue : null;
  const pack = typeof WVW_STATIC === 'object' && WVW_STATIC && Array.isArray(WVW_STATIC.objectives) ? WVW_STATIC.objectives : [];
  const meta = pack.find((x) => x.id === o.id);
  const line = cat && meta && cat.get(meta.upgrade_id);
  if (!line || !Array.isArray(line.tiers)) return null;
  const yaks = Number(o.yaks_delivered || 0);
  let spent = 0;
  let reached = 0;
  for (const tier of line.tiers) {
    const at = spent + Number(tier.yaks_required || 0);
    if (yaks >= at) reached += 1;
    spent = at;
  }
  return { tier: reached, of: line.tiers.length, name: reached ? line.tiers[reached - 1].name : null };
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
// The K/D leader needs this many deaths in the week: a team a few kills in is no record.
const LAB_KD_MIN_DEATHS = 500;
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
    { label: 'Most kills', icon: 'Swords', r: top((r) => r.kills), big: (r) => labNum(r.kills), unit: 'kills', period: 'this week' },
    { label: 'Most VP', icon: 'VP', r: top((r) => r.vp), big: (r) => labNum(r.vp), unit: 'VP', period: 'this week' },
    { label: 'Highest PPT', icon: 'Keep', r: top((r) => r.ppt), big: (r) => labNum(r.ppt), unit: 'points per tick', period: 'now' },
    { label: 'Most active', icon: 'Swords', r: top((r) => r.kills + r.deaths), big: (r) => labNum(r.kills + r.deaths), unit: 'kills + deaths', period: 'this week' },
    { label: 'Best K/D', icon: 'Swords', r: top((r) => r.kills / r.deaths, (r) => r.deaths >= LAB_KD_MIN_DEATHS),
      big: (r) => (r.kills / r.deaths).toFixed(2), unit: 'kills per death', period: `this week · ${LAB_KD_MIN_DEATHS}+ deaths` },
  ];
  return list.filter((x) => x.r && (x.icon === 'VP' || x.r.kills + x.r.deaths + x.r.ppt > 0));
}

// Opens the live map of a match by pressing its own "Live maps" button: the map then sits where it always
// does. A tab or an objective asked for waits in labMapWant until js/maps.js hands over its goTo.
let labMapWant = null;
function labOpenMap(matchId, type, id) {
  if (typeof tierMapButtons === 'undefined') return;
  labMapWant = type ? { matchId, type, id } : null;
  for (const btn of document.querySelectorAll('.tier-map-btn')) {
    const it = tierMapButtons.get(btn);
    if (it && it.match && it.match.id === matchId) { btn.click(); return; }
  }
  labMapWant = null;
}
// The js/maps.js hook, once the opening tab is up: goTo(type, id, select) shows a tab and selects an objective.
function labMapOpened(matchId, goTo) {
  const want = labMapWant;
  labMapWant = null;
  if (!want || want.matchId !== matchId || typeof goTo !== 'function') return;
  try { goTo(want.type, want.id == null ? null : want.id, want.id != null); } catch { /* the map is already up */ }
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
const labChipOf = (id) => labEl('span', 'lt-tier', `${labRegion(id)} · T${String(id).split('-')[1] || '?'}`);

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

// The map's capture rings (.wvw-ring in css/maps.css) round an objective's marker, looping: the Busiest map's
// motion, as the swords are the Hottest fight's.
function labPulse(type, color) {
  const wrap = labEl('span', 'lt-pulse');
  wrap.append(labEl('span', 'lt-pulse-ring'), labEl('span', 'lt-pulse-ring lt-pulse-ring-b'), labIconOf(type, color));
  return wrap;
}
// The castle's marker in its owner's colour, inside a ring of that colour: Stonemist's mark.
function labCastleMark(color) {
  const wrap = labEl('span', `lt-mark side-${color}`);
  wrap.appendChild(labIconOf('Castle', color));
  return wrap;
}
function labFightTile(f) {
  const teams = labEl('span', 'lt-teams');
  for (const c of COLORS) teams.appendChild(labTeamText(labTeamName(f.m, c), c));
  const where = LAB_MAP_LONG[f.type] || f.type;
  const when = f.silence > 3 * LAB_MIN ? `last kill ${labSpan(f.silence)} ago` : 'now';
  return labTile({ cls: 'lt-wide lt-hot', icon: labClash(), label: 'Hottest fight', chip: labChipOf(f.m.id),
    body: [labBig(labNum(f.n), 'kills / 10 min'), labEl('span', 'lt-map', `${where} · ${when}`), teams],
    go: () => labOpenMap(f.m.id, f.type),
    aria: `Hottest fight, ${labTierTag(f.m.id)}: ${labNum(f.n)} kills per 10 minutes on ${where}, ${when}. Open the live map on it` });
}
// "Captures by team": who holds what was taken, as a bar and three counts in the teams' colours.
function labBusyTile(flip) {
  const where = LAB_MAP_LONG[flip.type] || flip.type;
  const aria = `Busiest map, ${labTierTag(flip.m.id)}: ${flip.n} objectives taken in the last 2 hours on ${where}`;
  const go = () => labOpenMap(flip.m.id, flip.type);
  if (labPrefs.busy === 'count') {
    return labTile({ cls: 'lt-wide', icon: labIconOf('Tower'), label: 'Busiest map', chip: labChipOf(flip.m.id),
      body: [labBig(String(flip.n), 'captures'), labEl('span', 'lt-map', `${where} · last 2 h`)], go, aria: `${aria}. Open the live map on it` });
  }
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
  return labTile({ cls: 'lt-wide lt-busy', icon: labPulse(flip.last.type, flip.last.color), label: 'Busiest map', chip: labChipOf(flip.m.id),
    body: [labBig(String(flip.n), flip.n === 1 ? 'objective taken' : 'objectives taken'), labEl('span', 'lt-map', `${where} · last 2 h`), bar, teams],
    go, aria: `${aria}, held now by ${said}. Open the live map on it` });
}
function labHotTile() {
  const f = labPrefs.busyPreview ? null : labHot();
  if (f) return labFightTile(f);
  const flip = labFlips()[0];
  if (flip) return labBusyTile(flip);
  return labTile({ cls: 'lt-wide', icon: labImg('Event_Swords', 'lt-ic lt-ic-img', 16), label: 'Hottest fight', chip: labEl('span', 'lt-tier', 'All tiers'),
    body: [labEl('span', 'lt-map', 'No map with a fight right now')] });
}
// Three faces, the Hottest fight's shape (a small mark by the label, one thing big, a line of context):
// the owner's name, the time held, or the yaks delivered since it was taken (the API's yaks_delivered,
// which a capture sets back to 0).
function labStonemistTile() {
  const sm = labStonemist();
  if (!sm) return null;
  const up = labUpgrade(sm.o);
  const held = labSpan(sm.held);
  const yaks = Number(sm.o.yaks_delivered);
  const face = labPrefs.stone === 'yaks' && !Number.isFinite(yaks) ? 'owner' : labPrefs.stone;
  const owner = labEl('span', `lt-owner-name side-${sm.color}`, sm.name);
  const by = labEl('span', 'lt-teams');
  by.appendChild(labTeamText(sm.name, sm.color));
  const body = face === 'time' ? [labBig(held, 'held'), labEl('span', 'lt-map', 'Eternal Battlegrounds'), by]
    : face === 'yaks' ? [labBig(labNum(yaks), yaks === 1 ? 'yak since taken' : 'yaks since taken'), labEl('span', 'lt-map', `Held ${held}`), by]
      : [owner, labEl('span', 'lt-map', `Held ${held} · Eternal Battlegrounds`)];
  if (up) body.push(labEl('span', 'lt-line', up.tier ? `${up.name} · tier ${up.tier} of ${up.of}` : 'Not upgraded'));
  return labTile({ cls: `lt-stone lt-stone-${face}`, icon: labCastleMark(sm.color), label: 'Stonemist', chip: labChipOf(sm.m.id), body,
    go: () => labOpenMap(sm.m.id, 'Center', LAB_STONEMIST),
    aria: `Stonemist Castle, ${labTierTag(sm.m.id)}: held by ${sm.name} for ${held}${face === 'yaks' ? `, ${labNum(yaks)} yaks delivered since` : ''}. Open the live map on it` });
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

// ---- the week's leaders: a fixed list in a tile ("Static list"), the same list in a strip of its own
// under the grid ("Own strip"), or one at a time every LAB_ROT_MS with a pause button first in the Tab order ----
const LAB_ROT_MS = 7000;
const labRot = { idx: 0, timer: 0, hover: false, focus: false, paused: false, n: 0 };
const labStill = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function labLeaderRow(x) {
  const row = labEl('span', 'lt-lead');
  const what = labEl('span', 'lt-lead-what');
  what.append(labIconOf(x.icon), labEl('span', null, x.label));
  const val = labEl('span', 'lt-lead-val', x.big(x.r));
  row.append(what, labTeamText(x.r.name, x.r.color), val);
  return row;
}
function labLeadersList(list, cls) {
  const box = labEl('div', `lt-leads ${cls}`);
  box.setAttribute('aria-hidden', 'true');
  for (const x of list) box.appendChild(labLeaderRow(x));
  return box;
}
const labLeadersSaid = (list) => list.map((x) => `${x.label}, ${x.period}: ${x.r.name}, ${x.big(x.r)} ${x.unit}, ${labTierTag(x.r.m.id)}.`).join(' ');
function labLeadersStatic(list) {
  const box = labEl('div', 'lt-tile lt-wide lt-leaders');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Leaders this week');
  const top = labEl('span', 'lt-top');
  const label = labEl('span', 'lt-label');
  label.append(labIconOf('Keep'), labEl('span', null, 'Leaders'));
  top.append(label, labEl('span', 'lt-tier', 'This week'));
  box.append(labEl('span', 'sr-only', labLeadersSaid(list)), top, labLeadersList(list, ''), labEl('span', 'lt-line', 'All tiers, NA and EU · PPT now'));
  return box;
}
function labLeadersStrip(list) {
  const box = labEl('section', 'lt-strip');
  box.setAttribute('aria-label', 'This week’s leaders');
  const head = labEl('div', 'lt-strip-head');
  head.append(labEl('span', null, 'This week’s leaders'), labEl('span', 'lt-strip-note', 'All tiers · PPT now'));
  box.append(head, labEl('span', 'sr-only', labLeadersSaid(list)), labLeadersList(list, 'lt-leads-strip'));
  return box;
}
function labRotShow(i) {
  const box = document.querySelector('.lt-rot');
  if (!box) return;
  labRot.idx = i;
  box.querySelectorAll('.lt-slide').forEach((s, k) => s.classList.toggle('is-on', k === i));
  box.querySelectorAll('.lt-pip').forEach((b, k) => b.setAttribute('aria-pressed', k === i ? 'true' : 'false'));
}
function labRotTick() {
  if (labPrefs.leaders !== 'rot' || labRot.paused || labRot.hover || labRot.focus || document.hidden || labStill() || labRot.n < 2) return;
  labRotShow((labRot.idx + 1) % labRot.n);
}
function labRotPaint(b = document.querySelector('.lt-rot-pause')) {
  if (!b) return;
  const stopped = labRot.paused || labStill();
  b.setAttribute('aria-label', stopped ? 'Play the leaders' : 'Pause the leaders');
  b.textContent = '';
  b.appendChild(labIcon(stopped ? ['M8 6l10 6-10 6Z'] : ['M8 6v12', 'M16 6v12'], 'lt-rot-svg'));
}
function labLeadersRotating(list) {
  labRot.n = list.length;
  if (labRot.idx >= list.length || labStill()) labRot.idx = 0;
  const box = labEl('div', 'lt-tile lt-wide lt-rot');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-roledescription', 'carousel');
  box.setAttribute('aria-label', 'Leaders this week');
  const pause = labEl('button', 'lt-rot-pause');
  pause.type = 'button';
  pause.addEventListener('click', () => { labRot.paused = !labRot.paused; labRotPaint(); });
  const said = labEl('span', 'sr-only', labLeadersSaid(list));
  const slides = labEl('div', 'lt-slides');
  slides.setAttribute('aria-hidden', 'true');
  list.forEach((x, k) => {
    const s = labEl('div', `lt-slide${k === labRot.idx ? ' is-on' : ''}`);
    const top = labEl('span', 'lt-top');
    const label = labEl('span', 'lt-label');
    label.append(labIconOf(x.icon), labEl('span', null, `${x.label} · ${x.period}`));
    top.append(label, labChipOf(x.r.m.id));
    const who = labEl('span', 'lt-rot-row');
    who.append(labTeamText(x.r.name, x.r.color), labBig(x.big(x.r), x.unit));
    s.append(top, who);
    slides.appendChild(s);
  });
  const pips = labEl('div', 'lt-pips');
  // First in the row, so first in the Tab order.
  pips.appendChild(pause);
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
  box.append(said, slides, pips);
  labRotPaint(pause);
  if (!labRot.timer) labRot.timer = setInterval(labRotTick, LAB_ROT_MS);
  return box;
}
function labLeadersTile(list) {
  if (!list.length || labPrefs.leaders === 'strip') return null;
  return labPrefs.leaders === 'rot' ? labLeadersRotating(list) : labLeadersStatic(list);
}

const labTierTag = (id) => `${labRegion(id)} · T${String(id).split('-')[1] || '?'}`;
function labTilesPanel() {
  const panel = labEl('section', 'lt-panel');
  panel.setAttribute('aria-label', 'Highlights');
  panel.appendChild(labEl('div', 'lt-head', 'Highlights'));
  const grid = labEl('div', `lt-grid${labPrefs.grid2 ? ' lt-grid-2' : ''}`);
  const leaders = labLeaders();
  const tiles = [labHotTile(), labStonemistTile(), labClosestTile(), labLeadersTile(leaders)].filter(Boolean);
  for (const t of tiles) grid.appendChild(t);
  grid.classList.add(`lt-n${tiles.length}`);
  panel.appendChild(grid);
  if (labPrefs.leaders === 'strip' && leaders.length) panel.appendChild(labLeadersStrip(leaders));
  return panel;
}
