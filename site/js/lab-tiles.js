'use strict';
// LAB (never merged). The highlights panel, from the page's own live data (newestMatches and the kill
// readings of js/maps-early.js): no request of its own. Four tiles, each with its tier in the same
// corner, the site's own icon for what it counts, and the teams' colours beside their names. Every
// number says its period. Team names are strangers' text: textContent only.

const LAB_MIN = 60000;
const LAB_STONEMIST = '38-9';
const LAB_MAP_SHORT = { Center: 'EBG', RedHome: 'Red BL', BlueHome: 'Blue BL', GreenHome: 'Green BL' };
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
// The site's own pictures: the crossed swords mask (.swords-icon, css/facets.css) and the map's
// objective markers (assets/icons, as markerIcon in js/maps.js names them).
function labSiteIcon(kind, color) {
  if (kind === 'swords') return labEl('span', 'swords-icon lt-ic');
  const img = labEl('img', 'lt-ic lt-ic-img');
  img.src = `assets/icons/Event_${kind}${COLORS.includes(color) ? `_${color}` : ''}.webp`;
  img.alt = '';
  img.width = 16; img.height = 16;
  return img;
}

// One tile: the icon and what it counts, the tier in the top corner, the dominant number with its unit,
// the teams it is about, one line with the period. A tile about a match opens that match's map.
function labTile(t) {
  const el = labEl(t.matchId ? 'button' : 'div', `lt-tile${t.cls ? ` ${t.cls}` : ''}`);
  if (t.matchId) {
    el.type = 'button';
    el.setAttribute('aria-label', `${t.label}, ${t.tier}: ${t.big}${t.unit ? ` ${t.unit}` : ''}${t.teams ? `, ${t.teams.map((x) => x.name).join(' and ')}` : ''}. ${t.line}. Open the live map`);
  }
  if (t.matchId) el.addEventListener('click', () => labOpenMap(t.matchId));
  // The icon and the tier share the top row, so the tier sits in the same corner at every width.
  const top = labEl('span', 'lt-top');
  top.append(t.icon || labEl('span', 'lt-ic'), labEl('span', 'lt-tier', t.tier));
  el.append(top, labEl('span', 'lt-label', t.label));
  if (t.big) {
    const big = labEl('span', 'lt-big');
    big.appendChild(labEl('span', 'lt-num', t.big));
    if (t.unit) big.appendChild(labEl('span', 'lt-unit', t.unit));
    el.appendChild(big);
  }
  if (t.teams) {
    const teams = labEl('span', 'lt-teams');
    t.teams.forEach((x, k) => {
      if (k) teams.append(labEl('span', 'lt-vs', t.join || 'vs'));
      teams.appendChild(labTeamText(x.name, x.color));
    });
    el.appendChild(teams);
  }
  el.appendChild(labEl('span', 'lt-line', t.line));
  return el;
}

const labTierTag = (id) => `${labRegion(id)} · T${String(id).split('-')[1] || '?'}`;
function labTileData() {
  const out = [];
  const f = labFights()[0];
  const flip = f ? null : labFlips()[0];
  if (f) {
    const map = f.m.maps.find((x) => x.type === f.type) || {};
    const two = COLORS.map((c) => ({ color: c, name: labTeamName(f.m, c), kills: Number((map.kills || {})[c]) || 0 }))
      .sort((a, b) => b.kills - a.kills).slice(0, 2);
    out.push({ label: 'Hottest fight', icon: labSiteIcon('swords'), tier: labTierTag(f.m.id), big: labNum(f.n), unit: 'kills',
      teams: two, line: `${LAB_MAP_SHORT[f.type] || f.type} · last ${f.mins} min`, matchId: f.m.id });
  } else if (flip) {
    out.push({ label: 'Busiest map', icon: labSiteIcon('Tower'), tier: labTierTag(flip.m.id), big: String(flip.n), unit: 'captures',
      line: `${LAB_MAP_SHORT[flip.type] || flip.type} · last 2 h`, matchId: flip.m.id });
  } else {
    out.push({ label: 'Hottest fight', icon: labSiteIcon('swords'), tier: 'all tiers', big: '—', line: 'No readings yet · last 30 min' });
  }
  const sm = labStonemist();
  if (sm) {
    out.push({ label: 'Stonemist', icon: labSiteIcon('Castle', sm.color), tier: labTierTag(sm.m.id), big: '', teams: [{ name: sm.name, color: sm.color }],
      line: `Held ${labSpan(sm.held)} · now`, matchId: sm.m.id, cls: 'lt-owner' });
  }
  const close = labClosest();
  if (close) {
    out.push({ label: 'Closest match', icon: labEl('span', 'lt-ic lt-ic-text', 'VP'), tier: labTierTag(close.m.id), big: labNum(close.gap), unit: 'VP gap',
      teams: [close.a, close.b], line: 'Top two · this week', matchId: close.m.id });
  }
  const sk = labSkirmish();
  if (sk) {
    out.push({ label: 'Skirmish', tier: `${sk.region} · all tiers`, big: `${sk.n}/84`, unit: 'so far',
      line: `Next in ${labSpan(sk.next)}${sk.reset > 0 ? ` · reset in ${labSpan(sk.reset)}` : ''}` });
  }
  return out;
}

function labTilesPanel() {
  const panel = labEl('section', `lt-panel lt-tag-${labPrefs.tierTag}`);
  panel.setAttribute('aria-label', 'Highlights');
  panel.appendChild(labEl('div', 'lt-head', 'Highlights'));
  const grid = labEl('div', 'lt-grid');
  for (const t of labTileData()) grid.appendChild(labTile(t));
  panel.appendChild(grid);
  return panel;
}
