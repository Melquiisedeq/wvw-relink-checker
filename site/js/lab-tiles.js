'use strict';
// LAB (never merged). The highlights panel, from the page's own live data (newestMatches and the kill
// readings of js/maps-early.js): no request of its own. One region, the page's first or the one picked on
// the panel's switch: the Hottest fight and the Busiest map side by side, the Closest match under them, and
// the week's leaders one at a time, in a box of their own below. Team names are strangers' text: textContent
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

// The map's capture ring (.wvw-ring in css/maps.css) round an objective's marker, one ping on every blow of
// the swords (css/lab-mid.css): the Busiest map's motion, as the swords are the Hottest fight's.
function labPulse(type, color) {
  const wrap = labEl('span', 'lt-pulse');
  wrap.append(labEl('span', 'lt-pulse-ring'), labIconOf(type, color));
  return wrap;
}
// A calm pick (no swords lit in the region) wears grey, still swords and a white number.
function labFightTile(f) {
  const teams = labEl('span', 'lt-teams');
  for (const c of COLORS) teams.appendChild(labTeamText(labTeamName(f.m, c), c));
  const where = LAB_MAP_LONG[f.type] || f.type;
  const when = f.calm ? 'quiet now' : (f.silence > 3 * LAB_MIN ? `last kill ${labSpan(f.silence)} ago` : 'now');
  return labTile({ cls: `lt-hot${f.calm ? ' lt-calm' : ''}`, icon: labClash(), label: 'Hottest fight', chip: labChipOf(f.m.id),
    body: [labBig(labNum(f.n), 'kills / 10 min'), labEl('span', 'lt-map', `${where} · ${when}`), teams],
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

// ---- the week's leaders: one at a time for 5 s in a box under the tiles, with a pause button
// first in the Tab order; the pointer over it, the focus in it, a touch on it or reduced motion stop it ----
const labRot = { idx: 0, hover: false, focus: false, paused: false, n: 0, due: false, list: [] };
const labStill = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const labLeadersSaid = (list) => list.map((x) => `${x.label}, ${x.period}: ${x.r.name}, ${x.big(x.r)} ${x.unit}, ${labTierTag(x.r.m.id)}.`).join(' ');
function labRotShow(i) {
  const box = document.querySelector('.lt-rot');
  if (!box) return;
  labRot.idx = i;
  labRot.due = false;
  box.querySelectorAll('.lt-slide').forEach((s, k) => s.classList.toggle('is-on', k === i));
  labSegsPaint(box);
  labChangeFx(box, box.querySelectorAll('.lt-slide')[i], labRot.list[i]);
}
// "Change effect" (js/lab.js), once on a turn and never on a repaint; it plays with reduced motion too, as the
// site's run-once effects do. Each starts with the slide's fade.
let labCount = 0;
function labChangeFx(box, slide, x) {
  if (!slide || !x) return;
  const fx = labPrefs.changeFx;
  for (const o of box.querySelectorAll('.lt-rot-sheen, .lt-rot-edge')) o.remove();
  for (const s of box.querySelectorAll('.lt-fx-slide')) s.classList.remove('lt-fx-slide');
  if (fx === 'sheen' || fx === 'edge') {
    const o = labEl('span', fx === 'sheen' ? 'lt-rot-sheen' : `lt-rot-edge side-${x.r.color}`);
    o.addEventListener('animationend', () => o.remove());
    box.appendChild(o);
  }
  if (fx === 'slide') {
    void slide.offsetWidth;
    slide.classList.add('lt-fx-slide');
  }
  if (fx === 'count') labCountUp(slide.querySelector('.lt-mt-num .lt-num'), x);
}
// "Number counts up": from 85% of the value to it in 600 ms, easing out; K/D in its two decimals.
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
// The segments under the slides, one per metric: the shown one fills in 5 s (lt-fill, css/lab-mid.css), and
// its fill's end turns to the next. A hold (the pause, the pointer over the box, the focus in it) or reduced
// motion stops the fill where it is; a press on a segment goes to that metric.
function labSegsPaint(box) {
  const segs = box.querySelectorAll('.lt-seg-btn');
  if (!segs.length) return;
  segs.forEach((b, k) => {
    b.setAttribute('aria-pressed', k === labRot.idx ? 'true' : 'false');
    b.classList.toggle('is-done', k < labRot.idx);
    const old = b.querySelector('.lt-seg-fill');
    const fill = labEl('span', 'lt-seg-fill');
    if (k === labRot.idx) fill.addEventListener('animationend', () => { labRot.due = true; labRotHold(); });
    old.replaceWith(fill);
  });
  labRotHold(box);
}
// A fill that ends under a hold (a paused animation's clock can still run) turns when the hold ends.
function labRotHold(box = document.querySelector('.lt-rot')) {
  const held = labRot.paused || labRot.hover || labRot.focus || labStill();
  if (box) box.classList.toggle('is-held', held);
  if (labRot.due && !held && box && box.isConnected) {
    labRot.due = false;
    labRotShow((labRot.idx + 1) % labRot.n);
  }
}
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
  panel.appendChild(grid);
  const leaders = labLeadersBox(labLeaders());
  if (leaders) panel.appendChild(leaders);
  return panel;
}
