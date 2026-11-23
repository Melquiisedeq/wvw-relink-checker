'use strict';
// LAB (never merged). One guild at a time: the lab's field writes into the hidden #guildInput and
// awaits the page's own run() (serial, as ever), then reads what it left: the team from the
// showGuildFound hook, a failure from the results table it fills. The real #runBtn is moved into the
// bar, so its own busy state and the effects that start from it stay. Nothing scrolls the page by
// itself: the answer card's arrow does. Guild names are strangers' text: textContent only.

const LAB_RECENT_KEY = 'wvw-lab-recent-v1';
const LAB_MARK_MS = 8000;
const labS = { found: null, outcome: null, name: '', mark: null, markTimer: 0, watch: null };

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
  // The header's own crest, cloned, for the "Shield button" form: drawn over the button, not redrawn.
  const crest = document.querySelector('.title-row svg');
  if (crest) {
    const c = crest.cloneNode(true);
    c.setAttribute('class', 'ls-crest');
    c.setAttribute('aria-hidden', 'true');
    btnBox.appendChild(c);
  }
  bar.append(labIcon(LAB_LENS, 'ls-in-ic'), input, btnBox, dl);
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
// The bar's form: the button sits at the bar's right end in all three; the shield form names it by aria-label.
function labPaintSearchBar() {
  const box = document.querySelector('.ls-search');
  if (!box) return;
  box.className = `ls-search ls-form-${labPrefs.searchBar}`;
  if (labPrefs.searchBar === 'shield') runBtn.setAttribute('aria-label', 'Find team');
  else runBtn.removeAttribute('aria-label');
}

// "Simple": no trebuchet, no crest, no shake. run() calls these three by their global names, so for one
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
  const restore = labPrefs.effect === 'simple' ? labQuietFinale() : null;
  try { await run(); } catch { /* run() said it on statusMsg; read below */ }
  if (restore) restore();
  labS.outcome = await labReadOutcome(name);
  if (labS.outcome.ok) labRemember(labS.outcome.guild);
  labPaintAnswer();
  const card = document.querySelector('#labAnswer .ls-ans');
  // Only as far as needed, never centred, and only for the answer: the standings card is never scrolled to.
  const shown = card || document.getElementById('labAnswer');
  if (shown && typeof shown.scrollIntoView === 'function') shown.scrollIntoView({ block: 'nearest' });
  if (card && labPrefs.effect === 'simple') {
    card.classList.add('ls-sheen');
    labSparksFrom(card);
  }
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
function labGoButton(o) {
  const go = labEl('button', 'ls-go');
  go.type = 'button';
  go.setAttribute('aria-label', `Show ${o.team} in the standings and open its live map`);
  go.appendChild(labIcon(['M5 12h14', 'M13 6l6 6-6 6'], 'ls-go-svg'));
  go.addEventListener('click', () => { labScrollToTeam(o.team); if (o.matchId) labOpenMap(o.matchId); });
  return go;
}
// The answer: the team's own colour (the standings cards' side-* tint), the tier said loud, the rivals as chips.
function labAnswerCard(o) {
  const form = labPrefs.answer;
  const card = labEl('div', `ls-ans ls-ans-${form}${o.color ? ` side-${o.color}` : ''}`);
  const who = labEl('span', 'ls-who', `${o.guild} is on`);
  const team = labEl('span', 'ls-team', o.team);
  const rivals = labEl('div', 'ls-rivals');
  if (o.opp.length) {
    rivals.appendChild(labEl('span', 'ls-vs', 'vs'));
    for (const r of o.opp) rivals.appendChild(labChip(r));
  }
  if (form === 'banner') {
    const top = labEl('div', 'ls-ans-top');
    const name = labEl('div', 'ls-ans-name');
    name.append(who, team);
    top.appendChild(name);
    if (o.tier) {
      const tier = labEl('span', 'ls-tier');
      tier.append(labEl('b', null, `Tier ${o.tier}`), labEl('span', null, o.region));
      top.appendChild(tier);
    }
    const foot = labEl('div', 'ls-ans-foot');
    foot.append(rivals, labGoButton(o));
    card.append(top, foot);
  } else if (form === 'matchup') {
    const top = labEl('div', 'ls-ans-top');
    top.append(labEl('span', 'ls-where', o.tier ? `${o.region} · Tier ${o.tier}` : o.region), labGoButton(o));
    const row = labEl('div', 'ls-match-row');
    row.append(team, rivals);
    card.append(top, row, labEl('span', 'ls-who ls-who-under', `${o.guild}’s team`));
  } else {
    const num = labEl('div', 'ls-bignum');
    num.append(labEl('span', 'ls-bignum-label', `${o.region} tier`), labEl('b', null, o.tier || '?'));
    const name = labEl('div', 'ls-ans-name');
    name.append(who, team);
    card.append(num, name, labGoButton(o), rivals);
  }
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
// The trebuchet.js hook, after it aimed the round at the screen's centre: "Aimed" moves the target to
// the answer card (or the bar, if the answer is not up yet) and the crest with it.
function labAimBall(ball, arc, from) {
  if (labPrefs.effect !== 'aimed' || typeof document.querySelector !== 'function') return;
  const el = document.querySelector('#labAnswer .ls-ans') || document.querySelector('.ls-bar');
  if (!el) return;
  const r = el.getBoundingClientRect();
  const x = Math.min(window.innerWidth - 70, Math.max(70, r.left + r.width / 2));
  const y = Math.min(window.innerHeight - 70, Math.max(70, r.top + r.height / 2));
  document.documentElement.style.setProperty('--lab-ax', `${Math.round(x)}px`);
  document.documentElement.style.setProperty('--lab-ay', `${Math.round(y)}px`);
  const dx = x - from.x;
  const dy = y - from.y;
  ball.style.setProperty('--dx', `${Math.round(dx)}px`);
  arc.style.setProperty('--dy', `${Math.round(dy)}px`);
  arc.style.setProperty('--rise', `${Math.round(arcRise(dx, dy))}px`);
}

// ---- the found team's card in the standings ------------------------------------------------
// The showGuildFound hook. No scroll: the sheen and ring start when the card comes into view, and
// last 8 s from then; a standings repaint rebuilds the card, and labAfterStandings paints it again.
function labGuildFound(teamId, guildName) {
  if (typeof document.querySelectorAll !== 'function') return false;
  labS.found = { teamId, guildName };
  labDropMark();
  labS.mark = { teamName: getTeamName(teamId), guildName, started: 0 };
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
  const card = labMarkCardOf(m.teamName);
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
  if (!m || !m.started || Date.now() - m.started > LAB_MARK_MS) return null;
  const card = labMarkCardOf(m.teamName);
  if (!card) return null;
  for (const old of card.querySelectorAll('.lab-hl')) old.remove();
  const layer = labEl('span', `lab-hl${fresh ? ' is-fresh' : ''}`);
  layer.setAttribute('aria-hidden', 'true');
  card.appendChild(layer);
  return card;
}
function labDropMark() {
  clearTimeout(labS.markTimer);
  if (labS.watch) { labS.watch.disconnect(); labS.watch = null; }
  labS.mark = null;
  if (typeof document.querySelectorAll !== 'function') return;
  for (const el of document.querySelectorAll('.lab-hl')) el.remove();
}
function labScrollToTeam(name) {
  const card = name && labMarkCardOf(name);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
