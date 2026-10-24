// LAB (never merged). Card 28-0: one switch per suspect for the second-monitor video
// stutter, each on its own. Loaded just before js/boot.js; everything shown goes
// through textContent; no request of its own.

const LAB_KEY = 'wvw-lab-v1';
const LAB_VERSION = 2;          // bump when the defaults change: older saved choices are dropped
const LAB_ITEMS = [
  { type: 'section', label: 'Background photo' },
  { type: 'radio', key: 'photo', label: 'Photo', value: 'a', options: {
    a: 'A · Today',
    b: 'B · Baked (the fix)',
    c: 'C · No blur (diagnostic)',
    d: 'D · No blend (diagnostic)',
  } },
  { type: 'section', label: 'Diagnostic' },
  { type: 'check', key: 'embersStill', label: 'Embers still (diagnostic)', on: false },
  { type: 'check', key: 'scanStill', label: 'Title scan still (diagnostic)', on: false, cls: true },
  { type: 'check', key: 'noGlass', label: 'No frosted glass (diagnostic)', on: false, cls: true },
  { type: 'check', key: 'allStill', label: 'Everything still, as when not in focus (diagnostic)', on: false, cls: true },
  { type: 'check', key: 'blank', label: 'Blank page, only this panel (diagnostic)', on: false, cls: true },
  { type: 'note', label: 'Diagnostic switches are for finding the cause only; the fix is the baked photo.' },
];

// emberField is a const of boot.js, which loads after this file: it is only
// reachable from DOMContentLoaded on. Its own focus handler calls start(), so
// start is swapped for a no-op while the switch is on and put back when it is off.
let labEmberStart = null;
function labApplyEmbers() {
  if (typeof emberField !== 'object' || !emberField) return;
  const still = labPrefs.embersStill || labPrefs.allStill || labPrefs.blank;
  if (still && !labEmberStart) {
    labEmberStart = emberField.start;
    emberField.start = () => {};
    emberField.stop();
  } else if (!still && labEmberStart) {
    emberField.start = labEmberStart;
    labEmberStart = null;
    const watched = document.visibilityState !== 'hidden' && document.hasFocus();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (watched && !reduced) emberField.start();
  }
}

function labRepaint() {
  const root = document.documentElement;
  for (const k of Object.keys(LAB_ITEMS[1].options)) root.classList.toggle(`lab-photo-${k}`, labPrefs.photo === k);
  labApplyEmbers();
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
  head.append(labEl('strong', null, 'Lab'), labEl('span', 'lab-muted', ' · preview only'));
  body.appendChild(head);
  for (const it of LAB_ITEMS) {
    if (it.type === 'section') body.appendChild(labEl('div', 'lab-section', it.label));
    if (it.type === 'note') body.appendChild(labEl('p', 'lab-note', it.label));
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

// Timed test: the stutter comes and goes, so switching by hand and watching gives
// answers that contradict each other. The panel walks through the same states on a
// clock and logs when each began; a counter in the video's own window logs the
// stutters with the same clock, and the two logs are compared afterwards.
const LAB_STEPS = ['normal', 'blank', 'still'];
const LAB_ROUNDS = 3;
const LAB_STEP_MS = 90000;
let labRun = null;
let labRunLog = [];
const labClock = () => new Date().toTimeString().slice(0, 8);

function labSetStep(name) {
  Object.assign(labPrefs, { photo: 'a', embersStill: false, scanStill: false, noGlass: false,
    allStill: name === 'still', blank: name === 'blank' });
  labChanged();
}
function labNextStep() {
  if (labRun.i >= LAB_STEPS.length * LAB_ROUNDS) { labStopRun('done'); return; }
  labRun.name = LAB_STEPS[labRun.i % LAB_STEPS.length];
  labRun.until = Date.now() + LAB_STEP_MS;
  labRun.i++;
  labRun.log.push(`${labClock()} ${labRun.name}`);
  labSetStep(labRun.name);
  labRun.timer = setTimeout(labNextStep, LAB_STEP_MS);
  labShowRun();
}
function labStartRun() {
  if (labRun) return;
  labRun = { i: 0, log: [`${labClock()} start (${LAB_ROUNDS} rounds of ${LAB_STEPS.join(', ')}, ${LAB_STEP_MS / 1000} s each)`] };
  labRun.tick = setInterval(labShowRun, 1000);
  labNextStep();
}
function labStopRun(why) {
  if (!labRun) return;
  clearTimeout(labRun.timer);
  clearInterval(labRun.tick);
  labRun.log.push(`${labClock()} end (${why})`);
  labRunLog = labRun.log;
  labRun = null;
  labSetStep('normal');
  labShowRun();
}
// Clicking the video's window takes the focus away and the page goes idle on its own:
// that minute no longer says anything, so it is written down.
window.addEventListener('blur', () => { if (labRun) labRun.log.push(`${labClock()} focus lost`); });
window.addEventListener('focus', () => { if (labRun) labRun.log.push(`${labClock()} focus back`); });

let labRunEls = null;
function labBuildRun() {
  const body = labPanel.querySelector('.lab-body');
  body.appendChild(labEl('div', 'lab-section', 'Timed test'));
  body.appendChild(labEl('p', 'lab-note',
    `${LAB_STEPS.length * LAB_ROUNDS * LAB_STEP_MS / 60000} min. Keep this window in focus the whole time; watch the video, don't click it.`));
  const start = labEl('button', 'lab-btn', 'Start');
  start.type = 'button';
  start.addEventListener('click', () => (labRun ? labStopRun('stopped') : labStartRun()));
  const copy = labEl('button', 'lab-btn', 'Copy log');
  copy.type = 'button';
  copy.addEventListener('click', () => {
    const text = (labRun ? labRun.log : labRunLog).join('\n');
    navigator.clipboard.writeText(text).then(() => { copy.textContent = 'Copied'; }, () => { copy.textContent = 'Copy failed'; });
    setTimeout(() => { copy.textContent = 'Copy log'; }, 2000);
  });
  const row = labEl('div', 'lab-sub lab-sub-row');
  row.append(start, copy);
  const status = labEl('p', 'lab-note');
  const log = labEl('pre', 'lab-log');
  body.append(row, status, log);
  labRunEls = { start, status, log };
}
function labShowRun() {
  if (!labRunEls) return;
  const { start, status, log } = labRunEls;
  start.textContent = labRun ? 'Stop' : 'Start';
  if (labRun) {
    const left = Math.max(0, Math.round((labRun.until - Date.now()) / 1000));
    status.textContent = `Step ${labRun.i} of ${LAB_STEPS.length * LAB_ROUNDS}: ${labRun.name}, ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
  } else {
    status.textContent = labRunLog.length ? 'Finished. Copy the log and send it with the video counter\'s.' : '';
  }
  log.textContent = (labRun ? labRun.log : labRunLog).join('\n');
}

labPanel = labBuildPanel();
labBuildRun();
labPaintPanel();
labRepaint();
document.addEventListener('DOMContentLoaded', labApplyEmbers);
