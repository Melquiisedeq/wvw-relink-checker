'use strict';
// ---------------------------------------------------------------------
// Standings
// Loading the live match data for both regions and rendering one side
// of a tier: score, victory points, activity and the change flashes.
// ---------------------------------------------------------------------

// Grey blocks in the shape of the real thing while the first request is
// in flight, so the rails have their eventual shape instead of
// collapsing to a word.
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
// actually moved. Keyed by match and colour; sides are rebuilt from
// scratch on every refresh, so the numbers have to outlive the elements.
const prevSideStats = new Map(); // `${matchId}:${color}` -> { vp, skirmish, pct }

// Dropped the moment a tier's week ends, so the first refresh of the new
// one has nothing to compare against. Kept, it would have measured a
// fresh zero against last week's closing figures and floated a -2,116 VP
// over every side, with all three cards pulsing a collapse that never
// happened.
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

// A tier between weeks still has to be usable. Someone opening the site
// to look up who plays on a server should not be met with a shimmer, and
// nothing about that question went stale: team names survive a relink -
// it is which three are matched together that does not.
//
// Dropped is everything that would read as a standing: rank, colour,
// victory points, the stats line, the bar. The lie was never the data,
// it was last week's passing for this week's. `yoursByColor` comes only
// from the match panel, where saying which of the three is yours is the
// whole point of the screen.
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

// Flashes a number that just changed and floats the delta above it, so a
// refresh reads as movement rather than a silent swap.
function flashValue(el, delta) {
  if (!el || !Number.isFinite(delta) || delta === 0) return;

  el.classList.remove('value-changed');
  void el.offsetWidth; // restart the animation from zero
  el.classList.add('value-changed');

  // The number itself flashes, and the card it belongs to pulses at the
  // edge, so a change registers even when you are looking elsewhere.
  const side = el.closest('.standing-side');
  if (side) {
    side.classList.remove('side-pulse');
    void side.offsetWidth;
    side.classList.add('side-pulse');
  }

  // Deferred a frame because the side is still being assembled when this
  // runs: measuring now would read zeros off a detached element. The
  // delta is parked on <body> at the value's screen position rather than
  // inside the card, which clips its own chamfered corners and would
  // shear the number off as it rises.
  requestAnimationFrame(() => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // never made it onto the page

    const tag = document.createElement('span');
    tag.className = delta > 0 ? 'delta delta-up' : 'delta delta-down';
    tag.textContent = `${delta > 0 ? '+' : ''}${delta.toLocaleString()}`;
    tag.style.left = `${rect.left + rect.width / 2}px`;
    tag.style.top = `${rect.top - 4}px`;
    document.body.appendChild(tag);
    setTimeout(() => tag.remove(), 1700);
  });
}

// After a guild search: the card of the team the first guild landed on blinks
// three times, the page scrolls to it, and a strip hangs from its lower edge
// with the guild's name for a few seconds. The cards are rebuilt every
// refresh, so what was found is kept here and painted again onto the new
// cards (without the blink) until the time runs out.
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

// Shows the pulsing live-dot next to the synced time on success; plain
// text (no dot) for loading/error states.
function setStandingsStatus(el, synced, text) {
  clearRetryAlert(el);
  el.textContent = '';
  if (!synced) { el.textContent = text; return; }
  const dot = document.createElement('span');
  dot.className = 'live-dot';
  dot.title = 'Checks for new standings every 30 seconds while this tab is open';
  el.appendChild(dot);
  el.appendChild(document.createTextNode(text));
}

// The shimmering placeholder only stands in for an answer that has not
// arrived yet. Once one has failed it has arrived, and left alone it
// would shimmer behind the error line for as long as the tab is open.
function clearSkeleton(gridEl) {
  if (gridEl.querySelector('.skel-match')) gridEl.textContent = '';
}

// One region onto the page. A region that failed keeps whatever it last
// rendered rather than being emptied: last refresh's standings are still
// the standings, and blanking a column over one request says far less
// than leaving it up and saying it did not update. The first load is the
// exception, because what is up then is the skeleton.
function showRegion(gridEl, statusEl, matches, label, syncedAt, failed) {
  if (matches) {
    renderStandingsRegion(gridEl, matches);
    paintGuildFound(gridEl, false);
  } else clearSkeleton(gridEl);
  const ok = !!matches && matches.length > 0;
  if (ok) return setStandingsStatus(statusEl, true, syncedAt);
  // null is a request that failed, and it will be asked again (below);
  // [] is an answer with nothing in it, which asking again does not change.
  if (matches === null && failed) failed.push({ el: statusEl, label: `${label} standings` });
  else setStandingsStatus(statusEl, false, `Couldn't load ${label} standings.`);
}

// The fallback when the one request fails: the id list, then one request
// per region, the answers kept apart all the way down. null means that
// region's request failed; [] means it answered and has no matches.
// Collapsing the two is what let one region take the other down with it -
// Promise.all rejects whole, so a single 500 on EU threw away an NA answer
// that had already arrived and blanked both columns.
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
// one step and the pre-paint override in css/layout.css switches off with
// them, so nothing moves.
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
// the NA / EU halves of the relink bar (FLIP: measured before and after
// the move, then animated back from where each was). The columns pass
// under the centre column, shrinking and fading at the crossing so the
// text there stays readable, like two cards being shuffled. View
// Transitions were tried and dropped: capturing columns this tall froze
// the page for about 300ms before anything moved.
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
    } else if (region === 'NA' || region === 'EU') {
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
  if (btn) btn.focus({ preventScroll: true });

  for (const r of rails) {
    const was = railsWere.get(r);
    const now = r.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (!dx && !dy) continue;
    r.classList.add('is-swapping');
    // Linear time, eased per step: the fade has to cover the whole middle
    // stretch of the path, and one easing over the whole run bunched the
    // travel into the first frames, still opaque over the centre's text.
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
    // The halves cross on one line, so one rises and the other dips as they
    // pass, faded, instead of running through each other.
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
  const box = retryAlertOf(statusEl);
  if (box) box.textContent = '';
}

function paintRetryStatus(statusEl, spoken, visible, busy) {
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
}

function planStandingsRetry() {
  const paint = (spoken, visible) => {
    for (const f of standingsFailed) paintRetryStatus(f.el, spoken, visible, false);
  };
  if (standingsExtraUsed >= STANDINGS_RETRY_WINDOWS_MS.length) {
    for (const f of standingsFailed) {
      const text = `Couldn't load ${f.label}. It will try again in a few minutes.`;
      paintRetryStatus(f.el, text, text, false);
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
  for (const f of standingsFailed) paintRetryStatus(f.el, 'Trying again.', 'Trying again…', true);
  // The first load waits longer than a refresh: on a slow line the whole
  // body takes a while, and a refresh has the old table to fall back on.
  const timeoutMs = standingsEverLoaded ? REQUEST_TIMEOUT_MS : SLOW_REQUEST_TIMEOUT_MS;
  try {
    const asked = Date.now();
    let idList, naMatches, euMatches;
    // A load the peek asked for reads /api, which it saw ahead, and not the
    // game's ~97 KB again; with nothing from /api it leaves the board be.
    const all = origin === 'peek' ? await latestBoard() : await fetchAllMatches(timeoutMs);
    if (!all && origin === 'peek') return;
    if (all) {
      idList = all.map((m) => m.id);
      naMatches = all.filter((m) => m.id.startsWith('1-'));
      euMatches = all.filter((m) => m.id.startsWith('2-'));
    } else {
      [idList, naMatches, euMatches] = await loadStandingsByRegion();
    }
    const answered = [...(naMatches || []), ...(euMatches || [])];

    // Every refresh leaves a kills/deaths snapshot behind on its way
    // past. Nothing here waits on it and nothing extra is fetched - it is
    // what lets the maps popover say which map is busy the moment it
    // opens, instead of having to sample twice itself. See the fight log
    // in js/maps.js, which keeps only bodies whose score rose since `asked`.
    recordFightSamples(answered, asked);

    // Forget matches that no longer exist. IDs are stable week to week, so
    // this only bites when a region loses a tier: a leftover "1-4" would
    // keep getMaxTierForRegion answering 4, and the genuine bottom side in
    // tier 3 would get a relegation arrow instead of a flat bar. A tier
    // missing from the list was read again by id (fetchMatches); only one
    // missing from that read too is forgotten.
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
    // The id list itself failed, so there is nothing to say about either
    // region - but the same rule holds: what is on screen stays, because
    // a refresh that did not answer is not a reason to take away the one
    // that did. Only a skeleton has to go, for the reason in showRegion.
    clearSkeleton(standingsGridNA);
    clearSkeleton(standingsGridEU);
    failed.push({ el: standingsStatusNA, label: 'live standings' },
      { el: standingsStatusEU, label: 'live standings' });
  } finally {
    standingsInFlight = false;
  }
  standingsFailed = failed;
  if (failed.length) planStandingsRetry();
  else standingsExtraUsed = 0;
}

// Between the five-minute refreshes, the readers' summary (~0.2 KB on the
// wire, kept 15 s by Cloudflare) is read while the tab is visible: every
// PEEK_MS while the visitor is using the page, doubling to PEEK_IDLE_MAX_MS
// while not (the readers move every 2 min, so "it moved" would never let it
// slow down); never under PEEK_SAVE_MS with
// Save-Data on. Hidden, it stops; it runs at once when the tab comes back,
// when a popover closes and on the first input after an idle stretch. A live
// match /api holds further along than the one on show, which has not risen
// here for PEEK_BEHIND_MS, loads the board from /api/latest. With a popover
// open the board cannot load (it would take the popover's anchor down; the
// maps refresh themselves), so the numbers come when the popover closes.
const PEEK_MS = 30 * 1000;
const PEEK_IDLE_MAX_MS = 120 * 1000;
const PEEK_SAVE_MS = 60 * 1000;
const PEEK_ACTIVE_MS = 2 * 60 * 1000;   // input this recent counts as using the page
const PEEK_BEHIND_MS = 90 * 1000;
let peekLoadedAt = 0;           // a load the peek asked for: one per PEEK_BEHIND_MS, if /api fails
let peekTimer = null;
let peekDelay = PEEK_MS;
let peekAt = 0;                 // when the last peek ran
let inputAt = Date.now();

const peekFloor = () => (navigator.connection?.saveData === true ? PEEK_SAVE_MS : PEEK_MS);

// The board as /api holds it: each body on show, or the further-along one
// /api/latest gave for it. Null when /api gave nothing.
async function latestBoard() {
  const shown = [...matchDataCache.values()];
  const reading = shown.length ? startLatest() : null;
  const bodies = reading ? await reading : [];
  if (!bodies.length) return null;
  offerLatest(bodies);
  return shown.map((m) => (newestMatches.has(m.id) ? newestMatches.get(m.id).match : m))
    .sort((a, b) => byId(a.id, b.id));
}

async function peekLatest() {
  if (standingsInFlight || document.visibilityState === 'hidden' || standingsFailed.length) return;
  peekAt = Date.now();
  let sum;
  try { sum = await fetchOwnApi(LATEST_SUMMARY_URL); } catch { return; }
  if (!sum || typeof sum !== 'object') return;
  const now = Date.now();
  const ahead = new Set();
  for (const [id, k] of newestMatches) {
    const e = Object.hasOwn(sum, id) ? sum[id] : null;
    if (e && matchIsLive(k.match) && now - k.at >= PEEK_BEHIND_MS
      && Number.isFinite(e.score) && e.start === Date.parse(k.match.start_time)
      && e.score > colorSum(k.match.scores)) ahead.add(id);
  }
  if (!ahead.size) return;
  if (activeTrigger || standingsInFlight || now - peekLoadedAt < PEEK_BEHIND_MS) return;
  peekLoadedAt = now;
  await loadStandings('peek');
}

async function runPeek() {
  peekTimer = null;
  if (document.visibilityState === 'hidden') return;
  await peekLatest();
  const floor = peekFloor();
  const using = Date.now() - inputAt < PEEK_ACTIVE_MS || !!activeTrigger;
  peekDelay = using ? floor : Math.min(Math.max(peekDelay * 2, floor), PEEK_IDLE_MAX_MS);
  if (document.visibilityState !== 'hidden') peekTimer = setTimeout(runPeek, peekDelay);
}

// Now, unless a peek ran less than the floor ago: then when the floor is up.
function peekSoon() {
  if (document.visibilityState === 'hidden') return;
  clearTimeout(peekTimer);
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

// Rebuilding the grid on refresh would leave a popover pointing at a
// removed element, so close it first.
async function refreshStandings() {
  // Anything open is being read right now, and reloading takes the whole
  // board down and the popover's own anchor with it. So the tick is
  // skipped rather than spent closing something in someone's face; the
  // next one lands as soon as they are done. The tier maps do not go
  // stale in the meantime - they refresh themselves, in place.
  if (activeTrigger) return false;
  await loadStandings();
}

// Builds a "Label value · Label value" line with the label dimmed and the
// value bright. Used by both the standings rails and the match panel.
function buildStatsLine(pairs, className) {
  const container = document.createElement('span');
  if (className) container.className = className;

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
    const trendBtn = buildSkirmishTrendButton(serverName, match, color);
    if (trendBtn) values[skirmishIndex].appendChild(trendBtn);
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

function renderStandingSide(match, color, rankByColor, leaders, leaderScore) {
  const teamId = matchTeamId(match, color);
  const serverName = getTeamName(teamId);
  const kills = Number(match.kills?.[color] ?? 0);
  const deaths = Number(match.deaths?.[color] ?? 0);
  const kd = formatKd(kills, deaths);
  const vpNum = Number(match.victory_points?.[color] ?? 0);
  const vp = vpNum.toLocaleString();
  const skirmish = getSkirmishScore(match, color);

  const statsKey = `${match.id}:${color}`;
  const prev = prevSideStats.get(statsKey);
  const pctNow = (skirmish !== null && leaderScore !== null && leaderScore > 0)
    ? (skirmish / leaderScore) * 100
    : null;
  prevSideStats.set(statsKey, { vp: vpNum, skirmish, pct: pctNow });

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
  vpEl.innerHTML = `<span class="stat-label">VP </span><span class="stat-value">${vp}</span>`;
  const [regionCode, tierNum] = match.id.split('-');
  vpEl.appendChild(buildMovementIndicator(regionCode, tierNum, rank, isTiedOnVp(match, color)));
  top.appendChild(vpEl);

  const statsLine = buildStandingStats(match, color,
    { kills, deaths, kd, skirmish, serverName, leaders }, 'standing-side-stats');

  // Skirmish is always the first stat when it exists, so its value
  // element is the first .stat-value in the line.
  if (prev) {
    if (prev.vp !== vpNum) flashValue(vpEl.querySelector('.stat-value'), vpNum - prev.vp);
    if (skirmish !== null && prev.skirmish !== null && prev.skirmish !== skirmish) {
      flashValue(statsLine.querySelector('.stat-value'), skirmish - prev.skirmish);
    }
  }

  row.appendChild(top);
  row.appendChild(statsLine);

  if (skirmish !== null && leaderScore !== null) {
    row.appendChild(buildSkirmishBar(color, skirmish, leaderScore, prev ? prev.pct : null));
  }

  return row;
}

