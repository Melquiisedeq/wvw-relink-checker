'use strict';
// The highlights panel above the search: the Hottest fight, the Busiest map and the Closest match of one
// region, from what the page already holds (newestMatches, the kill readings of js/maps-early.js). js/boot.js
// asks for it after the first standings, and its sheet comes with it; it is painted again after each answer of
// the standings and each repaint of the map badges. Team names are strangers' text: textContent only.

const HL_MIN = 60000;
const HL_SHEET = 'css/highlights.css';
const hlNum = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const hlRegionOf = (id) => (String(id).charAt(0) === '1' ? 'NA' : 'EU');
const hlCap = (c) => c.charAt(0).toUpperCase() + c.slice(1);
const hlHhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const hlSpan = (ms) => {
  const m = Math.max(1, Math.round(ms / HL_MIN));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const hlEl = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// The region on show: the one picked on the panel's NA | EU switch, else the one the page puts first. Not
// kept between visits; swapping the page's columns drops the pick (startHighlights).
let hlPick = null;
const hlRegion = () => hlPick || railFirst().toUpperCase();

// The region's kept bodies, last week's included; hlLive leaves only the weeks still running.
function hlKept() {
  return [...newestMatches.values()].map((k) => k && k.match)
    .filter((m) => m && typeof m.id === 'string' && Array.isArray(m.maps) && hlRegionOf(m.id) === hlRegion())
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}
const hlLive = () => hlKept().filter(matchIsLive);
function hlTeamName(m, color) {
  const id = matchTeamId(m, color);
  return id ? getTeamName(id) : hlCap(color);
}
// Past HUD_STALE_MS without a rising score the body is old: its tiles say when it is from, as the map's corner does.
function hlOldAt(m) {
  const at = matchScoreRoseAt(m.id);
  return at && steadyNow() - at > HUD_STALE_MS ? at : 0;
}

// ---- the Hottest fight ----
// The live map's own pick (hotMapOf) on every running match: the map with its swords lit and the most kills per
// 10 min; with none lit in the region, the map with the most kills per 10 min all the same, calm. With no rate
// anywhere, { wait } holds the first match's view: why there is none.
function hlHot() {
  let best = null;
  let calm = null;
  let wait = null;
  for (const m of hlLive()) {
    const v = hotMapOf(m);
    if (!v.rates) { if (!wait) wait = { wait: v.view }; continue; }
    if (v.hot) {
      const n = v.rates.per.get(v.hot) || 0;
      if (!best || n > best.n) best = { m, type: v.hot, n, view: v.view };
      continue;
    }
    for (const [type, n] of v.rates.per) {
      if (!calm || n > calm.n) calm = { m, type, n, view: v.view, calm: true };
    }
  }
  return best || calm || wait;
}
// What the fight's line says after the map's name, by the map corner's own looks (killLook): the data stopped,
// "game data paused" at the score's last rise; old with no proof the map is quiet, or calm on a body that has
// not risen lately, "data up to"; calm, "quiet now"; lit but silent a while, the last kill's age. `still`: the
// number is not a pace of now, so it wears the calm look.
function hlFightWhen(f) {
  const v = f.view;
  const look = killLook(v, v.frozen);
  if (look.odd) return { text: `game data paused · ${hlHhmm(matchScoreRoseAt(f.m.id) || v.clock)}`, still: true };
  if (look.unproven || (f.calm && !v.alive)) return { text: `data up to ${hlHhmm(v.clock)}`, still: true };
  if (f.calm) return { text: 'quiet now', still: true };
  if (look.old) return { text: `last kill ${hlSpan(v.silence)} ago`, still: false };
  return { text: 'now', still: false };
}

// ---- the Busiest map ----
// Objectives that changed hands in the last 2 h, per map. An objective's owner now is the team that took it
// last, and one taken twice counts once: the API keeps only its last flip. The week's first minute is the reset.
const HL_FLIPS_MS = 2 * 60 * HL_MIN;
// hlNewest: the newest take of the week in the region, whatever its age, for a Busiest map with none in 2 h.
let hlNewest = null;
function hlFlips() {
  const t = steadyNow();
  const out = [];
  hlNewest = null;
  for (const m of hlLive()) {
    const week = Date.parse(m.start_time) || 0;
    for (const map of m.maps) {
      const by = { red: 0, blue: 0, green: 0 };
      let n = 0;
      let last = null;
      for (const o of map.objectives || []) {
        const at = Date.parse(o && o.last_flipped);
        if (!Number.isFinite(at) || o.type === 'Ruins' || o.type === 'Spawn' || at > t || at <= week + HL_MIN) continue;
        const c = String(o.owner || '').toLowerCase();
        if (!(c in by)) continue;
        if (!hlNewest || at > hlNewest.at) hlNewest = { m, type: map.type, at, objective: o.type, color: c };
        if (t - at > HL_FLIPS_MS) continue;
        by[c] += 1;
        n += 1;
        if (!last || at > last.at) last = { at, type: o.type, color: c };
      }
      if (n) out.push({ m, type: map.type, n, by, last });
    }
  }
  return out.sort((a, b) => b.n - a.n);
}

// ---- the Closest match ----
// The victory points of a skirmish [1st, 2nd, 3rd] by region (the id's first digit: 1 NA, 2 EU) and the UTC
// hour it starts, 00 to 22 (https://wiki.guildwars2.com/wiki/World_versus_World, "Skirmishes"). Teams tied take
// the points of the highest place among them. Checked against the week's finished skirmishes before anything is
// added (hlVpHolds): a table the game has changed shows the leader only.
const SKIRMISH_VP_ROWS = { a: [15, 14, 12], b: [22, 18, 14], c: [31, 24, 17], d: [51, 37, 24], e: [43, 32, 21], f: [23, 18, 14], g: [19, 16, 13] };
const SKIRMISH_VP = Object.freeze({
  1: 'eecfgggffffc'.split('').map((k) => SKIRMISH_VP_ROWS[k]),
  2: 'aaaabbbccddc'.split('').map((k) => SKIRMISH_VP_ROWS[k]),
});
const HL_SKIRMISH_MS = 2 * 60 * HL_MIN;
// The points each colour takes from a skirmish whose scores are `sc`, or null with no table for the hour.
function hlSkirmishVp(m, sk, sc) {
  const table = SKIRMISH_VP[m.id.charAt(0)];
  const start = Date.parse(m.start_time);
  if (!table || !Number.isFinite(start) || !Number.isInteger(sk.id)) return null;
  const hour = (Math.round(start / 3600000) + 2 * (sk.id - 1)) % 24;
  if (hour % 2) return null;
  return Object.fromEntries(COLORS.map((c) => [c, table[hour / 2][COLORS.filter((o) => sc[o] > sc[c]).length]]));
}
// The table holds when it gives the week's victory points from its finished skirmishes, all of them there from
// the first (js/api.js puts the history back in front of each body).
function hlVpHolds(m) {
  const list = Array.isArray(m.skirmishes) ? m.skirmishes : [];
  if (!list.length || !list[0] || list[0].id !== 1) return false;
  const got = { red: 0, blue: 0, green: 0 };
  for (const sk of list.slice(0, -1)) {
    const vp = sk && sk.scores && hlSkirmishVp(m, sk, sk.scores);
    if (!vp) return false;
    for (const c of COLORS) got[c] += vp[c];
  }
  return COLORS.every((c) => got[c] === Number((m.victory_points || {})[c]));
}
// The skirmish under way: each colour's score, its minutes left by the game's clock, and, when the table holds,
// what each colour would take if it ended now. Null with no skirmish to read.
function hlSkirmishNow(m) {
  const list = Array.isArray(m.skirmishes) ? m.skirmishes : [];
  const sk = list[list.length - 1];
  if (!sk) return null;
  const sc = {};
  for (const c of COLORS) {
    const v = getSkirmishScore(m, c);
    if (v === null) return null;
    sc[c] = v;
  }
  const end = Date.parse(m.start_time) + HL_SKIRMISH_MS * sk.id;
  const left = Math.max(0, Math.ceil((end - (Date.now() - ownClockLead)) / HL_MIN));
  if (!Number.isFinite(left) || left > 120) return null;
  return { sc, left, vp: hlVpHolds(m) ? hlSkirmishVp(m, sk, sc) : null };
}
// The running match whose top two are fewest VP apart; null with no running match, { fresh } while every running
// match is still on 0 VP (a new week).
function hlClosest() {
  let best = null;
  let any = false;
  for (const m of hlLive()) {
    any = true;
    const r = COLORS.map((c) => ({ color: c, name: hlTeamName(m, c), vp: Number((m.victory_points || {})[c]) || 0,
      score: Number((m.scores || {})[c]) || 0 })).sort((a, b) => b.vp - a.vp || b.score - a.score);
    if (!r[0].vp) continue;
    const gap = r[0].vp - r[1].vp;
    if (!best || gap < best.gap) best = { m, gap, a: r[0], b: r[1] };
  }
  if (!best) return any || hlKept().length ? { fresh: true } : null;
  const s = hlSkirmishNow(best.m);
  if (s) {
    const { a, b } = best;
    best.sk = s;
    best.lead = s.sc[a.color] === s.sc[b.color] ? null : (s.sc[a.color] > s.sc[b.color] ? a : b);
    if (s.vp) best.next = (a.vp + s.vp[a.color]) - (b.vp + s.vp[b.color]);
  }
  return best;
}
const hlLeft = (n) => (n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min left` : (n > 0 ? `${n} min left` : 'ending now'));
// Who has the better chance: the one ahead in the week if this skirmish ended now (c.next), or, with no VP table
// to add it up, the one ahead in the week now (proj false: nothing may say "if it ended now"). `tied`: level if it
// ended now, or level in the week with no table; x is then only the first row, and nothing may name a winner.
function hlFav(c) {
  const proj = !!(c.sk && c.sk.vp);
  const x = proj && c.next < 0 ? c.b : c.a;
  return { x, by: proj ? Math.abs(c.next) : c.gap, proj, tied: proj ? c.next === 0 : c.gap === 0 };
}
const hlTierNo = (id) => String(id).split('-')[1] || '?';
const hlTierTag = (id) => `${hlRegionOf(id)} · T${hlTierNo(id)}`;
function hlClosestSaid(c) {
  const f = hlFav(c);
  const team = (x) => `${hlCap(x.color)}, ${x.name}, ${hlNum(x.vp)} VP`;
  let s = `Closest match, ${hlTierTag(c.m.id)}: ${team(c.a)}; ${team(c.b)}; ${hlNum(c.gap)} apart this week.`;
  if (f.proj) {
    s += ` If this skirmish ended now, ${c.a.name} would take ${c.sk.vp[c.a.color]} VP and ${c.b.name} ${c.sk.vp[c.b.color]},`;
    s += f.tied ? ' and the two would be tied.'
      : f.x === c.a ? ` and ${c.a.name} would stay ahead, by ${hlNum(f.by)}.`
      : ` and ${c.b.name} would pass ${c.a.name}, ahead by ${hlNum(f.by)}.`;
  } else s += f.tied ? ' The two are tied this week.' : ` ${c.a.name} leads the week.`;
  if (c.sk) s += c.sk.left > 0 ? ` ${hlLeft(c.sk.left)} in this skirmish.` : ' This skirmish is ending now.';
  return `${s} Show them in the standings`;
}

// ---- the tiles ----
function hlDot(color) { return hlEl('span', `hl-dot hl-dot-${color}`); }
function hlTeamText(name, color) {
  const s = hlEl('span', 'hl-team');
  s.append(hlDot(color), hlEl('span', null, name));
  return s;
}
function hlImg(file, cls, size) {
  const img = hlEl('img', cls);
  img.src = `assets/icons/${file}.webp`;
  img.alt = '';
  img.width = size;
  img.height = size;
  return img;
}
// The live map's strike (.wvw-clash*, css/maps.css), its shine moved by transform (.hl-clash-band).
function hlClash() {
  const wrap = hlEl('span', 'hl-clash');
  const box = hlEl('span', 'wvw-clash');
  const shine = hlEl('span', 'wvw-clash-shine');
  shine.appendChild(hlEl('span', 'hl-clash-band'));
  box.append(hlImg('Event_Swords_back', 'wvw-clash-sword is-back', 14), hlImg('Event_Swords_up', 'wvw-clash-sword is-up', 14),
    hlEl('span', 'wvw-clash-flash'), shine);
  for (let i = 0; i < 5; i++) box.appendChild(hlEl('span', `wvw-clash-spark wvw-clash-spark-${i}`));
  wrap.appendChild(box);
  return wrap;
}
const hlChip = (id) => hlEl('span', 'hl-tier', `T${hlTierNo(id)}`);
// One tile: the icon and its name in the top row, the tier's chip in the far corner, then the body. `key` names the
// tile, so the focus finds it again after a repaint. A tile with t.go is a button.
function hlTile(t) {
  const el = hlEl(t.go ? 'button' : 'div', `hl-tile ${t.cls}`);
  el.dataset.hl = t.key;
  if (t.go) {
    el.type = 'button';
    el.setAttribute('aria-label', t.aria);
    // Kept from the document: the press that opens the map would otherwise reach the map's outside-click close.
    el.addEventListener('click', (e) => { e.stopPropagation(); t.go(); });
  }
  const top = hlEl('span', 'hl-top');
  const label = hlEl('span', 'hl-label');
  if (t.icon) label.appendChild(t.icon);
  label.appendChild(hlEl('span', null, t.label));
  top.append(label, t.chip || hlEl('span'));
  el.appendChild(top);
  for (const n of t.body) el.appendChild(n);
  return el;
}
function hlBig(num, unit) {
  const big = hlEl('span', 'hl-big');
  big.append(hlEl('span', 'hl-num', num), hlEl('span', 'hl-unit', unit));
  return big;
}
const HL_MAP_LONG = { Center: 'Eternal Battlegrounds', RedHome: 'Red Borderlands', BlueHome: 'Blue Borderlands', GreenHome: 'Green Borderlands' };
const hlMapName = (type) => HL_MAP_LONG[type] || type;

// The live map opened on one of its tabs by pressing the match's own "Live maps" button, so the map sits where it
// always does; the tab waits in hlMapWant until js/maps.js hands over its goTo (highlightsMapOpened).
let hlMapWant = null;
function hlOpenMap(matchId, type) {
  hlMapWant = { matchId, type };
  for (const btn of document.querySelectorAll('.tier-map-btn')) {
    const it = tierMapButtons.get(btn);
    if (it && it.match && it.match.id === matchId) { btn.click(); return; }
  }
  hlMapWant = null;
}
function highlightsMapOpened(matchId, goTo) {
  const want = hlMapWant;
  hlMapWant = null;
  if (want && want.matchId === matchId) goTo(want.type, null, false);
}

// The orange shine across the number, on the compositor: a soft band (.hl-shine) slides over it carrying a bright
// copy that slides back as far (.hl-shine-in), so the copy stays on the digits while the band crosses them.
function hlShine(big) {
  const num = big.querySelector('.hl-num');
  const win = hlEl('span', 'hl-shine');
  win.setAttribute('aria-hidden', 'true');
  win.appendChild(hlEl('span', 'hl-shine-in', num.textContent));
  num.appendChild(win);
  return big;
}
function hlFightTile(f) {
  const teams = hlEl('span', 'hl-teams');
  for (const c of COLORS) teams.appendChild(hlTeamText(hlTeamName(f.m, c), c));
  const where = hlMapName(f.type);
  const when = hlFightWhen(f);
  const big = hlBig(hlNum(f.n), 'kills / 10 min');
  return hlTile({ key: 'hot', cls: `hl-hot${when.still ? ' hl-calm' : ''}`, icon: hlClash(), label: 'Hottest fight', chip: hlChip(f.m.id),
    body: [when.still ? big : hlShine(big), hlEl('span', 'hl-map', `${where} · ${when.text}`), teams],
    go: () => hlOpenMap(f.m.id, f.type),
    aria: `Hottest fight, ${hlTierTag(f.m.id)}: ${hlNum(f.n)} kills per 10 minutes on ${where}, ${when.text}. Open the live map on it` });
}
// No kill rate: the site's spinner only until the first read of the kill history lands (null); after it, the map
// corner's reason, shortened. No running match to read (`view` undefined) is the turn of the week, before its body.
function hlWaitText(view) {
  const wait = view && view.counting;
  if (!killSheet) return null;
  if (!view || view.noWindow === 'reset') return 'Counting starts about 10 min after the reset';
  if (wait && wait.ready > steadyNow()) return `Counting since ${hlHhmm(wait.since)} · ready about ${hlHhmm(wait.ready)}`;
  return 'Not enough kill data to count 10 minutes';
}
function hlFightWait(view) {
  const line = hlEl('span', 'hl-map hl-wait');
  const text = hlWaitText(view);
  if (text === null) line.append(hlEl('span', 'spinner'), 'Reading the kills…');
  else line.append(text);
  return hlTile({ key: 'hot', cls: 'hl-hot hl-calm', icon: hlClash(), label: 'Hottest fight', body: [line] });
}
// The marker of the last objective taken, the map's capture ring round it pinging on each blow of the swords.
function hlPulse(type, color, still) {
  const wrap = hlEl('span', 'hl-pulse');
  if (!still) wrap.append(hlEl('span', 'hl-pulse-ring'));
  wrap.append(hlImg(`Event_${type}${COLORS.includes(color) ? `_${color}` : ''}`, 'hl-ic', 16));
  return wrap;
}
const hlDataFrom = (m) => (hlOldAt(m) ? ` · data from ${hlHhmm(hlOldAt(m))}` : '');
// Who holds what was taken, as a bar and three counts in the teams' colours.
function hlBusyTile(flip) {
  const where = hlMapName(flip.type);
  const order = COLORS.slice().sort((a, b) => flip.by[b] - flip.by[a]);
  const bar = hlEl('span', 'hl-split');
  const teams = hlEl('span', 'hl-takers');
  for (const c of order) {
    if (flip.by[c]) {
      const seg = hlEl('span', `hl-seg hl-dot-${c}`);
      seg.style.flexGrow = String(flip.by[c]);
      bar.appendChild(seg);
    }
    const row = hlEl('span', `hl-taker side-${c}`);
    row.append(hlTeamText(hlTeamName(flip.m, c), c), hlEl('b', 'hl-taker-n', String(flip.by[c])));
    teams.appendChild(row);
  }
  const said = order.map((c) => `${hlTeamName(flip.m, c)} ${flip.by[c]}`).join(', ');
  return hlTile({ key: 'busy', cls: 'hl-busy', icon: hlPulse(flip.last.type, flip.last.color), label: 'Busiest map', chip: hlChip(flip.m.id),
    body: [hlBig(String(flip.n), flip.n === 1 ? 'objective taken' : 'objectives taken'), hlEl('span', 'hl-map', `${where} · last 2 h${hlDataFrom(flip.m)}`), bar, teams],
    go: () => hlOpenMap(flip.m.id, flip.type),
    aria: `Busiest map, ${hlTierTag(flip.m.id)}: ${flip.n} ${flip.n === 1 ? 'objective' : 'objectives'} taken in the last 2 hours on ${where}, held now by ${said}. Open the live map on it` });
}

// No take in 2 h: the map of the newest take of the week and when, the marker still; none this week, the new week's line.
function hlQuietBusyTile(last) {
  if (!last) {
    return hlTile({ key: 'busy', cls: 'hl-busy', icon: hlPulse('Camp', null, true), label: 'Busiest map', body: [hlEl('span', 'hl-map', 'New week · first numbers soon')] });
  }
  const where = hlMapName(last.type);
  const when = `Last capture ${hlHhmm(last.at)}`;
  return hlTile({ key: 'busy', cls: 'hl-busy', icon: hlPulse(last.objective, last.color, true), label: 'Busiest map', chip: hlChip(last.m.id),
    body: [hlEl('span', 'hl-map hl-last', when), hlEl('span', 'hl-map', `${where}${hlDataFrom(last.m)}`)],
    go: () => hlOpenMap(last.m.id, last.type),
    aria: `Busiest map, ${hlTierTag(last.m.id)}: no objective taken in the last 2 hours; ${when} on ${where}. Open the live map on it` });
}

// The skirmish bar, the leader's part lit, each team's points if it ended now over its ends.
function hlSkBar(c) {
  const wrap = hlEl('span', 'hl-gain-bar');
  if (c.sk.vp) {
    const top = hlEl('span', 'hl-gain-ends');
    for (const x of [c.a, c.b]) top.appendChild(hlEl('span', `hl-gain side-${x.color}`, `+${c.sk.vp[x.color]} VP`));
    wrap.appendChild(top);
  }
  const bar = hlEl('span', 'hl-split');
  const total = c.sk.sc[c.a.color] + c.sk.sc[c.b.color];
  for (const x of [c.a, c.b]) {
    const seg = hlEl('span', `hl-seg hl-dot-${x.color}${c.lead && c.lead !== x ? ' hl-seg-dim' : ''}`);
    seg.style.flexGrow = String(total ? c.sk.sc[x.color] / total : 0.5);
    bar.appendChild(seg);
  }
  wrap.appendChild(bar);
  return wrap;
}
// The two rows, each team's week VP; a name too long is cut with an ellipsis, said whole by the tile's label.
function hlWeekRows(c) {
  const rows = hlEl('span', 'hl-vprows');
  for (const x of [c.a, c.b]) {
    const row = hlEl('span', `hl-vprow side-${x.color}`);
    const name = hlEl('span', 'hl-team hl-cut');
    name.append(hlDot(x.color), hlEl('span', 'hl-cut-nm', x.name));
    const vp = hlEl('span', 'hl-vp', hlNum(x.vp));
    vp.appendChild(hlEl('span', 'stat-label', ' VP'));
    row.append(name, vp);
    rows.appendChild(row);
  }
  return rows;
}
// "● Name set to win · 57 min left"; the second passing the first, "set to pass"; level, "Tied if it ended now",
// or with no table "Tied this week".
function hlFavFoot(c) {
  const f = hlFav(c);
  const line = hlEl('span', 'hl-line hl-sk-line');
  const tail = `${c.sk ? ` · ${hlLeft(c.sk.left)}` : ''}${hlDataFrom(c.m)}`;
  if (f.tied) line.append(`${f.proj ? 'Tied if it ended now' : 'Tied this week'}${tail}`);
  else line.append(hlTeamText(f.x.name, f.x.color), ` ${!f.proj ? 'leads the week' : f.x === c.b ? 'set to pass' : 'set to win'}${tail}`);
  return line;
}
// The scales, drawn like the other tiles' game icons: the beam turns on its pin and each pan hangs from an end
// (css/highlights.css, .hl-sc-*). Each moving part is an <svg> of its own over the whole box: a transform inside one
// SVG lays the page out again on every frame it moves, one on the <svg> box runs on the compositor.
// `lean`: -1 toward the first team, 1 the second, 0 level.
const HL_SCALES = [['M8 21.2 h8 v-1.8 h-8 Z'], ['M11.1 5 h1.8 v14.6 h-1.8 Z'],
  ['M3 6.8 h18 v1.6 h-18 Z', 'f', 'b'], ['M12 3 a1.9 1.9 0 1 0 0.01 0 Z', 'f', 'b'],
  ['M4.6 8.2 L2 13.4 M4.6 8.2 L7.2 13.4', 's', 'l'], ['M1.2 13.4 h6.8 a3.4 2.6 0 0 1 -6.8 0 Z', 'f', 'l'],
  ['M19.4 8.2 L16.8 13.4 M19.4 8.2 L22 13.4', 's', 'r'], ['M16 13.4 h6.8 a3.4 2.6 0 0 1 -6.8 0 Z', 'f', 'r']];
function hlScales(lean) {
  const ns = 'http://www.w3.org/2000/svg';
  const box = hlEl('span', `hl-ci hl-sc${lean > 0 ? ' hl-sc-right' : lean === 0 ? ' hl-sc-even' : ''}`);
  box.setAttribute('aria-hidden', 'true');
  const parts = {};
  for (const [d, k = 'f', g = 'fixed'] of HL_SCALES) {
    if (!parts[g]) {
      parts[g] = document.createElementNS(ns, 'svg');
      parts[g].setAttribute('viewBox', '0 0 24 24');
      parts[g].setAttribute('class', `hl-sc-${g}`);
      box.appendChild(parts[g]);
    }
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', `hl-ci-${k}`);
    parts[g].appendChild(p);
  }
  return box;
}
function hlClosestTile(c) {
  if (c.fresh) {
    return hlTile({ key: 'close', cls: 'hl-close', icon: hlScales(0), label: 'Closest match', body: [hlEl('span', 'hl-map', 'New week · first numbers soon')] });
  }
  const f = hlFav(c);
  const body = [hlBig(hlNum(c.gap), 'VP apart')];
  if (c.sk) body.push(hlSkBar(c));
  body.push(hlWeekRows(c), hlFavFoot(c));
  return hlTile({ key: 'close', cls: 'hl-close', icon: hlScales(f.tied ? 0 : f.x === c.b ? 1 : -1), label: 'Closest match', chip: hlChip(c.m.id),
    body, go: () => goToTier(getTeamName(matchTeamId(c.m, c.a.color)), undefined, c.m.id), aria: hlClosestSaid(c) });
}

function hlRegionSwitch(region) {
  const group = hlEl('div', 'hl-reg');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Highlights region');
  for (const r of ['NA', 'EU']) {
    const b = hlEl('button', 'hl-reg-btn');
    b.type = 'button';
    b.dataset.hl = `reg-${r}`;
    b.setAttribute('aria-pressed', r === region ? 'true' : 'false');
    b.appendChild(hlEl('span', `wvw-subtab${r === region ? ' is-active' : ''}`, r));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (hlRegion() === r) return;
      hlPick = r;
      paintHighlights();
    });
    group.appendChild(b);
  }
  return group;
}
// The panel for the region on show, or null with no match of it kept. The fight and the busiest map side by side,
// the fight's own map included, the Closest match under them.
function hlPanel() {
  const region = hlRegion();
  if (!hlKept().length) return null;
  const panel = hlEl('section', 'hl-panel frame-a');
  panel.setAttribute('aria-label', `Highlights, ${region}`);
  const head = hlEl('div', 'hl-head');
  head.append(hlEl('span', null, `Highlights · ${region}`), hlRegionSwitch(region));
  const grid = hlEl('div', 'hl-grid');
  const f = hlHot();
  const flip = hlFlips()[0];
  const c = hlClosest();
  grid.append(f && !f.wait ? hlFightTile(f) : hlFightWait(f && f.wait));
  grid.append(flip ? hlBusyTile(flip) : hlQuietBusyTile(hlNewest));
  if (c) grid.append(hlClosestTile(c));
  panel.append(head, grid);
  return panel;
}

// Painted only when something it says has changed, so the animations run on and nothing redraws for nothing; the
// focus goes back to the control it was on (data-hl).
let hlBox = null;
let hlSaid = '';
const hlText = (n) => (n ? n.textContent + [...n.querySelectorAll('[aria-label],[aria-pressed]')]
  .map((e) => `|${e.getAttribute('aria-label')}|${e.getAttribute('aria-pressed')}|${e.className.baseVal ?? e.className}`).join('') : '');
function paintHighlights() {
  if (!hlBox) return;
  // A panel that changes height moves the board under it: never while its cards slide (js/panels.js).
  const sliding = [...slideLive.values()].flatMap((l) => l.anims);
  if (sliding.length) {
    Promise.allSettled(sliding.map((a) => a.finished)).then(paintHighlights);
    return;
  }
  const panel = hlPanel();
  const said = hlText(panel);
  if (said === hlSaid) return;
  hlSaid = said;
  const was = hlBox.contains(document.activeElement) ? document.activeElement.dataset.hl : null;
  hlBox.replaceChildren(...(panel ? [panel] : []));
  const again = was && hlBox.querySelector(`[data-hl="${was}"]`);
  if (again) again.focus({ preventScroll: true });
}
// Its sheet first, so the panel never shows unstyled; then painted, and painted again with the columns' swap,
// which drops the region picked here.
function startHighlights() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = HL_SHEET;
  link.onload = () => {
    hlBox = document.createElement('div');
    hlBox.className = 'hl-box';
    document.querySelector('.search-panel').before(hlBox);
    new MutationObserver(() => { hlPick = null; paintHighlights(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-rail-first'] });
    paintHighlights();
  };
  document.head.appendChild(link);
}
