// LAB (never merged). Card 82-0, round 2: the swords on every map with a fight, the busiest marked,
// and the map's colour on each Captures row. "Today" is main's drawing. Hooks in the site,
// one line each: markHotTab (labMarkTabs) adds the other maps' swords; fightSamples and
// killView's body (labFightSamples, labBody) and recentCaptures (labCaptures) take the
// simulation. The corner and the tier button's badge still read killView's one busiest map.
// Everything shown goes through textContent; no request of its own.

const LAB_KEY = 'wvw-lab-82-0';
const LAB_VERSION = 2;          // bump when the defaults change: older saved choices are dropped
const LAB_SWORDS = { today: 'Today', A: 'A', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G', H: 'H', I: 'I', J: 'J', K: 'K', L: 'L', M: 'M', N: 'N', O: 'O', P: 'P' };
const LAB_CAPS = { today: 'Today', A: 'A', B: 'B', F: 'F' };
const LAB_ITEMS = [
  { type: 'check', key: 'keepMap', label: 'Keep the map open while I use the Lab', on: true },
  { type: 'section', label: 'Swords on the map tabs' },
  { type: 'radio', key: 'swords', label: 'Swords', options: LAB_SWORDS, value: 'today' },
  { type: 'note', text: 'Swords on every busy map; the busiest marked. A (round 1): a thin orange line under it. C (round 1): its swords bigger, a still glow. D: A\u2019s line, breathing slowly. E: an ember glow behind its swords, breathing slowly, the swords their usual size. F: a shine sweeping over its swords every few seconds. G: D and E together. H: the busiest\u2019s swords themselves glow, a soft light in their own shape, breathing. I: H, and the swords\u2019 orange warming to gold and back. J: the busiest\u2019s two swords swing apart and strike, with a few sparks. K: J\u2019s strike, then F\u2019s shine over the crossed swords, then a few seconds still. L: K, and the swords flare with an orange glow at the strike that fades. M: I without the gold: the glow, and the swords brightening in their own orange. N: L with about a second still between strikes. O: N, the glow always faintly on and swelling at the strike. P: N, and the orange line under the tab lighting up at the strike.' },
  { type: 'check', key: 'cornerFx', label: 'The map\u2019s corner: an effect on the busiest', on: true, cls: true },
  { type: 'radio', key: 'corner', label: 'Corner effect', options: { shine: 'Shine', strike: 'Strike' }, value: 'strike' },
  { type: 'note', text: 'Shine: the corner\u2019s swords glow with the shine. Strike: they strike like the tab\u2019s. Either way the shine crosses the kill number too. N, O and P only.' },
  { type: 'section', label: 'Captures: the map\u2019s colour' },
  { type: 'radio', key: 'caps', label: 'Captures map colour', options: LAB_CAPS, value: 'today' },
  { type: 'note', text: 'A: the map\u2019s dot before its name. B: a thin bar on the row\u2019s left edge. F: the map\u2019s name on a soft tint.' },
  { type: 'section', label: 'Simulate' },
  { type: 'button', label: 'Simulate fights on 3 maps (invented numbers)', run: () => labSimulate() },
  { type: 'button', label: 'Back to live data', run: () => { labEndSim('Live data again.'); labRepaint(); } },
];

// ---- the swords ------------------------------------------------------------
// Every map past the same floor killView lights the busiest with. No swords
// anywhere when killView lights none: its other refusals (a stale or stalled
// count) hold for every map.
function labLitTypes(view) {
  const out = [];
  if (!view || !view.hot || !view.rates) return out;
  for (const [type, n] of view.rates.per) {
    if (n >= HOT_FLOOR && (n >= HOT_BIG || view.silence <= HOT_SMALL_WANT_MS)) out.push(type);
  }
  if (!out.includes(view.hot)) out.push(view.hot);
  return out;
}

function labFullSwords() {
  const im = document.createElement('img');
  im.className = 'lab-sw';
  im.src = 'assets/icons/Event_Swords.webp';
  im.alt = '';
  im.width = 14;
  im.height = 14;
  return im;
}

// J: the site's own icon cut in two (assets/lab/: the "/" sword, on top as in the icon, and its
// mirror); each swings about its own guard (CSS transform-origin) and they strike at the cross.
function labOneSword(file, cls) {
  const im = labEl('img', `lab-clash-sw ${cls}`);
  im.src = `assets/lab/${file}`;
  im.alt = '';
  im.width = 14;
  im.height = 14;
  return im;
}
function labClash(shine) {
  const w = labEl('span', 'lab-clash');
  w.append(labOneSword('sword-back.png', 'lab-clash-back'), labOneSword('sword-up.png', 'lab-clash-up'), labEl('span', 'lab-clash-flash'));
  // K and L: the shine is born with the swords, so it always follows their strike.
  if (shine) w.appendChild(labEl('span', 'lab-clash-shine'));
  for (let i = 0; i < 5; i++) w.appendChild(labEl('span', `lab-spark lab-spark-${i}`));
  return w;
}
// LAB-CLASH-END

// The corner's shine and glow take the tab's place in the cycle (the site moves both by the same steps after).
function labSyncHud(hud) {
  const tab = document.querySelector('.info-popover .wvw-tab.lab-lead .lab-clash-shine');
  const ref = tab && tab.getAnimations()[0];
  if (!ref || !hud.isConnected) return;
  for (const a of hud.getAnimations({ subtree: true })) if (/^lab-.*-n$|^lab-corner-glow$/.test(a.animationName)) a.currentTime = ref.currentTime;
}

let labTabs = null;     // { tabs, refresh } of the open map, from the last markHotTab
function labMarkTabs(tabs, hot, view, refresh) {
  labTabs = { tabs, refresh };
  const mode = labPrefs.swords;
  const lit = mode === 'today' || !hot ? [] : labLitTypes(view);
  // The map's corner: orange swords on any map with a fight, not only the busiest.
  const open = [...tabs].find(([, b]) => b.classList.contains('is-active'));
  document.documentElement.classList.toggle('lab-corner-warm', !!open && lit.includes(open[0]));
  const hud = document.querySelector('.info-popover .wvw-hud-l');
  const hi = hud && hud.querySelector('img');
  if (hi) {
    // From the boxes, not offsetLeft: the corner is itself positioned, with a border.
    const hr = hud.getBoundingClientRect(), ir = hi.getBoundingClientRect();
    hud.style.setProperty('--lab-cx', `${ir.left - hr.left - hud.clientLeft}px`);
    hud.style.setProperty('--lab-cy', `${ir.top - hr.top - hud.clientTop}px`);
    hud.style.setProperty('--lab-cs', `${hi.offsetWidth}px`);
    // The busiest map's corner shines (swords and number) in step with its tab.
    const lead = !!open && open[0] === hot && lit.includes(hot);
    const strike = lead && 'NOP'.includes(mode) && labPrefs.corner === 'strike';
    const had = hud.querySelector('.lab-hud-clash');
    if (strike && !had) {
      const w = labEl('span', 'lab-hud-clash');
      w.style.setProperty('--lab-k', String(hi.offsetWidth / 14));
      w.appendChild(labClash(true));
      hud.appendChild(w);
    } else if (!strike && had) had.remove();
    hud.classList.toggle('lab-has-clash', strike);
    const state = lead ? labPrefs.corner : '';
    if (state && hud.dataset.labCorner !== state) setTimeout(() => labSyncHud(hud), 60);
    hud.dataset.labCorner = state;
    hud.classList.toggle('lab-hud-lead', lead);
  }
  for (const [type, b] of tabs) {
    const role = !lit.includes(type) ? '' : type === hot ? 'lead' : 'lit';
    if (role === 'lit') {
      const c = typeof fightCount === 'function' ? fightCount(view.rates, type) : null;
      if (c) b.title = `${MAP_PANEL_NAME[type] || type} \u2014 ${c.kills} kills in ${c.mins} min`;
    }
    // The site repaints the tabs every second: rebuilt each time, the animations would restart.
    const want = role && `${mode}:${role}`;
    if ((b.dataset.lab || '') === want) continue;
    b.dataset.lab = want;
    for (const e of b.querySelectorAll('.lab-sw, .lab-glow, .lab-clash')) e.remove();
    b.classList.remove('lab-lit', 'lab-lead');
    if (role === 'lit') {
      b.insertBefore(labFullSwords(), b.firstChild);
      b.classList.add('lab-lit');
    }
    if (role === 'lead') {
      b.classList.add('lab-lead');
      // Inserted first-child, so the later one sits under: the glow goes in after the clash.
      if ('JKLNOP'.includes(mode)) b.insertBefore(labClash(mode !== 'J'), b.firstChild);
      if ('HILMNO'.includes(mode)) {
        const g = labFullSwords();
        g.className = 'lab-glow';
        b.insertBefore(g, b.firstChild);
      }
    }
  }
}

// ---- the simulation ----------------------------------------------------------
// Per live match, a minute-by-minute kill history from 14 min before the click
// to LAB_SIM_MS after it, ending at the body's real totals at the click, served
// in place of the real one (fightSamples, killView's body). Per 10 min: Green BL
// clearly the busiest, EBG and Red BL past the floor, Blue BL quiet.
const LAB_SIM_MS = 15 * 60 * 1000;
const LAB_RATE = { GreenHome: 240, Center: 120, RedHome: 85, BlueHome: 10 };
let labSim = null;      // { until, timer, matches: Map(id -> { samples, caps }) }
let labSimTag = null;

function labLiveMatches() {
  const out = [];
  if (typeof newestMatches === 'undefined') return out;
  for (const k of newestMatches.values()) if (k && k.match && matchIsLive(k.match)) out.push(k.match);
  return out;
}

function labSamples(match, t0) {
  const base = fightTotals(match);
  const out = [];
  for (let t = -14 * 60000; t <= LAB_SIM_MS; t += 60000) {
    const n = {};
    for (const type in base) n[type] = Math.max(0, Math.round(base[type] + (LAB_RATE[type] || 0) * t / 600000));
    out.push({ at: t0 + t, n });
  }
  return out;
}

// Captures on all four maps, interleaved in time, on the match's own objectives.
function labCapsFor(match, t0) {
  const owners = ['red', 'green', 'blue'];
  const per = [];
  for (const type of ['Center', 'RedHome', 'BlueHome', 'GreenHome']) {
    const map = (match.maps || []).find((m) => m && m.type === type);
    const objs = ((map && map.objectives) || []).filter((o) => o && typeof o.id === 'string'
      && ['Camp', 'Tower', 'Keep'].includes(o.type));
    per.push(objs.slice(0, 3).map((o) => ({ id: o.id, type: o.type, map: type })));
  }
  const out = [];
  for (let k = 0; k < 3; k++) for (const list of per) if (list[k]) out.push(list[k]);
  return out.map((it, j) => ({ ...it, owner: owners[j % 3], at: t0 - 30000 - j * 110000 }));
}

function labSimulate() {
  const live = labLiveMatches();
  if (!live.length) { labStatus('No live match held yet: wait for the standings.'); return; }
  labEndSim(null);
  const t0 = steadyNow();
  const matches = new Map();
  for (const m of live) matches.set(m.id, { samples: labSamples(m, t0), caps: labCapsFor(m, t0) });
  labSim = { until: t0 + LAB_SIM_MS, matches };
  labSim.timer = setInterval(() => {
    if (steadyNow() > labSim.until) { labEndSim('The simulation ended by itself: live data again.'); }
    labRepaint();
  }, 20000);
  labShowTag(true);
  labStatus('Simulated on every live match for 15 min: open a tier\u2019s maps. Green BL busiest, EBG and Red BL past the floor; Captures on all four maps.');
  labRepaint();
}

function labEndSim(message) {
  if (labSim) { clearInterval(labSim.timer); labSim = null; }
  labShowTag(false);
  if (message) labStatus(message);
}

function labShowTag(on) {
  if (!on) { if (labSimTag) labSimTag.remove(); labSimTag = null; return; }
  if (labSimTag) return;
  labSimTag = labEl('div', 'lab-simmark', 'simulated');
  labSimTag.title = 'Lab: the kills and the captures on screen are invented. "Back to live data" in the Lab panel.';
  document.body.appendChild(labSimTag);
}

function labSimFor(match) {
  if (!labSim || !match) return null;
  return labSim.matches.get(match.id) || null;
}
function labFightSamples(match) {
  const sim = labSimFor(match);
  if (!sim) return null;
  const now = steadyNow();
  return sim.samples.filter((s) => s.at <= now);
}
function labBody(match, now) {
  const sim = labSimFor(match);
  if (!sim) return null;
  let last = sim.samples[0];
  for (const s of sim.samples) if (s.at <= now) last = s;
  return { ...last.n };
}
function labCaptures(match) {
  const sim = labSimFor(match);
  return sim ? sim.caps.map((it) => ({ ...it })) : null;
}

// Called after any change: the classes the CSS reads, the open map's tabs, the badges.
function labRepaint() {
  const root = document.documentElement;
  for (const k of Object.keys(LAB_SWORDS)) root.classList.toggle(`lab-sw-${k}`, labPrefs.swords === k);
  for (const k of Object.keys(LAB_CAPS)) root.classList.toggle(`lab-caps-${k}`, labPrefs.caps === k);
  if (labTabs && [...labTabs.tabs.values()].some((b) => b.isConnected)) labTabs.refresh();
  if (typeof paintMapBadges === 'function') paintMapBadges();
}

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
    if (it.type === 'note') body.appendChild(labEl('p', 'lab-note', it.text));
    if (it.type === 'button') {
      const b = labEl('button', 'lab-btn', it.label);
      b.type = 'button';
      b.addEventListener('click', it.run);
      body.appendChild(b);
    }
    if (it.type === 'check') {
      const l = labEl('label', 'lab-check');
      const c = labEl('input');
      c.type = 'checkbox';
      c.dataset.toggle = it.key;
      c.addEventListener('change', () => { labPrefs[it.key] = c.checked; labChanged(); });
      l.append(c, ` ${it.label}`);
      body.appendChild(l);
    }
    if (it.type === 'radio') {
      const fs = labEl('fieldset', 'lab-radios lab-radios-block');
      fs.appendChild(labEl('legend', null, it.label));
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
  for (const c of body.querySelectorAll('input[data-toggle]')) c.checked = !!labPrefs[c.dataset.toggle];
  for (const r of body.querySelectorAll('input[type=radio]')) r.checked = labPrefs[r.name.slice(4)] === r.value;
  for (const it of LAB_ITEMS) if (it.cls) document.documentElement.classList.toggle(`lab-${it.key}`, !!labPrefs[it.key]);
}

labPanel = labBuildPanel();
// The maps window makes the rest of the page inert, the panel too: a tap on it then lands on the
// backdrop and closes the map. With "Keep the map open" the panel stays usable over it.
new MutationObserver(() => { if (labPrefs.keepMap && labPanel.inert) labPanel.inert = false; })
  .observe(labPanel, { attributes: true, attributeFilter: ['inert'] });
labPaintPanel();
labRepaint();
