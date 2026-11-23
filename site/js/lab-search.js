'use strict';
// LAB (never merged). One guild at a time: the lab's field writes into the hidden #guildInput and
// awaits the page's own run() (serial, as ever), then reads what it left: the team from the
// showGuildFound hook, a failure from the results table it fills. The real #runBtn is moved into the
// bar, so its own busy state and the effects that start from it stay. Nothing scrolls the page by
// itself: the answer card's arrow brings the tier into view. Guild names are strangers' text: textContent only.

const LAB_RECENT_KEY = 'wvw-lab-recent-v1';
const LAB_MARK_MS = 8000;
const labS = { found: null, outcome: null, name: '', mark: null, markTimer: 0, watch: null, spot: null,
  checkAt: 0, brokeAt: 0, veilAt: 0, veilTimer: 0, veiledMs: null };

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
// "Suggestions while typing" fills the <datalist>; "Chips under the bar" shows up to four, and a tap checks again.
function labPaintRecent() {
  const dl = document.getElementById('labGuildList');
  const chips = document.getElementById('labRecent');
  const input = document.getElementById('labGuild');
  if (!dl || !chips || !input) return;
  dl.textContent = '';
  chips.textContent = '';
  const list = labRecent();
  if (labPrefs.recent === 'chips') {
    input.removeAttribute('list');
    for (const n of list.slice(0, 4)) {
      const b = labEl('button', 'ls-recent-chip', n);
      b.type = 'button';
      b.addEventListener('click', () => { input.value = n; labCheck(n); });
      chips.appendChild(b);
    }
    return;
  }
  input.setAttribute('list', 'labGuildList');
  for (const n of list) {
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
  const recent = labEl('div', 'ls-recent');
  recent.id = 'labRecent';
  recent.setAttribute('aria-label', 'Recent guilds');
  const answer = labEl('div', 'ls-answer');
  answer.id = 'labAnswer';
  answer.setAttribute('role', 'status');
  answer.setAttribute('aria-live', 'polite');
  box.append(head, label, bar, recent, answer);
  return box;
}
// Both the Check button and the answer's arrow draw this double chevron, turned by CSS.
const LAB_CHEVRONS = ['M6 7l5 5-5 5', 'M12 7l5 5-5 5'];
let labRunWatch = null;
function labPaintRunBtn() {
  const box = document.querySelector('.ls-search');
  if (!box || typeof runBtn === 'undefined') return;
  const arrow = labPrefs.runBtn === 'arrow';
  box.classList.toggle('ls-run-arrow', arrow);
  if (arrow) runBtn.setAttribute('aria-label', 'Check');
  else runBtn.removeAttribute('aria-label');
  labDressRunBtn();
  if (!labRunWatch && typeof MutationObserver === 'function') {
    labRunWatch = new MutationObserver(labDressRunBtn);
    labRunWatch.observe(runBtn, { childList: true });
  }
}
// run() puts the pips in while it asks and writes "Check" back as text when it ends: the arrow goes back over the word.
function labDressRunBtn() {
  if (runBtn.querySelector('.btn-pips')) return;
  const arrow = labPrefs.runBtn === 'arrow';
  const has = runBtn.querySelector('.ls-run-svg');
  if (arrow && !has) {
    runBtn.textContent = '';
    runBtn.appendChild(labIcon(LAB_CHEVRONS, 'ls-run-svg'));
  }
  if (!arrow && has) runBtn.textContent = 'Check';
}

// "Simple" and "Small shield": no trebuchet, no crest, no shake. run() calls these three by their global names, so for one
// run they are swapped out; the sparks then fly from the answer card (labSparksFrom).
function labQuietFinale() {
  const keep = { startCharge: window.startCharge, playFinale: window.playFinale, sparkFromButton: window.sparkFromButton };
  window.startCharge = () => {};
  window.playFinale = () => {};
  window.sparkFromButton = () => {};
  return () => Object.assign(window, keep);
}
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
  labS.outcome = { asking: true };
  labPaintAnswer();
  guildInput.value = name;
  const fx = labPrefs.effect;
  labS.checkAt = performance.now();
  labS.brokeAt = 0;
  const restore = fx === 'simple' || fx === 'small' ? labQuietFinale() : null;
  try { await run(); } catch { /* run() said it on statusMsg; read below */ }
  if (restore) restore();
  labS.outcome = await labReadOutcome(name);
  if (labS.outcome.ok) labRemember(labS.outcome.guild);
  labPaintAnswer();
  const card = document.querySelector('#labAnswer .ls-ans');
  // Only as far as needed, never centred, and only for the answer: the standings card is never scrolled to.
  const shown = card || document.getElementById('labAnswer');
  if (shown && typeof shown.scrollIntoView === 'function') shown.scrollIntoView({ block: 'nearest' });
  if (!card) return;
  if (fx === 'simple') labHitCard(card);
  if (fx === 'small') labMiniShield(card);
  if (fx === 'split' && !labS.brokeAt) labVeil(card);
}

// The strike on the answer card: the sheen once over it and the sparks flying off it.
function labHitCard(card) {
  card.classList.remove('ls-sheen');
  void card.offsetWidth;
  card.classList.add('ls-sheen');
  labSparksFrom(card);
}
// "Shield splits": the card waits under the crest and shows on the break; without one, at LAB_VEIL_MAX_MS.
const LAB_VEIL_MAX_MS = 2500;
function labVeil(card) {
  card.classList.add('ls-veiled');
  labS.veilAt = performance.now();
  clearTimeout(labS.veilTimer);
  labS.veilTimer = setTimeout(labUnveil, LAB_VEIL_MAX_MS);
}
function labUnveil() {
  clearTimeout(labS.veilTimer);
  const card = document.querySelector('#labAnswer .ls-ans.ls-veiled');
  if (!card) return;
  labS.veiledMs = Math.round(performance.now() - labS.veilAt);
  card.classList.remove('ls-veiled');
  card.classList.add('ls-revealed');
  labHitCard(card);
}
// "Small shield": the header's crest, cloned into the card, cracks and falls in two halves (css/impact.css's cut).
function labMiniShield(card) {
  const crest = document.querySelector('.title-row svg');
  if (!crest) { labHitCard(card); return; }
  const box = labEl('span', 'ls-mini');
  box.setAttribute('aria-hidden', 'true');
  for (const side of ['l', 'r']) {
    const half = labEl('span', `ls-mini-half ls-mini-${side}`);
    const c = crest.cloneNode(true);
    c.removeAttribute('width');
    c.removeAttribute('height');
    half.appendChild(c);
    box.appendChild(half);
  }
  box.appendChild(labEl('span', 'ls-mini-crack'));
  card.appendChild(box);
  setTimeout(() => labHitCard(card), 330);
  setTimeout(() => box.remove(), 900);
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
  el.addEventListener('click', () => labGoToTier([o.team]));
  return el;
}
function labGoButton(o) {
  const pill = labPrefs.arrow === 'pill';
  const go = labGo(labEl('button', pill ? 'ls-go ls-go-pill' : 'ls-go'), o);
  if (pill) go.appendChild(labEl('span', null, 'See in standings'));
  go.appendChild(labIcon(LAB_CHEVRONS, 'ls-go-svg'));
  return go;
}
// The answer: the team's own colour (the standings cards' side-* tint), the tier said loud, the rivals as chips.
function labAnswerCard(o) {
  const card = labEl('div', `ls-ans ls-arrow-${labPrefs.arrow} ls-way-${labTierWay(o)}${o.color ? ` side-${o.color}` : ''}`);
  const name = labEl('div', 'ls-ans-name');
  name.append(labEl('span', 'ls-who', `${o.guild} is on`), labEl('span', 'ls-team', o.team));
  const rivals = labEl('div', 'ls-rivals');
  if (o.opp.length) {
    rivals.appendChild(labEl('span', 'ls-vs', 'vs'));
    for (const r of o.opp) rivals.appendChild(labChip(r));
  }
  const top = labEl('div', 'ls-ans-top');
  top.appendChild(name);
  const chipGo = labPrefs.arrow === 'chip' && o.tier;
  if (o.tier) {
    const tier = chipGo ? labGo(labEl('button', 'ls-tier ls-tier-go'), o) : labEl('span', 'ls-tier');
    tier.append(labEl('b', null, `Tier ${o.tier}`), labEl('span', null, o.region));
    if (chipGo) tier.appendChild(labIcon(LAB_CHEVRONS, 'ls-go-svg'));
    top.appendChild(tier);
  }
  const foot = labEl('div', 'ls-ans-foot');
  foot.appendChild(rivals);
  if (!chipGo && o.tier) foot.appendChild(labGoButton(o));
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
// The trebuchet.js hook, after it aimed the round at the screen's centre: "Aimed", "Shield lands" and
// "Shield splits" move the target to the answer card (or the bar, if the answer is not up yet) and the
// crest with it. The two new ones size the crest to the card and strike the card on the break, FLIGHT_MS on.
function labAimBall(ball, arc, from) {
  const fx = labPrefs.effect;
  if (!['aimed', 'land', 'split'].includes(fx) || typeof document.querySelector !== 'function') return;
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
  if (fx === 'aimed') return;
  // The 200 px stack holds a 178 px tall crest: "lands" a bit under the card's height, "splits" over all of it.
  const want = fx === 'split' ? r.height * 1.25 : r.height * 0.9;
  html.style.setProperty('--lab-as', Math.min(1, Math.max(0.45, want / 178)).toFixed(3));
  setTimeout(labOnBreak, typeof FLIGHT_MS === 'number' ? FLIGHT_MS : 560);
}
function labOnBreak() {
  labS.brokeAt = performance.now();
  const card = document.querySelector('#labAnswer .ls-ans');
  if (!card) return;
  if (card.classList.contains('ls-veiled')) labUnveil();
  else labHitCard(card);
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
// The strike on the team cards at the end of a spotlight: the sheen, the sparks, and the 8 s ring from now.
function labStrikeCards(names) {
  labDropMark();
  labS.mark = { names, started: Date.now() };
  for (const card of labPaintMark(true)) labSparksFrom(card);
  labS.markTimer = setTimeout(labDropMark, LAB_MARK_MS);
}

// ---- the tier spotlight ------------------------------------------------------------------------
// The whole tier is brought into view (centred, or its top if it is taller than the screen) and the
// spotlight starts once 60 % of it is in sight; the strike on the cards comes when it ends.
const LAB_SPOT_HIT_MS = { run: 1100, dim: 350, ring: 950 };
const LAB_SPOT_MS = 2500;
function labGoToTier(names) {
  const card = labMarkCardOf(names[0]);
  const tier = card && card.closest('.standing-match');
  if (!tier) return;
  if (labS.spot) labS.spot.disconnect();
  const h = tier.getBoundingClientRect().height;
  tier.scrollIntoView({ behavior: 'smooth', block: h > window.innerHeight * 0.9 ? 'start' : 'center' });
  if (typeof IntersectionObserver !== 'function') { labPlaySpot(tier, names); return; }
  // A tier taller than the screen never gets 60 % of itself in: then most of the screen will do.
  const need = Math.min(0.6, (window.innerHeight * 0.85) / Math.max(1, h));
  const io = new IntersectionObserver((list) => {
    if (!list.some((e) => e.isIntersecting && e.intersectionRatio >= need - 0.01)) return;
    io.disconnect();
    labS.spot = null;
    labPlaySpot(tier, names);
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
function labRing() {
  return labEl('span', 'lab-ring');
}
function labPlaySpot(tier, names) {
  const kind = labPrefs.spot;
  for (const old of document.querySelectorAll('.lab-spot')) old.remove();
  for (const m of document.querySelectorAll('.lab-dimmed')) m.classList.remove('lab-dimmed');
  const first = labMarkCardOf(names[0]);
  const col = tier.parentElement;
  col.classList.add('lab-spot-col');
  const fx = labEl('span', `lab-spot lab-spot-${kind}`);
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
  const ring = labRing();
  fx.appendChild(ring);
  if (kind === 'run') for (const side of ['t', 'r', 'b', 'l']) ring.appendChild(labEl('i', `lab-run-${side}`));
  if (kind === 'ring') fx.append(labRing(), labRing());
  col.appendChild(fx);
  if (kind === 'dim') {
    for (const m of col.children) if (m !== tier && m.classList.contains('standing-match')) m.classList.add('lab-dimmed');
  }
  setTimeout(() => labStrikeCards(names), LAB_SPOT_HIT_MS[kind]);
  setTimeout(() => {
    fx.remove();
    for (const m of document.querySelectorAll('.lab-dimmed')) m.classList.remove('lab-dimmed');
  }, LAB_SPOT_MS);
}
