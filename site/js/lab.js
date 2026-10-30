// LAB (never merged). Card 38-0: the kills' window on the map's corner and in
// "What you missed". Loaded just before js/boot.js. Hooks in the site, one line
// each: fightSamples and killView's body (js/maps-early.js) take the simulated
// history; missedPeriod asks labMissedStart for the start; paintKills
// (js/maps.js) hands its corner to labPaintKills. Everything shown goes through
// textContent; no request of its own.

const LAB_KEY = 'wvw-lab-38-0';
const LAB_VERSION = 1;
const LAB_SIM_MS = 6 * 60 * 1000;
const LAB_MAPS = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];

const LAB_ITEMS = [
  { type: 'section', label: 'A · Same interval, same count' },
  { type: 'radio', key: 'a', label: 'A', options: {
    today: 'Today',
    start: 'Missed starts at the first step the page did not have',
    steps: '…and the corner lists the steps',
  }, value: 'today' },
  { type: 'button', label: 'Simulate 29/10: step at the edge + tab hidden (invented numbers)', run: () => labSimulate('edge') },
  { type: 'section', label: 'B · After a data gap' },
  { type: 'radio', key: 'b', label: 'B', options: { today: 'Today ("81 kills in 63 min")', jump: 'The jump ("+74 at 10:47")' }, value: 'today' },
  { type: 'button', label: 'Simulate a 55-min gap (invented numbers)', run: () => labSimulate('gap') },
  { type: 'section', label: 'D · "data up to"' },
  { type: 'radio', key: 'd', label: 'D', options: { today: 'Today (from 5.5 min)', always: 'Always' }, value: 'today' },
  { type: 'section', label: 'S · "no new kills since"' },
  { type: 'radio', key: 's', label: 'S', options: { today: 'Match time (today)', own: "Each map's own time" }, value: 'today' },
  { type: 'button', label: 'Simulate a quiet borderland (invented numbers)', run: () => labSimulate('quiet') },
  { type: 'section', label: 'Simulation' },
  { type: 'button', label: 'Back to live data', run: () => labEndSim('Back to live data.') },
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
let labLastA = labPrefs.a;
function labChanged() {
  labSave();
  labPaintPanel();
  if (labPrefs.a !== labLastA) { labLastA = labPrefs.a; labRemakeNotes(); }
}

let labPanel = null;
function labStatus(text) {
  const s = labPanel && labPanel.querySelector('.lab-status');
  if (s) s.textContent = text;
}

// ---- the simulation ---------------------------------------------------
// One history per live match, built at the click around the totals the page
// held then (`body`), and served in place of the real one until it ends: the
// next read of /api/kills changes nothing while it lasts.
let labSim = null;      // { kind, until, timer, matches: Map(id -> { body, samples, note }) }
let labSimTag = null;

const labMin = (m, s = 0) => (m * 60 + s) * 1000;

// Steps on a map at `t` ms from the click (negative: before it).
const LAB_TIMELINES = {
  // 1-1 Green BL, 29/10 (UTC 01:36-01:55), moved so the popover's moment is now.
  edge: { from: labMin(-40), gaps: [], steps: [
    { t: labMin(-30), map: 'GreenHome', d: 31 },
    { t: labMin(-24, -10), map: 'GreenHome', d: 12 },
    { t: labMin(-19, -2), map: 'GreenHome', d: 40 },
    { t: -labMin(14, 17), map: 'GreenHome', d: 56 },
    { t: -labMin(7, 59), map: 'GreenHome', d: 84 },
    { t: -labMin(3, 0), map: 'GreenHome', d: 22 },
    { t: labMin(2, 1), map: 'GreenHome', d: 83 },
  ], hiddenAt: -labMin(7, 30), missed: 22 },
  // EBG, 1-1, 29/10: no row for the match for 55 min, then +74 at once.
  gap: { from: labMin(-90), gaps: [[-labMin(56), -labMin(1)]], steps: [
    { t: -labMin(85), map: 'Center', d: 6 }, { t: -labMin(80), map: 'Center', d: 4 },
    { t: -labMin(75), map: 'Center', d: 9 }, { t: -labMin(70), map: 'Center', d: 3 },
    { t: -labMin(65), map: 'Center', d: 5 }, { t: -labMin(60), map: 'Center', d: 2 },
    { t: -labMin(57), map: 'GreenHome', d: 3 },
    { t: -labMin(1), map: 'Center', d: 74 }, { t: -labMin(1), map: 'RedHome', d: 6 },
  ] },
  // EBG fighting, a step every 5 min; Red BL still for 30 min.
  quiet: { from: labMin(-60), gaps: [], steps: [] },
};
(() => {
  const q = LAB_TIMELINES.quiet.steps;
  const ebg = [38, 52, 41, 60, 47, 55, 39, 62, 44, 58, 50, 46, 57, 49];
  for (let i = 0; i < ebg.length; i++) q.push({ t: -labMin(5 * (ebg.length - 1 - i), 40), map: 'Center', d: ebg[i] });
  for (const t of [labMin(4, 20), labMin(9, 20)]) q.push({ t, map: 'Center', d: 45 });
  for (const m of [-55, -50, -45, -40, -35, -30]) q.push({ t: labMin(m, -20), map: 'RedHome', d: 9 + (-m % 7) });
  for (const m of [-38, -21, -9]) q.push({ t: labMin(m, -5), map: 'BlueHome', d: 7 });
  q.sort((a, b) => a.t - b.t);
})();

// Readings every minute (the history's own pace) and one at each step, valued
// so the newest reading before the click holds exactly `body`.
function labBuildSamples(spec, body, t0) {
  const times = new Set(spec.steps.map((s) => s.t));
  for (let t = spec.from; t <= LAB_SIM_MS; t += 60000) times.add(t);
  const inGap = (t) => spec.gaps.some(([a, b]) => t > a && t < b);
  const past = {};
  for (const m of LAB_MAPS) past[m] = 0;
  for (const s of spec.steps) if (s.t <= 0) past[s.map] += s.d;
  const out = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    if (inGap(t)) continue;
    const n = {};
    for (const m of LAB_MAPS) {
      let v = (Number(body[m]) || 0) - past[m];
      for (const s of spec.steps) if (s.map === m && s.t <= t) v += s.d;
      n[m] = Math.max(0, v);
    }
    out.push({ at: t0 + t, n });
  }
  return out;
}

function labLiveMatches() {
  const out = [];
  for (const [, kept] of newestMatches) if (kept && kept.match && matchIsLive(kept.match)) out.push(kept.match);
  return out;
}

function labSimulate(kind) {
  const live = labLiveMatches();
  if (!live.length) { labStatus('No live match held yet: open the standings first.'); return; }
  labEndSim(null);
  const spec = LAB_TIMELINES[kind];
  const t0 = Date.now();
  const matches = new Map();
  for (const m of live) {
    const body = fightTotals(m);
    matches.set(m.id, { body, samples: labBuildSamples(spec, body, t0), note: null });
  }
  labSim = { kind, until: t0 + LAB_SIM_MS, matches };
  labSim.timer = setTimeout(() => labEndSim('The simulation ended by itself: live data again.'), LAB_SIM_MS);
  if (kind === 'edge') {
    for (const m of live) labSimNote(m, t0 + spec.hiddenAt, spec.missed);
  }
  labShowTag(true);
  labStatus({
    edge: 'Simulated on every live match: Green BL steps +56, +84, +22, and +83 lands in 2 min. The tab "was hidden" just after the +84: open the maps, Green BL tab.',
    gap: 'Simulated on every live match: no kill data for 55 min, then +74 on EBG 1 min ago. Open the maps, EBG tab.',
    quiet: 'Simulated on every live match: EBG steps every 5 min, Red BL still for 30 min. Open the maps, Red BL tab, then EBG.',
  }[kind]);
}

// A tab-return summary whose body before is the real one minus the kills after
// the hide, on Green BL.
function labSimNote(after, hiddenAt, missed) {
  const before = JSON.parse(JSON.stringify(after));
  const map = (before.maps || []).find((x) => x && x.type === 'GreenHome');
  if (!map || !map.kills) return;
  let left = missed;
  for (const c of ['green', 'red', 'blue']) {
    const take = Math.min(left, Number(map.kills[c]) || 0);
    map.kills[c] = (Number(map.kills[c]) || 0) - take;
    left -= take;
  }
  const sim = labSim.matches.get(after.id);
  sim.note = { before, after, since: hiddenAt, back: Date.now() };
  labMakeSimNote(after.id);
}

function labMakeSimNote(id) {
  const sim = labSim && labSim.matches.get(id);
  if (!sim || !sim.note) return;
  const { before, after, since, back } = sim.note;
  const old = missedNotes.get(id);
  missedMakeNote(before, after, since, back, 'return');
  const note = missedNotes.get(id);
  // Kept off missedRefreshNote: a real body coming in would rewrite it.
  note.before = null;
  note.lab = true;
  if (old && old.lab) Object.assign(note, { open: old.open, wideOpen: old.wideOpen, moreMaps: old.moreMaps });
}

// The A choice changes the start: every summary up is made again.
function labRemakeNotes() {
  for (const [id, note] of [...missedNotes]) {
    if (note.lab) { labMakeSimNote(id); continue; }
    if (!note.before) continue;
    missedMakeNote(note.before, note.after, note.rawSince, note.back, note.kind, note.back);
    Object.assign(missedNotes.get(id), { until: note.until, open: note.open, wideOpen: note.wideOpen, moreMaps: note.moreMaps });
  }
}

function labEndSim(message) {
  if (labSim) {
    clearTimeout(labSim.timer);
    for (const id of labSim.matches.keys()) {
      const n = missedNotes.get(id);
      if (n && n.lab) missedNotes.delete(id);
    }
    labSim = null;
  }
  labShowTag(false);
  if (message) labStatus(message);
}

function labShowTag(on) {
  if (!on) { if (labSimTag) labSimTag.remove(); labSimTag = null; return; }
  if (labSimTag) return;
  labSimTag = labEl('div', 'lab-simmark', 'simulated');
  labSimTag.title = 'Lab: the kill history on screen is invented. "Back to live data" in the Lab panel.';
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

// Hook in killView: the totals held at the click, so a real body arriving
// does not land on top of the invented history.
function labBody(match) {
  const sim = labSimFor(match);
  return sim ? { ...sim.body } : null;
}

// Hook in missedPeriod. A1: the start is when the first reading above the body
// before reached us, the first step the page did not have.
function labMissedStart(list, need, start, sure) {
  if (labPrefs.a === 'today') return { start, sure };
  const total = (s) => sumKills(s.n);
  const j = list.findIndex((s) => total(s) > need);
  // 1 ms before the reading, so missedPeriod's end (a reading after the start) can be that same reading.
  return j >= 0 ? { start: list[j].at - 1, sure: true } : { start, sure };
}

// ---- the corner --------------------------------------------------------
const labExtra = new WeakMap();   // left corner -> { steps, tail }

function labSpans(ctx) {
  let x = labExtra.get(ctx.left);
  if (!x) {
    const tail = labEl('span', 'lab-tail');
    ctx.line2.appendChild(tail);
    const steps = labEl('span', 'wvw-hud-small lab-steps');
    ctx.line2.parentNode.appendChild(steps);
    x = { tail, steps };
    labExtra.set(ctx.left, x);
  }
  return x;
}

function labHistory(matchId) {
  const kept = newestMatches.get(matchId);
  if (!kept) return null;
  const match = kept.match;
  const body = labBody(match) || fightTotals(match);
  return { list: fightSamples(match), body };
}

// The steps of one map between the window's base and the clock: the time each
// reached the page, which is what dates the kills today.
function labSteps(h, view, type) {
  const base = h.list.filter((s) => s.at <= view.gap.from).pop();
  let prev = base ? Number(base.n[type]) || 0 : 0;
  const out = [];
  for (const s of h.list) {
    if (s.at <= view.gap.from || s.at > view.clock) continue;
    const v = Number(s.n[type]) || 0;
    if (v > prev) { out.push({ d: v - prev, at: s.at }); prev = v; }
  }
  const b = Number(h.body[type]) || 0;
  if (b > prev) out.push({ d: b - prev, at: view.clock });
  return out;
}

// When this map's own count last moved, and whether that is only "before" the
// oldest reading.
function labOwnClock(h, view, type) {
  let top = Number(h.body[type]) || 0;
  for (const s of h.list) top = Math.max(top, Number(s.n[type]) || 0);
  const i = h.list.findIndex((s) => (Number(s.n[type]) || 0) >= top);
  if (i < 0) return { at: view.clock, before: false };
  return { at: h.list[i].at, before: i === 0 };
}

function labTwo(ctx) {
  ctx.left.classList.add('is-two');
  ctx.line2.hidden = false;
  ctx.put(ctx.smallSep, ' in ');
  ctx.put(ctx.smallMark, ctx.odd ? '⚠ ' : '');
}

function labPaintKills(ctx) {
  const { view, type, line, put, hhmm } = ctx;
  const x = labSpans(ctx);
  let tail = '';
  let steps = '';
  let text = ctx.text;
  const h = line && view && view.clock && type ? labHistory(ctx.matchId) : null;
  if (h) {
    const mins = (ms) => Math.round(ms / 60000);
    let sDone = false;
    if (labPrefs.b === 'jump' && view.long && view.gap) {
      const s0 = h.list.filter((s) => s.at <= view.gap.from).pop();
      const s1 = h.list.find((s) => s.at >= view.gap.to);
      const v1 = s1 ? Number(s1.n[type]) || 0 : Number(h.body[type]) || 0;
      const jump = Math.max(0, v1 - (s0 ? Number(s0.n[type]) || 0 : 0));
      const hole = mins(view.gap.to - view.gap.from);
      labTwo(ctx);
      put(ctx.big, jump > 0 ? `+${jump}` : '0');
      ctx.smallTail.hidden = true;
      put(ctx.lead, 'at ');
      put(ctx.smallTime, hhmm(view.gap.to));
      tail = ` · after ${hole} min without data`;
      text = `${jump} kills reached us at ${hhmm(view.gap.to)}, after ${hole} min with no kill data (${hhmm(view.gap.from)}–${hhmm(view.gap.to)}).`
        + ` They happened at some point in those ${hole} min; exactly when is not known.`;
      sDone = true;
    }
    if (!sDone && labPrefs.s === 'own' && !ctx.odd) {
      const own = labOwnClock(h, view, type);
      const quietMatch = ctx.old && ctx.lead.textContent.startsWith('no new kills');
      const freshMatch = !ctx.old && !ctx.hole;
      if (Date.now() - own.at > KILLS_QUIET_MS && (freshMatch || quietMatch)) {
        labTwo(ctx);
        put(ctx.lead, own.before ? 'no new kills since before ' : 'no new kills since ');
        put(ctx.smallTime, hhmm(own.at));
        text = `No new kills on this map since ${own.before ? 'before ' : ''}${hhmm(own.at)}`
          + (freshMatch ? `, while other maps of the match moved (latest at ${hhmm(view.clock)}).` : ', as on a quiet map.')
          + ` ${line.kills} kills in the ${line.mins} min up to ${hhmm(view.clock)}.`;
        sDone = true;
      }
    }
    if (!sDone && labPrefs.d === 'always' && !ctx.two) {
      labTwo(ctx);
      put(ctx.lead, 'data up to ');
      put(ctx.smallTime, hhmm(view.clock));
      text = `${line.kills} kills in the ${line.mins} min up to ${hhmm(view.clock)}, when the newest kill data reached us.`;
    }
    if (labPrefs.a === 'steps' && view.gap && !(labPrefs.b === 'jump' && view.long)) {
      const list = labSteps(h, view, type);
      if (list.length) {
        const shown = list.slice(-3);
        steps = (list.length > 3 ? '… ' : '') + shown.map((s) => `+${s.d} ${hhmm(s.at)}`).join(' · ');
        text += ` Steps in this window, at the time each reached us: ${list.map((s) => `+${s.d} at ${hhmm(s.at)}`).join(', ')}.`;
      }
    }
  }
  if (x.tail.textContent !== tail) x.tail.textContent = tail;
  if (x.steps.textContent !== steps) x.steps.textContent = steps;
  x.steps.hidden = !steps;
  if (text !== ctx.text) ctx.tip(text);
}

// A1 with a single step: start and end are the same minute, said once.
if (window.MutationObserver) {
  new MutationObserver(() => {
    if (labPrefs.a === 'today') return;
    for (const el of document.querySelectorAll('.wvw-missed-time')) {
      const m = /^(.+?)\u2013(.+)$/.exec(el.textContent);
      if (m && (m[2] === m[1] || m[2].startsWith(`${m[1]} `))) el.textContent = m[2];
    }
  }).observe(document.body, { childList: true, subtree: true });
}

// ---- the panel -----------------------------------------------------------
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
  head.append(labEl('strong', null, 'Lab'), labEl('span', 'lab-muted', ' · kills window, preview only'));
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
      const fs = labEl('fieldset', 'lab-radios lab-radios-block');
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
}

labPanel = labBuildPanel();
labPaintPanel();
