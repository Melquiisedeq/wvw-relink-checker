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

labPanel = labBuildPanel();
labPaintPanel();
labRepaint();
document.addEventListener('DOMContentLoaded', labApplyEmbers);
