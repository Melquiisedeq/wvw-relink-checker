'use strict';
// Server guild lists: the alliance grid and solo list shown from a standings row, and the button that opens it.

const EXPAND_ICON_EXPAND = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M15 4H20V9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M9 20H4V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M20 4L13 11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M4 20L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EXPAND_ICON_COLLAPSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M20 9H15V4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M4 15H9V20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M15 9L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M9 15L3 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function buildAllianceCard(alliance) {
  const block = document.createElement('div');
  block.className = 'alliance-block';
  const name = document.createElement('div');
  name.className = 'alliance-name';
  name.textContent = alliance.tag ? `[${alliance.tag}] ${alliance.name}` : alliance.name;
  block.appendChild(name);
  block.appendChild(buildGuildList(alliance.members));
  return block;
}

// Compact mode: plain stacked list. Expanded mode: columns bin-packed by real
// card height (largest first, into the shortest column), so they stay even.
function layoutAllianceGrid(grid, alliances, expanded) {
  grid.textContent = '';
  if (!expanded) {
    for (const alliance of alliances) grid.appendChild(buildAllianceCard(alliance));
    return;
  }

  const COL_WIDTH = 220, GAP = 12, MAX_COLS = 4;
  const gridWidth = grid.getBoundingClientRect().width || 0;
  const numCols = Math.max(1, Math.min(
    MAX_COLS, alliances.length, Math.floor((gridWidth + GAP) / (COL_WIDTH + GAP)) || 1
  ));

  const columns = [];
  for (let i = 0; i < numCols; i++) {
    const col = document.createElement('div');
    col.className = 'alliance-grid-col';
    grid.appendChild(col);
    columns.push(col);
  }

  if (numCols === 1) {
    for (const alliance of alliances) columns[0].appendChild(buildAllianceCard(alliance));
    return;
  }

  // Build every card into the first column so all of them share the same
  // final column width, then read their real heights in one batch.
  const cards = alliances.map(a => ({ el: buildAllianceCard(a), height: 0 }));
  for (const c of cards) columns[0].appendChild(c.el);
  for (const c of cards) c.height = c.el.getBoundingClientRect().height;
  cards.sort((a, b) => b.height - a.height);

  const colHeights = new Array(numCols).fill(0);
  for (const c of cards) {
    let target = 0;
    for (let i = 1; i < numCols; i++) {
      if (colHeights[i] < colHeights[target]) target = i;
    }
    columns[target].appendChild(c.el); // moves it out of column 0 automatically
    colHeights[target] += c.height + GAP;
  }
}

function buildGuildList(entries) {
  const list = document.createElement('div');
  list.className = 'guild-list';
  for (const entry of entries) {
    const line = document.createElement('div');
    line.className = 'guild-line';
    if (entry.tag) {
      const tag = document.createElement('span');
      tag.className = 'guild-tag';
      tag.textContent = `[${entry.tag}] `;
      line.appendChild(tag);
    }
    line.appendChild(document.createTextNode(entry.name));
    if (entry.region) {
      const region = document.createElement('span');
      region.className = 'guild-region';
      region.textContent = ` (${entry.region})`;
      line.appendChild(region);
    }
    list.appendChild(line);
  }
  return list;
}

// Lucide "camera", "check" and "x" (https://lucide.dev), ISC licence: Copyright (c) 2026 Lucide Icons and Contributors.
const SHOT_ICONS = {
  camera: '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/><circle cx="12" cy="13" r="3"/>',
  ok: '<path d="M20 6 9 17l-5-5"/>',
  fail: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
};
function setShotIcon(btn, key) {
  btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + SHOT_ICONS[key] + '</svg>';
}

function guildsShotCanvas(team, alliances, solo) {
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
      if (x.measureText(t).width <= width) { cur = t; continue; }
      if (cur) { out.push(cur); cur = ''; }
      // A word wider than the column is cut by character.
      for (const ch of word) {
        if (cur && x.measureText(cur + ch).width > width) { out.push(cur); cur = ch; } else cur += ch;
      }
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  };
  const inner = W - PAD * 2;
  const numCols = Math.max(1, Math.min(4, alliances.length || 1, Math.floor((inner + GAP) / (220 + GAP)) || 1));
  const colW = (inner - GAP * (numCols - 1)) / numCols;
  const region = (g) => (g.region ? `(${g.region})` : '');
  // One string per guild so a wrapped line keeps its tag, name and region together.
  const full = (g) => `${g.tag ? `[${g.tag}] ` : ''}${g.name}${g.region ? ` ${region(g)}` : ''}`;
  const cards = alliances.map((a) => {
    const head = wrap(a.tag ? `[${a.tag}] ${a.name}` : a.name, colW - 20, 700);
    const rows = a.members.map((g) => ({ g, parts: wrap(full(g), colW - 30, 400) }));
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
  const soloCols = Array.from({ length: Math.max(1, Math.min(numCols, solo.length)) }, () => ({ h: 0, rows: [] }));
  for (const g of solo) {
    const parts = wrap(full(g), colW - 4, 400);
    let t = 0;
    for (let i = 1; i < soloCols.length; i++) if (soloCols[i].h < soloCols[t].h) t = i;
    soloCols[t].rows.push({ g, parts });
    soloCols[t].h += parts.length * LH;
  }
  const alliancesH = alliances.length ? 26 + Math.max(...cols.map((k) => k.h)) - GAP : 0;
  const soloH = solo.length ? 34 + Math.max(...soloCols.map((k) => k.h)) : 0;
  const H = PAD + 34 + alliancesH + soloH + 36;
  c.width = W * SCALE;
  c.height = H * SCALE;
  x.scale(SCALE, SCALE);
  x.fillStyle = col('--card', '#171b21');
  x.fillRect(0, 0, W, H);
  x.textBaseline = 'alphabetic';
  font(700, 22);
  x.fillStyle = col('--text', '#e6e9ee');
  x.fillText(team, PAD, PAD + 20);
  let y = PAD + 34;
  const section = (label, top) => {
    font(800, 11);
    x.fillStyle = col('--muted', '#9aa4b2');
    x.fillText(label.toUpperCase().split('').join(String.fromCharCode(8202)), PAD, top + 12);
    x.fillStyle = col('--border', '#2a313a');
    x.fillRect(PAD, top + 18, inner, 1);
  };
  const drawLine = (g, parts, px, py) => {
    parts.forEach((txt, i) => {
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
      const reg = region(g) && i === parts.length - 1 && txt.endsWith(region(g)) ? region(g) : '';
      const main = reg ? txt.slice(0, txt.length - reg.length) : txt;
      x.fillStyle = col('--text', '#e6e9ee');
      x.fillText(main, cx, base);
      if (reg) {
        x.fillStyle = col('--muted', '#9aa4b2');
        x.fillText(reg, cx + x.measureText(main).width, base);
      }
    });
  };
  if (alliances.length) {
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
        for (const r of card.rows) { drawLine(r.g, r.parts, cx + 20, ry); ry += r.parts.length * LH; }
        cy += card.h + GAP;
      }
    });
    y = top + Math.max(...cols.map((k) => k.h)) - GAP;
  }
  if (solo.length) {
    section('Solo guilds', y + 8);
    const top = y + 8 + 26;
    soloCols.forEach((k, i) => {
      let ry = top + FS;
      for (const r of k.rows) { drawLine(r.g, r.parts, PAD + i * (colW + GAP) + 2, ry); ry += r.parts.length * LH; }
    });
  }
  font(400, 11);
  x.fillStyle = col('--muted', '#9aa4b2');
  x.textAlign = 'right';
  x.fillText(`wvwrelink.com · ${new Date().toLocaleDateString('en-CA')}`, W - PAD, H - 14);
  return c;
}

// Run-once effects, so reduced motion keeps them.
function showShotResult(btn, popover, text) {
  if (!btn.isConnected) return;
  const failed = text === 'Failed';
  setShotIcon(btn, failed ? 'fail' : 'ok');
  btn.classList.toggle('shot-done', !failed);
  const status = popover.querySelector('.info-popover-shot-status');
  if (status) status.textContent = text;
  const r = btn.getBoundingClientRect();
  const bubble = document.createElement('div');
  bubble.className = 'shot-bubble';
  bubble.textContent = text;
  bubble.setAttribute('aria-hidden', 'true');
  bubble.style.left = (r.left + r.width / 2) + 'px';
  bubble.style.top = (r.bottom + 6) + 'px';
  document.body.appendChild(bubble);
  bubble.animate([{ opacity: 0, transform: 'translate(-50%,-4px)' }, { opacity: 1, transform: 'translate(-50%,0)' }],
    { duration: 160, easing: 'ease-out', fill: 'forwards' });
  setTimeout(() => bubble.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' })
    .finished.then(() => bubble.remove()), 1500);
  clearTimeout(btn.__shotTimer);
  btn.__shotTimer = setTimeout(() => {
    btn.classList.remove('shot-done');
    setShotIcon(btn, 'camera');
    if (status) status.textContent = '';
  }, 2000);
}

function playShotFlash(btn, popover) {
  const r = popover.getBoundingClientRect();
  const flash = document.createElement('div');
  flash.className = 'shot-flash';
  Object.assign(flash.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  document.body.appendChild(flash);
  flash.animate([{ opacity: .7 }, { opacity: 0 }], { duration: 420, easing: 'ease-out' })
    .finished.then(() => flash.remove());
  btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(.78)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
    { duration: 380, easing: 'ease-out' });
}

function downloadShot(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'wvwrelink-guilds.png';
  a.addEventListener('click', (e) => e.stopPropagation()); // a click on the document would close the popover
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// The clipboard write starts inside the click with the blob still a promise: awaiting it
// first loses the user gesture in Safari.
function copyGuildsShot(btn, popover, teamName) {
  playShotFlash(btn, popover);
  const blobP = new Promise((res, rej) => {
    try {
      guildsShotCanvas(teamName, popover.__allianceData || [], popover.__soloData || [])
        .toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png');
    } catch (e) { rej(e); }
  });
  let wrote;
  try {
    wrote = navigator.clipboard && window.ClipboardItem && navigator.clipboard.write
      ? navigator.clipboard.write([new ClipboardItem({ 'image/png': blobP })])
      : Promise.reject(new Error('unsupported'));
  } catch (e) { wrote = Promise.reject(e); }
  wrote.then(() => showShotResult(btn, popover, 'Copied'), async () => {
    try {
      const blob = await blobP;
      const file = new File([blob], 'wvwrelink-guilds.png', { type: 'image/png' });
      let shared = false;
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: teamName });
          shared = true;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      if (shared) showShotResult(btn, popover, 'Shared');
      else {
        downloadShot(blob);
        showShotResult(btn, popover, 'Saved');
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      showShotResult(btn, popover, 'Failed');
    }
  });
}

function renderGuildsPopoverContent(popover, teamName, data, triggerEl) {
  popover.textContent = '';
  popover.classList.remove('info-popover--expanded');
  popover.__allianceData = null;
  popover.__soloData = data ? data.solo : null;

  const header = document.createElement('div');
  header.className = 'info-popover-header';
  const title = document.createElement('span');
  title.textContent = teamName;
  header.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'info-popover-header-actions';

  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'info-popover-expand';
  expandBtn.innerHTML = EXPAND_ICON_EXPAND;
  expandBtn.setAttribute('aria-label', 'Expand for a full-list screenshot');
  expandBtn.title = expandBtn.getAttribute('aria-label');
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowExpanded = !popover.classList.contains('info-popover--expanded');
    setPopoverExpanded(popover, triggerEl, nowExpanded);
  });
  const shotBtn = document.createElement('button');
  shotBtn.type = 'button';
  shotBtn.className = 'info-popover-shot';
  setShotIcon(shotBtn, 'camera');
  shotBtn.setAttribute('aria-label', 'Copy the list as an image');
  shotBtn.title = shotBtn.getAttribute('aria-label');
  shotBtn.disabled = !(data && (data.alliances.length || data.solo.length));
  shotBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    copyGuildsShot(shotBtn, popover, teamName);
  });
  actions.appendChild(shotBtn);
  actions.appendChild(expandBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'info-popover-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', closePopover);
  actions.appendChild(closeBtn);

  header.appendChild(actions);
  popover.appendChild(header);
  const shotStatus = document.createElement('span');
  shotStatus.className = 'sr-only info-popover-shot-status';
  shotStatus.setAttribute('role', 'status');
  popover.appendChild(shotStatus);

  // Everything except header/footer lives in this container so the
  // expanded (screenshot) mode can lay it out in multiple columns.
  const body = document.createElement('div');
  body.className = 'info-popover-body';

  const hasAlliances = data && data.alliances.length > 0;
  const hasSolo = data && data.solo.length > 0;

  if (!hasAlliances && !hasSolo) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.style.margin = '0';
    empty.textContent = 'No guilds listed for this server in the community sheet yet.';
    body.appendChild(empty);
  } else {
    if (hasAlliances) {
      const wrap = document.createElement('div');
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'info-popover-section-title';
      sectionTitle.textContent = 'Alliances';
      wrap.appendChild(sectionTitle);
      const grid = document.createElement('div');
      grid.className = 'alliance-grid';
      wrap.appendChild(grid);
      body.appendChild(wrap);
      popover.__allianceData = data.alliances;
      layoutAllianceGrid(grid, data.alliances, false);
    }
    if (hasSolo) {
      const wrap = document.createElement('div');
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'info-popover-section-title';
      sectionTitle.textContent = 'Solo guilds';
      wrap.appendChild(sectionTitle);
      wrap.appendChild(buildGuildList(data.solo));
      body.appendChild(wrap);
    }
  }
  popover.appendChild(body);

  const footer = document.createElement('p');
  footer.className = 'info-popover-footer';
  footer.textContent = 'Community-maintained, may be incomplete or outdated. ';
  const link = document.createElement('a');
  link.href = SHEET_HUMAN_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Open sheet';
  footer.appendChild(link);
  popover.appendChild(footer);
}

async function toggleGuildsPopover(teamName, triggerEl) {
  const popover = openPopover(triggerEl, `Guilds on ${teamName}`, (el) => {
    const loading = document.createElement('p');
    loading.className = 'hint';
    loading.style.margin = '0';
    loading.innerHTML = '<span class="spinner"></span>Loading community list…';
    el.appendChild(loading);
  }, 'info-popover--guilds');
  if (!popover) return; // it was already open; openPopover just closed it

  let byTeam;
  try {
    byTeam = await loadCommunityGuilds();
  } catch {
    if (activeTrigger !== triggerEl) return;
    popover.textContent = '';
    const msg = document.createElement('p');
    msg.className = 'hint';
    msg.style.margin = '0';
    msg.textContent = "Couldn't load the community guild list right now.";
    popover.appendChild(msg);
    return;
  }

  if (activeTrigger !== triggerEl) return; // closed while loading
  renderGuildsPopoverContent(popover, teamName, byTeam.get(teamName), triggerEl);
  positionPopover(popover, triggerEl);
}

// The shield with an info mark inside: this page's sign for "there is a guild
// list behind this". The teams notice in js/relink.js draws the same one, called
// rather than copied; safe across the load order because nothing calls this until
// a click or a countdown tick.
//
// aria-hidden for both callers: the button's own aria-label says what it opens,
// and inside the notice's sentence the word is supplied as text beside the icon
// (buildTeamsNotice in js/relink.js). Not role="img": that makes the icon an
// OBJECT in the accessibility tree and the screen reader stops at it, losing the
// rest of the sentence.
function serverGuildsShield(size) {
  return `<svg width="${size}" height="${Math.round(size * 19 / 17)}" viewBox="0 0 24 27" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">`
    + '<path d="M12 2 L21 4.5 V13 C21 19 17 23.5 12 25.5 C7 23.5 3 19 3 13 V4.5 Z" '
    + 'fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>'
    + '<circle cx="12" cy="9.5" r="1.6" fill="currentColor"/>'
    + '<rect x="10.4" y="13.2" width="3.2" height="8" rx="1.6" fill="currentColor"/></svg>';
}

// Small shield icon with an info mark inside, next to NA server names
// only. Opens the community guild list popover on click.
function buildServerGuildsButton(teamName) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn server-guilds-btn';
  btn.setAttribute('aria-label', `Show guilds on ${teamName}`);
  btn.title = `Show guilds on ${teamName}`;
  markPopoverTrigger(btn);
  btn.innerHTML = serverGuildsShield(17);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGuildsPopover(teamName, btn);
  });
  return btn;
}

