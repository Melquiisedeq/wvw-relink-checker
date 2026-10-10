// LAB (never merged). Lab 16-0, "the data's clock": how the map's two corners and the
// standings' "Synced" line could say how old the data is when the game's API falls
// behind. Three boxes, each with Today / A / B / C side by side, and two "Simulate…"
// buttons for the rare states. Loaded just before js/boot.js. Everything the page shows
// goes through textContent. No new request: it reads what the page already holds
// (newestMatches, matchDataCache, the kill history through fightSamples/killView).

const LAB_KEY = 'wvw-lab16-v1';
const LAB_VERSION = 1;          // bump when the defaults change: older saved choices are dropped

const LAB_KILLS_HINTS = {
  today: 'As on the site now.',
  a: 'One line: "80 kills · 10 min up to 14:47 ⚠", dimmed when the API is behind.',
  b: 'Two lines: "80 kills in 10 min" / "data up to 14:47 ⚠".',
  c: 'The number, a small clock and the time; the period on tap.',
};
const LAB_WHEN_HINTS = {
  today: 'As on the site now ("Updated 5s ago").',
  a: '"checked 20 s ago · data from 14:47".',
  b: '"data from 14:47"; "checked" on tap.',
  c: 'A live dot that goes past 6 min, then "data 41 min old".',
};
const LAB_SYNC_HINTS = {
  today: 'As on the site now ("Synced 15:10").',
  a: '"Data from 14:47 · checked 15:10": the oldest tier\'s data.',
  b: '"Synced 15:10", and "· 2 tiers behind since 14:47" only when one is.',
  c: '"Synced 15:10"; the dot changes shape, tap it for the age.',
};
const LAB_ABC = { today: 'Today', a: 'A', b: 'B', c: 'C' };

const LAB_ITEMS = [
  { type: 'section', label: '1 · Kills corner (map, left)' },
  { type: 'radio', key: 'kills', label: 'Kills corner', options: LAB_ABC, value: 'a', hints: LAB_KILLS_HINTS },
  { type: 'section', label: '2 · Data corner (map, right)' },
  { type: 'radio', key: 'when', label: 'Data corner', options: LAB_ABC, value: 'a', hints: LAB_WHEN_HINTS },
  { type: 'section', label: '3 · "Synced" (top of the standings)' },
  { type: 'radio', key: 'sync', label: 'Synced line', options: LAB_ABC, value: 'a', hints: LAB_SYNC_HINTS },
  { type: 'section', label: 'Simulate (made-up numbers, marked "sim")' },
  { type: 'button', label: 'Simulate the API stuck 40 min', run: () => labSimulate('stall') },
  { type: 'button', label: 'Simulate just after the reset', run: () => labSimulate('reset') },
  { type: 'button', label: 'Clear the simulation', run: () => labSimulate(null) },
];

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
    if (it.type === 'radio') {
      const fs = labEl('fieldset', 'lab-radios');
      fs.appendChild(labEl('legend', 'lab-sr-legend', it.label));
      for (const [k, text] of Object.entries(it.options)) {
        const rl = labEl('label');
        const r = labEl('input');
        r.type = 'radio';
        r.name = `lab-${it.key}`;
        r.value = k;
        r.addEventListener('change', () => { if (r.checked) { labPrefs[it.key] = k; labChanged(); } });
        rl.append(r, ` ${text}`);
        fs.appendChild(rl);
      }
      body.appendChild(fs);
      const hint = labEl('div', 'lab-hint');
      hint.dataset.hint = it.key;
      body.appendChild(hint);
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
  for (const h of body.querySelectorAll('.lab-hint')) {
    const it = LAB_ITEMS.find((x) => x.key === h.dataset.hint);
    h.textContent = (it && it.hints && it.hints[labPrefs[it.key]]) || '';
  }
}

// ---- shared pieces ------------------------------------------------------

const labHhmm = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// "20 s", "41 min", "2 h 5 min"
function labAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
function labSimTag() {
  const s = labEl('span', 'lab-simtag', 'sim');
  s.title = 'Lab: simulated, the numbers are made up';
  return s;
}
function labClockIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'lab-clock');
  const c = document.createElementNS(ns, 'circle');
  c.setAttribute('cx', '8'); c.setAttribute('cy', '8'); c.setAttribute('r', '6.5');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M8 4.2V8l2.6 1.6');
  svg.append(c, p);
  return svg;
}

// When each match was last read from anywhere (standings, peek, the map's poll):
// fed by the one-line hook in keepNewestMatch.
const labChecked = new Map();
function labMatchOffered(match) {
  if (match && typeof match.id === 'string') labChecked.set(match.id, Date.now());
}

// ---- simulations --------------------------------------------------------
// { kind: 'stall', id, since } or { kind: 'reset', id, start }. Lab-only: the
// page's own logic never sees it, only the lab's corners and the lab's line.
let labSim = null;
let labOpenMatch = null;      // the match of the map on show
let labOpenAt = 0;
const LAB_SIM_KILLS = Object.freeze({ Center: 80, RedHome: 34, BlueHome: 52, GreenHome: 21 });

function labSimFor(id) { return labSim && labSim.id === id ? labSim : null; }

function labSimulate(kind) {
  if (!kind) { labSim = null; labStatus('Simulation cleared.'); labRepaint(); return; }
  const now = Date.now();
  let id = labOpenMatch && now - labOpenAt < 5000 ? labOpenMatch : null;
  if (!id) id = [...matchDataCache.keys()].sort(byId)[0] || null;
  if (!id) { labStatus('No match loaded yet.'); return; }
  labSim = kind === 'stall'
    ? { kind, id, since: now - 40 * 60000 }
    : { kind, id, start: now - 4 * 60000 };
  const [region, tier] = id.split('-');
  const where = `${REGION_NAMES[region] || region} Tier ${tier}`;
  labStatus(kind === 'stall'
    ? `Simulated on ${where}: the API stuck since ${labHhmm(labSim.since)}. Made-up kills.`
    : `Simulated on ${where}: the reset 4 min ago.`);
  labRepaint();
}

// The data's clock for a match: when its score last moved, or the simulated stop.
function labDataClock(id) {
  const sim = labSimFor(id);
  if (sim && sim.kind === 'stall') return sim.since;
  return matchScoreRoseAt(id);
}

// ---- 1 · the kills, by the data's clock ------------------------------------
// The window ends at the kills' own clock (killView's), and its base is the
// reading nearest to 10 min before it, never further than 15 min back nor
// nearer than 8 min (the history has a line every 5 min). No such reading: a dash,
// which after a reset says why. A step that came after the kills stood still past
// KILLS_CATCHUP_MS lights no swords.
const LAB_WIN_WANT = 10 * 60000;
const LAB_WIN_MIN = 8 * 60000;
const LAB_WIN_MAX = 15 * 60000;

function labKillView(match, type, now = Date.now()) {
  const out = { state: 'none', reason: 'nodata', kills: 0, mins: 0, end: 0, hot: false, catchup: false, sim: false };
  if (!match || !matchIsLive(match)) { out.reason = 'idle'; return out; }
  const sim = labSimFor(match.id);
  if (sim && sim.kind === 'reset') { out.reason = 'reset'; out.sim = true; return out; }
  if (sim && sim.kind === 'stall') {
    return { ...out, state: 'late', kills: LAB_SIM_KILLS[type] || 40, mins: 10, end: sim.since, sim: true };
  }
  const view = killView(match, null, now);
  if (!view.clock) return out;
  const list = fightSamples(match);
  const target = view.clock - LAB_WIN_WANT;
  let base = null;
  for (const s of list) {
    const span = view.clock - s.at;
    if (span < LAB_WIN_MIN || span > LAB_WIN_MAX) continue;
    if (!base || Math.abs(s.at - target) < Math.abs(base.at - target)) base = s;
  }
  if (!base) {
    const start = Date.parse(match.start_time);
    out.reason = Number.isFinite(start) && view.clock - start < LAB_WIN_MAX + LAB_WIN_WANT ? 'reset' : 'nodata';
    return out;
  }
  const span = view.clock - base.at;
  const body = fightTotals(match);
  const per = {};
  for (const t in body) {
    let high = Number(body[t]) || 0;
    for (const s of list) if (s.at <= view.clock) high = Math.max(high, Number(s.n[t]) || 0);
    per[t] = Math.max(0, high - (Number(base.n[t]) || 0));
  }
  const rose = labDataClock(match.id);
  const stale = !!rose && now - rose > HUD_STALE_MS;
  out.state = stale || view.strange || view.frozen ? 'late' : view.silence > KILLS_QUIET_MS ? 'quiet' : 'live';
  out.kills = per[type] || 0;
  out.mins = Math.round(span / 60000);
  out.end = view.clock;
  out.catchup = Number.isFinite(view.prevRun) && view.prevRun > KILLS_CATCHUP_MS;
  if (out.state === 'live' && !out.catchup && view.silence <= HOT_WANT_MS) {
    let best = null;
    let bestN = 0;
    for (const t in per) if (per[t] > bestN) { bestN = per[t]; best = t; }
    out.hot = best === type && bestN * (LAB_WIN_WANT / span) >= HOT_FLOOR;
  }
  return out;
}

function labKillsTip(v) {
  if (v.state === 'none') {
    return v.reason === 'reset'
      ? 'Counting starts about 10 minutes after the reset: there is nothing earlier this week to compare with.'
      : 'Not enough kill data to count 10 minutes.';
  }
  const t = labHhmm(v.end);
  const tail = v.catchup ? ' The last jump came after the kills stood still, so it lights no swords.' : '';
  if (v.state === 'late') {
    return `${v.kills} kills in the ${v.mins} min up to ${t}. The game's API has been behind since ${t}, so this is not now.${tail}`;
  }
  if (v.state === 'quiet') return `No new kills since ${t}, as on a quiet map. ${v.kills} kills in the ${v.mins} min up to then.${tail}`;
  return `Player kills on this map in the last ${v.mins} minutes. Orange swords mark the busiest map, past 50.${tail}`;
}

// One description of what the corner shows, so it is only rebuilt when it changes.
function labKillsSpec(v, alt) {
  const tip = labKillsTip(v);
  if (v.state === 'none') return { icon: 'swords', cold: true, dim: false, lines: [[['big', '–'], ['small', 'kills']]], tip, sim: v.sim };
  const big = ['big', String(v.kills)];
  const t = labHhmm(v.end);
  if (v.state === 'live') {
    return { icon: 'swords', cold: !v.hot, dim: false, lines: [[big, ['small', `kills · ${v.mins} min`]]], tip, sim: v.sim };
  }
  const late = v.state === 'late';
  const warn = late ? ' ⚠' : '';
  if (alt === 'b') {
    return { icon: 'swords', cold: true, dim: late, two: true, tip, sim: v.sim,
      lines: [[big, ['small', 'kills'], ['small', `in ${v.mins} min`]],
        [['small2' + (late ? ' lab-warn' : ''), late ? `data up to ${t}${warn}` : `no new kills since ${t}`]]] };
  }
  if (alt === 'c') {
    return { icon: 'clock', cold: true, dim: late, tip, sim: v.sim,
      lines: [[big, ['time' + (late ? ' lab-warn' : ''), t + warn]]] };
  }
  return { icon: 'swords', cold: true, dim: late, tip, sim: v.sim,
    lines: [[big, ['small', `kills · ${v.mins} min`], ['small', `up to ${t}${warn}`]]] };
}

// ---- 2 · the data's age -------------------------------------------------------
function labWhenSpec(id, alt, now = Date.now()) {
  const rose = labDataClock(id);
  const checked = labChecked.get(id) || 0;
  const sim = !!labSimFor(id) && labSimFor(id).kind === 'stall';
  const age = Math.max(0, now - rose);
  const stale = age > HUD_STALE_MS;
  const t = labHhmm(rose);
  const chk = checked ? `checked ${labAge(now - checked)} ago` : 'not checked yet';
  const tip = `${checked ? `Checked ${labAge(now - checked)} ago` : 'Not checked yet'}: this page asks the game's API every 30 s.`
    + ` Data from ${t}: when this match's score last changed there${stale ? `, ${labAge(age)} ago` : ''}.`
    + " The game's API itself runs about 40 s behind the game.";
  if (alt === 'b') return { stale, sim, tip, parts: [[stale ? 'lab-warn' : '', `${stale ? '⚠ ' : ''}data from ${t}`]] };
  if (alt === 'c') {
    return { stale, sim, tip, dot: !stale,
      parts: [[stale ? 'lab-warn' : '', `${stale ? '⚠ ' : ''}data ${labAge(age)} old`]] };
  }
  return { stale, sim, tip, parts: [['', chk], ['lab-sep', ' · '], [stale ? 'lab-warn' : '', `${stale ? '⚠ ' : ''}data from ${t}`]] };
}

// ---- the corners on the map --------------------------------------------------------
let labWrap = null;

function labBuildCorners(wrap) {
  // The site's class names too: the map's pan and its focus tap skip them (maps.js).
  const note = labEl('p', 'lab-hud-note wvw-hud-note');
  note.hidden = true;
  note.addEventListener('click', (e) => { e.stopPropagation(); note.hidden = true; });
  const corner = (side) => {
    const box = labEl('div', `lab-hud wvw-hud lab-hud-${side}`);
    const btn = labEl('button', 'lab-hud-btn');
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !note.hidden && note.dataset.side === side;
      note.hidden = open;
      if (open) return;
      note.dataset.side = side;
      note.className = `lab-hud-note wvw-hud-note at-${side}`;
      note.textContent = btn.dataset.tip || '';
    });
    box.appendChild(btn);
    return box;
  };
  wrap.append(corner('l'), corner('r'), note);
}

function labPaintKillsCorner(btn, spec) {
  const key = JSON.stringify(spec);
  if (btn.dataset.key === key) return;
  btn.dataset.key = key;
  btn.dataset.tip = spec.tip;
  btn.title = spec.tip;
  btn.textContent = '';
  const box = btn.parentElement;
  box.classList.toggle('is-cold', !!spec.cold);
  box.classList.toggle('is-dim', !!spec.dim);
  if (spec.icon === 'clock') btn.appendChild(labClockIcon());
  else {
    const img = labEl('img');
    img.src = 'assets/icons/Event_Swords.webp';
    img.alt = '';
    img.width = 18;
    img.height = 18;
    btn.appendChild(img);
  }
  const txt = labEl('span', `lab-hud-txt${spec.two ? ' is-two' : ''}`);
  for (const line of spec.lines) {
    const row = labEl('span', 'lab-hud-line');
    for (const [cls, text] of line) {
      const [kind, ...more] = cls.split(' ');
      row.appendChild(labEl('span', [`lab-hud-${kind}`, ...more].join(' '), text));
    }
    txt.appendChild(row);
  }
  if (spec.sim) txt.firstChild.appendChild(labSimTag());
  btn.appendChild(txt);
}

function labPaintWhenCorner(btn, spec) {
  const key = JSON.stringify(spec);
  if (btn.dataset.key === key) return;
  btn.dataset.key = key;
  btn.dataset.tip = spec.tip;
  btn.title = spec.tip;
  btn.textContent = '';
  const row = labEl('span', `lab-hud-ago${spec.stale ? ' is-stale' : ''}`);
  if (spec.dot) row.appendChild(labEl('span', 'live-dot lab-hud-dot'));
  for (const [cls, text] of spec.parts) row.appendChild(labEl('span', cls || null, text));
  if (spec.sim) row.appendChild(labSimTag());
  btn.appendChild(row);
}

// Hook: called by paintCorners in js/maps.js every second and on every change.
function labCornersPainted(wrap, match, type, rose) {
  if (!wrap || !match) return;
  labWrap = wrap;
  labOpenMatch = match.id;
  labOpenAt = Date.now();
  const body = (newestMatches.get(match.id) || {}).match || match;
  const killsAlt = labPrefs.kills;
  const whenAlt = labPrefs.when;
  const sim = labSimFor(match.id);
  const pop = wrap.closest('.info-popover');
  if (pop) pop.classList.toggle('lab-sim-on', !!sim);
  wrap.classList.toggle('lab-kills-on', killsAlt !== 'today');
  wrap.classList.toggle('lab-when-on', whenAlt !== 'today');
  if (!wrap.querySelector('.lab-hud-l')) labBuildCorners(wrap);
  const left = wrap.querySelector('.lab-hud-l');
  const right = wrap.querySelector('.lab-hud-r');
  const known = !!rose || !!sim;
  left.hidden = killsAlt === 'today' || !known;
  right.hidden = whenAlt === 'today' || !known;
  if (!left.hidden) labPaintKillsCorner(left.firstChild, labKillsSpec(labKillView(body, type), killsAlt));
  if (!right.hidden) labPaintWhenCorner(right.firstChild, labWhenSpec(match.id, whenAlt));
  const note = wrap.querySelector('.lab-hud-note');
  if (note && !note.hidden) {
    const btn = wrap.querySelector(`.lab-hud-${note.dataset.side} .lab-hud-btn`);
    const gone = !btn || btn.parentElement.hidden;
    if (gone) note.hidden = true;
    else if (note.textContent !== btn.dataset.tip) note.textContent = btn.dataset.tip;
  }
}

// ---- 3 · the standings' line ---------------------------------------------------
const labStatusSaved = new Map();   // status element -> { text, lastText }

// Hook: called by setStandingsStatus in js/standings.js after it paints.
function labStatusPainted(el, synced, text) {
  if (!synced) { labStatusSaved.delete(el); return; }
  labStatusSaved.set(el, { text, lastText: el.textContent, mine: false });
  labPaintStatus(el, true);
}

function labRegionTiers(el) {
  const region = el.id.endsWith('EU') ? '2' : '1';
  const now = Date.now();
  const tiers = [];
  for (const id of matchDataCache.keys()) {
    if (!id.startsWith(`${region}-`)) continue;
    const clock = labDataClock(id);
    if (!clock) continue;
    tiers.push({ id, clock, behind: now - clock > HUD_STALE_MS, sim: !!labSimFor(id) && labSimFor(id).kind === 'stall',
      checked: labChecked.get(id) || 0 });
  }
  return tiers;
}

function labPaintStatus(el, fresh) {
  const saved = labStatusSaved.get(el);
  if (!saved) return;
  // Someone else wrote here since (a retry, an error): leave it alone.
  if (!fresh && el.textContent !== saved.lastText) { labStatusSaved.delete(el); return; }
  const alt = labPrefs.sync;
  if (alt === 'today') {
    if (saved.mine) { labStatusSaved.delete(el); el.classList.remove('lab-std-on'); setStandingsStatus(el, true, saved.text); }
    return;
  }
  const tiers = labRegionTiers(el);
  if (!tiers.length) return;
  const now = Date.now();
  const oldest = tiers.reduce((a, b) => (b.clock < a.clock ? b : a));
  const behind = tiers.filter((t) => t.behind);
  const checked = Math.max(...tiers.map((t) => t.checked)) || now;
  const sim = tiers.some((t) => t.sim);
  const since = behind.length ? Math.min(...behind.map((t) => t.clock)) : 0;
  const key = JSON.stringify([alt, labHhmm(oldest.clock), labHhmm(checked), behind.length, since && labHhmm(since),
    sim, saved.text, behind.length ? Math.floor((now - since) / 60000) : 0]);
  if (!fresh && el.dataset.labKey === key) return;
  const tipOpen = !!el.querySelector('.lab-std-tip:not([hidden])');
  el.textContent = '';
  el.dataset.labKey = key;
  const tierName = (id) => `Tier ${id.split('-')[1]}`;
  if (alt === 'c') {
    const dot = labEl('button', behind.length ? 'lab-std-dot is-behind' : 'lab-std-dot');
    dot.type = 'button';
    const tipText = behind.length
      ? `Some data is ${labAge(now - since)} old: ${behind.map((t) => tierName(t.id)).join(', ')}, since ${labHhmm(since)}. The rest is current.`
      : 'All data is current. Checks for new standings every 30 seconds while this tab is open.';
    dot.setAttribute('aria-label', tipText);
    dot.title = tipText;
    const tip = labEl('span', 'lab-std-tip', tipText);
    tip.hidden = !tipOpen;
    dot.addEventListener('click', (e) => { e.stopPropagation(); tip.hidden = !tip.hidden; saved.lastText = el.textContent; });
    el.append(dot, labEl('span', null, saved.text), tip);
  } else {
    const dot = labEl('span', 'live-dot');
    dot.title = 'Checks for new standings every 30 seconds while this tab is open';
    el.appendChild(dot);
    if (alt === 'a') {
      el.append(labEl('span', oldest.behind ? 'lab-warn' : null, `Data from ${labHhmm(oldest.clock)}`),
        labEl('span', null, ` · checked ${labHhmm(checked)}`));
    } else {
      el.appendChild(labEl('span', null, saved.text));
      if (behind.length) {
        el.append(labEl('span', 'lab-warn', ` · ${behind.length} tier${behind.length > 1 ? 's' : ''} behind`),
          labEl('span', 'lab-warn', ` since ${labHhmm(since)}`));
      }
    }
  }
  if (sim) el.appendChild(labSimTag());
  el.classList.add('lab-std-on');
  saved.mine = true;
  saved.lastText = el.textContent;
}

function labRepaintStatuses() {
  for (const el of [...labStatusSaved.keys()]) labPaintStatus(el, false);
}

// ---- repaint ------------------------------------------------------------------------
function labRepaint() {
  labRepaintStatuses();
  // The map repaints its corners every second (paintCorners); this only
  // makes the next paint rebuild them.
  if (labWrap && labWrap.isConnected) {
    for (const b of labWrap.querySelectorAll('.lab-hud-btn')) delete b.dataset.key;
  }
}

document.addEventListener('click', () => {
  for (const t of document.querySelectorAll('.lab-std-tip:not([hidden])')) t.hidden = true;
});
setInterval(labRepaintStatuses, 5000);

labPanel = labBuildPanel();
labPaintPanel();
labRepaint();
