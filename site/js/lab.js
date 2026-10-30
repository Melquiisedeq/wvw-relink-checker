// LAB (never merged). Card 38-0, round 3: "What you missed" shows only past
// the corner's 10 minutes, with no time limit, folded past 2 h and on a click
// on the map. A switch runs main's summary ("Today", verbatim copies below) or
// the site's new one ("New"); a second picks how the header's two counts are
// told apart; three buttons hold an invented kill history. Hooks in the site,
// one line each: fightSamples and killView's body take the simulation;
// missedMakeNote, missedMatchOffered, paintMissed and missedFold hand over to
// main's behaviour under "Today"; missedRefreshNote leaves a simulated summary
// alone. Everything shown goes through textContent; no request of its own.

const LAB_KEY = 'wvw-lab-38-0';
const LAB_VERSION = 3;
const LAB_SIM_MS = 10 * 60 * 1000;
const LAB_MAPS = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];
const LAB_MODES = { today: 'Today', new: 'New' };
const LAB_BADGES = { colour: 'Colour', icons: 'Icons', both: 'Both' };

const labEl = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function labReadPrefs() {
  const p = { open: false, mode: 'new', badges: 'both' };
  try {
    const v = JSON.parse(localStorage.getItem(LAB_KEY) || 'null');
    if (!v || v.v !== LAB_VERSION) return p;
    if (typeof v.open === 'boolean') p.open = v.open;
    if (Object.prototype.hasOwnProperty.call(LAB_MODES, v.mode)) p.mode = v.mode;
    if (Object.prototype.hasOwnProperty.call(LAB_BADGES, v.badges)) p.badges = v.badges;
  } catch { /* storage off or corrupt: the defaults */ }
  return p;
}
const labPrefs = labReadPrefs();
function labSave() {
  try { localStorage.setItem(LAB_KEY, JSON.stringify({ v: LAB_VERSION, ...labPrefs })); } catch { /* fine */ }
}

let labPanel = null;
function labStatus(text) {
  const s = labPanel && labPanel.querySelector('.lab-status');
  if (s) s.textContent = text;
}

// ---- Today | New ---------------------------------------------------------
const labToday = () => labPrefs.mode === 'today';
function labTodayMakeNote(before, after, since, back, kind, endAt) {
  if (!labToday()) return false;
  labMainMakeNote(before, after, since, back, kind, endAt);
  return true;
}
function labTodayOffered(match, kept) {
  if (!labToday()) return false;
  labMainOffered(match, kept);
  return true;
}
function labTodayPaint(view) {
  if (!labToday()) return false;
  labMainPaintMissed(view);
  return true;
}
// main has no fold on a click on the map.
function labTodayFold() {
  return labToday();
}

// Colour, Icons or Both: the site draws both; lab.css takes one away.
function labApplyBadges() {
  const root = document.documentElement;
  for (const k of Object.keys(LAB_BADGES)) root.classList.toggle(`lab-badges-${k}`, labPrefs.badges === k);
}

// Every summary up is made again under the other mode, from the same bodies.
function labRemakeNotes() {
  for (const [id, note] of [...missedNotes]) {
    if (!note.before) continue;
    missedMakeNote(note.before, note.after, note.rawSince, note.back, note.kind, note.endAt ?? Date.now());
    const fresh = missedNotes.get(id);
    if (fresh) fresh.until = note.until;
  }
}

// ---- the simulations -----------------------------------------------------
// One history per live match, built at the click around the body the page held
// then, served in place of the real one (fightSamples, killView's body) until
// "Back to live data" or the summary's 10 minutes: the next read of
// /api/kills and the next body change nothing while it holds.
let labSim = null;      // { kind, until, timer, matches: Map(id -> { body, samples }) }
let labSimTag = null;

const labMin = (m, s = 0) => (m * 60 + s) * 1000;
const labClone = (x) => JSON.parse(JSON.stringify(x));

// Readings every minute from `from` (the history's own pace) and one at each
// step, valued so the newest reading before the click holds exactly `top`.
function labBuildSamples(from, steps, top, t0) {
  const times = new Set(steps.map((s) => s.t));
  for (let t = from; t <= LAB_SIM_MS; t += 60000) times.add(t);
  const past = {};
  for (const m of LAB_MAPS) past[m] = 0;
  for (const s of steps) if (s.t <= 0) past[s.map] += s.d;
  const out = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const n = {};
    for (const m of LAB_MAPS) {
      let v = (Number(top[m]) || 0) - past[m];
      for (const s of steps) if (s.map === m && s.t <= t) v += s.d;
      n[m] = Math.max(0, v);
    }
    out.push({ at: t0 + t, n });
  }
  return out;
}

// Takes `d` kills off one map of a body, colour by colour.
function labLessKills(body, type, d) {
  const map = (body.maps || []).find((x) => x && x.type === type);
  if (!map || !map.kills) return;
  let left = d;
  for (const c of ['green', 'red', 'blue']) {
    const take = Math.min(left, Number(map.kills[c]) || 0);
    map.kills[c] = (Number(map.kills[c]) || 0) - take;
    left -= take;
  }
}

function labLiveMatches() {
  const out = [];
  for (const [, kept] of newestMatches) if (kept && kept.match && matchIsLive(kept.match)) out.push(kept.match);
  return out;
}

// 29/10, NA T1 Green BL: a step every 5 min, the tab hidden 12 min from just
// after the +84, and this page's copy 2 behind the shared history at the
// return. At the return the data covers exactly the corner's 10 min, so "New"
// waits; the +61, 2:50 after the click, makes the period longer and the
// summary is born, its kills above the corner's.
function labSim2910(m, t0) {
  const steps = [
    { t: -labMin(17, 10), map: 'GreenHome', d: 56 },
    { t: -labMin(12, 10), map: 'GreenHome', d: 84 },
    { t: -labMin(7, 10), map: 'GreenHome', d: 22 },
    { t: -labMin(2, 10), map: 'GreenHome', d: 83 },
    { t: labMin(2, 50), map: 'GreenHome', d: 61 },
  ];
  const body = fightTotals(m);
  const top = { ...body, GreenHome: (body.GreenHome || 0) + 2 };
  const before = labClone(m);
  labLessKills(before, 'GreenHome', 22 + 83 - 2);
  return { body, samples: labBuildSamples(-labMin(40), steps, top, t0),
    note: { before, after: m, since: t0 - labMin(12) } };
}

// Away 5 min on a busy EBG: the data covers less than the corner's 10 min,
// and the steps after the return were seen live, so "New" shows nothing.
function labSimShort(m, t0) {
  const steps = [
    { t: -labMin(6, 20), map: 'Center', d: 40 },
    { t: -labMin(1, 20), map: 'Center', d: 30 },
    { t: labMin(3, 40), map: 'Center', d: 25 },
    { t: labMin(8, 40), map: 'Center', d: 20 },
  ];
  const body = fightTotals(m);
  const before = labClone(m);
  labLessKills(before, 'Center', 30);
  return { body, samples: labBuildSamples(-labMin(30), steps, body, t0),
    note: { before, after: m, since: t0 - labMin(5) } };
}

const LAB_FLIPS = new Set(['Camp', 'Tower', 'Keep', 'Castle']);
const LAB_OWNER_NEXT = { Red: 'Blue', Blue: 'Green', Green: 'Red' };

// Away 8 h: the body before is 8 h old, every camp to castle changed hands
// since, their flips spread over the 8 h, and the history holds the last 30
// min as /api/kills does.
function labSim8h(m, t0) {
  const after = labClone(m);
  const before = labClone(m);
  const byMap = (after.maps || []).map((map) => (map.objectives || []).filter((o) => o && LAB_FLIPS.has(o.type)));
  const order = [];
  for (let i = 0; byMap.some((l) => i < l.length); i++) for (const l of byMap) if (l[i]) order.push(l[i]);
  const span = 8 * 60 * 60 * 1000;
  order.forEach((o, i) => { o.last_flipped = new Date(t0 - labMin(3) - Math.round(i * span / order.length)).toISOString(); });
  const flipped = new Set(order.map((o) => o.id));
  for (const map of before.maps || []) {
    for (const o of map.objectives || []) if (o && flipped.has(o.id)) o.owner = LAB_OWNER_NEXT[o.owner] || 'Red';
  }
  const away = { Center: 900, RedHome: 420, BlueHome: 380, GreenHome: 510 };
  for (const type of LAB_MAPS) labLessKills(before, type, away[type]);
  const steps = [
    { t: -labMin(16), map: 'Center', d: 40 },
    { t: -labMin(8), map: 'Center', d: 35 },
    { t: -labMin(7), map: 'GreenHome', d: 18 },
    { t: -labMin(2), map: 'RedHome', d: 9 },
  ];
  const body = fightTotals(m);
  return { body, samples: labBuildSamples(-labMin(30), steps, body, t0),
    note: { before, after, since: t0 - labMin(8 * 60 + 5) } };
}

const LAB_SIMS = {
  d2910: { make: labSim2910, done: 'Simulated on every live match: open a tier\'s maps, Green BL tab. Under New the summary comes with the next kills, in 3 min.' },
  short: { make: labSimShort, done: 'Simulated on every live match: open a tier\'s maps. Under New no summary, under Today one.' },
  away8h: { make: labSim8h, done: 'Simulated on every live match: open a tier\'s maps. The summary is on every map.' },
};

function labSimulate(kind) {
  const live = labLiveMatches();
  if (!live.length) { labStatus('No live match held yet: wait for the standings.'); return; }
  labEndSim(null);
  const t0 = Date.now();
  const matches = new Map();
  labSim = { kind, until: t0 + LAB_SIM_MS, matches };
  for (const m of live) {
    const sim = LAB_SIMS[kind].make(labClone(m), t0);
    matches.set(m.id, sim);
    missedNotes.delete(m.id);
    missedMakeNote(sim.note.before, sim.note.after, sim.note.since, t0, 'return');
  }
  labSim.timer = setTimeout(() => labEndSim('The simulation ended by itself: live data again.'), LAB_SIM_MS);
  labShowTag(true);
  labStatus(LAB_SIMS[kind].done);
}

function labEndSim(message) {
  if (labSim) {
    clearTimeout(labSim.timer);
    for (const id of labSim.matches.keys()) missedNotes.delete(id);
    labSim = null;
  }
  labShowTag(false);
  if (message) labStatus(message);
}

function labShowTag(on) {
  if (!on) { if (labSimTag) labSimTag.remove(); labSimTag = null; return; }
  if (labSimTag) return;
  labSimTag = labEl('div', 'lab-simmark', 'simulated');
  labSimTag.title = 'Lab: the kills and the summary on screen are invented. "Back to live data" in the Lab panel.';
  document.body.appendChild(labSimTag);
}

function labSimFor(match) {
  if (!labSim || !match) return null;
  if (Date.now() > labSim.until) { labEndSim('The simulation ended by itself: live data again.'); return null; }
  return labSim.matches.get(match.id) || null;
}

// Hook in fightSamples: the simulated history, readings up to now.
function labFightSamples(match) {
  const sim = labSimFor(match);
  if (!sim) return null;
  const now = Date.now();
  return sim.samples.filter((s) => s.at <= now);
}

// Hook in killView: the body held at the click.
function labBody(match) {
  const sim = labSimFor(match);
  return sim ? { ...sim.body } : null;
}

// Hook in missedRefreshNote: a real body does not replace a simulated summary.
function labHoldNote(match) {
  return !!labSimFor(match);
}

// ---- the panel -----------------------------------------------------------
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
  head.append(labEl('strong', null, 'Lab'), labEl('span', 'lab-muted', ' · What you missed, preview only'));
  body.appendChild(head);

  const fs = labEl('fieldset', 'lab-switch');
  fs.appendChild(labEl('legend', 'lab-sr-legend', 'Summary'));
  for (const [k, text] of Object.entries(LAB_MODES)) {
    const rl = labEl('label');
    const r = labEl('input');
    r.type = 'radio';
    r.name = 'lab-mode';
    r.value = k;
    r.addEventListener('change', () => {
      if (!r.checked || labPrefs.mode === k) return;
      labPrefs.mode = k;
      labSave();
      labRemakeNotes();
      labPaintPanel();
    });
    rl.append(r, labEl('span', null, text));
    fs.appendChild(rl);
  }
  body.appendChild(fs);

  body.appendChild(labEl('span', 'lab-muted', 'The two counts in the header'));
  const fb = labEl('fieldset', 'lab-switch');
  fb.appendChild(labEl('legend', 'lab-sr-legend', 'The two counts in the header'));
  for (const [k, text] of Object.entries(LAB_BADGES)) {
    const rl = labEl('label');
    const r = labEl('input');
    r.type = 'radio';
    r.name = 'lab-badges';
    r.value = k;
    r.addEventListener('change', () => {
      if (!r.checked) return;
      labPrefs.badges = k;
      labSave();
      labPaintPanel();
    });
    rl.append(r, labEl('span', null, text));
    fb.appendChild(rl);
  }
  body.appendChild(fb);

  const buttons = [
    ['Simulate 29/10 (invented numbers)', () => labSimulate('d2910')],
    ['Simulate short absence, 5 min (invented numbers)', () => labSimulate('short')],
    ['Simulate 8 h away (invented numbers)', () => labSimulate('away8h')],
    ['Back to live data', () => labEndSim('Back to live data.')],
  ];
  for (const [label, run] of buttons) {
    const b = labEl('button', 'lab-btn', label);
    b.type = 'button';
    b.addEventListener('click', run);
    body.appendChild(b);
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
  for (const r of body.querySelectorAll('input[name=lab-mode]')) r.checked = labPrefs.mode === r.value;
  for (const r of body.querySelectorAll('input[name=lab-badges]')) r.checked = labPrefs.badges === r.value;
  labApplyBadges();
}

labPanel = labBuildPanel();
labPaintPanel();

// ---- "Today": main's summary, verbatim ---------------------------------------
// missedMakeNote and missedMatchOffered from js/maps-early.js, paintMissed from
// js/maps.js, as they are on main; missedPeriod and missedRefreshNote did not
// change and are the site's own.
function labMainMakeNote(before, after, since, back, kind, endAt = back) {
  const changes = missedOwnerChanges(before, after).slice(0, MISSED_CHANGES_MAX);
  const name = (c) => {
    const id = COLORS.includes(c) ? matchTeamId(after, c) : null;
    return id ? getTeamName(id) : 'Neutral';
  };
  for (const c of changes) { c.toName = name(c.to); c.fromName = name(c.from); }
  // The whole match, before against after: the number a reader can check.
  const kills = Math.max(0, missedKillTotal(after) - missedKillTotal(before));
  // The same difference map by map, the maps that moved, in the tabs' order.
  const was = new Map(missedMaps(before).map((m) => [m && m.type, colorSum(m && m.kills)]));
  const order = Object.keys(MAP_TAB_NAME);
  const perMap = missedMaps(after)
    .map((m) => ({ type: m && m.type, n: Math.max(0, colorSum(m && m.kills) - (was.get(m && m.type) || 0)) }))
    .filter((m) => m.n > 0 && typeof m.type === 'string')
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const period = missedPeriod(before, after, since, endAt, changes);
  // The body is kept only after this call: until then the end is the period's,
  // then the time the kept body's data is from, which the history may still
  // move earlier. A later body moves that time on, so the earliest end
  // seen stands (missedMatchOffered reads it before keepNewestMatch writes).
  const newest = Math.max(period.start, ...changes.map((c) => (c.flipped <= endAt ? c.flipped : -Infinity)));
  let earliest = period.end;
  const end = () => {
    const kept = newestMatches.get(after.id);
    if (kept && !missedBodyChanged(kept.match, after)) earliest = Math.min(earliest, kept.at);
    return Math.max(earliest, newest);
  };
  missedNotes.set(after.id, { kind, since: period.start, get end() { return end(); }, sure: period.sure, back,
    before, rawSince: since, after,
    until: back + MISSED_SHOW_MS, changes, kills, perMap,
    open: false, wideOpen: true, moreMaps: new Set() });
  if (endAt === back) missedRingFor(after.id, changes);
}
function labMainOffered(match, kept) {
  const now = Date.now();
  const lastOffer = missedLastOffer.get(match.id) || 0;
  missedLastOffer.set(match.id, now);
  const standing = missedNotes.get(match.id);
  // Reading the end fixes it before keepNewestMatch moves `at` on.
  if (standing) void standing.end;
  if (!kept || matchIsBehind(match, kept.match)) return;
  if (match.start_time !== kept.match.start_time || !matchIsLive(match)) return;
  if (missedReturn && now - missedReturn.back > MISSED_RETURN_WAIT_MS) missedReturn = null;
  if (missedReturn && missedReturn.bodies.has(match.id)) {
    const before = missedReturn.bodies.get(match.id);
    missedReturn.bodies.delete(match.id);
    if (before.start_time === match.start_time && missedBodyChanged(before, match)) {
      missedMakeNote(before, match, missedReturn.since, now, 'return');
      return;
    }
  }
  if (now - kept.at > HUD_STALE_MS && lastOffer > kept.at && now - lastOffer < MISSED_ASLEEP_MS
      && missedBodyChanged(kept.match, match)) {
    missedMakeNote(kept.match, match, kept.at, now, 'pause');
    return;
  }
  if (missedRefreshNote(match, now)) return;
  // Any other update: the ring alone, on what changed hands under your eyes.
  missedRingFor(match.id, missedOwnerChanges(kept.match, match));
}
function labMainPaintMissed(view) {
  const note = missedNoteFor(view.matchId);
  let box = view.side.querySelector('.wvw-missed:not(.is-leaving)');
  if (!note || (!note.changes.length && !note.kills)) {
    if (box) {
      box.classList.add('is-leaving');
      setTimeout(() => box.remove(), 200);
    }
    return;
  }
  const narrow = window.matchMedia(MISSED_NARROW).matches;
  // Folded on a phone until asked; open beside the map until hidden.
  const open = narrow ? note.open : note.wideOpen;
  const key = JSON.stringify([view.type, note.since, note.end, note.sure, narrow, open, [...note.moreMaps].sort()]);
  if (box && box.dataset.key === key) return;
  if (!box) {
    box = missedEl('section', 'wvw-missed');
    view.side.insertBefore(box, view.side.firstChild);
  }
  box.dataset.key = key;
  box.dataset.kind = note.kind;
  box.textContent = '';
  box.classList.toggle('is-open', open);

  const away = note.kind === 'return';
  const span = note.sure ? missedSpan(note.since, note.end) : `since before ${missedHhmm(note.since)}`;
  const changes = note.changes;

  const head = missedEl('button', 'wvw-missed-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  head.title = (away
    ? `What changed in the match while this tab was in the background, ${span}.`
    : `The game's API repeated an old answer; this is what changed in the match, ${span}.`)
    + ' Shown for 10 minutes after the data came back.';
  const title = missedEl('span', 'wvw-group wvw-missed-title');
  title.append(`${away ? 'What you missed' : 'What happened'} · `, missedEl('span', 'wvw-missed-time', span));
  head.appendChild(title);
  if (changes.length) {
    const count = missedEl('span', 'wvw-missed-count', String(changes.length));
    count.setAttribute('aria-label', `${changes.length} objective${changes.length === 1 ? '' : 's'} changed hands`);
    head.appendChild(count);
  }
  head.appendChild(missedChevron());
  head.addEventListener('click', (e) => {
    e.stopPropagation();
    if (narrow) note.open = !open; else note.wideOpen = !open;
    note.moreMaps.clear();
    view.repaint();
  });
  box.appendChild(head);
  if (!open) return;

  const sub = missedEl('p', 'wvw-missed-sub',
    away ? 'While this tab was in the background' : "While the game's API was behind");
  // One row per map that had a change or a kill, in the tabs' order: the map's
  // name (a button to its tab) and its kills, then the chips of that map.
  // The open map's chips are normal, the others a little quieter.
  const kills = new Map(note.perMap.map((m) => [m.type, m.n]));
  const rows = [];
  for (const type of Object.keys(MAP_TAB_NAME)) {
    const list = changes.filter((c) => c.map === type);
    if (!list.length && !kills.has(type)) continue;
    const mapName = MAP_TAB_NAME[type];
    const here = type === view.type;
    const row = missedEl('div', `wvw-missed-row tint-${MISSED_MAP_TINT[type] || 'neutral'}${here ? '' : ' is-other'}`);
    const top = missedEl('div', 'wvw-missed-rowhead');
    const name = missedEl('button', 'wvw-missed-mapname');
    name.type = 'button';
    name.title = `Open ${mapName}`;
    name.appendChild(missedEl('span', `dot dot-${MISSED_MAP_TINT[type] || 'neutral'}`));
    name.append(mapName);
    name.addEventListener('click', (e) => { e.stopPropagation(); view.goTo(type, null, false); });
    top.appendChild(name);
    if (kills.has(type)) {
      const n = kills.get(type);
      const k = missedEl('span', 'wvw-missed-kills');
      k.setAttribute('aria-label', `${n} kill${n === 1 ? '' : 's'} on ${mapName}`);
      k.appendChild(missedEl('b', 'wvw-missed-killn', String(n)));
      k.append(n === 1 ? ' kill' : ' kills');
      top.appendChild(k);
    }
    row.appendChild(top);
    if (list.length) {
      const chips = missedEl('div', 'wvw-chips');
      const room = note.moreMaps.has(type) ? list.length : narrow ? MISSED_CHIPS_NARROW : MISSED_CHIPS_WIDE;
      for (const c of list.slice(0, room)) chips.appendChild(missedChip(c, here, view.goTo, view.spot));
      const hidden = list.length - Math.min(list.length, room);
      if (hidden > 0) {
        const more = missedEl('button', 'wvw-chip wvw-chip-more', `+${hidden}`);
        more.type = 'button';
        more.setAttribute('aria-label', `Show ${hidden} more on ${mapName}`);
        more.addEventListener('click', (e) => { e.stopPropagation(); note.moreMaps.add(type); view.repaint(); });
        chips.appendChild(more);
      }
      row.appendChild(chips);
    }
    rows.push(row);
  }
  const body = missedEl('div', 'wvw-missed-body');
  // Rows first on every width: on a phone they are what a tap opened it for.
  const parts = narrow ? [...rows, sub] : [sub, ...rows];
  for (const p of parts) body.appendChild(p);
  box.appendChild(body);
}
