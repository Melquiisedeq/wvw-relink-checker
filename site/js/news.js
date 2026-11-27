'use strict';
// The news panel under the search: the WvW lines of the game's update notes (/api/notes), read once
// after the standings are painted. Everything in the answer is a stranger's text: it goes in by
// textContent, and a link is used only when it is a page of the wiki's own host. With no usable
// answer the panel is never made.

const NEWS_URL = '/api/notes';
const NEWS_WIKI = 'https://wiki.guildwars2.com';
const NEWS_WIKI_UPDATES = NEWS_WIKI + '/wiki/Game_updates';
const NEWS_SVG = 'http://www.w3.org/2000/svg';
const NEWS_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const NEWS_MONTH_RE = NEWS_MONTHS.join('|');
const NEWS_DAY_RE = /^(\d{4})-(\d\d)-(\d\d)$/;
const NEWS_KIND_WEIGHT = { map: 6, rule: 4, buff: 3, nerf: 3, fix: 1 };
const NEWS_KIND_OF_TYPE = { buff: 'buff', nerf: 'nerf', bug: 'fix', wvw_rule: 'rule' };
const NEWS_TAGS = { buff: '▲ Buff', nerf: '▼ Nerf', map: 'Map', rule: 'Rule', fix: 'Fix' };
const NEWS_FILTERS = { wvw: 'WvW', all: 'All', fix: 'Fixes' };
const NEWS_LEAD_DAYS = 45;
const NEWS_MAX_ITEMS = 200;
const NEWS_MAX_TEXT = 400;
const NEWS_TICK_MS = 60 * 1000;
let newsItems = [];
let newsFilter = 'wvw';
let newsPanel = null;
let newsTimer = 0;

// The profession icons are the game's own (/v2/professions, icon); the page picks one by the
// profession's name, never by an address the answer carries. The elite specialisations name their profession.
const NEWS_PROFESSION_ICONS = {
  Guardian: 'https://render.guildwars2.com/file/C32BE61FC55C962524624F643897ECF1A9C80462/156634.png',
  Warrior: 'https://render.guildwars2.com/file/0A97E13F29B3597A447EEC04A09BE5BD699A2250/156643.png',
  Engineer: 'https://render.guildwars2.com/file/5CCB361F44CCC7256132405D31E3A24DACCF440A/156632.png',
  Ranger: 'https://render.guildwars2.com/file/49B10316B424F4E20139EB5E51ADCF24A8724E9B/156640.png',
  Thief: 'https://render.guildwars2.com/file/F9EC00E23F630D6DB20CDA985592EC010E2A5705/156641.png',
  Elementalist: 'https://render.guildwars2.com/file/77B793123251931AFF9FCA24C07E0F704BC4DA49/156630.png',
  Mesmer: 'https://render.guildwars2.com/file/E43730AD49A903C3A1B4F27E41DE04EA51A775EC/156636.png',
  Necromancer: 'https://render.guildwars2.com/file/AE56F8670807B87CF6EEE3FC7E6CB9710959E004/156638.png',
  Revenant: 'https://render.guildwars2.com/file/7C9309BE7A2A48C6A9FBCC70CC1EBEBFD7593C05/961390.png',
};
const NEWS_ELITE_PROFESSION = {
  Amalgam: 'Engineer', Antiquary: 'Thief', Berserker: 'Warrior', Bladesworn: 'Warrior',
  Catalyst: 'Elementalist', Chronomancer: 'Mesmer', Conduit: 'Revenant', Daredevil: 'Thief',
  Deadeye: 'Thief', Dragonhunter: 'Guardian', Druid: 'Ranger', Evoker: 'Elementalist',
  Firebrand: 'Guardian', Galeshot: 'Ranger', Harbinger: 'Necromancer', Herald: 'Revenant',
  Holosmith: 'Engineer', Luminary: 'Guardian', Mechanist: 'Engineer', Mirage: 'Mesmer', Paragon: 'Warrior',
  Reaper: 'Necromancer', Renegade: 'Revenant', Ritualist: 'Necromancer', Scourge: 'Necromancer',
  Scrapper: 'Engineer', Soulbeast: 'Ranger', Specter: 'Thief', Spellbreaker: 'Warrior',
  Tempest: 'Elementalist', Troubadour: 'Mesmer', Untamed: 'Ranger', Vindicator: 'Revenant',
  Virtuoso: 'Mesmer', Weaver: 'Elementalist', Willbender: 'Guardian',
};

// A page of the wiki as the wiki's own host, or '': the one place a href is made from the answer.
function newsWikiHref(s) {
  if (typeof s !== 'string' || s.length > 300) return '';
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (u.origin !== NEWS_WIKI || !u.pathname.startsWith('/wiki/')) return '';
  return NEWS_WIKI + u.pathname + u.hash;
}

const newsDay = (t) => `${new Date(t).getUTCDate()} ${NEWS_MONTHS[new Date(t).getUTCMonth()].slice(0, 3)}`;
const newsSeconds = (s) => s.replace(/\s+seconds?$/, ' s').replace(/[.,]$/, '');

function newsItem(r) {
  const day = NEWS_DAY_RE.exec(r.day);
  if (!day || typeof r.text !== 'string' || !r.text || r.text.length > NEWS_MAX_TEXT) return null;
  const at = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12);
  const text = r.text;
  const sub = typeof r.sub === 'string' ? r.sub : '';
  const head = /^([^.:!?]{2,48}):\s+(.+)$/.exec(text);
  const name = head ? head[1] : '';
  const rest = head ? head[2] : text;
  let kind = NEWS_KIND_OF_TYPE[r.type] || '';
  if (kind === 'rule' && /\bmap\b/i.test(text) && /Borderlands/.test(text) && /\b(new|replaced)\b/i.test(text)) kind = 'map';
  let before = '';
  let after = '';
  let desc = '';
  const fromTo = /\bfrom\s+([\d.,%]+(?:\s+seconds?)?)\s+to\s+([\d.,%]+(?:\s+seconds?)?)/.exec(rest);
  if ((kind === 'buff' || kind === 'nerf') && fromTo) {
    before = newsSeconds(fromTo[1]);
    after = newsSeconds(fromTo[2]);
    const what = /^(?:Increased|Reduced|Decreased)\s+(?:the\s+)?(.+?)\s+from\b/.exec(rest);
    desc = what ? what[1].charAt(0).toUpperCase() + what[1].slice(1) : rest;
  } else if (name && /^[\d,.]+\s*→\s*[\d,.]+(\s*\([^)]*\))?$/.test(rest)) {
    const sides = rest.split('→');
    before = sides[0].trim();
    after = sides[1].trim();
  } else desc = rest;
  const until = new RegExp(`until\\s+(${NEWS_MONTH_RE})\\s+(\\d{1,2})`).exec(text);
  const prof = Object.hasOwn(NEWS_PROFESSION_ICONS, sub) ? sub
    : (Object.hasOwn(NEWS_ELITE_PROFESSION, sub) ? NEWS_ELITE_PROFESSION[sub] : '');
  return {
    at, update: typeof r.update === 'string' ? r.update : '', kind, name, before, after, desc, text, prof,
    link: newsWikiHref(r.link) || newsWikiHref(r.page),
    only: /\bin WvW only\b/i.test(text),
    until: until ? Date.UTC(new Date(at).getUTCFullYear(), NEWS_MONTHS.indexOf(until[1]), Number(until[2]), 12) : 0,
  };
}

// The rows of one value table ("Keep captures: 250 → 100 (T0), …") read as one item, not eighteen.
function newsGroup(items) {
  const out = [];
  let table = null;
  for (const it of items) {
    const isRow = it.kind === 'rule' && it.name && /→/.test(it.text) && it.text.length < 120;
    if (isRow && table && table.update === it.update) { table.rows.push(it); continue; }
    if (isRow) { table = { ...it, rows: [it] }; out.push(table); continue; }
    table = null;
    out.push(it);
  }
  return out.flatMap((t) => {
    if (!t.rows) return [t];
    if (t.rows.length < 3) return t.rows;
    const first = t.rows[0];
    return [{ ...t, name: 'Point values', before: '', after: '', desc: `${t.rows.length} values changed, starting with ${first.name}: ${first.text.split(': ')[1]}` }];
  });
}

function newsRead(body) {
  const list = body && Array.isArray(body.notes) ? body.notes.slice(0, NEWS_MAX_ITEMS) : [];
  return newsGroup(list.map((r) => (r && typeof r === 'object' ? newsItem(r) : null)).filter(Boolean));
}

const newsScore = (i) => (NEWS_KIND_WEIGHT[i.kind] || 0) * 10 - (Date.now() - i.at) / (7 * 864e5);
const newsLive = (i) => i.until > Date.now();

function newsEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function newsLink(cls, text, href) {
  const a = newsEl('a', cls, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}
function newsIcon(paths, cls) {
  const svg = document.createElementNS(NEWS_SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', cls);
  for (const d of paths) {
    const p = document.createElementNS(NEWS_SVG, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
// Our own drawings: a castle for a map, a shield for a rule, the notes' page for the header.
const NEWS_ICONS = {
  map: ['M4 20V9l4-3 4 3 4-3 4 3v11', 'M9 20v-5h6v5'],
  rule: ['M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6Z', 'M9 12l2 2 4-4'],
  notes: ['M6 3h9l4 4v14H6Z', 'M14 3v5h5', 'M9 12h7', 'M9 16h7'],
};

function newsTag(i) {
  if (!i.kind) return null;
  if (newsLive(i)) return newsEl('span', 'news-tag news-tag-date', `Until ${newsDay(i.until)}`);
  return newsEl('span', `news-tag news-tag-${i.kind}`, NEWS_TAGS[i.kind]);
}

function newsLine(i) {
  const line = newsEl('span', 'news-line');
  const tag = newsTag(i);
  if (tag) line.appendChild(tag);
  if (i.prof && (i.kind === 'buff' || i.kind === 'nerf')) {
    const img = newsEl('img', 'news-prof');
    img.src = NEWS_PROFESSION_ICONS[i.prof];
    img.alt = i.prof;
    img.title = i.prof;
    img.width = 18;
    img.height = 18;
    line.appendChild(img);
  }
  if (i.name) line.appendChild(i.link ? newsLink('news-name', i.name, i.link) : newsEl('span', 'news-name', i.name));
  if (i.before) {
    const ba = newsEl('span', 'news-ba');
    ba.append(newsEl('s', null, i.before), newsEl('i', null, '→'), newsEl('b', null, i.after));
    line.appendChild(ba);
  }
  if (i.only) line.appendChild(newsEl('span', 'news-only', 'WvW only'));
  return line;
}
function newsDesc(i) {
  if (!i.desc) return null;
  if (i.name || !i.link) return newsEl('span', 'news-desc', i.desc);
  return newsLink('news-desc news-desc-link', i.desc, i.link);
}

function newsHead() {
  const h = newsEl('div', 'news-src');
  h.appendChild(newsIcon(NEWS_ICONS.notes, 'news-mark'));
  const t = newsEl('span', 'news-src-text');
  t.append(newsEl('b', null, 'Guild Wars 2 Wiki'), ' · Game updates · WvW');
  h.appendChild(t);
  h.appendChild(newsLink('news-src-link', 'wiki ↗', NEWS_WIKI_UPDATES));
  return h;
}

function newsLeadOf(items) {
  const big = items.filter((i) => (i.kind === 'map' || i.kind === 'rule') && Date.now() - i.at < NEWS_LEAD_DAYS * 864e5);
  if (!big.length) return null;
  return big.sort((a, b) => b.at - a.at || NEWS_KIND_WEIGHT[b.kind] - NEWS_KIND_WEIGHT[a.kind])[0];
}
function newsSpan(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
function newsLead(lead) {
  const box = newsEl('div', `news-lead news-lead-${lead.kind}`);
  box.appendChild(newsEl('div', 'news-lead-ic')).appendChild(newsIcon(NEWS_ICONS[lead.kind], 'news-lead-svg'));
  const body = newsEl('div', 'news-lead-body');
  body.appendChild(newsEl('span', 'news-dt', `${newsDay(lead.at)} · ${lead.kind === 'map' ? 'New map' : 'Rule change'}`));
  const sentences = lead.text.split(/(?<=[.!])\s+/);
  const titleText = lead.name ? `${lead.name}: ${lead.desc}` : sentences[0].replace(/[.!]$/, '');
  body.appendChild(lead.link ? newsLink('news-lead-title', titleText, lead.link) : newsEl('span', 'news-lead-title', titleText));
  if (!lead.name && sentences[1]) body.appendChild(newsEl('p', 'news-lead-line', sentences[1]));
  if (newsLive(lead)) body.appendChild(newsEl('span', 'news-pill', `Beta ends in ${newsSpan(lead.until - Date.now())}`));
  box.appendChild(body);
  return box;
}

function newsShown(items) {
  if (newsFilter === 'fix') return items.filter((i) => i.kind === 'fix');
  if (newsFilter === 'wvw') return items.filter((i) => i.kind !== 'fix' && (i.kind === 'map' || i.kind === 'rule' || i.only));
  return items;
}
function newsTimeline(items, days) {
  const box = newsEl('div', 'news-c');
  const tl = newsEl('div', 'news-tl');
  const byDay = new Map();
  for (const i of newsShown(items).sort((a, b) => b.at - a.at)) {
    const k = newsDay(i.at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(i);
  }
  for (const [d, list] of [...byDay].slice(0, days)) {
    tl.appendChild(newsEl('div', 'news-d')).appendChild(newsEl('span', 'news-dt', d));
    // Two a day, of two kinds when the day has them: a balance line under a rule, not two rules.
    const ranked = list.slice().sort((a, b) => newsScore(b) - newsScore(a));
    const two = ranked.slice(0, 1).concat(ranked.slice(1).find((i) => i.kind !== ranked[0].kind) || ranked.slice(1, 2));
    for (const i of two) {
      const r = newsEl('div', 'news-r');
      r.appendChild(newsLine(i));
      const desc = newsDesc(i);
      if (desc) r.appendChild(desc);
      tl.appendChild(r);
    }
  }
  if (!byDay.size) tl.appendChild(newsEl('p', 'news-empty', 'Nothing of this kind in the recent updates.'));
  box.appendChild(tl);
  const group = newsEl('div', 'news-filters');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Show');
  for (const [k, label] of Object.entries(NEWS_FILTERS)) {
    const b = newsEl('button', 'news-filter', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', newsFilter === k ? 'true' : 'false');
    b.addEventListener('click', () => { newsFilter = k; newsPaint(); newsPanel.querySelector('[aria-pressed="true"]').focus(); });
    group.appendChild(b);
  }
  box.appendChild(group);
  return box;
}

function newsBuild() {
  const panel = newsEl('section', 'news-panel frame-a');
  panel.setAttribute('aria-label', 'Game updates for WvW');
  panel.appendChild(newsHead());
  const lead = newsLeadOf(newsItems);
  if (lead) panel.appendChild(newsLead(lead));
  panel.appendChild(newsTimeline(newsItems.filter((i) => i !== lead), lead ? 2 : 3));
  return panel;
}
function newsPaint() {
  const next = newsBuild();
  newsPanel.replaceChildren(...next.childNodes);
}

// The countdown and the "Until" tags follow the clock; the minute stops when no date is ahead.
function newsTick() {
  if (!newsItems.some(newsLive)) { clearInterval(newsTimer); newsTimer = 0; }
  if (document.hidden || newsPanel.contains(document.activeElement)) return;
  newsPaint();
}

// The panel's styles are read with the panel, not with the page: the opening carries nothing of them.
function newsMount() {
  const sheet = document.createElement('link');
  sheet.rel = 'stylesheet';
  sheet.href = 'css/news.css';
  sheet.addEventListener('load', () => {
    newsPanel = newsBuild();
    matchPanelsContainer.after(newsPanel);
    if (newsItems.some(newsLive)) newsTimer = setInterval(newsTick, NEWS_TICK_MS);
  }, { once: true });
  document.head.appendChild(sheet);
}

async function startNews() {
  try {
    newsItems = newsRead(await fetchOwnApi(NEWS_URL));
  } catch { return; }
  if (newsItems.length) newsMount();
}
