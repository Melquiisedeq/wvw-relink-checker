// LAB (never merged). The skeleton of a lab's toggle panel: copy to site/js/lab.js on
// the lab branch, fill LAB_ITEMS and labRepaint(), and write the prototypes below it.
// Loaded just before js/boot.js (check-structure wants boot.js last). Everything the
// page shows goes through textContent. The 15-0 lab, whole, is in
// .claude/tools/lab/pecas/ for the pieces worth reusing (README.md says what each lab has).

const LAB_KEY = 'wvw-lab-40-1-39-3';
const LAB_VERSION = 1;          // bump when the defaults change: older saved choices are dropped
// One entry per control, in order. check: a toggle; radio: one of a few; button: an
// action (a "Simulate…" so the owner sees what a rare event looks like); section: a title.
const LAB_ITEMS = [
  { type: 'section', label: 'Embers (39-3)' },
  { type: 'note', label: 'Watch the top half of the page. Switches live.' },
  { type: 'radio', key: 'ember', label: 'Curve', value: 'today', options: {
    today: 'Today', A: 'A · hold, fade late', B: 'B · A + shrinks', C: 'C · smooth' } },
  { type: 'section', label: 'Guild screenshot (40-1)' },
  { type: 'note', label: 'Click the shield next to a team name in the standings, then look at the popover.' },
  { type: 'radio', key: 'shot', label: 'Form', value: 'today', options: {
    today: 'Today', a: '(a) Visible button', b: '(b) Copy image', c: '(c) Both' } },
];

// Called after any change: repaint whatever the prototypes draw.
function labRepaint() { labDecorate(document.querySelector('.info-popover--guilds')); }

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
    if (it.type === 'note') body.appendChild(labEl('div', 'lab-muted lab-note', it.label));
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


// ---- 39-3: the ember curves (pesquisa-brasas) -----------------------------------
// p: 0 at the bottom, 1 at the top. Called from draw() in js/boot.js, per ember per frame.
function labEmberAlpha(p) {
  const m = labPrefs.ember;
  if (m === 'A' || m === 'B') {
    return p < .10 ? p / .10 * .9 : p < .82 ? .9 - (p - .10) / .72 * .2 : .7 * (1 - (p - .82) / .18);
  }
  if (m === 'C') return p < .10 ? p / .10 * .9 : .9 * (1 - Math.pow(p, 3));
  return p < .12 ? (p / .12) * .85 : p < .70 ? .85 - ((p - .12) / .58) * .35 : .50 - ((p - .70) / .30) * .50;
}
function labEmberK(p) {
  const m = labPrefs.ember;
  if (m === 'B') return 1.15 - p * .6;
  if (m === 'C') return 1.1 - p * .5;
  return .6 + p * .55;
}

// ---- 40-1: the guild popover's screenshot button --------------------------------
const labShotDone = new WeakMap();

function labGuildData(popover) {
  const title = popover.querySelector('.info-popover-header > span');
  const line = (el) => {
    const tag = el.querySelector('.guild-tag');
    const region = el.querySelector('.guild-region');
    let name = '';
    for (const n of el.childNodes) if (n.nodeType === 3) name += n.nodeValue;
    return { tag: tag ? tag.textContent.replace(/^\s*\[|\]\s*$/g, '') : '', name: name.trim(), region: region ? region.textContent.trim() : '' };
  };
  const alliances = [...popover.querySelectorAll('.alliance-block')].map((b) => ({
    name: b.querySelector('.alliance-name').textContent,
    lines: [...b.querySelectorAll('.guild-line')].map(line),
  }));
  let solo = [];
  for (const t of popover.querySelectorAll('.info-popover-section-title')) {
    if (t.textContent === 'Solo guilds' && t.nextElementSibling) solo = [...t.nextElementSibling.querySelectorAll('.guild-line')].map(line);
  }
  return { team: title ? title.textContent : '', alliances, solo };
}

// The same columns as layoutAllianceGrid when expanded (same count rule at the width
// of the 880 px popover, largest card first into the shortest column), drawn by hand.
function labShotCanvas(d) {
  const W = 880, PAD = 22, GAP = 12, LH = 20, FS = 14, SCALE = 2;
  const cs = getComputedStyle(document.documentElement);
  const col = (v, f) => cs.getPropertyValue(v).trim() || f;
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const c = document.createElement('canvas');
  const x = c.getContext('2d');
  const font = (w, px) => { x.font = `${w} ${px}px ${family}`; };
  const wrap = (text, width, w) => {
    font(w, FS);
    const out = [];
    let cur = '';
    for (const word of text.split(/\s+/)) {
      const t = cur ? `${cur} ${word}` : word;
      if (cur && x.measureText(t).width > width) { out.push(cur); cur = word; } else cur = t;
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  };
  const inner = W - PAD * 2;
  const numCols = Math.max(1, Math.min(4, d.alliances.length || 1, Math.floor((inner + GAP) / (220 + GAP)) || 1));
  const colW = (inner - GAP * (numCols - 1)) / numCols;
  // A guild line is drawn as one string so a wrapped line keeps its tag, name and region together.
  const full = (g) => `${g.tag ? `[${g.tag}] ` : ''}${g.name}${g.region ? ` ${g.region}` : ''}`;
  const cards = d.alliances.map((a) => {
    const head = wrap(a.name, colW - 20, 700);
    const rows = a.lines.map((g) => ({ g, parts: wrap(full(g), colW - 30, 400) }));
    const h = 16 + head.length * LH + rows.reduce((n, r) => n + r.parts.length * LH, 0) + 2;
    return { head, rows, h };
  }).sort((a, b) => b.h - a.h);
  const cols = Array.from({ length: numCols }, () => ({ h: 0, items: [] }));
  for (const k of cards) {
    let t = 0;
    for (let i = 1; i < numCols; i++) if (cols[i].h < cols[t].h) t = i;
    cols[t].items.push(k);
    cols[t].h += k.h + GAP;
  }
  const soloCols = Array.from({ length: Math.max(1, Math.min(numCols, d.solo.length)) }, () => ({ h: 0, rows: [] }));
  for (const g of d.solo) {
    const parts = wrap(full(g), colW - 4, 400);
    let t = 0;
    for (let i = 1; i < soloCols.length; i++) if (soloCols[i].h < soloCols[t].h) t = i;
    soloCols[t].rows.push({ g, parts });
    soloCols[t].h += parts.length * LH;
  }
  const alliancesH = d.alliances.length ? 26 + Math.max(...cols.map((k) => k.h)) - GAP : 0;
  const soloH = d.solo.length ? 34 + Math.max(...soloCols.map((k) => k.h)) : 0;
  const H = PAD + 34 + alliancesH + soloH + 36;
  c.width = W * SCALE;
  c.height = H * SCALE;
  x.scale(SCALE, SCALE);
  x.fillStyle = col('--card', '#171b21');
  x.fillRect(0, 0, W, H);
  x.textBaseline = 'alphabetic';
  font(700, 22);
  x.fillStyle = col('--text', '#e6e9ee');
  x.fillText(d.team, PAD, PAD + 20);
  let y = PAD + 34;
  const section = (label, top) => {
    font(800, 11);
    x.fillStyle = col('--muted', '#9aa4b2');
    x.fillText(label.toUpperCase().split('').join(String.fromCharCode(8202)), PAD, top + 12);
    x.fillStyle = col('--border', '#2a313a');
    x.fillRect(PAD, top + 18, inner, 1);
  };
  const drawLine = (g, parts, px, py, maxW) => {
    // The first wrapped part carries the tag in the accent colour and the region muted.
    parts.forEach((txt, i) => {
      font(400, FS);
      let cx = px;
      const base = py + i * LH;
      const tagText = i === 0 && g.tag ? `[${g.tag}] ` : '';
      if (tagText && txt.startsWith(tagText)) {
        font(700, FS);
        x.fillStyle = col('--accent', '#7fd6f2');
        x.fillText(tagText, cx, base);
        cx += x.measureText(tagText).width;
        txt = txt.slice(tagText.length);
      }
      font(400, FS);
      const reg = g.region && i === parts.length - 1 && txt.endsWith(g.region) ? g.region : '';
      const main = reg ? txt.slice(0, txt.length - reg.length) : txt;
      x.fillStyle = col('--text', '#e6e9ee');
      x.fillText(main, cx, base);
      if (reg) {
        x.fillStyle = col('--muted', '#9aa4b2');
        x.fillText(reg, cx + x.measureText(main).width, base);
      }
    });
  };
  if (d.alliances.length) {
    section('Alliances', y);
    const top = y + 26;
    cols.forEach((k, i) => {
      let cy = top;
      const cx = PAD + i * (colW + GAP);
      for (const card of k.items) {
        x.fillStyle = 'rgba(255,255,255,.04)';
        x.fillRect(cx, cy, colW, card.h);
        x.strokeStyle = col('--border', '#2a313a');
        x.strokeRect(cx + .5, cy + .5, colW - 1, card.h - 1);
        font(700, FS);
        x.fillStyle = col('--blue', '#6aa9ff');
        card.head.forEach((t, j) => x.fillText(t, cx + 10, cy + 8 + FS + j * LH));
        let ry = cy + 8 + FS + card.head.length * LH;
        for (const r of card.rows) { drawLine(r.g, r.parts, cx + 20, ry, colW - 30); ry += r.parts.length * LH; }
        cy += card.h + GAP;
      }
    });
    y = top + Math.max(...cols.map((k) => k.h)) - GAP;
  }
  if (d.solo.length) {
    section('Solo guilds', y + 8);
    const top = y + 8 + 26;
    soloCols.forEach((k, i) => {
      let ry = top + FS;
      for (const r of k.rows) { drawLine(r.g, r.parts, PAD + i * (colW + GAP) + 2, ry, colW - 4); ry += r.parts.length * LH; }
    });
  }
  font(400, 11);
  x.fillStyle = col('--muted', '#9aa4b2');
  x.textAlign = 'right';
  x.fillText(`wvwrelink.com · ${new Date().toISOString().slice(0, 10)}`, W - PAD, H - 14);
  x.textAlign = 'left';
  return c;
}

function labFlash(btn, text) {
  const label = btn.querySelector('.lab-g-text');
  if (!label) return;
  label.textContent = text;
  clearTimeout(btn.__labT);
  btn.__labT = setTimeout(() => { label.textContent = 'Copy image'; }, 2000);
}

function labDownload(blob) {
  const url = URL.createObjectURL(blob);
  const a = labEl('a');
  a.href = url;
  a.download = 'wvwrelink-guilds.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// The clipboard write starts inside the click, with the blob still a promise: awaiting it
// first loses the user gesture in Safari.
function labCopy(btn, popover) {
  const d = labGuildData(popover);
  const blobP = new Promise((res, rej) => {
    try { labShotCanvas(d).toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'); } catch (e) { rej(e); }
  });
  let wrote;
  try {
    wrote = navigator.clipboard && window.ClipboardItem && navigator.clipboard.write
      ? navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })])
      : Promise.reject(new Error('unsupported'));
  } catch (e) { wrote = Promise.reject(e); }
  wrote.then(() => labFlash(btn, 'Copied'), async () => {
    try {
      const blob = await blobP;
      const file = new File([blob], 'wvwrelink-guilds.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: d.team });
        labFlash(btn, 'Shared');
      } else { labDownload(blob); labFlash(btn, 'Saved'); }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      labFlash(btn, 'Failed');
    }
  });
}

// Turns the popover's header into the chosen form. Idempotent: called after every render,
// every expand/shrink (which rewrites the expand button) and every panel change.
function labDecorate(popover) {
  if (!popover || !popover.classList.contains('info-popover--guilds')) return;
  const mode = labPrefs.shot;
  const expandBtn = popover.querySelector('.info-popover-expand');
  const actions = popover.querySelector('.info-popover-header-actions');
  if (!expandBtn || !actions) return;
  const hasList = !!popover.querySelector('.guild-line');
  let bar = popover.querySelector('.lab-g-bar');
  if (mode === 'today') {
    if (bar) { actions.insertBefore(expandBtn, actions.firstChild); bar.remove(); }
    expandBtn.classList.remove('lab-g-expand');
    const t = expandBtn.querySelector('.lab-g-text');
    if (t) t.remove();
    return;
  }
  if (!bar) {
    bar = labEl('div', 'lab-g-bar');
    popover.insertBefore(bar, popover.querySelector('.info-popover-body'));
  }
  const showExpand = mode === 'a' || mode === 'c';
  const showCopy = mode === 'b' || mode === 'c';
  let copy = bar.querySelector('.lab-g-copy');
  if (showCopy && !copy) {
    copy = labEl('button', 'lab-g-btn lab-g-copy');
    copy.type = 'button';
    copy.append(labEl('span', 'lab-g-text', 'Copy image'));
    copy.addEventListener('click', (e) => { e.stopPropagation(); labCopy(copy, popover); });
    bar.prepend(copy);
  }
  if (copy) { copy.hidden = !showCopy; copy.disabled = !hasList; }
  if (showExpand) {
    if (expandBtn.parentNode !== bar) bar.appendChild(expandBtn);
    expandBtn.classList.add('lab-g-btn', 'lab-g-expand');
    const t = expandBtn.querySelector('.lab-g-text') || expandBtn.appendChild(labEl('span', 'lab-g-text'));
    t.textContent = popover.classList.contains('info-popover--expanded') ? 'Shrink' : 'Full list';
  } else {
    if (expandBtn.parentNode === bar) actions.insertBefore(expandBtn, actions.firstChild);
    expandBtn.classList.remove('lab-g-btn', 'lab-g-expand');
    const t = expandBtn.querySelector('.lab-g-text');
    if (t) t.remove();
  }
  bar.hidden = !showCopy && !showExpand;
}

labPanel = labBuildPanel();
labPaintPanel();
labRepaint();
