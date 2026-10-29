'use strict';
// Standings: loading the live match data for both regions and rendering one side of a tier (score, VP, activity, change flashes).

// Grey blocks in the shape of the real thing while the first request is in
// flight, so the rails keep their eventual shape.
function showStandingsSkeleton(gridEl) {
  gridEl.textContent = '';
  for (let i = 0; i < 3; i++) {
    const box = document.createElement('div');
    box.className = 'skel-match';
    const title = document.createElement('div');
    title.className = 'skel skel-title';
    box.appendChild(title);
    for (let r = 0; r < 3; r++) {
      const row = document.createElement('div');
      row.className = 'skel skel-row';
      box.appendChild(row);
    }
    gridEl.appendChild(box);
  }
}

// Last VP / skirmish per side, so a background refresh can highlight what
// actually moved. Keyed by match and colour, not kept on the cards: a card
// built again (renderStandingsRegion) has to compare against the one it replaces.
const prevSideStats = new Map(); // `${matchId}:${color}` -> { vp, skirmish, pct }

// Dropped the moment a tier's week ends, so the first refresh of the new one has
// nothing to compare against: kept, it would measure a fresh zero against last
// week's closing figures and float a huge negative delta over every side.
function forgetSideStats(matchId) {
  for (const color of COLORS) prevSideStats.delete(`${matchId}:${color}`);
}

// The tier a team of last week's line-up plays in this week, when this page
// holds that match live: on a relink night the API serves tiers from both
// weeks, and the team would otherwise stand in two tiers at once.
function newerTierOfTeam(match, teamId) {
  const region = match.id.split('-')[0];
  const start = Date.parse(match.start_time);
  for (const m of matchDataCache.values()) {
    if (m.id === match.id || !m.id.startsWith(`${region}-`) || !matchIsLive(m)) continue;
    if (Date.parse(m.start_time) > start && colorForTeam(m, teamId)) return m.id.split('-')[1];
  }
  return null;
}

// Every team the page knows in a region: the fixed table plus whatever the
// cached bodies name (one body per tier, so the bodies alone fall short).
// Table ids are 1 + region (NA 11xxx, EU 12xxx).
function regionTeamIds(regionCode) {
  const ids = new Set(Object.keys(TEAM_NAMES).filter((id) => id.startsWith(`1${regionCode}`)));
  for (const m of matchDataCache.values()) {
    if (!m.id.startsWith(`${regionCode}-`)) continue;
    for (const color of COLORS) {
      const teamId = matchTeamId(m, color);
      if (teamId) ids.add(teamId);
    }
  }
  return ids;
}

// With exactly one tier still on last week and the rest live on the new one,
// the teams left over are the late tier's line-up. Only when the sum closes:
// every team of the region is 3 per tier and exactly 3 are left. A table
// with an extra or a missing team breaks the count, so it gives null too.
function deduceLineup(matches, allTeams, tierCount) {
  const live = matches.filter(matchIsLive);
  const newest = Math.max(...live.map((m) => Date.parse(m.start_time)));
  const late = matches.filter((m) => !matchIsLive(m) || Date.parse(m.start_time) < newest);
  if (!live.length || late.length !== 1 || allTeams.size !== 3 * tierCount) return null;
  const taken = new Set();
  for (const m of matches) {
    if (m === late[0]) continue;
    for (const color of COLORS) taken.add(matchTeamId(m, color));
  }
  const left = [...allTeams].filter((id) => !taken.has(id));
  if (left.length !== 3) return null;
  left.sort((a, b) => getTeamName(a).localeCompare(getTeamName(b)));
  const [red, blue, green] = left.map((id) => [Number(id)]);
  return { id: late[0].id, lineupOnly: true, all_worlds: { red, blue, green } };
}

// A tier between weeks still has to be usable for looking up who plays on a
// server: team names survive a relink, only which three are matched together
// does not.
//
// Dropped is everything that would read as a standing: rank, colour, victory
// points, the stats line, the bar. `yoursByColor` comes only from the match
// panel, where saying which of the three is yours is the point.
//
// A line-up only (match.lineupOnly: deduced, or from this browser's memory)
// is this week's, not last week's: same rows, its own line.
const LINEUP_NOTE = "This week's line-up \u00b7 scores not in yet";

function buildStandingsStale(match, yoursByColor) {
  const wrap = document.createElement('div');
  const isNA = match.id.startsWith('1-');
  for (const color of COLORS) {
    const teamId = matchTeamId(match, color);
    if (!teamId) continue;
    const name = getTeamName(teamId);
    const row = document.createElement('div');
    row.className = 'standing-stale';
    const label = document.createElement('span');
    label.className = 'standing-side-name';
    label.textContent = name;
    row.appendChild(label);
    const tier = match.lineupOnly ? null : newerTierOfTeam(match, teamId);
    if (tier) {
      const moved = document.createElement('span');
      moved.className = 'standing-moved';
      moved.textContent = `\u2192 Tier ${tier}`;
      moved.title = `This week: Tier ${tier}`;
      row.appendChild(moved);
    }
    // Same rule as everywhere else: the community sheet is NA only.
    if (isNA) row.appendChild(buildServerGuildsButton(name));
    const yours = (yoursByColor && yoursByColor[color]) || [];
    if (yours.length) {
      row.classList.add('is-yours');
      const pin = document.createElement('span');
      pin.className = 'pin-badge';
      pin.textContent = `📍 ${yours.join(', ')}`;
      row.appendChild(pin);
    }
    wrap.appendChild(row);
  }
  const note = document.createElement('p');
  note.className = 'standings-waiting';
  note.textContent = match.lineupOnly ? LINEUP_NOTE : "Last week's line-up \u00b7 waiting on the API";
  wrap.appendChild(note);
  return wrap;
}

// The numbers that changed in this repaint, flashed together by flashChanges.
const pendingFlashes = []; // [valueEl, delta]

// Flashes each number that just changed, pulses its card at the edge so a
// change registers off-centre, and floats the delta above it. All at once: a
// class removed and added again restarts its animation only across a layout,
// so they share one layout.
function flashChanges() {
  const list = pendingFlashes.splice(0).filter(([, delta]) => Number.isFinite(delta));
  if (!list.length) return;
  const sides = new Set(list.map(([el]) => el.closest('.standing-side')).filter(Boolean));
  let restart = false;
  for (const [el] of list) if (el.classList.contains('value-changed')) { el.classList.remove('value-changed'); restart = true; }
  for (const s of sides) if (s.classList.contains('side-pulse')) { s.classList.remove('side-pulse'); restart = true; }
  if (restart) void document.body.offsetWidth; // restart the animations from zero
  for (const [el] of list) el.classList.add('value-changed');
  for (const s of sides) s.classList.add('side-pulse');

  // Deferred a frame: showRegion hangs the guild-found strip after this, which
  // moves the cards below it. The delta is parked on <body> at the value's
  // screen position, because the card clips its own chamfered corners and
  // would shear it off. Every position is read before any delta is added, so
  // the page is laid out once.
  requestAnimationFrame(() => {
    const rects = list.map(([el]) => el.getBoundingClientRect());
    list.forEach(([, delta], i) => {
      const rect = rects[i];
      if (rect.width === 0 && rect.height === 0) return; // never made it onto the page
      const tag = document.createElement('span');
      tag.className = delta > 0 ? 'delta delta-up' : 'delta delta-down';
      tag.textContent = `${delta > 0 ? '+' : ''}${delta.toLocaleString()}`;
      tag.style.left = `${rect.left + rect.width / 2}px`;
      tag.style.top = `${rect.top - 4}px`;
      document.body.appendChild(tag);
      setTimeout(() => tag.remove(), 1700);
    });
  });
}

// A card outlives its flash, so the flash's classes go when it ends: the next
// repaint flashes only what changed then.
document.addEventListener('animationend', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (e.animationName === 'value-flash') t.classList.remove('value-changed');
  else if (e.animationName === 'side-pulse') t.classList.remove('side-pulse');
});

// After a guild search: the card of the team the first guild landed on blinks
// three times, the page scrolls to it, and a strip hangs from its lower edge
// with the guild's name for a few seconds. A refresh can build the cards
// again or move them, so what was found is kept here and painted again after
// every refresh (without the blink) until the time runs out.
const GUILD_FOUND_MS = 8000;
const GUILD_FOUND_FLASH_MS = 2600;
let guildFound = null; // { teamName, guildName, until }

function paintGuildFound(root, fresh) {
  if (!guildFound) return null;
  const left = guildFound.until - Date.now();
  if (left <= 0) { guildFound = null; return null; }
  let card = null;
  for (const n of root.querySelectorAll('.standing-side .standing-side-name')) {
    if (n.textContent === guildFound.teamName) { card = n.closest('.standing-side'); break; }
  }
  if (!card) return null;
  const next = card.nextElementSibling;
  if (next && next.classList.contains('guild-found-strip')) next.remove();
  const color = COLORS.find((c) => card.classList.contains(`side-${c}`)) || 'blue';
  const strip = document.createElement('div');
  strip.className = `guild-found-strip side-${color}`;
  if (!fresh) strip.classList.add('is-settled');
  const who = document.createElement('span');
  who.className = 'guild-found-name';
  who.textContent = guildFound.guildName;
  const note = document.createElement('span');
  note.className = 'guild-found-note';
  note.textContent = ' \u00b7 from your search';
  strip.append(who, note);
  card.after(strip);
  if (fresh) {
    card.classList.remove('guild-found-flash');
    void card.offsetWidth; // restart the blink
    card.classList.add('guild-found-flash');
    setTimeout(() => card.classList.remove('guild-found-flash'), GUILD_FOUND_FLASH_MS);
  }
  setTimeout(() => {
    strip.classList.add('is-leaving');
    setTimeout(() => strip.remove(), 300);
  }, left);
  return card;
}

// Called once, by the search, with the team and guild it chose.
function showGuildFound(teamId, guildName) {
  guildFound = { teamName: getTeamName(teamId), guildName, until: Date.now() + GUILD_FOUND_MS };
  const card = paintGuildFound(document, true);
  if (!card) return;
  const b = card.getBoundingClientRect();
  if (b.top >= 0 && b.bottom <= window.innerHeight) return;
  // The visitor wins: a wheel, a touch, a key or a click while the page is
  // still travelling stops it where it is and gives the scroll back.
  const yield_ = () => {
    window.scrollTo({ top: window.scrollY, behavior: 'instant' });
    drop();
  };
  const types = ['wheel', 'touchstart', 'keydown', 'mousedown'];
  const drop = () => types.forEach((t) => window.removeEventListener(t, yield_));
  types.forEach((t) => window.addEventListener(t, yield_, { passive: true }));
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if ('onscrollend' in window) window.addEventListener('scrollend', drop, { once: true });
  setTimeout(drop, 2000);
}

const RESET_NOTE = 'Weekly reset \u00b7 new matchups arriving';

// Shows the pulsing live-dot next to the synced time on success; plain
// text (no dot) for loading/error states.
// A dot already there keeps pulsing: only the time changes.
function setStandingsStatus(el, synced, text) {
  clearRetryAlert(el);
  const [had, time] = el.childNodes;
  if (synced && el.childNodes.length === 2 && had.classList?.contains('live-dot') && time.nodeType === Node.TEXT_NODE) {
    if (time.nodeValue !== text) time.nodeValue = text;
    return;
  }
  el.textContent = '';
  if (!synced) { el.textContent = text; return; }
  const dot = document.createElement('span');
  dot.className = 'live-dot';
  dot.title = 'Checks for new standings every half minute or so while you use the page';
  el.appendChild(dot);
  el.appendChild(document.createTextNode(text));
}

// The shimmer only stands in for an answer that has not arrived; a failed one has
// arrived, and would shimmer behind the error line for as long as the tab is open.
function clearSkeleton(gridEl) {
  if (gridEl.querySelector('.skel-match')) gridEl.textContent = '';
}

// One region onto the page. A region that failed keeps whatever it last rendered:
// last refresh's standings are still the standings. The first load is the
// exception, because what is up then is the skeleton.
function showRegion(gridEl, statusEl, matches, label, syncedAt, failed) {
  const resetting = regionResetting(label, Date.now());
  if (matches && (matches.length || !resetting)) {
    renderStandingsRegion(gridEl, matches);
    paintGuildFound(gridEl, false);
  } else clearSkeleton(gridEl);
  const ok = !!matches && matches.length > 0;
  if (ok) return setStandingsStatus(statusEl, true, syncedAt);
  // null is a request that failed, and it will be asked again (below);
  // [] is an answer with nothing in it, which asking again does not change.
  // In the minutes after the region's reset either is the game's API not yet
  // having the new week: both are asked again, and an empty answer leaves
  // the table up as a failure does.
  if ((matches === null || resetting) && failed) failed.push({ el: statusEl, label: `${label} standings`, region: label });
  else setStandingsStatus(statusEl, false, `Couldn't load ${label} standings.`);
}

// The fallback when the one request fails: the id list, then one request
// per region, the answers kept apart all the way down. null means that
// region's request failed; [] means it answered and has no matches.
// Collapsing the two lets one region take the other down: Promise.all rejects
// whole, so a single 500 on EU would throw away an NA answer already arrived.
async function loadStandingsByRegion() {
  const idList = await fetchJson(`${API_BASE}/wvw/matches`);
  if (!Array.isArray(idList) || idList.length === 0) {
    throw new Error('No active matches returned');
  }

  const naIds = idList.filter((id) => id.startsWith('1-'));
  const euIds = idList.filter((id) => id.startsWith('2-'));

  const fetchRegion = async (ids, region) => {
    if (ids.length === 0) return [];
    const data = await fetchMatches(`${API_BASE}/wvw/matches?ids=${ids.map(encodeURIComponent).join(',')}`,
      REQUEST_TIMEOUT_MS, [region]);
    return Array.isArray(data) ? data : [];
  };

  const [naMatches, euMatches] = await Promise.all([
    fetchRegion(naIds, '1').catch(() => null),
    fetchRegion(euIds, '2').catch(() => null),
  ]);
  return [idList, naMatches, euMatches];
}

// Puts the column js/region.js chose on the left in the DOM, not only on
// screen: CSS order moves what is seen, while Tab and a screen reader
// follow the source. The two asides and their left/right classes swap in
// one step and the pre-paint override in css/layout.css switches off with them.
function placeRails() {
  const na = standingsGridNA.closest('.rail');
  const eu = standingsGridEU.closest('.rail');
  const [first, second] = railFirst() === 'eu' ? [eu, na] : [na, eu];
  if (first.nextElementSibling !== second) first.parentNode.insertBefore(first, second);
  first.classList.replace('rail-right', 'rail-left');
  second.classList.replace('rail-left', 'rail-right');
  document.documentElement.classList.add('rails-placed');
}

// The swap button: the other column first, remembered for next time. A
// popover open on the old side would be left pointing at a column that
// moved, so it closes first; the button moves with its column and loses
// focus on the way, so it gets it back.
//
// Everything that swapped slides to its new place - the two columns and
// the NA / EU halves of the relink bar (FLIP: read before and after
// the move, then animated back from where each was). The columns pass under the
// centre column, shrinking and fading at the crossing so the text there stays
// readable. Not View Transitions: capturing columns this tall freezes the page
// before anything moves.
const SWAP_MS = 650;
const SWAP_EASE = 'cubic-bezier(.45, 0, .2, 1)';

// The relink bar's region labels and countdowns, keyed so the same half
// can be found again after updateRelinkBanner rebuilds them.
function bannerHalves() {
  const out = new Map();
  let region = null;
  for (const el of relinkBanner.querySelectorAll('.region, .time')) {
    if (el.classList.contains('region')) {
      region = el.textContent.trim();
      if (region === 'NA' || region === 'EU') out.set(region, el);
    } else {
      out.set(region + ' time', el);
    }
  }
  return out;
}

function swapRails(btn) {
  if (activePopover) closePopover();
  const rails = [...document.querySelectorAll('.rail')];
  const railsWere = new Map(rails.map((r) => [r, r.getBoundingClientRect()]));
  const halvesWere = new Map([...bannerHalves()].map(([k, el]) => [k, el.getBoundingClientRect()]));

  const next = railFirst() === 'eu' ? 'na' : 'eu';
  document.documentElement.dataset.railFirst = next;
  try { localStorage.setItem(RAIL_FIRST_KEY, next); } catch {}
  placeRails();
  updateRelinkBanner();
  btn.focus({ preventScroll: true });

  for (const r of rails) {
    const was = railsWere.get(r);
    const now = r.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (!dx && !dy) continue;
    r.classList.add('is-swapping');
    // Linear time, eased per step: the fade has to cover the whole middle stretch
    // of the path; one easing over the run bunches the travel into the first
    // frames, still opaque over the centre's text.
    r.animate([
      { transform: `translate(${dx}px, ${dy}px)`, opacity: 1, easing: 'ease-in' },
      { transform: `translate(${dx * .7}px, ${dy * .7}px) scale(.92)`, opacity: .08, offset: .3 },
      { transform: `translate(${dx * .3}px, ${dy * .3}px) scale(.92)`, opacity: .08, offset: .7, easing: 'ease-out' },
      { transform: 'none', opacity: 1 },
    ], { duration: SWAP_MS }).finished.finally(() => r.classList.remove('is-swapping'));
  }
  for (const [key, el] of bannerHalves()) {
    const was = halvesWere.get(key);
    if (!was) continue;
    const dx = was.left - el.getBoundingClientRect().left;
    if (!dx) continue;
    // The halves cross on one line, so one rises and the other dips as they pass.
    const lift = dx > 0 ? -7 : 7;
    el.classList.add('is-swapping');
    el.animate([
      { transform: `translateX(${dx}px)`, opacity: 1 },
      { transform: `translate(${dx / 2}px, ${lift}px)`, opacity: .35, offset: .5 },
      { transform: 'none', opacity: 1 },
    ], { duration: SWAP_MS, easing: SWAP_EASE })
      .finished.finally(() => el.classList.remove('is-swapping'));
  }
}

// Every match of both regions in one request - the one index.html
// preloads, so the first load usually finds it already here. null when it
// fails, and then loadStandings asks region by region instead.
async function fetchAllMatches(timeoutMs) {
  try {
    const all = await fetchMatches(`${API_BASE}/wvw/matches?ids=all`, timeoutMs, ['1', '2']);
    const ok = Array.isArray(all) ? all.filter((m) => m && typeof m.id === 'string') : [];
    return ok.length > 0 ? ok : null;
  } catch {
    return null;
  }
}

// ---- After a failed load ---------------------------------------------
// A failed load is asked again twice, soon, each at a random moment inside
// its window (STANDINGS_RETRY_WINDOWS_MS), then left to the 5-minute cycle.
// The message says so, with the seconds counting, and a button asks now.
// A load that works clears the count. Never decided by navigator.onLine or
// navigator.connection: one is only a hint, the other is missing in Safari
// and Firefox.
let standingsEverLoaded = false;   // the long deadline is for the first one only
let standingsInFlight = false;
let standingsExtraUsed = 0;        // extra tries spent since the last cycle load
let standingsFailed = [];          // { el, label } of what the last load left unloaded
let standingsRetry = null;         // { timer, tick } while an extra try is waiting

function cancelStandingsRetry() {
  if (!standingsRetry) return;
  clearTimeout(standingsRetry.timer);
  clearInterval(standingsRetry.tick);
  standingsRetry = null;
}

// The status line with its button. Built once per element and then only its
// text changes, so a keyboard user's focus survives the countdown. The
// visible words are aria-hidden and the live region gets a steady sentence:
// a number changing every second would be read out every second.
// The "Try again" button, here and in the guild search: the reload arrow
// (drawn inline like the site's other icons) and the words.
function buildRetryButton(onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'retry-btn';
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
  btn.appendChild(document.createTextNode('Try again'));
  btn.addEventListener('click', onClick);
  return btn;
}

function retryAlertOf(statusEl) {
  return statusEl.closest('.standings-card').querySelector('.standings-alert');
}
function clearRetryAlert(statusEl) {
  retryAlertOf(statusEl).textContent = '';
}

function paintRetryStatus(statusEl, spoken, visible, busy, calm) {
  const el = retryAlertOf(statusEl);
  statusEl.textContent = '';
  let btn = el.querySelector('.retry-btn');
  if (!btn) {
    const msg = document.createElement('span');
    const spin = document.createElement('span');
    spin.className = 'spinner';
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    const vis = document.createElement('span');
    vis.className = 'retry-vis';
    vis.setAttribute('aria-hidden', 'true');
    msg.append(spin, sr, vis);
    btn = buildRetryButton(retryStandingsNow);
    el.append(msg, btn);
  }
  const sr = el.querySelector('.sr-only');
  const vis = el.querySelector('.retry-vis');
  if (sr.textContent !== spoken) sr.textContent = spoken;
  if (vis.textContent !== visible) vis.textContent = visible;
  el.querySelector('.spinner').style.display = busy ? '' : 'none';
  btn.setAttribute('aria-disabled', busy ? 'true' : 'false');
  btn.style.display = calm ? 'none' : '';
}

function planStandingsRetry() {
  const paint = (spoken, visible) => {
    for (const f of standingsFailed) {
      if (f.region && regionResetting(f.region, Date.now())) paintRetryStatus(f.el, RESET_NOTE, RESET_NOTE, false, true);
      else paintRetryStatus(f.el, spoken, visible, false);
    }
  };
  if (standingsExtraUsed >= STANDINGS_RETRY_WINDOWS_MS.length) {
    for (const f of standingsFailed) {
      const text = f.region && regionResetting(f.region, Date.now())
        ? RESET_NOTE : `Couldn't load ${f.label}. It will try again in a few minutes.`;
      paintRetryStatus(f.el, text, text, false, text === RESET_NOTE);
    }
    return;
  }
  const [lo, hi] = STANDINGS_RETRY_WINDOWS_MS[standingsExtraUsed];
  const ms = lo + Math.random() * (hi - lo);
  let left = Math.ceil(ms / 1000);
  const spoken = "Couldn't load the standings. Trying again shortly.";
  const show = () => paint(spoken, `Couldn't load standings. Trying again in ${left} s…`);
  show();
  standingsRetry = {
    // A popover open is being read, and a load takes its anchor down; the
    // try waits for it, without counting.
    timer: setTimeout(function fire() {
      if (activeTrigger) standingsRetry.timer = setTimeout(fire, 5000);
      else retryStandingsNow();
    }, ms),
    tick: setInterval(() => { if (left > 1) { left--; show(); } }, 1000),
  };
}

// The button, and the timer when it runs out. Nothing while a load is in
// the air. Pressed while an extra try is waiting, it takes that try's place;
// pressed after the last one, it is a single try of its own.
function retryStandingsNow() {
  if (standingsInFlight) return;
  loadStandings(standingsRetry ? 'retry' : 'manual');
}

// Loads every active match (NA + EU) and powers the standings rails.
// Results are cached, so a later guild check reuses them.
async function loadStandings(origin = 'cycle') {
  // One load at a time, whoever asks: the 5-minute cycle, an extra try or the
  // button. A second request now would only race the first.
  if (standingsInFlight) return;
  standingsInFlight = true;
  const failed = [];
  cancelStandingsRetry();
  if (origin === 'cycle') standingsExtraUsed = 0;
  else if (origin === 'retry') standingsExtraUsed++;
  for (const f of standingsFailed) paintRetryStatus(f.el, 'Trying again.', 'Trying again…', true,
    f.region && regionResetting(f.region, Date.now()));
  // The first load waits longer than a refresh: on a slow line the whole
  // body takes a while, and a refresh has the old table to fall back on.
  const timeoutMs = standingsEverLoaded ? REQUEST_TIMEOUT_MS : SLOW_REQUEST_TIMEOUT_MS;
  try {
    const asked = Date.now();
    let idList, naMatches, euMatches;
    // A load the peek asked for reads /api when the summary is ahead, and not
    // the game's ~97 KB again; with nothing newer in hand it leaves the board be.
    let all = origin === 'peek' ? await latestBoard(peekCopy) : await fetchAllMatches(timeoutMs);
    if (!all && origin === 'peek') return;
    if (!all) {
      try {
        [idList, naMatches, euMatches] = await loadStandingsByRegion();
      } catch (err) {
        all = await copyBoard(err);
      }
    }
    if (all) {
      idList = all.map((m) => m.id);
      naMatches = all.filter((m) => m.id.startsWith('1-'));
      euMatches = all.filter((m) => m.id.startsWith('2-'));
    }
    const answered = [...(naMatches || []), ...(euMatches || [])];

    // Every refresh leaves a kills/deaths snapshot behind: nothing waits on it and
    // nothing extra is fetched, and the maps popover can say which map is busy the
    // moment it opens. See the fight log in js/maps-early.js, which keeps only bodies
    // whose score rose since `asked`.
    recordFightSamples(answered, asked);

    // Forget matches that no longer exist. IDs are stable week to week, so this
    // only bites when a region loses a tier: a leftover "1-4" would keep
    // getMaxTierForRegion answering 4 and give tier 3's bottom side a relegation
    // arrow. A tier missing from the list was read again by id (fetchMatches);
    // only one missing from that read too is forgotten.
    const liveIds = new Set([...idList, ...answered.filter((m) => m && typeof m.id === 'string').map((m) => m.id)]);
    for (const id of [...matchDataCache.keys()]) {
      if (!liveIds.has(id)) matchDataCache.delete(id);
    }
    for (const [teamId, matchId] of [...teamToMatchId]) {
      if (!liveIds.has(matchId)) teamToMatchId.delete(teamId);
    }

    for (const match of answered) {
      if (!match || typeof match.id !== 'string' || typeof match.all_worlds !== 'object') continue;
      matchDataCache.set(match.id, match);
      for (const color of COLORS) {
        const teamId = matchTeamId(match, color);
        if (!teamId) continue;
        // A mixed list holds the same team in last week's tier and this
        // week's: the newer week keeps the team, whatever the list order.
        const had = matchDataCache.get(teamToMatchId.get(teamId));
        if (!had || had.id === match.id || matchReplaces(match, had)) teamToMatchId.set(teamId, match.id);
      }
    }

    updateRelinkFromMatches(naMatches, euMatches);
    const syncedAt = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    if (answered.length > 0) standingsEverLoaded = true;
    showRegion(standingsGridNA, standingsStatusNA, naMatches, 'NA', syncedAt, failed);
    showRegion(standingsGridEU, standingsStatusEU, euMatches, 'EU', syncedAt, failed);
    primeMapBadges();
  } catch {
    // The id list itself failed, so nothing is said about either region: what is on
    // screen stays. Only a skeleton has to go, for the reason in showRegion.
    clearSkeleton(standingsGridNA);
    clearSkeleton(standingsGridEU);
    failed.push({ el: standingsStatusNA, label: 'live standings', region: 'NA' },
      { el: standingsStatusEU, label: 'live standings', region: 'EU' });
  } finally {
    standingsInFlight = false;
  }
  standingsFailed = failed;
  if (failed.length) planStandingsRetry();
  else standingsExtraUsed = 0;
  if (standingsSkipped) setTimeout(readOwed, 0);
}

// Between the five-minute refreshes, the readers' summary (~0.2 KB on the
// wire, kept 15 s by Cloudflare) is read while the tab is visible: every
// PEEK_MS while the visitor is using the page, doubling to PEEK_IDLE_MAX_MS
// while not (the readers move every minute, so "it moved" would never let it
// slow down); never under PEEK_SAVE_MS less a few seconds with Save-Data on.
// Once a summary has been read the delay is spent to land PEEK_AFTER_MS after
// the newest `at` it gave, a whole number of minutes on (see peekWait): the
// readers write once a minute and /api shows it only after the cache and the
// way to the database; a moved minute mark is followed. Hidden, it stops; it
// runs at once when the tab comes back,
// when a popover closes and on the first input after an idle stretch. A live
// match /api holds further along than the one on show, which has not risen
// here for PEEK_BEHIND_MS, loads the board from /api/latest; a body in hand
// further along than the one on show loads it from what is in hand. With a
// popover open the board cannot load (it would take the popover's anchor
// down), so the numbers come when the popover closes; an open map whose match
// the summary shows ahead reads at once (mapAhead, js/popover.js).
const PEEK_MS = 30 * 1000;
const PEEK_IDLE_MAX_MS = 120 * 1000;
const PEEK_SAVE_MS = 60 * 1000;
const PEEK_ACTIVE_MS = 2 * 60 * 1000;   // input this recent counts as using the page
const PEEK_BEHIND_MS = 30 * 1000;
const PEEK_AFTER_MS = 25 * 1000;
const PEEK_RETRY_MS = 10 * 1000;   // an aligned peek that saw no newer `at` (a clock ahead of the server's) asks once more
let peekStill = false;          // the last peek read a summary whose newest `at` had not moved
let peekAligned = false;        // the peek now due was armed by peekWait, not by a show or an input
let peekLoadedAt = 0;           // a load the peek asked for: one per PEEK_BEHIND_MS, if /api fails
let peekCopy = false;           // that load asks /api/latest: the summary is ahead of a body on show
let peekTimer = null;
let peekDelay = PEEK_MS;
let peekAt = 0;                 // when the last peek ran
let peekAnchor = 0;             // ms: the newest `at` in the last summary read (server time)
let inputAt = Date.now();

const peekFloor = () => (navigator.connection?.saveData === true ? PEEK_SAVE_MS : PEEK_MS);

// The board as this page holds it: each body on show, or the further-along
// one in hand, after what /api/latest gave when `copy` asks for it. Null when
// the copy gave nothing and nothing in hand is further along.
async function latestBoard(copy) {
  const shown = [...matchDataCache.values()];
  const reading = copy && shown.length ? startLatest() : null;
  const bodies = reading ? await reading : [];
  offerLatest(bodies);
  const board = shown.map((m) => (newestMatches.has(m.id) ? newestMatches.get(m.id).match : m));
  if (!bodies.length && board.every((m, i) => m === shown[i])) return null;
  return board.sort((a, b) => byId(a.id, b.id));
}

// The game's reads failed (the visitor's server group down, or the IP
// refused): our copy draws the board when one of its bodies rose within
// HUD_STALE_MS, by its own `at`. A copy empty, down or stopped throws `err`,
// and the failure stands.
async function copyBoard(err) {
  const shown = [...matchDataCache.values()];
  const reading = shown.length ? startLatest() : null;
  const bodies = reading ? await reading : [];
  offerLatest(bodies);
  const now = Date.now();
  if (!bodies.some((b) => now - (latestBodyAt.get(b) || 0) <= HUD_STALE_MS)) throw err;
  return shown.map((m) => (newestMatches.has(m.id) ? newestMatches.get(m.id).match : m)).sort((a, b) => byId(a.id, b.id));
}

// The newest `at` of a summary in ms, 0 when none is a number.
function summaryAt(sum) {
  let newest = 0;
  for (const e of Object.values(sum)) {
    const at = e && typeof e === 'object' ? e.at * 1000 : NaN;
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest;
}

// Ms until the next peek, from `now`: the last aligned moment within `delay`,
// or the one a minute on when that is under the floor away (5 s of slack, for
// a read that took a while). Never zero, so a skipped peek cannot spin.
function peekWait(delay, now) {
  if (!peekAnchor) return delay;
  const base = peekAnchor + PEEK_AFTER_MS;
  let t = base + Math.floor((now + delay - base) / 60000) * 60000;
  if (t < now + peekFloor() - 5000) t += 60000;
  return t - now;
}

// An aligned peek that read no newer `at` (a clock ahead of the server's) is
// followed by one more after PEEK_RETRY_MS, never under Save-Data; that one is
// not aligned, so it is not followed in turn. The timer alone reads two a minute
// at most on average (an aligned read and its retry per minute mark); a show or
// an input adds a read, never within the floor of the last.
function peekNext(delay, now) {
  if (peekStill && peekAligned && peekFloor() === PEEK_MS) { peekAligned = false; return PEEK_RETRY_MS; }
  peekAligned = peekAnchor > 0;
  return peekWait(delay, now);
}

// What a summary teaches: the newest `at`, and whether it moved.
function peekLearn(sum) {
  const newest = summaryAt(sum);
  if (!newest) return;
  peekStill = peekAnchor > 0 && newest <= peekAnchor;
  peekAnchor = newest;
}

async function peekLatest() {
  if (standingsInFlight || document.visibilityState === 'hidden' || standingsFailed.length) return;
  peekAt = Date.now();
  peekStill = false;
  let sum;
  try { sum = await fetchOwnApi(LATEST_SUMMARY_URL, 'no-store'); } catch { return; }
  if (!sum || typeof sum !== 'object') return;
  const now = Date.now();
  peekLearn(sum);
  latestSummaryLearn(sum);
  const copied = new Set();   // live matches our copy holds further along than this page
  let inHand = false;         // a body in hand (the open map, or an answer past LATEST_WAIT_MS) the list does not draw yet
  for (const [id, k] of newestMatches) {
    if (!matchIsLive(k.match)) continue;
    const drawn = matchDataCache.get(id);
    if (drawn && drawn.start_time === k.match.start_time
      && colorSum(k.match.scores) > colorSum(drawn.scores)) inHand = true;
    if (summaryAhead(k.match)) copied.add(id);
  }
  if (copied.size && mapAhead) mapAhead(copied);
  const behind = [...copied].some((id) => now - newestMatches.get(id).at >= PEEK_BEHIND_MS);
  if (!inHand && !behind) return;
  if (activeTrigger || standingsInFlight || now - peekLoadedAt < PEEK_BEHIND_MS) return;
  peekLoadedAt = now;
  peekCopy = behind;
  await loadStandings('peek');
}

async function runPeek() {
  peekTimer = null;
  if (document.visibilityState === 'hidden') return;
  await peekLatest();
  const floor = peekFloor();
  const using = Date.now() - inputAt < PEEK_ACTIVE_MS || !!activeTrigger;
  peekDelay = using ? floor : Math.min(Math.max(peekDelay * 2, floor), PEEK_IDLE_MAX_MS);
  if (document.visibilityState !== 'hidden') {
    clearTimeout(peekTimer);   // a show or an input during the peek may have armed one
    peekTimer = setTimeout(runPeek, peekNext(peekDelay, Date.now()));
  }
}

// Now, unless a peek ran less than the floor ago: then when the floor is up.
function peekSoon() {
  if (document.visibilityState === 'hidden') return;
  clearTimeout(peekTimer);
  peekAligned = false;
  peekTimer = setTimeout(runPeek, Math.max(0, peekFloor() - (Date.now() - peekAt)));
}

function startPeeking() {
  peekAt = Date.now();   // the first load just read /api/latest
  peekTimer = setTimeout(runPeek, PEEK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(peekTimer); peekTimer = null; return; }
    peekDelay = peekFloor();
    peekSoon();
  });
  const onInput = () => {
    const idle = peekDelay > peekFloor();
    inputAt = Date.now();
    if (idle) { peekDelay = peekFloor(); peekSoon(); }
  };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
    window.addEventListener(type, onInput, { passive: true, capture: true });
  }
}

// Set by a tick skipped under an open popover; readOwed pays it once none is open.
let standingsSkipped = false;

// The list's scheduled run (set in js/boot.js).
let standingsTick = null;

// Reads the game for a skipped tick, through the scheduler's own run so it
// counts as that tick's (a tab return then does not read twice). The mark
// stays while a popover is open or a load is in flight (loadStandings calls this
// again when it ends). True when a read is owed, so the caller skips the peek.
function readOwed() {
  if (!standingsSkipped) return false;
  if (activeTrigger || standingsInFlight) return true;
  if (standingsTick) standingsTick();
  return true;
}

// A refresh that builds the board again takes an open popover's anchor down, so none runs while one is open.
async function refreshStandings() {
  // Anything open is being read, and reloading takes the board and the popover's
  // anchor down: the tick is skipped, not spent closing it. The tier maps refresh
  // themselves in place meanwhile.
  if (activeTrigger) { standingsSkipped = true; return false; }
  standingsSkipped = false;
  await loadStandings();
}

// Builds a "Label value · Label value" line with the label dimmed and the
// value bright. Used by both the standings rails and the match panel.
function buildStatsLine(pairs, className) {
  const container = document.createElement('span');
  container.className = className;

  pairs.forEach(([label, value], i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      container.appendChild(sep);
    }
    const labelSpan = document.createElement('span');
    labelSpan.className = 'stat-label';
    labelSpan.textContent = `${label} `;
    const valueSpan = document.createElement('span');
    valueSpan.className = 'stat-value';
    valueSpan.textContent = value;
    container.appendChild(labelSpan);
    container.appendChild(valueSpan);
  });

  return container;
}

// Builds the "Skirmish · Activity · K/D" line with icons and leader
// underline. Shared by the standings rail and the match panel.
function buildStandingStats(match, color, stats, className) {
  const { kills, deaths, kd, skirmish, serverName, leaders } = stats;

  const statPairs = [];
  let skirmishIndex = -1;
  if (skirmish !== null) { skirmishIndex = statPairs.length; statPairs.push(['Skirmish', formatCompact(skirmish)]); }
  const activityIndex = statPairs.length;
  statPairs.push(['Activity', formatCompact(kills + deaths)]);
  const kdIndex = statPairs.length;
  statPairs.push(['K/D', kd]);

  const statsLine = buildStatsLine(statPairs, className);
  const values = statsLine.querySelectorAll('.stat-value');

  if (skirmishIndex !== -1) {
    values[skirmishIndex].appendChild(buildSkirmishTrendButton(serverName, match, color));
    if (leaders.skirmish === color) markStatLeader(values[skirmishIndex]);
  }
  if (leaders.activity === color) markStatLeader(values[activityIndex]);
  values[activityIndex].appendChild(buildActivityInfoButton(serverName, match, color));

  const kdValue = values[kdIndex];
  if (deaths > 0 && kills !== deaths) kdValue.classList.add(kills > deaths ? 'kd-good' : 'kd-bad');
  if (leaders.kd === color) markStatLeader(kdValue);
  kdValue.appendChild(buildMapKdButton(serverName, match, color));

  return statsLine;
}

// What one side shows, and what it showed at the last repaint (prevSideStats,
// replaced here by what it shows now).
function sideFigures(match, color, leaderScore) {
  const kills = Number(match.kills?.[color] ?? 0);
  const deaths = Number(match.deaths?.[color] ?? 0);
  const vpNum = Number(match.victory_points?.[color] ?? 0);
  const skirmish = getSkirmishScore(match, color);
  const statsKey = `${match.id}:${color}`;
  const prev = prevSideStats.get(statsKey);
  const pctNow = (skirmish !== null && leaderScore !== null && leaderScore > 0)
    ? (skirmish / leaderScore) * 100
    : null;
  prevSideStats.set(statsKey, { vp: vpNum, skirmish, pct: pctNow });
  const serverName = getTeamName(matchTeamId(match, color));
  return { serverName, kills, deaths, kd: formatKd(kills, deaths), vpNum, skirmish, prev };
}

function queueSideFlashes({ prev, vpNum, skirmish }, vpValue, skirmishValue) {
  if (!prev) return;
  if (prev.vp !== vpNum) pendingFlashes.push([vpValue, vpNum - prev.vp]);
  if (skirmishValue && prev.skirmish !== null && prev.skirmish !== skirmish) {
    pendingFlashes.push([skirmishValue, skirmish - prev.skirmish]);
  }
}

function renderStandingSide(match, color, rankByColor, leaders, leaderScore) {
  const figures = sideFigures(match, color, leaderScore);
  const { serverName, kills, deaths, kd, vpNum, skirmish, prev } = figures;

  const row = document.createElement('div');
  row.className = `standing-side side-${color}`;

  const top = document.createElement('div');
  top.className = 'standing-side-top';

  const badge = document.createElement('span');
  const rank = rankByColor[color];
  badge.className = `rank-badge rank-${rank}`;
  badge.textContent = String(rank);

  const dot = document.createElement('span');
  dot.className = `dot dot-${color}`;

  const name = document.createElement('span');
  name.className = 'standing-side-name';
  name.textContent = serverName;

  top.appendChild(badge);
  top.appendChild(dot);
  top.appendChild(name);
  if (match.id.startsWith('1-')) top.appendChild(buildServerGuildsButton(serverName));

  const vpEl = document.createElement('span');
  vpEl.className = 'standing-vp';
  vpEl.innerHTML = `<span class="stat-label">VP </span><span class="stat-value">${vpNum.toLocaleString()}</span>`;
  const [regionCode, tierNum] = match.id.split('-');
  vpEl.appendChild(buildMovementIndicator(regionCode, tierNum, rank, isTiedOnVp(match, color)));
  top.appendChild(vpEl);

  const statsLine = buildStandingStats(match, color,
    { kills, deaths, kd, skirmish, serverName, leaders }, 'standing-side-stats');

  row.appendChild(top);
  row.appendChild(statsLine);

  // Skirmish is always the first stat when it exists, so its value element
  // is the first .stat-value in the line.
  queueSideFlashes(figures, vpEl.querySelector('.stat-value'),
    skirmish !== null ? statsLine.querySelector('.stat-value') : null);

  if (skirmish !== null && leaderScore !== null) {
    row.appendChild(buildSkirmishBar(color, skirmish, leaderScore, prev ? prev.pct : null));
  }

  return row;
}

const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
// A stat value holds its number as its first text node, its button after it.
function setLeadText(el, text) {
  const t = el.firstChild;
  if (t.nodeValue !== text) t.nodeValue = text;
}

// renderStandingSide, written into the card on the page (patchStandingsRegion
// has checked it has the same team and the same stats).
// `restyled`: the card was moved by insertBefore and has no style yet.
function patchStandingSide(match, color, side, rankByColor, leaders, leaderScore, restyled) {
  const figures = sideFigures(match, color, leaderScore);
  const { kills, deaths, kd, vpNum, skirmish } = figures;
  const rank = rankByColor[color];

  const badge = side.querySelector('.rank-badge');
  if (badge.className !== `rank-badge rank-${rank}`) badge.className = `rank-badge rank-${rank}`;
  setText(badge, String(rank));

  const vpEl = side.querySelector('.standing-vp');
  const vpValue = vpEl.querySelector('.stat-value');
  setText(vpValue, vpNum.toLocaleString());
  const [regionCode, tierNum] = match.id.split('-');
  const move = buildMovementIndicator(regionCode, tierNum, rank, isTiedOnVp(match, color));
  const had = vpEl.querySelector('.movement-indicator');
  if (!had) vpEl.appendChild(move);
  else if (had.className !== move.className || had.title !== move.title || had.textContent !== move.textContent) {
    had.replaceWith(move);
  }

  const values = side.querySelectorAll('.standing-side-stats .stat-value');
  let i = 0;
  const skirmishValue = skirmish !== null ? values[i++] : null;
  const activityValue = values[i++];
  const kdValue = values[i++];
  if (skirmishValue) {
    setLeadText(skirmishValue, formatCompact(skirmish));
    skirmishValue.classList.toggle('stat-leader', leaders.skirmish === color);
    rebindPopoverMatch(skirmishValue.querySelector('.activity-btn'), match);
  }
  setLeadText(activityValue, formatCompact(kills + deaths));
  activityValue.classList.toggle('stat-leader', leaders.activity === color);
  rebindPopoverMatch(activityValue.querySelector('.activity-info-btn'), match);
  setLeadText(kdValue, kd);
  const kdSign = deaths > 0 && kills !== deaths;
  kdValue.classList.toggle('kd-good', kdSign && kills > deaths);
  kdValue.classList.toggle('kd-bad', kdSign && kills < deaths);
  kdValue.classList.toggle('stat-leader', leaders.kd === color);
  rebindPopoverMatch(kdValue.querySelector('.map-kd-btn'), match);

  queueSideFlashes(figures, vpValue, skirmishValue);

  // The fill stays, so its width transition runs from the width it has; a
  // card without style is given it first, at the old width.
  if (skirmish !== null && leaderScore !== null) {
    const rawPct = leaderScore > 0 ? (skirmish / leaderScore) * 100 : 0;
    const fill = side.querySelector('.skirmish-bar-fill');
    const width = `${Math.max(4, rawPct)}%`;
    if (fill.style.width !== width) {
      if (restyled) void getComputedStyle(fill).width;
      fill.style.width = width;
    }
    setText(side.querySelector('.skirmish-bar-pct'), `${Math.round(rawPct)}%`);
  }
}
