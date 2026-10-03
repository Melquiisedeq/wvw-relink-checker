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
  note.textContent = "Last week's line-up - the new matchup isn't published yet";
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

// Shows the pulsing live-dot next to the synced time on success; plain
// text (no dot) for loading/error states.
function setStandingsStatus(el, synced, text) {
  el.textContent = '';
  if (!synced) { el.textContent = text; return; }
  const dot = document.createElement('span');
  dot.className = 'live-dot';
  dot.title = 'Live standings, refreshes automatically every ~5 minutes';
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
function showRegion(gridEl, statusEl, matches, label, syncedAt) {
  if (matches) renderStandingsRegion(gridEl, matches);
  else clearSkeleton(gridEl);
  const ok = !!matches && matches.length > 0;
  setStandingsStatus(statusEl, ok, ok ? syncedAt : `Couldn't load ${label} standings.`);
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

  const fetchRegion = async (ids) => {
    if (ids.length === 0) return [];
    const data = await fetchMatches(`${API_BASE}/wvw/matches?ids=${ids.map(encodeURIComponent).join(',')}`);
    return Array.isArray(data) ? data : [];
  };

  const [naMatches, euMatches] = await Promise.all([
    fetchRegion(naIds).catch(() => null),
    fetchRegion(euIds).catch(() => null),
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
async function fetchAllMatches() {
  try {
    const all = await fetchMatches(`${API_BASE}/wvw/matches?ids=all`);
    const ok = Array.isArray(all) ? all.filter((m) => m && typeof m.id === 'string') : [];
    return ok.length > 0 ? ok : null;
  } catch {
    return null;
  }
}

// Loads every active match (NA + EU) and powers the standings rails.
// Results are cached, so a later guild check reuses them.
async function loadStandings() {
  try {
    const asked = Date.now();
    let idList, naMatches, euMatches;
    const all = await fetchAllMatches();
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
    // in js/maps.js. Only bodies whose score rose in this refresh: a frozen
    // or repeated one would be logged as a reading taken now.
    recordFightSamples(answered.filter((m) => m && matchScoreRoseAt(m.id) >= asked));

    // Forget matches that no longer exist. IDs are stable week to week, so
    // this only bites when a region loses a tier: a leftover "1-4" would
    // keep getMaxTierForRegion answering 4, and the genuine bottom side in
    // tier 3 would get a relegation arrow instead of a flat bar.
    const liveIds = new Set(idList);
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
        if (teamId) teamToMatchId.set(teamId, match.id);
      }
    }

    updateRelinkFromMatches(naMatches, euMatches);
    const syncedAt = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    showRegion(standingsGridNA, standingsStatusNA, naMatches, 'NA', syncedAt);
    showRegion(standingsGridEU, standingsStatusEU, euMatches, 'EU', syncedAt);
    primeMapBadges();
  } catch {
    // The id list itself failed, so there is nothing to say about either
    // region - but the same rule holds: what is on screen stays, because
    // a refresh that did not answer is not a reason to take away the one
    // that did. Only a skeleton has to go, for the reason in showRegion.
    clearSkeleton(standingsGridNA);
    clearSkeleton(standingsGridEU);
    standingsStatusNA.textContent = "Couldn't load live standings right now.";
    standingsStatusEU.textContent = "Couldn't load live standings right now.";
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
  if (activeTrigger) return;
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
  if (kills !== deaths) kdValue.classList.add(kills > deaths ? 'kd-good' : 'kd-bad');
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
  vpEl.appendChild(buildMovementIndicator(regionCode, tierNum, rank));
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

