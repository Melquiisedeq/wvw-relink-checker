'use strict';
// LAB (never merged). One guild at a time: the lab's field writes into the hidden #guildInput and
// awaits the page's own run() (serial, as ever), then reads what it left: the team from the
// showGuildFound hook, a failure from the results table it fills. The real #runBtn is moved into the
// field's row, so its own busy state and effects stay. Guild names are strangers' text: textContent only.

const LAB_RECENT_KEY = 'wvw-lab-recent-v1';
const LAB_MARK_MS = 8000;
const labS = { found: null, outcome: null, name: '', mark: null, markTimer: 0 };

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

function labBuildSearch() {
  const box = labEl('div', 'ls-search');
  const label = labEl('label', 'ls-label', 'Guild name');
  label.htmlFor = 'labGuild';
  const row = labEl('div', 'ls-row');
  const input = labEl('input', 'ls-input');
  input.id = 'labGuild';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Exactly as in game';
  input.setAttribute('list', 'labGuildList');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); labCheck(input.value); } });
  const dl = labEl('datalist');
  dl.id = 'labGuildList';
  row.append(input, dl);
  // Pressed in the capture phase, before boot.js's own listener on the button would start run() itself.
  row.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#runBtn')) { e.stopPropagation(); e.preventDefault(); labCheck(input.value); }
  }, true);
  const answer = labEl('div', 'ls-answer');
  answer.id = 'labAnswer';
  answer.setAttribute('role', 'status');
  answer.setAttribute('aria-live', 'polite');
  box.append(label, row, answer);
  return box;
}

async function labCheck(raw) {
  const name = String(raw || '').trim();
  if (!name || runBtn.disabled) return;
  labS.name = name;
  labS.found = null;
  labS.mark = null;
  labClearMark();
  labS.outcome = { asking: true };
  labPaintAnswer();
  guildInput.value = name;
  try { await run(); } catch { /* run() said it on statusMsg; read below */ }
  labS.outcome = await labReadOutcome(name);
  if (labS.outcome.ok) labRemember(labS.outcome.guild);
  labPaintAnswer();
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

function labVs(opp) {
  const s = labEl('span', 'ls-vs');
  s.append('vs ');
  opp.forEach((o, k) => {
    if (k) s.append(' and ');
    s.appendChild(labTeamText(o.name, o.color));
  });
  return s;
}
function labPaintAnswer() {
  const box = document.getElementById('labAnswer');
  if (!box) return;
  box.textContent = '';
  const o = labS.outcome;
  const form = labSetup().search;
  box.className = `ls-answer ls-form-${form}`;
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
  const where = o.tier ? `${o.region} · Tier ${o.tier}` : o.region;
  if (form === 'A') {
    const p = labEl('p', 'ls-line');
    p.append(labEl('b', null, o.guild), ' is on ', labTeamText(o.team, o.color || 'none'), ` (${o.region})`);
    if (o.tier) p.append(` · Tier ${o.tier}`);
    if (o.opp.length) p.append(' · ', labVs(o.opp));
    box.appendChild(p);
  } else if (form === 'B') {
    const card = labEl('div', `ls-card ls-card-${o.color || 'none'}`);
    const text = labEl('div', 'ls-card-text');
    const top = labEl('span', 'ls-card-top');
    top.append(labEl('span', 'ls-card-guild', `${o.guild} is on `), labEl('b', 'ls-card-team', o.team));
    const sub = labEl('span', 'ls-card-sub', where);
    if (o.opp.length) sub.append(' · ', labVs(o.opp));
    text.append(top, sub);
    card.appendChild(text);
    const go = labEl('button', 'ls-go');
    go.type = 'button';
    go.setAttribute('aria-label', `Show ${o.team} in the standings and open its live map`);
    go.appendChild(labIcon(['M5 12h14', 'M13 6l6 6-6 6'], 'ls-go-svg'));
    go.addEventListener('click', () => { labScrollToMark(); if (o.matchId) labOpenMap(o.matchId); });
    card.appendChild(go);
    box.appendChild(card);
  } else {
    const p = labEl('p', 'ls-line ls-found');
    p.append('Found: ', labTeamText(o.team, o.color || 'none'), ` (${o.region}${o.tier ? `, Tier ${o.tier}` : ''})`);
    if (o.opp.length) p.append(' · ', labVs(o.opp));
    box.appendChild(p);
  }
}

// ---- the found team's card in the standings ------------------------------------------------
// The showGuildFound hook: the lab paints its own mark (A blinks, B sheen + ring, C "is here").
function labGuildFound(teamId, guildName) {
  if (typeof document.querySelectorAll !== 'function') return false;
  labS.found = { teamId, guildName };
  clearTimeout(labS.markTimer);
  labClearMark();
  labS.mark = { kind: labSetup().mark, teamName: getTeamName(teamId), guildName, until: Date.now() + LAB_MARK_MS };
  const card = labPaintMark(true);
  labS.markTimer = setTimeout(labClearMark, LAB_MARK_MS);
  if (card) labScrollTo(card);
  return true;
}
function labMarkCardOf(name) {
  for (const n of document.querySelectorAll('.standing-side .standing-side-name')) {
    if (n.textContent === name) return n.closest('.standing-side');
  }
  return null;
}
function labPaintMark(fresh) {
  const m = labS.mark;
  if (!m || Date.now() > m.until) return null;
  const card = labMarkCardOf(m.teamName);
  if (!card) return null;
  for (const old of card.querySelectorAll('.lab-hl, .lab-here')) old.remove();
  if (m.kind === 'blink') {
    if (!fresh) return card;
    card.classList.remove('guild-found-flash');
    void card.offsetWidth;
    card.classList.add('guild-found-flash');
    setTimeout(() => card.classList.remove('guild-found-flash'), 2600);
    return card;
  }
  const layer = labEl('span', `lab-hl lab-hl-${m.kind}${fresh ? ' is-fresh' : ''}`);
  layer.setAttribute('aria-hidden', 'true');
  card.appendChild(layer);
  if (m.kind === 'here') {
    card.classList.add('lab-here-card');
    const here = labEl('span', 'lab-here');
    here.append(labEl('b', null, m.guildName), ' is here');
    card.appendChild(here);
  }
  return card;
}
function labClearMark() {
  if (typeof document.querySelectorAll !== 'function') return;
  for (const el of document.querySelectorAll('.lab-hl, .lab-here')) el.remove();
  for (const c of document.querySelectorAll('.lab-here-card')) c.classList.remove('lab-here-card');
  if (labS.mark && Date.now() > labS.mark.until) labS.mark = null;
}
function labScrollTo(card) {
  const b = card.getBoundingClientRect();
  if (b.top >= 0 && b.bottom <= window.innerHeight) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function labScrollToMark() {
  const name = labS.outcome && labS.outcome.team;
  const card = name && labMarkCardOf(name);
  if (card) labScrollTo(card);
}
