'use strict';
// LAB (never merged). The highlights panel, from the page's own live data (newestMatches and the kill
// readings of js/maps-early.js): no request of its own. A board of four (A), the hour's duel (B) or a
// strip of pills (C). Every number says its period. Team names are strangers' text: textContent only.

const LAB_MIN = 60000;
const LAB_STONEMIST = '38-9';
const LAB_MAP_SHORT = { Center: 'EBG', RedHome: 'Red BL', BlueHome: 'Blue BL', GreenHome: 'Green BL' };
const labNow = () => (typeof steadyNow === 'function' ? steadyNow() : Date.now());
const labNum = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const labRegion = (id) => (String(id).charAt(0) === '1' ? 'NA' : 'EU');
const labTier = (id) => `${labRegion(id)} T${String(id).split('-')[1] || '?'}`;
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

// Kills per map over about the last half hour: the kept body and the readings (fightSamples), the
// newest counts by killHighs since kills only rise in a week.
function labFights() {
  const t = labNow();
  const out = [];
  if (typeof fightSamples !== 'function' || typeof killHighs !== 'function') return out;
  for (const k of labKept()) {
    const m = k.match;
    const samples = fightSamples(m);
    if (!samples.length) continue;
    const high = killHighs(fightTotals(m), samples);
    const last = samples[samples.length - 1];
    const headAt = Math.max(Number(k.at) || 0, last.at);
    let base = null;
    for (const s of samples) {
      if (s.at <= headAt - 30 * LAB_MIN) base = s;
      else { if (!base) base = s; break; }
    }
    if (!base || headAt - base.at < 8 * LAB_MIN) continue;
    for (const type of Object.keys(high)) {
      const n = high[type] - (Number(base.n[type]) || 0);
      if (n > 0) out.push({ m, type, n, mins: Math.round((headAt - base.at) / LAB_MIN), age: t - headAt });
    }
  }
  return out.sort((a, b) => b.n - a.n);
}
// Objectives that changed hands in the last 2 h, per map: what stands in for a fight with no readings.
function labFlips() {
  const t = labNow();
  const out = [];
  for (const k of labKept()) {
    const m = k.match;
    const week = Date.parse(m.start_time) || 0;
    for (const map of m.maps) {
      let n = 0;
      for (const o of map.objectives || []) {
        const at = Date.parse(o && o.last_flipped);
        if (!Number.isFinite(at) || o.type === 'Ruins' || o.type === 'Spawn' || at > t || t - at > 2 * 60 * LAB_MIN || at <= week + LAB_MIN) continue;
        n += 1;
      }
      if (n) out.push({ m, type: map.type, n });
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
    const row = { m: k.match, color, name: labTeamName(k.match, color), held: t - Date.parse(o.last_flipped) };
    if (!best || row.held < best.held) best = row;
  }
  return best;
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
function labKiller() {
  let best = null;
  for (const k of labKept()) for (const t of labTeams(k.match)) if (!best || t.kills > best.kills) best = { ...t, m: k.match };
  return best;
}
function labSkirmish() {
  const list = labKept().filter((k) => labRegion(k.match.id) === 'NA');
  const use = list.length ? list : labKept();
  const starts = use.map((k) => Date.parse(k.match.start_time)).filter(Number.isFinite);
  const ends = use.map((k) => Date.parse(k.match.end_time)).filter(Number.isFinite);
  if (!starts.length) return null;
  const into = labNow() - Math.max(...starts);
  if (into < 0) return null;
  const two = 120 * LAB_MIN;
  return {
    region: labRegion(use[0].match.id),
    n: Math.min(typeof WEEK_SKIRMISHES === 'number' ? WEEK_SKIRMISHES : 84, Math.floor(into / two) + 1),
    next: two - (into % two),
    reset: ends.length ? Math.min(...ends) - labNow() : 0,
  };
}

// Opens the live map of a match by pressing its own "Live maps" button: the map then sits where it always does.
function labOpenMap(matchId) {
  if (typeof tierMapButtons === 'undefined') return;
  for (const btn of document.querySelectorAll('.tier-map-btn')) {
    const it = tierMapButtons.get(btn);
    if (it && it.match && it.match.id === matchId) { btn.click(); return; }
  }
}

function labDot(color) { return labEl('span', `lab-dot lab-dot-${color}`); }
function labTeamText(name, color) {
  const s = labEl('span', 'lab-team');
  s.append(labDot(color), labEl('span', null, name));
  return s;
}
function labSwords() {
  return labIcon(['M4 4l10 10', 'M4 4h3l9 9-3 3-9-9Z', 'M20 4L10 14', 'M20 4h-3l-4 4', 'M7 17l-3 3', 'M17 17l3 3'], 'lt-swords');
}

// One tile: a label, the dominant number, one line of context with the period; a match opens its map.
function labTile(t) {
  const el = labEl(t.matchId ? 'button' : 'div', `lt-tile${t.cls ? ` ${t.cls}` : ''}`);
  if (t.matchId) {
    el.type = 'button';
    el.setAttribute('aria-label', `${t.label}: ${t.big}. ${t.line}. Open the live map of ${labTier(t.matchId)}`);
    el.addEventListener('click', () => labOpenMap(t.matchId));
  }
  const top = labEl('span', 'lt-label', t.label);
  if (t.icon) top.prepend(t.icon);
  el.appendChild(top);
  const big = labEl('span', 'lt-big');
  if (t.color) big.appendChild(labDot(t.color));
  big.appendChild(labEl('span', null, t.big));
  el.appendChild(big);
  el.appendChild(labEl('span', 'lt-line', t.line));
  if (t.color) el.style.setProperty('--lt-team', `var(--${t.color})`);
  return el;
}

function labTileData() {
  const fights = labFights();
  const f = fights[0];
  const flip = f ? null : labFlips()[0];
  const sm = labStonemist();
  const close = labClosest();
  const sk = labSkirmish();
  const kill = labKiller();
  const out = {};
  if (f) out.fight = { label: 'Hottest fight', big: `${labNum(f.n)} kills`, line: `${LAB_MAP_SHORT[f.type] || f.type} · ${labTier(f.m.id)} · ${f.mins} min`, matchId: f.m.id, icon: labSwords(), cls: 'lt-fight', f };
  else if (flip) out.fight = { label: 'Busiest map', big: `${flip.n} captures`, line: `${LAB_MAP_SHORT[flip.type] || flip.type} · ${labTier(flip.m.id)} · last 2 h`, matchId: flip.m.id, icon: labSwords(), cls: 'lt-fight' };
  else out.fight = { label: 'Hottest fight', big: '—', line: 'No readings yet · 30 min' };
  if (sm) out.sm = { label: 'Stonemist', big: sm.name, line: `${labTier(sm.m.id)} · held ${labSpan(sm.held)}`, matchId: sm.m.id, color: sm.color, cls: 'lt-team' };
  if (close) out.close = { label: 'Closest match', big: `${labNum(close.gap)} VP`, line: `${labTier(close.m.id)} · ${close.a.name} vs ${close.b.name} · this week`, matchId: close.m.id };
  if (sk) out.clock = { label: 'Skirmish', big: `${sk.n}/84`, line: `${sk.region} · next in ${labSpan(sk.next)}${sk.reset > 0 ? ` · reset in ${labSpan(sk.reset)}` : ''}`, cls: 'lt-clock' };
  if (kill) out.kill = { label: 'Most kills', big: labNum(kill.kills), line: `${kill.name} · ${labTier(kill.m.id)} · so far`, matchId: kill.m.id, color: kill.color, cls: 'lt-team' };
  return out;
}

function labDuel(d) {
  const f = d.fight.f;
  if (!f) {
    const t = labTile(d.fight);
    t.classList.add('lt-wide');
    return t;
  }
  const el = labEl('button', 'lt-duel');
  el.type = 'button';
  const map = f.m.maps.find((x) => x.type === f.type) || {};
  const two = COLORS.map((c) => ({ color: c, name: labTeamName(f.m, c), kills: Number((map.kills || {})[c]) || 0 }))
    .sort((a, b) => b.kills - a.kills).slice(0, 2);
  el.setAttribute('aria-label', `Hottest fight: ${two[0].name} and ${two[1].name}, ${labNum(f.n)} kills in ${f.mins} min on ${LAB_MAP_SHORT[f.type] || f.type}, ${labTier(f.m.id)}. Open the live map`);
  el.addEventListener('click', () => labOpenMap(f.m.id));
  el.appendChild(labEl('span', 'lt-label', `Hottest fight · ${LAB_MAP_SHORT[f.type] || f.type} · ${labTier(f.m.id)}`));
  const row = labEl('span', 'lt-duel-row');
  const side = (t) => {
    const s = labEl('span', `lt-side lt-side-${t.color}`);
    s.append(labEl('span', 'lt-side-name', t.name), labEl('span', 'lt-side-n', `${labNum(t.kills)} this week`));
    return s;
  };
  const mid = labEl('span', 'lt-duel-mid');
  mid.append(labSwords(), labEl('span', 'lt-duel-n', labNum(f.n)), labEl('span', 'lt-duel-unit', `kills · ${f.mins} min`));
  row.append(side(two[0]), mid, side(two[1]));
  el.appendChild(row);
  return el;
}

function labTilesPanel(form) {
  const d = labTileData();
  const panel = labEl('section', `lt-panel lt-form-${form}`);
  panel.setAttribute('aria-label', 'Highlights');
  const head = labEl('div', 'lt-head', 'Highlights');
  if (form !== 'C') panel.appendChild(head);
  if (form === 'A') {
    const grid = labEl('div', 'lt-grid');
    for (const k of ['fight', 'sm', 'close', 'clock']) if (d[k]) grid.appendChild(labTile(d[k]));
    panel.appendChild(grid);
  } else if (form === 'B') {
    panel.appendChild(labDuel(d));
    const two = labEl('div', 'lt-pair');
    for (const k of ['sm', 'close']) if (d[k]) two.appendChild(labTile(d[k]));
    panel.appendChild(two);
  } else {
    const strip = labEl('div', 'lt-strip');
    strip.setAttribute('aria-label', 'Highlights');
    strip.setAttribute('role', 'group');
    for (const k of ['fight', 'sm', 'close', 'clock', 'kill']) {
      if (!d[k]) continue;
      const t = labTile(d[k]);
      t.classList.add('lt-pill');
      strip.appendChild(t);
    }
    panel.appendChild(strip);
  }
  return panel;
}
