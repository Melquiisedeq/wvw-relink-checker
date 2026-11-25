'use strict';
// LAB (never merged). The highlights panel, from the page's own live data (newestMatches and the kill
// readings of js/maps-early.js): no request of its own. One region, the page's first or the one picked on
// the panel's switch: the Hottest fight and the Busiest map side by side, the Closest match under them, and
// the week's leaders one at a time, in a box of their own above the tiles. Team names are strangers' text: textContent
// only.

const LAB_MIN = 60000;
const labNow = () => (typeof steadyNow === 'function' ? steadyNow() : Date.now());
const labNum = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const labRegion = (id) => (String(id).charAt(0) === '1' ? 'NA' : 'EU');
// The region the highlights cover: the one picked on their own NA | EU switch, else the one the page puts
// first (railFirst, js/dom.js). Swapping the page's columns drops the pick (js/lab.js): the last action wins.
// Not kept between visits.
let labRegionPick = null;
const labRegionFirst = () => labRegionPick || (typeof railFirst === 'function' ? railFirst() : 'na').toUpperCase();
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
// lit with the most kills per 10 min. With no swords lit in the region, the map with the most kills per
// 10 min all the same, marked calm. Null while no match has a kill rate yet. The data holds the three
// teams' kills together per map, not each team's over a window, so the number is the map's and the three
// teams are named alike.
function labHot() {
  if (typeof hotMapOf !== 'function') return null;
  let best = null;
  let calm = null;
  for (const k of labKept()) {
    let v;
    try { v = hotMapOf(k.match); } catch { continue; }
    if (!v || !v.rates) continue;
    if (v.hot) {
      const n = v.rates.per.get(v.hot) || 0;
      if (!best || n > best.n) best = { m: k.match, type: v.hot, n, silence: v.view.silence };
      continue;
    }
    for (const [type, n] of v.rates.per) {
      if (!calm || n > calm.n) calm = { m: k.match, type, n, silence: v.view.silence, calm: true };
    }
  }
  return best || calm;
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
    { label: 'Most kills', short: 'Kills', icon: () => labImg('Event_Swords', 'lt-ic lt-ic-img', 16), r: top((r) => r.kills), val: (r) => r.kills, big: (r) => labNum(r.kills), unit: 'kills', period: 'this week' },
    { label: 'Most VP', short: 'VP', icon: () => labIconOf('VP'), r: top((r) => r.vp), val: (r) => r.vp, big: (r) => labNum(r.vp), unit: 'VP', period: 'this week' },
    { label: 'Highest PPT', short: 'PPT', icon: () => labIcon(LAB_TREND, 'lt-ic lt-ic-svg'), r: top((r) => r.ppt), val: (r) => r.ppt, big: (r) => labNum(r.ppt), unit: 'points per tick', period: 'now' },
    { label: 'Most active', short: 'Active', icon: () => labIcon(LAB_BOLT, 'lt-ic lt-ic-svg'), r: top((r) => r.kills + r.deaths), val: (r) => r.kills + r.deaths, big: (r) => labNum(r.kills + r.deaths), unit: 'kills + deaths', period: 'this week' },
    { label: 'Best K/D', short: 'K/D', kd: true, r: top((r) => r.kills / r.deaths, (r) => r.deaths >= LAB_KD_MIN_DEATHS),
      val: (r) => r.kills / r.deaths, big: (r) => (r.kills / r.deaths).toFixed(2), unit: 'kills per death', period: 'this week' },
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
  // The shine's band moves inside the swords' mask by transform (.lt-clash-band, css/lab-mid.css).
  const shine = labEl('span', 'wvw-clash-shine');
  shine.appendChild(labEl('span', 'lt-clash-band'));
  box.append(labImg('Event_Swords_back', 'wvw-clash-sword is-back', 14), labImg('Event_Swords_up', 'wvw-clash-sword is-up', 14),
    labEl('span', 'wvw-clash-flash'), shine);
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

// The map's capture ring (.wvw-ring in css/maps.css) round an objective's marker, one ping on every blow of
// the swords (css/lab-mid.css): the Busiest map's motion, as the swords are the Hottest fight's.
function labPulse(type, color) {
  const wrap = labEl('span', 'lt-pulse');
  wrap.append(labEl('span', 'lt-pulse-ring'), labIconOf(type, color));
  return wrap;
}
// The orange shine across the Hottest number, drawn on the compositor: a soft band (.lt-shine, its mask) slides
// over the number and carries a bright copy of it that slides back as far (.lt-shine-in), so the copy stays on
// the digits while the band crosses them (css/lab-mid.css).
function labShine(big) {
  const num = big.querySelector('.lt-num');
  if (!num) return big;
  const win = labEl('span', 'lt-shine');
  win.setAttribute('aria-hidden', 'true');
  win.appendChild(labEl('span', 'lt-shine-in', num.textContent));
  num.appendChild(win);
  return big;
}
// A calm pick (no swords lit in the region) wears grey, still swords and a white number.
function labFightTile(f) {
  const teams = labEl('span', 'lt-teams');
  for (const c of COLORS) teams.appendChild(labTeamText(labTeamName(f.m, c), c));
  const where = LAB_MAP_LONG[f.type] || f.type;
  const when = f.calm ? 'quiet now' : (f.silence > 3 * LAB_MIN ? `last kill ${labSpan(f.silence)} ago` : 'now');
  return labTile({ cls: `lt-hot${f.calm ? ' lt-calm' : ''}`, icon: labClash(), label: 'Hottest fight', chip: labChipOf(f.m.id),
    body: [labShine(labBig(labNum(f.n), 'kills / 10 min')), labEl('span', 'lt-map', `${where} · ${when}`), teams],
    go: () => labOpenMap(f.m.id, f.type),
    aria: `Hottest fight, ${labTierTag(f.m.id)}: ${labNum(f.n)} kills per 10 minutes on ${where}, ${when}. Open the live map on it` });
}
// No kill rate yet: the site's own spinner (.spinner, css/base.css).
function labFightWait() {
  const line = labEl('span', 'lt-map lt-wait');
  line.append(labEl('span', 'spinner'), 'Reading the kills…');
  return labTile({ cls: 'lt-hot lt-calm', icon: labClash(), label: 'Hottest fight', chip: labEl('span'), body: [line] });
}
// Who holds what was taken, as a bar and three counts in the teams' colours.
function labBusyTile(flip) {
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
  const icon = labPulse(flip.last.type, flip.last.color);
  return labTile({ cls: 'lt-busy', icon, label: 'Busiest map', chip: labChipOf(flip.m.id),
    body: [labBig(String(flip.n), flip.n === 1 ? 'objective taken' : 'objectives taken'), labEl('span', 'lt-map', `${where} · last 2 h`), bar, teams],
    go: () => labOpenMap(flip.m.id, flip.type),
    aria: `Busiest map, ${labTierTag(flip.m.id)}: ${flip.n} objectives taken in the last 2 hours on ${where}, held now by ${said}. Open the live map on it` });
}
// The fight, always, and the busiest map beside it, the fight's own map included.
function labTopTiles() {
  const f = labHot();
  const flip = labFlips()[0];
  return [f ? labFightTile(f) : labFightWait(), flip && labBusyTile(flip)].filter(Boolean);
}
// ---- the Closest match and its skirmish ----------------------------------------------------
// The victory points of a skirmish [1st, 2nd, 3rd] by region (the id's first digit: 1 NA, 2 EU) and the UTC
// hour it starts, 00 to 22 (https://wiki.guildwars2.com/wiki/World_versus_World, "Skirmishes"). Teams tied
// take the points of the highest place among them. The page checks it against the week's finished
// skirmishes before it adds anything (labVpHolds): a table the game has changed shows the leader only.
const LAB_VP_ROWS = { a: [15, 14, 12], b: [22, 18, 14], c: [31, 24, 17], d: [51, 37, 24], e: [43, 32, 21], f: [23, 18, 14], g: [19, 16, 13] };
const LAB_WAR_VP = Object.freeze({
  1: 'eecfgggffffc'.split('').map((k) => LAB_VP_ROWS[k]),
  2: 'aaaabbbccddc'.split('').map((k) => LAB_VP_ROWS[k]),
});
// The panel's "Simulate a changed VP table": the regions' rows swapped, which no week's skirmishes add up to.
let labVpWrong = false;
const LAB_SKIRMISH_MS = 2 * 60 * LAB_MIN;
// The game's clock, as the page keeps it (js/api.js).
const labServerNow = () => Date.now() - (typeof ownClockLead === 'number' ? ownClockLead : 0);
// The points each colour takes from a skirmish whose scores are `sc`, or null with no table for the hour.
function labSkirmishVp(m, sk, sc) {
  const table = LAB_WAR_VP[labVpWrong ? (m.id.charAt(0) === '1' ? 2 : 1) : m.id.charAt(0)];
  const start = Date.parse(m.start_time);
  if (!table || !Number.isFinite(start) || !Number.isInteger(sk.id)) return null;
  const hour = (Math.round(start / 3600000) + 2 * (sk.id - 1)) % 24;
  if (hour % 2) return null;
  return Object.fromEntries(COLORS.map((c) => [c, table[hour / 2][COLORS.filter((o) => sc[o] > sc[c]).length]]));
}
// The table holds when it gives the week's victory points from its finished skirmishes, all of them there
// from the first (js/api.js puts the history back in front of each body).
function labVpHolds(m) {
  const list = Array.isArray(m.skirmishes) ? m.skirmishes : [];
  if (!list.length || !list[0] || list[0].id !== 1) return false;
  const got = { red: 0, blue: 0, green: 0 };
  for (const sk of list.slice(0, -1)) {
    const vp = sk && sk.scores && labSkirmishVp(m, sk, sk.scores);
    if (!vp) return false;
    for (const c of COLORS) got[c] += vp[c];
  }
  return COLORS.every((c) => got[c] === Number((m.victory_points || {})[c]));
}
// The skirmish under way: each colour's score (getSkirmishScore, js/panels.js), its minutes left, and, when
// the table holds, what each colour would take if it ended now. Null with no skirmish to read.
function labSkirmishNow(m) {
  const list = Array.isArray(m.skirmishes) ? m.skirmishes : [];
  const sk = list[list.length - 1];
  if (!sk || typeof getSkirmishScore !== 'function') return null;
  const sc = {};
  for (const c of COLORS) {
    const v = getSkirmishScore(m, c);
    if (v === null) return null;
    sc[c] = v;
  }
  const end = Date.parse(m.start_time) + LAB_SKIRMISH_MS * sk.id;
  const left = Math.max(0, Math.ceil((end - labServerNow()) / LAB_MIN));
  if (!Number.isFinite(left) || left > 120) return null;
  return { sc, left, vp: labVpHolds(m) ? labSkirmishVp(m, sk, sc) : null };
}
// The panel's "Simulate long team names": the two longest names in TEAM_NAMES on the Closest match.
let labLongNames = false;
// The panel's "Simulate": the second passing the first if it ended now, and the skirmish's last 3 minutes.
let labPassSim = false;
let labLastSim = false;
const LAB_LONG = ['Lutgardis Conservatory', 'Throne of Balthazar'];
function labClosest() {
  let best = null;
  for (const k of labKept()) {
    const r = labTeams(k.match).sort((a, b) => b.vp - a.vp || b.score - a.score);
    const gap = r[0].vp - r[1].vp;
    if (!best || gap < best.gap) best = { m: k.match, gap, a: r[0], b: r[1] };
  }
  if (!best) return null;
  if (labLongNames) [best.a.name, best.b.name] = LAB_LONG;
  const s = labSkirmishNow(best.m);
  if (s && labLastSim) s.left = 3;
  if (s && labPassSim) {
    // Made up: the second leads the skirmish and takes enough to pass the first if it ended now.
    const { a, b } = best;
    const o = COLORS.find((x) => x !== a.color && x !== b.color);
    s.sc = { [a.color]: 310, [b.color]: 420, [o]: 180 };
    s.vp = { [b.color]: 12 + best.gap + 7, [a.color]: 12, [o]: 8 };
  }
  if (s) {
    const { a, b } = best;
    best.sk = s;
    best.lead = s.sc[a.color] === s.sc[b.color] ? null : (s.sc[a.color] > s.sc[b.color] ? a : b);
    if (s.vp) best.next = (a.vp + s.vp[a.color]) - (b.vp + s.vp[b.color]);
  }
  return best;
}
const labLeft = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min left` : (n > 0 ? `${n} min left` : 'ending now'));
// The week's gap after the skirmish: "34 apart", or the second ahead of the first.
const labNextGap = (c) => (c.next >= 0 ? `${labNum(c.next)} apart` : `${c.b.name} ahead by ${labNum(-c.next)}`);
// Who has the better chance: the one ahead in the week if this skirmish ended now (c.next), or, with no VP
// table to add it up, the one ahead in the week now (proj false: nothing may say "if it ended now").
function labFav(c) {
  const proj = !!(c.sk && c.sk.vp);
  const x = proj && c.next < 0 ? c.b : c.a;
  return { x, other: x === c.a ? c.b : c.a, by: proj ? Math.abs(c.next) : c.gap, proj };
}
const labTimeLeft = (c) => (c.sk ? labLeft(c.sk.left) : '');
function labClosestSaid(c) {
  const f = labFav(c);
  const team = (x) => `${labCap(x.color)}, ${x.name}, ${labNum(x.vp)} VP`;
  let s = `Closest match, ${labTierTag(c.m.id)}: ${team(c.a)}; ${team(c.b)}; ${labNum(c.gap)} apart this week.`;
  if (f.proj) {
    s += f.x === c.a ? ` If this skirmish ended now, ${c.a.name} would stay ahead, by ${labNum(f.by)}.`
      : ` If this skirmish ended now, ${c.b.name} would pass ${c.a.name}, ahead by ${labNum(f.by)}.`;
  } else s += ` ${c.a.name} leads the week.`;
  if (c.sk) s += c.sk.left > 0 ? ` ${labLeft(c.sk.left)} in this skirmish.` : ' This skirmish is ending now.';
  return `${s} Show them in the standings`;
}
function labVpBar(parts) {
  const total = parts.reduce((n, x) => n + x.n, 0);
  const bar = labEl('span', 'lt-split');
  for (const x of parts) {
    const seg = labEl('span', `lt-seg lab-dot-${x.color}${x.dim ? ' lt-seg-dim' : ''}`);
    seg.style.flexGrow = String(total ? x.n / total : 0.5);
    bar.appendChild(seg);
  }
  return bar;
}
function labVpRows(c, right) {
  const rows = labEl('span', 'lt-vprows');
  for (const x of [c.a, c.b]) {
    const row = labEl('span', `lt-vprow side-${x.color}${c.lead === x ? ' is-lead' : ''}`);
    row.append(labTeamText(x.name, x.color), right(x));
    rows.appendChild(row);
  }
  return rows;
}
const labWeekVp = (x) => {
  const vp = labEl('span', 'lt-vp', labNum(x.vp));
  vp.appendChild(labEl('span', 'stat-label', ' VP'));
  return vp;
};
// Who leads the skirmish between the two, said with the leader's dot.
function labLeadLine(c, tail) {
  const line = labEl('span', 'lt-line lt-sk-line');
  if (c.lead) line.append(labTeamText(c.lead.name, c.lead.color), ` leads this skirmish`);
  else line.append('Tied in this skirmish');
  line.append(` · ${labLeft(c.sk.left)}${tail || ''}`);
  return line;
}
// A name that may be cut short with an ellipsis: the tile's aria-label (labClosestSaid) says it whole.
function labCutName(x) {
  const s = labEl('span', 'lab-team lt-cut');
  s.append(labDot(x.color), labEl('span', 'lt-cut-nm', x.name));
  return s;
}
// Round 13: round 9 and 10's frame (the big number, the bar, the two rows, the foot), each row the team's week VP.
const labWeekBar = (c) => labVpBar([c.a, c.b].map((x) => ({ color: x.color, n: x.vp })));
const labSkBar = (c) => labVpBar([c.a, c.b].map((x) => ({ color: x.color, n: c.sk.sc[x.color], dim: c.lead && c.lead !== x })));
// The two rows, "● Name … 1,690 VP"; with mark, the favourite's name lit and `mark` beside its number.
function labWeekRows(c, mark) {
  const f = labFav(c);
  const rows = labEl('span', 'lt-vprows');
  for (const x of [c.a, c.b]) {
    const lit = mark && f.x === x;
    const row = labEl('span', `lt-vprow side-${x.color}${lit ? ' is-lead' : ''}`);
    const right = labEl('span', 'lt-vp-right');
    if (lit) right.appendChild(labEl('span', 'lt-fav-w', mark));
    right.appendChild(labWeekVp(x));
    row.append(labCutName(x), right);
    rows.appendChild(row);
  }
  return rows;
}
// The foot "● Name set to win · 57 min left"; the second passing the first is "set to pass".
function labFavFoot(c, word) {
  const f = labFav(c);
  const line = labEl('span', 'lt-line lt-sk-line');
  const said = !f.proj ? 'leads the week' : (f.x === c.b ? 'set to pass' : word);
  line.append(labTeamText(f.x.name, f.x.color), ` ${said} · ${labTimeLeft(c)}`);
  return line;
}
// The gap if it ended now as the big number, or the week's with no VP table.
function labProjBig(c, unit) {
  const f = labFav(c);
  if (!f.proj) return labBig(labNum(c.gap), 'VP apart this week');
  return labBig(labNum(f.by), f.x === c.a ? unit : `${unit}, ${c.b.name} ahead`);
}
const LAB_CLOSE = {
  weekFav: (c) => [labBig(labNum(c.gap), 'VP apart'), labWeekBar(c), labWeekRows(c), labFavFoot(c, 'set to win')],
  skFav: (c) => [labBig(labNum(c.gap), 'VP apart'), labSkBar(c), labWeekRows(c), labFavFoot(c, 'set to win')],
  rowWord: (c) => [labBig(labNum(c.gap), 'VP apart'), labWeekBar(c), labWeekRows(c, 'favoured'),
    labEl('span', 'lt-line', `${labFav(c).proj ? 'If it ended now · ' : ''}${labTimeLeft(c)}`)],
  rowArrow: (c) => [labBig(labNum(c.gap), 'VP apart'), labSkBar(c), labWeekRows(c, '▲'),
    labEl('span', 'lt-line', `▲ ${labFav(c).proj ? 'ahead if it ended now' : 'leads the week'} · ${labTimeLeft(c)}`)],
  projRows: (c) => [labProjBig(c, 'VP apart if it ended now'), labWeekBar(c), labWeekRows(c, 'favoured'),
    labEl('span', 'lt-line', `Week VP now · ${labTimeLeft(c)}`)],
  projFoot: (c) => [labProjBig(c, 'apart if it ended now'), labSkBar(c), labWeekRows(c), labFavFoot(c, 'set to win')],
  onTrack: (c) => [labBig(labNum(c.gap), 'VP apart'), labWeekBar(c), labWeekRows(c), labFavFoot(c, 'on track to win')],
};
function labClosestBody(c) {
  const v = labPrefs.closest;
  if (!c.sk || v === 'today') {
    return [labBig(labNum(c.gap), 'VP apart'), labVpBar([c.a, c.b].map((x) => ({ color: x.color, n: x.vp }))),
      labVpRows(c, labWeekVp), labEl('span', 'lt-line', 'Top two · this week')];
  }
  if (Object.prototype.hasOwnProperty.call(LAB_CLOSE, v)) return LAB_CLOSE[v](c);
  const gain = c.sk.vp;
  const skBar = () => labVpBar([c.a, c.b].map((x) => ({ color: x.color, n: c.sk.sc[x.color], dim: c.lead && c.lead !== x })));
  const rows = labVpRows(c, (x) => (gain ? labEl('span', 'lt-vp lt-sk-gain', `+${gain[x.color]} VP`) : labEl('span', 'lt-vp lt-sk-score', labNum(c.sk.sc[x.color]))));
  // (a lean): round 10's without the skirmish's line, the time in the foot.
  if (v === 'alean') {
    return [labBig(labNum(c.gap), 'VP apart'), skBar(), rows,
      labEl('span', 'lt-line', `${gain ? `If it ended now · ${labNextGap(c)}` : 'Skirmish score'} · ${labTimeLeft(c)}`)];
  }
  // (a): the bar is the skirmish's, each row its points if it ended now.
  return [labBig(labNum(c.gap), 'VP apart'), labLeadLine(c), skBar(), rows,
    labEl('span', 'lt-line', gain ? `If it ended now · ${labNextGap(c)}` : 'Skirmish score · top two')];
}
function labClosestTile() {
  const c = labClosest();
  if (!c) return null;
  const v = c.sk ? labPrefs.closest : 'today';
  return labTile({ cls: `lt-close lt-close-${v}`, label: 'Closest match', chip: labChipOf(c.m.id),
    body: labClosestBody(c),
    go: () => labGoToTier([c.a.name, c.b.name]),
    aria: labClosestSaid(c) });
}

// ---- the week's leaders: one at a time for 5 s in a box above the tiles, with a pause button
// first in the Tab order; the pointer over it, the focus in it, a touch on it or reduced motion stop it ----
const labRot = { idx: 0, hover: false, focus: false, paused: false, n: 0, list: [] };
const labStill = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const labLeadersSaid = (list) => list.map((x) => `${x.label}, ${x.period}: ${x.r.name}, ${x.big(x.r)} ${x.unit}, ${labTierTag(x.r.m.id)}.`).join(' ');
function labRotShow(i) {
  const box = document.querySelector('.lt-rot');
  if (!box) return;
  labRot.idx = i;
  labTurn.ms = 0;
  box.querySelectorAll('.lt-slide').forEach((s, k) => s.classList.toggle('is-on', k === i));
  labSegsPaint(box);
  labChangeFx(box, box.querySelectorAll('.lt-slide')[i], labRot.list[i]);
}
// On a turn, never on a repaint, and with reduced motion too (the site's run-once effects play): the number
// counting up and the box's top rule lit in the leader's colour, with the slide's fade.
let labCount = 0;
function labChangeFx(box, slide, x) {
  if (!slide || !x) return;
  for (const o of box.querySelectorAll('.lt-rot-edge')) o.remove();
  const o = labEl('span', `lt-rot-edge side-${x.r.color}`);
  o.addEventListener('animationend', () => o.remove());
  box.appendChild(o);
  labCountUp(slide.querySelector('.lt-mt-num .lt-num'), x);
}
// The number from 85% of the value to it in 600 ms, easing out; K/D in its two decimals.
function labCountUp(el, x) {
  const id = ++labCount;
  if (!el || typeof requestAnimationFrame !== 'function') return;
  const end = x.val(x.r);
  const say = (v) => (x.kd ? v.toFixed(2) : labNum(Math.round(v)));
  const t0 = performance.now();
  const step = (now) => {
    if (id !== labCount || !el.isConnected) return;
    const p = Math.min(1, (now - t0) / 600);
    el.textContent = p < 1 ? say(end * (0.85 + 0.15 * (1 - (1 - p) ** 3))) : x.big(x.r);
    if (p < 1) requestAnimationFrame(step);
  };
  el.textContent = say(end * 0.85);
  requestAnimationFrame(step);
}
function labRotPaint(b = document.querySelector('.lt-rot-pause')) {
  if (!b) return;
  const stopped = labRot.paused || labStill();
  b.setAttribute('aria-label', stopped ? 'Play the leaders' : 'Pause the leaders');
  b.textContent = '';
  b.appendChild(labIcon(stopped ? ['M8 6l10 6-10 6Z'] : ['M8 6v12', 'M16 6v12'], 'lt-rot-svg'));
}
// K/D as the card writes it: "K/D" before the number, green above 1 and red below.
function labKdBig(x, r, cls) {
  const big = labEl('span', cls);
  const n = labEl('span', 'lt-num', x.big(r));
  if (r.kills !== r.deaths) n.classList.add(r.kills > r.deaths ? 'kd-good' : 'kd-bad');
  big.append(labEl('span', 'stat-label', 'K/D'), n);
  return big;
}
// The metric's name with "now" on the one that is not the week's: the week is said once, in the box's head.
const labShort = (x) => (x.period === 'now' ? `${x.label} · now` : x.label);
// The number with its unit after it, or K/D as the card writes it.
const labLeadNum = (x, cls) => {
  const big = x.kd ? labKdBig(x, x.r, `lt-big lt-kd ${cls}`) : labBig(x.big(x.r), x.unit);
  big.classList.add(cls);
  return big;
};
function labLeadTeam(x, cls) {
  const t = labEl('span', `${cls} side-${x.r.color}`);
  const name = labTeamText(x.r.name, x.r.color);
  name.classList.add('lt-lead-name');
  t.append(name, labChipOf(x.r.m.id));
  return t;
}
// The metric's mark big and faint at the box's right edge, and a soft glow in the leader's colour
// (css/lab-mid.css). Each is the slide's own, so each fades with it.
function labDeco(x) {
  const ic = labEl('span', 'lt-deco-ic');
  if (x.kd) ic.appendChild(labEl('span', 'lt-ic lt-ic-vp', 'K/D'));
  else if (x.icon) ic.appendChild(x.icon());
  return [labEl('span', 'lt-deco-glow'), ic];
}
// "Metric as title": the metric heads the slide, with where it sits in the turn; team and number centred.
function labTitleSlide(x, k, n) {
  const s = labEl('div', `lt-slide lt-mt side-${x.r.color}`);
  s.append(...labDeco(x));
  const head = labEl('span', 'lt-mt-head');
  const title = labEl('span', 'lt-mt-title');
  if (x.icon) title.appendChild(x.icon());
  title.appendChild(labEl('span', null, labShort(x)));
  head.append(title, labEl('span', 'lt-mt-note', `Leaders · ${k + 1}/${n} · this week`));
  s.append(head, labLeadTeam(x, 'lt-mt-team'), labLeadNum(x, 'lt-mt-num'));
  return s;
}
// The segments under the slides, one per metric: the shown one fills in 5 s and then turns to the next. The
// fill moves on the embers' frames (emberField.nextFrame, js/boot.js), so it stands still where the page's
// looping animations do: the tab hidden, reduced motion. A hold (the pause, the pointer over the box, the
// focus in it) stops it where it is; a press on a segment goes to that metric.
const LAB_TURN_MS = 5000;
const labTurn = { ms: 0, last: 0, asked: false };
function labSegsPaint(box) {
  const segs = box.querySelectorAll('.lt-seg-btn');
  if (!segs.length) return;
  segs.forEach((b, k) => {
    b.setAttribute('aria-pressed', k === labRot.idx ? 'true' : 'false');
    b.classList.toggle('is-done', k < labRot.idx);
    const fill = b.querySelector('.lt-seg-fill');
    if (fill) fill.style.transform = '';
  });
  labTurnPaint(box);
  labRotHold(box);
}
function labTurnPaint(box) {
  const fill = box.querySelector('.lt-seg-btn[aria-pressed="true"] .lt-seg-fill');
  if (fill) fill.style.transform = `scaleX(${Math.min(1, labTurn.ms / LAB_TURN_MS)})`;
}
const labHeld = () => labRot.paused || labRot.hover || labRot.focus || labStill();
function labTurnAsk() {
  if (labTurn.asked) return;
  labTurn.asked = true;
  labTurn.last = 0;
  if (typeof emberField === 'object' && emberField) emberField.nextFrame(labTurnTick);
  else if (typeof requestAnimationFrame === 'function') requestAnimationFrame(labTurnTick);
}
// A frame back after a hidden tab or a slow one moves the fill one frame's worth, not the time away.
function labTurnTick(now) {
  labTurn.asked = false;
  const box = document.querySelector('.lt-rot');
  if (!box || !box.isConnected || labHeld()) return;
  if (labTurn.last) labTurn.ms += Math.min(100, Math.max(0, now - labTurn.last));
  if (labTurn.ms >= LAB_TURN_MS) {
    labRotShow((labRot.idx + 1) % labRot.n);
    return;
  }
  labTurnPaint(box);
  const last = now;
  labTurnAsk();
  labTurn.last = last;
}
function labRotHold(box = document.querySelector('.lt-rot')) {
  const held = labHeld();
  if (box) box.classList.toggle('is-held', held);
  if (!held && box && box.isConnected) labTurnAsk();
}
if (typeof matchMedia === 'function') matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => labRotHold());
// The segments carry the metrics' short names under them from 360 px (css/lab-mid.css).
function labLeadersBox(list) {
  if (!list.length) return null;
  labRot.n = list.length;
  labRot.list = list;
  if (labRot.idx >= list.length || labStill()) labRot.idx = 0;
  const box = labEl('section', 'lt-tile lt-rot');
  box.setAttribute('aria-roledescription', 'carousel');
  box.setAttribute('aria-label', 'Leaders this week');
  const pause = labEl('button', 'lt-rot-pause');
  pause.type = 'button';
  pause.addEventListener('click', () => { labRot.paused = !labRot.paused; labRotPaint(); labRotHold(); });
  const slides = labEl('div', 'lt-slides');
  slides.setAttribute('aria-hidden', 'true');
  list.forEach((x, k) => {
    const sl = labTitleSlide(x, k, list.length);
    sl.classList.toggle('is-on', k === labRot.idx);
    slides.appendChild(sl);
  });
  const segs = labEl('div', 'lt-segs');
  list.forEach((x, k) => {
    const b = labEl('button', 'lt-seg-btn');
    b.type = 'button';
    b.setAttribute('aria-label', x.label);
    b.setAttribute('aria-pressed', k === labRot.idx ? 'true' : 'false');
    b.append(labEl('span', 'lt-seg-fill'), labEl('span', 'lt-seg-name', x.short));
    b.addEventListener('click', () => labRotShow(k));
    segs.appendChild(b);
  });
  box.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { labRot.hover = true; labRotHold(); } });
  box.addEventListener('pointerleave', () => { labRot.hover = false; labRotHold(); });
  // A touch has no hover to end: it stops the turning as the button does.
  box.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && !labRot.paused) { labRot.paused = true; labRotPaint(); labRotHold(); } });
  box.addEventListener('focusin', () => { labRot.focus = true; labRotHold(); });
  box.addEventListener('focusout', () => { labRot.focus = false; labRotHold(); });
  const said = labEl('span', 'sr-only', labLeadersSaid(list));
  // The pause in the top corner, first in the box and in the Tab order; the segments at the foot.
  box.append(pause, said, slides, segs);
  labRotPaint(pause);
  labSegsPaint(box);
  return box;
}

// The highlights' own region switch, styled as the live map's tabs (.wvw-subtab, css/maps.css): only the
// highlights change.
function labRegionSwitch(region) {
  const group = labEl('div', 'lt-reg');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Highlights region');
  for (const r of ['NA', 'EU']) {
    const b = labEl('button', 'lt-reg-btn');
    b.type = 'button';
    b.setAttribute('aria-pressed', r === region ? 'true' : 'false');
    b.appendChild(labEl('span', `wvw-subtab${r === region ? ' is-active' : ''}`, r));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (labRegionFirst() === r) return;
      labRegionPick = r;
      labPaintTiles();
      const again = document.querySelector(`.lt-reg-btn[aria-pressed="true"]`);
      if (again) again.focus();
    });
    group.appendChild(b);
  }
  return group;
}
function labTilesPanel() {
  const region = labRegionFirst();
  const panel = labEl('section', 'lt-panel');
  panel.setAttribute('aria-label', `Highlights, ${region}`);
  const head = labEl('div', 'lt-head');
  head.append(labEl('span', null, `Highlights · ${region}`), labRegionSwitch(region));
  panel.appendChild(head);
  const grid = labEl('div', 'lt-grid');
  for (const t of [...labTopTiles(), labClosestTile()].filter(Boolean)) grid.appendChild(t);
  const leaders = labLeadersBox(labLeaders());
  if (leaders) panel.appendChild(leaders);
  panel.appendChild(grid);
  return panel;
}
