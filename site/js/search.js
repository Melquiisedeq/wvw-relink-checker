'use strict';
// The search: one guild name, asked of the game in series (name to id, the guild, the
// guild-to-team table, the team's match), answered in a card in the team's colour. Its
// arrow brings the tier into view and plays the spotlight there. Guild names are
// strangers' text: textContent only.

const RECENT_GUILDS_KEY = 'wvw-relink-checker:recent-guilds';
const RECENT_GUILDS_MAX = 8;
// The pasted list the search before this one kept; nothing reads it any more.
const OLD_GUILDS_KEY = 'wvw-relink-checker:guilds';
const MARK_MS = 8000;
const SPOT_HIT_MS = 350;
const SPOT_MS = 2500;
// The tier's ring, in px; its corners are cut like the tier's own (css/facets.css).
const SPOT_RING = 3;
// Below this the rails sit under the middle (css/layout.css), so the tier is always below the answer.
const SEARCH_NARROW = '(max-width: 1399px)';
const searchAnswer = document.getElementById('searchAnswer');
const recentGuildList = document.getElementById('recentGuilds');
const found = { mark: null, markTimer: 0, watch: null, spot: null };
let lastAsked = '';

try { localStorage.removeItem(OLD_GUILDS_KEY); } catch { /* no storage: nothing kept either */ }

// An effect (js/trebuchet.js) never stops the search: missing or throwing, it is skipped.
function fx(effect) {
  try { effect(); } catch { /* the effect only */ }
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function recentGuilds() {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_GUILDS_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_GUILDS_MAX) : [];
  } catch { return []; }
}
function paintRecentGuilds() {
  recentGuildList.textContent = '';
  for (const n of recentGuilds()) {
    const o = el('option');
    o.value = n;
    recentGuildList.appendChild(o);
  }
}
function rememberGuild(name) {
  const list = [name, ...recentGuilds().filter((x) => x.toLowerCase() !== name.toLowerCase())].slice(0, RECENT_GUILDS_MAX);
  try { localStorage.setItem(RECENT_GUILDS_KEY, JSON.stringify(list)); } catch { /* the list just won't persist */ }
  paintRecentGuilds();
}
paintRecentGuilds();

// What the game said, as the answer card reads it. A finished week, or one the page only
// remembers, says nothing about the tier or the rivals: the team and its region stay.
async function lookUp(name) {
  let maps;
  try { maps = await getWvwMaps(); } catch { return { error: "Couldn't load WvW data. The connection may be slow.", retry: true }; }
  let guildId;
  let info;
  try {
    guildId = await resolveGuildId(name);
    info = await getGuildInfo(guildId);
  } catch (e) {
    return e.notFound ? { error: 'Not found. Check the exact in-game name.' } : { error: "The game isn't answering.", retry: true };
  }
  const link = findLink(guildId, maps);
  if (!link) return { error: `${info.name} has no WvW team yet.` };
  let match = null;
  try { match = await getMatchForTeam(link.teamId); } catch { match = null; }
  const color = match ? colorForTeam(match, link.teamId) : null;
  const out = { ok: true, guild: info.name, teamId: link.teamId, team: getTeamName(link.teamId), region: link.region, color, tier: '', opp: [] };
  if (match && color && !match.fromMemory && matchIsLive(match)) {
    out.tier = String(match.id).split('-')[1] || '';
    out.opp = COLORS.filter((c) => c !== color).map((c) => ({ color: c, name: getTeamName(matchTeamId(match, c)) }));
  }
  return out;
}

async function run() {
  const name = guildInput.value.trim();
  if (!name || runBtn.disabled) return;
  lastAsked = name;
  // The phone's keyboard closes, so the answer is in sight.
  guildInput.blur();
  dropMark();
  dropStrip();
  paintAnswer({ asking: true });
  runBtn.disabled = true;
  runBtn.innerHTML = '<span class="btn-pips"><span></span><span></span><span></span></span>';
  closePopover();
  let outcome = { error: 'Something went wrong partway through. Give it another try.', retry: true };
  // However it ends, the button comes back: otherwise it stays disabled, the trebuchet
  // hauled back and its frame loop alive.
  try {
    fx(() => sparksFrom(runBtn));
    fx(() => startCharge());
    outcome = await lookUp(name);
    if (outcome.ok) {
      rememberGuild(outcome.guild);
      markFound(outcome.team);
    }
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = 'Check';
    paintAnswer(outcome);
    const card = searchAnswer.querySelector('.search-card');
    // Only as far as needed, and only the answer: the standings card is never scrolled to.
    (card || searchAnswer).scrollIntoView({ block: 'nearest' });
    fx(() => playFinale());
  }
}

function paintAnswer(o) {
  searchAnswer.textContent = '';
  if (o.asking) {
    const p = el('p', 'search-progress');
    p.append(el('span', 'spinner'), 'Asking the game…');
    searchAnswer.appendChild(p);
    return;
  }
  if (o.error) {
    const p = el('p', 'search-err', o.error);
    if (o.retry) {
      const b = el('button', 'search-retry', 'Try again');
      b.type = 'button';
      b.addEventListener('click', () => { guildInput.value = lastAsked; run(); });
      p.append(' ', b);
    }
    searchAnswer.appendChild(p);
    return;
  }
  searchAnswer.appendChild(answerCard(o));
}

// Where the team's tier is from the answer: below it on a narrow page, in a side rail from 1400 px.
function tierWay(o) {
  if (matchMedia(SEARCH_NARROW).matches) return 'down';
  const grid = document.getElementById(`standingsGrid${o.region}`);
  const mid = document.querySelector('main.wrap');
  if (!grid || !mid) return 'down';
  return grid.getBoundingClientRect().left < mid.getBoundingClientRect().left ? 'left' : 'right';
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHEVRONS = ['M6 7l5 5-5 5', 'M12 7l5 5-5 5'];
function chevrons() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'search-go-svg');
  for (const d of CHEVRONS) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}
function teamDot(color) { return el('span', `search-dot search-dot-${color}`); }

// The answer: the standings cards' side-* tint, the tier said loud, the rivals by name.
function answerCard(o) {
  const card = el('div', `search-card search-way-${tierWay(o)}${o.color ? ` side-${o.color}` : ''}`);
  const name = el('div', 'search-card-name');
  name.append(el('span', 'search-who', `${o.guild} is on`), el('span', 'search-team', o.team));
  const top = el('div', 'search-card-top');
  top.appendChild(name);
  const tier = el('span', 'search-tier');
  tier.append(el('b', null, o.tier ? `Tier ${o.tier}` : o.region), el('span', null, o.tier ? o.region : ''));
  top.appendChild(tier);
  card.appendChild(top);
  if (!o.tier) return card;
  const rivals = el('div', 'search-rivals');
  rivals.appendChild(el('span', 'search-vs', 'vs'));
  for (const r of o.opp) {
    const c = el('span', `search-rival side-${r.color}`);
    c.append(teamDot(r.color), el('span', null, r.name));
    rivals.appendChild(c);
  }
  const go = el('button', 'search-go');
  go.type = 'button';
  go.setAttribute('aria-label', `Show ${o.team} in the standings, ${o.region} Tier ${o.tier}`);
  go.addEventListener('click', () => goToTier(o.team, o.guild));
  go.appendChild(chevrons());
  const foot = el('div', 'search-card-foot');
  foot.append(rivals, go);
  card.appendChild(foot);
  return card;
}

// sparkFromButton's flight (.btn-spark in css), from any box.
function sparksFrom(box) {
  const r = box.getBoundingClientRect();
  if (r.width === 0) return;
  for (let i = 0; i < 14; i++) {
    const spark = el('div', 'btn-spark');
    spark.style.left = `${r.left + Math.random() * r.width}px`;
    spark.style.top = `${r.top + Math.random() * Math.min(r.height, 24)}px`;
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const distance = 30 + Math.random() * 70;
    spark.style.setProperty('--sx', `${Math.round(Math.cos(angle) * distance)}px`);
    spark.style.setProperty('--sy', `${Math.round(Math.sin(angle) * distance)}px`);
    spark.style.animationDelay = `${(Math.random() * 0.12).toFixed(2)}s`;
    document.body.appendChild(spark);
    setTimeout(() => spark.remove(), 900);
  }
}

// ---- where the finale lands ----------------------------------------------------------------
// js/trebuchet.js asks where to throw: the answer card, or the bar if no answer is up. The
// crest is sized to it (--aim-x/y/s, css/search.css), and the card is struck on the break.
function finaleTarget() {
  const box = searchAnswer.querySelector('.search-card') || document.querySelector('.search-bar');
  if (!box) return null;
  const r = box.getBoundingClientRect();
  const x = Math.min(window.innerWidth - 70, Math.max(70, r.left + r.width / 2));
  const y = Math.min(window.innerHeight - 70, Math.max(70, r.top + r.height / 2));
  const html = document.documentElement;
  html.style.setProperty('--aim-x', `${Math.round(x)}px`);
  html.style.setProperty('--aim-y', `${Math.round(y)}px`);
  // The crest's stack is 178 px tall: it lands a little under the card's height.
  html.style.setProperty('--aim-s', Math.min(1, Math.max(0.45, (r.height * 0.9) / 178)).toFixed(3));
  return { x, y };
}
function strikeAnswer() {
  const card = searchAnswer.querySelector('.search-card');
  if (!card) return;
  card.classList.remove('search-sheen');
  void card.offsetWidth;
  card.classList.add('search-sheen');
  sparksFrom(card);
}

// ---- the found team's card in the standings ------------------------------------------------
// A sheen and a soft ring for MARK_MS from when the card comes into view; a standings repaint
// rebuilds the card, and markAfterRepaint paints it again.
function cardOfTeam(name) {
  for (const n of document.querySelectorAll('.standing-side .standing-side-name')) {
    if (n.textContent === name) return n.closest('.standing-side');
  }
  return null;
}
function markFound(teamName) {
  dropMark();
  found.mark = { name: teamName, started: 0 };
  markAfterRepaint();
}
function markAfterRepaint() {
  const m = found.mark;
  if (!m) return;
  if (found.watch) { found.watch.disconnect(); found.watch = null; }
  if (m.started) { paintMark(false); return; }
  const card = cardOfTeam(m.name);
  if (!card) return;
  found.watch = new IntersectionObserver((list) => {
    if (list.some((e) => e.isIntersecting)) startMark();
  }, { threshold: 0.6 });
  found.watch.observe(card);
}
function startMark() {
  if (found.watch) { found.watch.disconnect(); found.watch = null; }
  const m = found.mark;
  if (!m || m.started) return;
  m.started = Date.now();
  paintMark(true);
  found.markTimer = setTimeout(dropMark, MARK_MS);
}
function paintMark(fresh) {
  const m = found.mark;
  if (!m || !m.started || Date.now() - m.started > MARK_MS) return null;
  const card = cardOfTeam(m.name);
  if (!card) return null;
  for (const old of card.querySelectorAll('.found-mark')) old.remove();
  const layer = el('span', `found-mark${fresh ? ' is-fresh' : ''}`);
  layer.setAttribute('aria-hidden', 'true');
  card.appendChild(layer);
  return card;
}
function dropMark() {
  clearTimeout(found.markTimer);
  if (found.watch) { found.watch.disconnect(); found.watch = null; }
  found.mark = null;
  for (const e of document.querySelectorAll('.found-mark')) e.remove();
}
// The strip with the guild's name under its team's card (paintGuildFound in js/standings.js,
// which every standings repaint calls again until `until`).
function hangStrip(teamName, guildName) {
  guildFound = { teamName, guildName, until: Date.now() + MARK_MS };
  paintGuildFound(document, true);
}
function dropStrip() {
  guildFound = null;
  for (const s of document.querySelectorAll('.guild-found-strip')) s.remove();
}

// ---- the tier spotlight ----------------------------------------------------------------------
// The tier is brought into view (centred, or its top if taller than the screen); once 60 % of it
// is in sight the other tiers of its column dim, it is ringed, and its team's card is struck.
function goToTier(teamName, guild) {
  const card = cardOfTeam(teamName);
  const tier = card && card.closest('.standing-match');
  if (!tier) return;
  if (found.spot) found.spot.disconnect();
  const h = tier.getBoundingClientRect().height;
  tier.scrollIntoView({ behavior: 'smooth', block: h > window.innerHeight * 0.9 ? 'start' : 'center' });
  // A tier taller than the screen never gets 60 % of itself in: then most of the screen will do.
  const need = Math.min(0.6, (window.innerHeight * 0.85) / Math.max(1, h));
  const io = new IntersectionObserver((list) => {
    if (!list.some((e) => e.isIntersecting && e.intersectionRatio >= need - 0.01)) return;
    io.disconnect();
    found.spot = null;
    playSpot(tier, teamName, guild);
  }, { threshold: need });
  found.spot = io;
  io.observe(tier);
}
function ringPath(w, h) {
  const c = 15;
  const t = SPOT_RING;
  return `path(evenodd, 'M${c} 0H${w}V${h - c}L${w - c} ${h}H0V${c}Z M${c + 1} ${t}L${t} ${c + 1}V${h - t}H${w - c - 1}L${w - t} ${h - c - 1}V${t}Z')`;
}
// The strip hangs before the ring is measured: it makes the tier taller, and a ring measured
// without it would cross it.
function playSpot(tier, teamName, guild) {
  for (const old of document.querySelectorAll('.tier-spot')) old.remove();
  for (const m of document.querySelectorAll('.tier-dimmed')) m.classList.remove('tier-dimmed');
  hangStrip(teamName, guild);
  const first = cardOfTeam(teamName);
  const col = tier.parentElement;
  col.classList.add('tier-spot-col');
  const spot = el('span', 'tier-spot');
  spot.setAttribute('aria-hidden', 'true');
  const glow = first ? getComputedStyle(first).getPropertyValue('--side-glow').trim() : '';
  if (glow) spot.style.setProperty('--spot-c', glow);
  const w = tier.offsetWidth + 2 * SPOT_RING;
  const h = tier.offsetHeight + 2 * SPOT_RING;
  spot.style.left = `${tier.offsetLeft - SPOT_RING}px`;
  spot.style.top = `${tier.offsetTop - SPOT_RING}px`;
  spot.style.width = `${w}px`;
  spot.style.height = `${h}px`;
  spot.style.setProperty('--spot-ring', ringPath(w, h));
  spot.appendChild(el('span', 'tier-ring'));
  col.appendChild(spot);
  for (const m of col.children) if (m !== tier && m.classList.contains('standing-match')) m.classList.add('tier-dimmed');
  setTimeout(() => {
    dropMark();
    found.mark = { name: teamName, started: Date.now() };
    const card = paintMark(true);
    if (card) sparksFrom(card);
    found.markTimer = setTimeout(dropMark, MARK_MS);
  }, SPOT_HIT_MS);
  setTimeout(() => {
    spot.remove();
    for (const m of document.querySelectorAll('.tier-dimmed')) m.classList.remove('tier-dimmed');
  }, SPOT_MS);
}
