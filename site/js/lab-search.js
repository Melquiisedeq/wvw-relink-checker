'use strict';
// LAB (never merged). One guild at a time: the lab's field writes into the hidden #guildInput and
// awaits the page's own run() (serial, as ever), then reads what it left: the team from the
// showGuildFound hook, a failure from the results table it fills. The real #runBtn is moved into the
// bar, so its own busy state and the effects that start from it stay. Nothing scrolls the page by
// itself: the answer card's arrow brings the tier into view. Guild names are strangers' text: textContent only.

const LAB_RECENT_KEY = 'wvw-lab-recent-v1';
const LAB_MARK_MS = 8000;
const labS = { found: null, outcome: null, name: '', mark: null, markTimer: 0, watch: null, spot: null, brokeAt: 0 };

function labRecent() {
  try {
    const v = JSON.parse(localStorage.getItem(LAB_RECENT_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 8) : [];
  } catch { return []; }
}
function labRemember(name) {
  const list = [name, ...labRecent().filter((x) => x.toLowerCase() !== name.toLowerCase())].slice(0, 8);
  try { localStorage.setItem(LAB_RECENT_KEY, JSON.stringify(list)); } catch { /* fine */ }
  labPaintRecent();
}
// The last guilds found, offered by the field as you type.
function labPaintRecent() {
  const dl = document.getElementById('labGuildList');
  if (!dl) return;
  dl.textContent = '';
  for (const n of labRecent()) {
    const o = document.createElement('option');
    o.value = n;
    dl.appendChild(o);
  }
}

const LAB_LENS = ['M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13Z', 'M15.5 15.5 20 20'];
function labBuildSearch() {
  const box = labEl('section', 'ls-search');
  box.setAttribute('aria-label', 'Find your guild’s team');
  const head = labEl('div', 'ls-head');
  head.append(labIcon(LAB_LENS, 'ls-head-ic'), labEl('span', null, 'Find your guild’s team'));
  const label = labEl('label', 'sr-only', 'Guild name, exactly as in game');
  label.htmlFor = 'labGuild';
  const bar = labEl('div', 'ls-bar');
  const input = labEl('input', 'ls-input');
  input.id = 'labGuild';
  input.type = 'search';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('enterkeyhint', 'search');
  input.placeholder = 'Exact in-game guild name';
  input.setAttribute('list', 'labGuildList');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); labCheck(input.value); } });
  const dl = labEl('datalist');
  dl.id = 'labGuildList';
  const btnBox = labEl('span', 'ls-btn');
  bar.append(input, btnBox, dl);
  // Pressed in the capture phase, before boot.js's own listener on the button would start run() itself.
  bar.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#runBtn')) { e.stopPropagation(); e.preventDefault(); labCheck(input.value); }
  }, true);
  const answer = labEl('div', 'ls-answer');
  answer.id = 'labAnswer';
  answer.setAttribute('role', 'status');
  answer.setAttribute('aria-live', 'polite');
  box.append(head, label, bar, answer);
  return box;
}
// The answer's arrow: a double chevron, turned by CSS to where the tier is.
const LAB_CHEVRONS = ['M6 7l5 5-5 5', 'M12 7l5 5-5 5'];

// sparkFromButton's sparks (the .btn-spark flight in css), from a box of the lab's choosing.
function labSparksFrom(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0) return;
  for (let i = 0; i < 14; i++) {
    const spark = labEl('div', 'btn-spark');
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

async function labCheck(raw) {
  const name = String(raw || '').trim();
  if (!name || runBtn.disabled) return;
  labS.name = name;
  labS.found = null;
  // The phone's keyboard closes, so the answer is in sight.
  const input = document.getElementById('labGuild');
  if (input) input.blur();
  labDropMark();
  labDropStrip();
  labS.outcome = { asking: true };
  labPaintAnswer();
  guildInput.value = name;
  labS.brokeAt = 0;
  try { await run(); } catch { /* run() said it on statusMsg; read below */ }
  labS.outcome = await labReadOutcome(name);
  if (labS.outcome.ok) labRemember(labS.outcome.guild);
  labPaintAnswer();
  const card = document.querySelector('#labAnswer .ls-ans');
  // Only as far as needed, never centred, and only for the answer: the standings card is never scrolled to.
  const shown = card || document.getElementById('labAnswer');
  if (shown && typeof shown.scrollIntoView === 'function') shown.scrollIntoView({ block: 'nearest' });
}

// The strike on the answer card: the sheen once over it and the sparks flying off it.
function labHitCard(card) {
  card.classList.remove('ls-sheen');
  void card.offsetWidth;
  card.classList.add('ls-sheen');
  labSparksFrom(card);
}
async function labReadOutcome(name) {
  if (labS.found) {
    const { teamId, guildName } = labS.found;
    let match = null;
    try { match = await getMatchForTeam(teamId); } catch { match = null; }
    const color = match ? colorForTeam(match, teamId) : null;
    const out = { ok: true, guild: guildName, team: getTeamName(teamId), color, matchId: match ? match.id : '' };
    const cell = resultBody.querySelector('tr td:nth-child(3)');
    out.region = match ? labRegion(match.id) : (cell ? cell.textContent : '');
    out.tier = match ? String(match.id).split('-')[1] : '';
    out.opp = match && color ? COLORS.filter((c) => c !== color).map((c) => ({ color: c, name: labTeamName(match, c) })) : [];
    return out;
  }
  const err = resultBody.querySelector('td.status-err');
  const said = err ? err.textContent : '';
  if (said.startsWith('Guild not found')) return { error: 'Not found. Check the exact in-game name.' };
  if (said.startsWith('No WvW link')) return { error: `${name} has no WvW team yet.` };
  return { error: "The game isn't answering.", retry: true };
}

function labChip(o) {
  const c = labEl('span', `ls-chip side-${o.color}`);
  c.append(labDot(o.color), labEl('span', null, o.name));
  return c;
}
// Where the team's tier is from the answer: below it on a narrow page, in a side rail from 1400 px.
function labTierWay(o) {
  if (typeof matchMedia !== 'function' || matchMedia(LAB_NARROW).matches) return 'down';
  const grid = document.getElementById(`standingsGrid${o.region}`);
  const mid = document.getElementById('labMid');
  if (!grid || !mid) return 'down';
  return grid.getBoundingClientRect().left < mid.getBoundingClientRect().left ? 'left' : 'right';
}
// Scrolls to the tier and plays the spotlight there; the live map stays shut.
function labGo(el, o) {
  el.type = 'button';
  el.setAttribute('aria-label', `Show ${o.team} in the standings, ${o.region} Tier ${o.tier}`);
  el.addEventListener('click', () => labGoToTier([o.team], o.guild));
  return el;
}
function labGoButton(o) {
  const go = labGo(labEl('button', 'ls-go'), o);
  go.appendChild(labIcon(LAB_CHEVRONS, 'ls-go-svg'));
  return go;
}
// The answer: the team's own colour (the standings cards' side-* tint), the tier said loud, the rivals as chips.
function labAnswerCard(o) {
  const card = labEl('div', `ls-ans ls-way-${labTierWay(o)}${o.color ? ` side-${o.color}` : ''}`);
  const name = labEl('div', 'ls-ans-name');
  name.append(labEl('span', 'ls-who', `${o.guild} is on`), labEl('span', 'ls-team', o.team));
  const rivals = labEl('div', 'ls-rivals');
  if (o.opp.length) {
    rivals.appendChild(labEl('span', 'ls-vs', 'vs'));
    for (const r of o.opp) rivals.appendChild(labChip(r));
  }
  const top = labEl('div', 'ls-ans-top');
  top.appendChild(name);
  if (o.tier) {
    const tier = labEl('span', 'ls-tier');
    tier.append(labEl('b', null, `Tier ${o.tier}`), labEl('span', null, o.region));
    top.appendChild(tier);
  }
  const foot = labEl('div', 'ls-ans-foot');
  foot.appendChild(rivals);
  if (o.tier) foot.appendChild(labGoButton(o));
  card.append(top, foot);
  return card;
}

function labPaintAnswer() {
  const box = document.getElementById('labAnswer');
  if (!box) return;
  box.textContent = '';
  const o = labS.outcome;
  if (!o) return;
  if (o.asking) {
    const p = labEl('p', 'ls-progress');
    p.append(labEl('span', 'spinner'), 'Asking the game…');
    box.appendChild(p);
    return;
  }
  if (o.error) {
    const p = labEl('p', 'ls-err', o.error);
    if (o.retry) {
      const b = labEl('button', 'ls-retry', 'Try again');
      b.type = 'button';
      b.addEventListener('click', () => labCheck(labS.name));
      p.append(' ', b);
    }
    box.appendChild(p);
    return;
  }
  box.appendChild(labAnswerCard(o));
}

// ---- where the finale lands -------------------------------------------------------------------
// The trebuchet.js hook, after it aimed the round at the screen's centre: the target moves to the answer
// card (or the bar, if the answer is not up yet) and the crest with it, sized to the card; the card is
// struck on the break, FLIGHT_MS on. --lab-ax/ay/as place and size the crest and everything round it.
function labAimBall(ball, arc, from) {
  if (typeof document.querySelector !== 'function') return;
  const el = document.querySelector('#labAnswer .ls-ans') || document.querySelector('.ls-bar');
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = Math.min(window.innerWidth - 70, Math.max(70, r.left + r.width / 2));
  const y = Math.min(window.innerHeight - 70, Math.max(70, r.top + r.height / 2));
  const html = document.documentElement;
  html.style.setProperty('--lab-ax', `${Math.round(x)}px`);
  html.style.setProperty('--lab-ay', `${Math.round(y)}px`);
  const dx = x - from.x;
  const dy = y - from.y;
  ball.style.setProperty('--dx', `${Math.round(dx)}px`);
  arc.style.setProperty('--dy', `${Math.round(dy)}px`);
  arc.style.setProperty('--rise', `${Math.round(arcRise(dx, dy))}px`);
  // The 200 px stack holds a 178 px tall crest: a bit under the card's height.
  const want = r.height * 0.9;
  html.style.setProperty('--lab-as', Math.min(1, Math.max(0.45, want / 178)).toFixed(3));
  setTimeout(labOnBreak, typeof FLIGHT_MS === 'number' ? FLIGHT_MS : 560);
}
function labOnBreak() {
  labS.brokeAt = performance.now();
  const card = document.querySelector('#labAnswer .ls-ans');
  if (card) labHitCard(card);
}

// ---- the found team's card in the standings ------------------------------------------------
// The showGuildFound hook. No scroll: the sheen and ring start when the card comes into view, and
// last 8 s from then; a standings repaint rebuilds the card, and labAfterStandings paints it again.
function labGuildFound(teamId, guildName) {
  if (typeof document.querySelectorAll !== 'function') return false;
  labS.found = { teamId, guildName };
  labDropMark();
  labS.mark = { names: [getTeamName(teamId)], started: 0 };
  labWatchMark();
  return true;
}
// paintGuildFound draws the strip for the guildFound it reads (js/standings.js), and every standings
// repaint draws it again until `until`; the blink it starts is the site's, and the lab's mark stands for it.
function labHangStrip(teamName, guildName) {
  labDropStrip();
  if (!guildName || typeof paintGuildFound !== 'function') return;
  guildFound = { teamName, guildName, until: Date.now() + LAB_MARK_MS };
  const card = paintGuildFound(document, true);
  if (card) card.classList.remove('guild-found-flash');
}
function labDropStrip() {
  if (typeof paintGuildFound !== 'function') return;
  guildFound = null;
  for (const s of document.querySelectorAll('.guild-found-strip')) s.remove();
}
function labMarkCardOf(name) {
  for (const n of document.querySelectorAll('.standing-side .standing-side-name')) {
    if (n.textContent === name) return n.closest('.standing-side');
  }
  return null;
}
function labWatchMark() {
  const m = labS.mark;
  if (!m) return;
  if (labS.watch) { labS.watch.disconnect(); labS.watch = null; }
  if (m.started) { labPaintMark(false); return; }
  const card = labMarkCardOf(m.names[0]);
  if (!card) return;
  if (typeof IntersectionObserver !== 'function') { labStartMark(); return; }
  labS.watch = new IntersectionObserver((list) => {
    if (list.some((e) => e.isIntersecting)) labStartMark();
  }, { threshold: 0.6 });
  labS.watch.observe(card);
}
function labStartMark() {
  if (labS.watch) { labS.watch.disconnect(); labS.watch = null; }
  const m = labS.mark;
  if (!m || m.started) return;
  m.started = Date.now();
  labPaintMark(true);
  labS.markTimer = setTimeout(labDropMark, LAB_MARK_MS);
}
function labPaintMark(fresh) {
  const m = labS.mark;
  if (!m || !m.started || Date.now() - m.started > LAB_MARK_MS) return [];
  const cards = m.names.map(labMarkCardOf).filter(Boolean);
  for (const card of cards) {
    for (const old of card.querySelectorAll('.lab-hl')) old.remove();
    const layer = labEl('span', `lab-hl${fresh ? ' is-fresh' : ''}`);
    layer.setAttribute('aria-hidden', 'true');
    card.appendChild(layer);
  }
  return cards;
}
function labDropMark() {
  clearTimeout(labS.markTimer);
  if (labS.watch) { labS.watch.disconnect(); labS.watch = null; }
  labS.mark = null;
  if (typeof document.querySelectorAll !== 'function') return;
  for (const el of document.querySelectorAll('.lab-hl')) el.remove();
}
// The strike on the team cards at the end of a spotlight: the sheen, the sparks, the 8 s ring from now.
function labStrikeCards(names) {
  labDropMark();
  labS.mark = { names, started: Date.now() };
  for (const card of labPaintMark(true)) labSparksFrom(card);
  labS.markTimer = setTimeout(labDropMark, LAB_MARK_MS);
}

// ---- the tier spotlight ------------------------------------------------------------------------
// The whole tier is brought into view (centred, or its top if it is taller than the screen) and, once
// 60 % of it is in sight, the other tiers of its column dim and it is ringed; then the strike on the cards.
const LAB_SPOT_HIT_MS = 350;
const LAB_SPOT_MS = 2500;
function labGoToTier(names, guild) {
  const card = labMarkCardOf(names[0]);
  const tier = card && card.closest('.standing-match');
  if (!tier) return;
  if (labS.spot) labS.spot.disconnect();
  const h = tier.getBoundingClientRect().height;
  tier.scrollIntoView({ behavior: 'smooth', block: h > window.innerHeight * 0.9 ? 'start' : 'center' });
  if (typeof IntersectionObserver !== 'function') { labPlaySpot(tier, names, guild); return; }
  // A tier taller than the screen never gets 60 % of itself in: then most of the screen will do.
  const need = Math.min(0.6, (window.innerHeight * 0.85) / Math.max(1, h));
  const io = new IntersectionObserver((list) => {
    if (!list.some((e) => e.isIntersecting && e.intersectionRatio >= need - 0.01)) return;
    io.disconnect();
    labS.spot = null;
    labPlaySpot(tier, names, guild);
  }, { threshold: need });
  labS.spot = io;
  io.observe(tier);
}
// The tier's own outline (css/facets.css cuts its corners with a clip-path that would also cut anything
// drawn inside it): a ring of that shape, LAB_RING px thick, laid over the tier from its column.
const LAB_RING = 3;
function labRingPath(w, h) {
  const c = 15;
  const t = LAB_RING;
  return `path(evenodd, 'M${c} 0H${w}V${h - c}L${w - c} ${h}H0V${c}Z M${c + 1} ${t}L${t} ${c + 1}V${h - t}H${w - c - 1}L${w - t} ${h - c - 1}V${t}Z')`;
}
// The guild's strip (the arrow of a found guild) hangs under its team's card before the ring is measured:
// it makes the tier taller, and a ring measured without it would cross it.
function labPlaySpot(tier, names, guild) {
  for (const old of document.querySelectorAll('.lab-spot')) old.remove();
  for (const m of document.querySelectorAll('.lab-dimmed')) m.classList.remove('lab-dimmed');
  if (guild) labHangStrip(names[0], guild);
  const first = labMarkCardOf(names[0]);
  const col = tier.parentElement;
  col.classList.add('lab-spot-col');
  const fx = labEl('span', 'lab-spot');
  fx.setAttribute('aria-hidden', 'true');
  const glow = first ? getComputedStyle(first).getPropertyValue('--side-glow').trim() : '';
  if (glow) fx.style.setProperty('--lab-c', glow);
  const w = tier.offsetWidth + 2 * LAB_RING;
  const h = tier.offsetHeight + 2 * LAB_RING;
  fx.style.left = `${tier.offsetLeft - LAB_RING}px`;
  fx.style.top = `${tier.offsetTop - LAB_RING}px`;
  fx.style.width = `${w}px`;
  fx.style.height = `${h}px`;
  fx.style.setProperty('--lab-ring', labRingPath(w, h));
  fx.appendChild(labEl('span', 'lab-ring'));
  col.appendChild(fx);
  for (const m of col.children) if (m !== tier && m.classList.contains('standing-match')) m.classList.add('lab-dimmed');
  setTimeout(() => labStrikeCards(names), LAB_SPOT_HIT_MS);
  setTimeout(() => {
    fx.remove();
    for (const m of document.querySelectorAll('.lab-dimmed')) m.classList.remove('lab-dimmed');
  }, LAB_SPOT_MS);
}
