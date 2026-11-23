'use strict';
// LAB (never merged). The news panel: LAB_NEWS_ROWS (js/lab-news.js) read into items and drawn in
// one of the layouts the setups pick (A ledger, B lead + grid, C timeline, R = C under B's lead,
// M = A with three items and "More updates"). Wiki text is strangers' text: textContent only.

const LAB_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const LAB_KIND_WEIGHT = { map: 6, event: 5, rule: 4, reward: 3, buff: 3, nerf: 3, fix: 1 };
const LAB_WIKI = 'https://wiki.guildwars2.com/wiki/';
const labNotes = { sim: null, more: false, filter: 'wvw' };

function labNoteDate(update, page) {
  const m = new RegExp(`(${LAB_MONTHS.join('|')})\\s+(\\d{1,2}),\\s+(\\d{4})`).exec(update || '');
  if (m) return Date.UTC(Number(m[3]), LAB_MONTHS.indexOf(m[1]), Number(m[2]), 12);
  return Date.parse(`${page}T12:00:00Z`) || 0;
}
const labDay = (t) => `${new Date(t).getUTCDate()} ${LAB_MONTHS[new Date(t).getUTCMonth()].slice(0, 3)}`;
const labSeconds = (s) => s.replace(/\s+seconds?$/, ' s').replace(/[.,]$/, '');

function labNoteItem(r) {
  const at = labNoteDate(r.update, r.page);
  const text = String(r.text || '');
  const head = /^([^.:!?]{2,48}):\s+(.+)$/.exec(text);
  const name = head ? head[1] : '';
  const rest = head ? head[2] : text;
  let kind = null;
  if (r.type === 'wvw_rule') {
    if (/\bmap\b/i.test(text) && /Borderlands/.test(text) && /\b(new|replaced)\b/i.test(text)) kind = 'map';
    else kind = 'rule';
  } else if (r.type === 'event') kind = 'event';
  else if (r.type === 'buff' || r.type === 'nerf') kind = r.type;
  else if (r.type === 'bug' || r.type === 'balance_bug_mix') kind = 'fix';
  else if (r.type === 'reward') kind = 'reward';
  let before = ''; let after = ''; let desc = '';
  const ft = /\bfrom\s+([\d.,%]+(?:\s+seconds?)?)\s+to\s+([\d.,%]+(?:\s+seconds?)?)/.exec(rest);
  if ((kind === 'buff' || kind === 'nerf') && ft) {
    before = labSeconds(ft[1]); after = labSeconds(ft[2]);
    const what = /^(?:Increased|Reduced|Decreased)\s+(?:the\s+)?(.+?)\s+from\b/.exec(rest);
    desc = what ? what[1].charAt(0).toUpperCase() + what[1].slice(1) : rest;
  } else if (name && /^[\d,.]+\s*→\s*[\d,.]+(\s*\([^)]*\))?$/.test(rest)) {
    const a = rest.split('→');
    before = a[0].trim(); after = a[1].trim();
  } else desc = rest;
  const until = new RegExp(`until\\s+(${LAB_MONTHS.join('|')})\\s+(\\d{1,2})`).exec(text);
  const prof = LAB_PROFESSION_ICONS[r.sub] ? r.sub : (LAB_ELITE_PROFESSION[r.sub] || '');
  const link = /^[A-Za-z0-9_%().'-]+(#[A-Za-z0-9_.]+)?$/.test(r.link || '') ? LAB_WIKI + r.link : LAB_WIKI + `Game_updates/${r.page}`;
  return {
    at, page: r.page, update: r.update, kind, name, before, after, desc, text, link, prof,
    only: /\bin WvW only\b/i.test(text), example: !!r.example,
    wvw: Array.isArray(r.modes) && r.modes.length === 1 && r.modes[0] === 'WvW',
    until: until ? Date.UTC(new Date(at).getUTCFullYear(), LAB_MONTHS.indexOf(until[1]), Number(until[2]), 12) : 0,
  };
}

// The rows of one value table ("Keep captures: 250 → 100 (T0), …") read as one item, not eighteen.
function labNoteItems(rows) {
  const out = [];
  let table = null;
  for (const r of rows) {
    const it = labNoteItem(r);
    const isRow = it.kind === 'rule' && it.name && /→/.test(it.text) && it.text.length < 120;
    if (isRow && table && table.update === it.update) { table.rows.push(it); continue; }
    if (isRow) { table = { ...it, rows: [it] }; out.push(table); continue; }
    table = null;
    out.push(it);
  }
  for (const t of out) {
    if (!t.rows || t.rows.length < 3) continue;
    const first = t.rows[0];
    Object.assign(t, { name: 'Point values', before: '', after: '', desc: `${t.rows.length} values changed, starting with ${first.name}: ${first.text.split(': ')[1]}` });
  }
  const maps = new Set(out.filter((i) => i.kind === 'map').map((i) => i.update));
  return out.filter((i) => !(i.kind === 'event' && maps.has(i.update)));
}

function labAllNotes() {
  const rows = labNotes.sim ? labNotes.sim.concat(LAB_NEWS_ROWS) : LAB_NEWS_ROWS;
  return labNoteItems(rows);
}
// An invented update is what the simulation is for: it always makes the cut.
const labNoteScore = (i) => (i.example ? 1000 : 0) + (LAB_KIND_WEIGHT[i.kind] || 0) * 10 - (Date.now() - i.at) / (7 * 864e5);

// The n most telling items, at most perUpdate from one update, newest first.
function labPickNotes(items, n, perUpdate = 2) {
  const per = new Map();
  const chosen = [];
  for (const i of items.slice().sort((a, b) => labNoteScore(b) - labNoteScore(a))) {
    if (chosen.length >= n) break;
    const k = per.get(i.update) || 0;
    if (k >= perUpdate) continue;
    per.set(i.update, k + 1);
    chosen.push(i);
  }
  return chosen.sort((a, b) => b.at - a.at || (LAB_KIND_WEIGHT[b.kind] || 0) - (LAB_KIND_WEIGHT[a.kind] || 0));
}

const LAB_SVG = 'http://www.w3.org/2000/svg';
function labIcon(paths, cls) {
  const svg = document.createElementNS(LAB_SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls || 'ln-svg');
  for (const d of paths) {
    const p = document.createElementNS(LAB_SVG, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
// Our own drawings, one per kind: castle for a map, shield for a rule, flag for an event, scales for balance.
const LAB_KIND_ICON = {
  map: ['M4 20V9l4-3 4 3 4-3 4 3v11', 'M9 20v-5h6v5'],
  rule: ['M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6Z', 'M9 12l2 2 4-4'],
  event: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  balance: ['M12 4v16', 'M6 20h12', 'M4 8h16', 'M6 8l-3 6h6Z', 'M18 8l-3 6h6Z'],
  notes: ['M6 3h9l4 4v14H6Z', 'M14 3v5h5', 'M9 12h7', 'M9 16h7'],
};

function labNoteTag(i) {
  if (!i.kind) return null;
  const text = { buff: '▲ Buff', nerf: '▼ Nerf', map: 'Map', rule: 'Rule', fix: 'Fix', reward: 'Reward', event: 'Event' }[i.kind];
  if (i.until && i.until > Date.now()) {
    return labEl('span', 'ln-tag ln-tag-date', `Until ${labDay(i.until)}`);
  }
  return labEl('span', `ln-tag ln-tag-${i.kind}`, text);
}

function labNoteLine(i, opts) {
  const line = labEl('span', 'ln-line');
  const tag = labNoteTag(i);
  if (tag) line.appendChild(tag);
  if (opts.profIcon && i.prof && (i.kind === 'buff' || i.kind === 'nerf')) {
    const img = labEl('img', 'ln-prof');
    img.src = LAB_PROFESSION_ICONS[i.prof];
    img.alt = i.prof;
    img.title = i.prof;
    img.width = 18; img.height = 18;
    img.loading = 'lazy';
    line.appendChild(img);
  }
  if (i.name) {
    const a = labEl('a', 'ln-name', i.name);
    a.href = i.link; a.target = '_blank'; a.rel = 'noopener';
    line.appendChild(a);
  }
  if (i.before) {
    const ba = labEl('span', 'ln-ba');
    ba.append(labEl('s', null, i.before), labEl('i', null, '→'), labEl('b', null, i.after));
    line.appendChild(ba);
  }
  if (i.only) line.appendChild(labEl('span', 'ln-only', 'WvW only'));
  if (i.example) line.appendChild(labEl('span', 'lab-simtag', 'example'));
  return line;
}
function labNoteDesc(i) {
  if (!i.desc) return null;
  if (i.name) return labEl('span', 'ln-desc', i.desc);
  const a = labEl('a', 'ln-desc ln-desc-link', i.desc);
  a.href = i.link; a.target = '_blank'; a.rel = 'noopener';
  return a;
}

function labNewsHead(sub, opts) {
  const h = labEl('div', 'ln-src');
  if (opts.ownIcon) h.appendChild(labIcon(LAB_KIND_ICON.notes, 'ln-mark-svg'));
  else h.appendChild(labEl('span', 'ln-mark', '[[ ]]'));
  const t = labEl('span', 'ln-src-text');
  t.append(labEl('b', null, 'Guild Wars 2 Wiki'), ` · ${sub}`);
  h.appendChild(t);
  if (labNotes.sim) h.appendChild(labEl('span', 'lab-simtag', 'example update'));
  const a = labEl('a', 'ln-src-link', 'wiki ↗');
  a.href = `${LAB_WIKI}Game_updates`; a.target = '_blank'; a.rel = 'noopener';
  h.appendChild(a);
  return h;
}

function labNewsLedger(items, n, opts, more) {
  const box = labEl('div', 'ln-a');
  const shown = labPickNotes(items, labNotes.more && more ? n + 5 : n);
  let last = '';
  for (const i of shown) {
    const row = labEl('div', 'ln-a-it');
    const d = labDay(i.at);
    row.appendChild(labEl('span', 'ln-day', d === last ? '' : d));
    last = d;
    const body = labEl('div', 'ln-a-body');
    body.appendChild(labNoteLine(i, opts));
    const desc = labNoteDesc(i);
    if (desc) body.appendChild(desc);
    row.appendChild(body);
    box.appendChild(row);
  }
  if (more) {
    const b = labEl('button', 'ln-more', labNotes.more ? 'Fewer updates' : 'More updates');
    b.type = 'button';
    b.addEventListener('click', () => { labNotes.more = !labNotes.more; labPaintNews(); });
    box.appendChild(b);
  }
  return box;
}

function labLeadOf(items) {
  const big = items.filter((i) => ['map', 'event', 'rule'].includes(i.kind) && Date.now() - i.at < 45 * 864e5);
  if (!big.length) return null;
  return big.sort((a, b) => b.at - a.at || LAB_KIND_WEIGHT[b.kind] - LAB_KIND_WEIGHT[a.kind])[0];
}
function labSpan(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
function labNewsLead(lead) {
  const box = labEl('div', `ln-lead ln-lead-${lead.kind}`);
  box.appendChild(labEl('div', 'ln-lead-ic')).appendChild(labIcon(LAB_KIND_ICON[lead.kind] || LAB_KIND_ICON.rule));
  const body = labEl('div', 'ln-lead-body');
  const what = { map: 'New map', event: 'Event', rule: 'Rule change' }[lead.kind];
  const dt = labEl('span', 'ln-dt', `${labDay(lead.at)} · ${what}`);
  if (lead.example) dt.appendChild(labEl('span', 'lab-simtag', 'example'));
  body.appendChild(dt);
  const sentences = lead.text.split(/(?<=[.!])\s+/).filter((s) => !/https?:/.test(s));
  const title = labEl('a', 'ln-lead-title', lead.name ? `${lead.name}: ${lead.desc}` : sentences[0].replace(/[.!]$/, ''));
  title.href = lead.link; title.target = '_blank'; title.rel = 'noopener';
  body.appendChild(title);
  if (!lead.name && sentences[1]) body.appendChild(labEl('p', 'ln-lead-line', sentences[1]));
  if (lead.until && lead.until > Date.now()) body.appendChild(labEl('span', 'ln-pill', `Beta ends in ${labSpan(lead.until - Date.now())}`));
  box.appendChild(body);
  return box;
}

function labNewsGrid(items, opts) {
  const grid = labEl('div', 'ln-grid');
  for (const i of items) {
    const c = labEl('div', 'ln-cell');
    c.appendChild(labNoteLine(i, opts));
    const desc = labNoteDesc(i);
    if (desc) c.appendChild(desc);
    grid.appendChild(c);
  }
  return grid;
}

const LAB_FILTERS = { wvw: 'WvW', all: 'All', fix: 'Fixes' };
function labFilterNotes(items) {
  if (labNotes.filter === 'fix') return items.filter((i) => i.kind === 'fix');
  if (labNotes.filter === 'wvw') return items.filter((i) => i.kind !== 'fix' && (['map', 'event', 'rule', 'reward'].includes(i.kind) || i.only || i.wvw));
  return items;
}
function labNewsTimeline(items, days, opts) {
  const box = labEl('div', 'ln-c');
  const tl = labEl('div', 'ln-tl');
  const byDay = new Map();
  for (const i of labFilterNotes(items).sort((a, b) => b.at - a.at)) {
    const k = labDay(i.at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(i);
  }
  for (const [d, list] of [...byDay].slice(0, days)) {
    tl.appendChild(labEl('div', 'ln-d')).appendChild(labEl('span', 'ln-dt', d));
    // Two a day, of two kinds when the day has them: a balance line under a rule, not two rules.
    const ranked = list.slice().sort((a, b) => labNoteScore(b) - labNoteScore(a));
    const two = ranked.slice(0, 1).concat(ranked.slice(1).find((i) => i.kind !== ranked[0].kind) || ranked.slice(1, 2));
    for (const i of two) {
      const r = labEl('div', 'ln-r');
      r.appendChild(labNoteLine(i, opts));
      const desc = labNoteDesc(i);
      if (desc) r.appendChild(desc);
      tl.appendChild(r);
    }
  }
  if (!byDay.size) tl.appendChild(labEl('p', 'ln-empty', 'Nothing of this kind in the recent updates.'));
  box.appendChild(tl);
  const st = labEl('div', 'ln-filters');
  st.setAttribute('role', 'group');
  st.setAttribute('aria-label', 'Show');
  for (const [k, label] of Object.entries(LAB_FILTERS)) {
    const b = labEl('button', 'ln-filter', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', labNotes.filter === k ? 'true' : 'false');
    b.addEventListener('click', () => { labNotes.filter = k; labPaintNews(); });
    st.appendChild(b);
  }
  box.appendChild(st);
  return box;
}

function labNewsPanel(form, opts) {
  const items = labAllNotes();
  const panel = labEl('section', `ln-panel ln-form-${form}`);
  panel.setAttribute('aria-label', 'Game updates for WvW');
  if (form === 'A' || form === 'M') {
    panel.appendChild(labNewsHead('Game updates', opts));
    panel.appendChild(labNewsLedger(items, form === 'M' ? 3 : 5, opts, form === 'M'));
  } else if (form === 'B') {
    panel.appendChild(labNewsHead('latest WvW changes', opts));
    const lead = labLeadOf(items);
    if (lead) panel.appendChild(labNewsLead(lead));
    panel.appendChild(labNewsGrid(labPickNotes(items.filter((i) => i !== lead && i.kind), 4, 2), opts));
  } else {
    panel.appendChild(labNewsHead('Game updates · WvW', opts));
    const lead = form === 'R' ? labLeadOf(items) : null;
    if (lead) panel.appendChild(labNewsLead(lead));
    panel.appendChild(labNewsTimeline(items.filter((i) => i !== lead), lead ? 2 : 3, opts));
  }
  return panel;
}

// ---- "Simulate a new update": invented rows in the wiki's shape, marked as examples. ----
function labSimRows(kind) {
  const t = new Date(Math.max(Date.now(), ...LAB_NEWS_ROWS.map((r) => labNoteDate(r.update, r.page))) + 864e5);
  const iso = t.toISOString().slice(0, 10);
  const update = `Update - ${LAB_MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`;
  const end = new Date(t.getTime() + 14 * 864e5);
  const row = (type, text, sub = '', section = 'World vs. World') => ({
    page: iso, update, section, sub, text, link: '', type, sure: type !== 'balance_unsure', modes: ['WvW'], example: true,
  });
  if (kind === 'balance') {
    return [
      row('buff', 'Healing Rain: Increased the healing power scaling from 0.3 to 0.4 in WvW only.', 'Elementalist', 'Profession Skills'),
      row('nerf', 'Seethe: Reduced the damage bonus from 10% to 7% in WvW only.', 'Tempest', 'Profession Skills'),
      row('nerf', "Owl's Flight: Reduced the power coefficient from 1.35 to 1.2 in WvW only.", 'Ranger', 'Profession Skills'),
      row('buff', "Death's Retreat: Reduced the initiative cost from 6 to 5 in PvP and WvW.", 'Thief', 'Profession Skills'),
    ];
  }
  if (kind === 'rule') {
    return [
      row('wvw_rule', 'Keep and castle lords now gain 10% more health while the objective is at upgrade tier 3.'),
      row('wvw_rule', 'Supply camps now deliver supply 20% faster during a War Score beta.'),
      row('wvw_rule', 'Keep waypoints now stay open for 30 seconds after the objective becomes contested.'),
    ];
  }
  if (kind === 'map') {
    return [
      row('event', 'New WvW Borderlands map beta event begins.', '', ''),
      row('wvw_rule', `The new Example Borderlands map has replaced the Seared Borderlands map in WvW! The beta for this new map will run until ${LAB_MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}.`),
      row('bug', 'Fixed an issue that caused the Example Borderlands garrison gate to stay closed after a capture.'),
    ];
  }
  return [
    row('balance_unsure', 'Shadow Refuge: This skill now pulses stealth one fewer time in WvW.', 'Thief', 'Profession Skills'),
    row('balance_unsure', 'Well of Blood: This skill now also grants barrier to allies in the area in PvP and WvW.', 'Necromancer', 'Profession Skills'),
    row('balance_unsure', 'Arcing Arrow: This skill now inflicts burning only on the first target it hits in WvW.', 'Paragon', 'Profession Skills'),
    row('balance_unsure', 'Siege golems now take part in the War Score of the objective they were built in.'),
  ];
}
function labSimNews(kind) {
  labNotes.sim = kind ? labSimRows(kind) : null;
  labNotes.more = false;
  labPaintNews();
}
