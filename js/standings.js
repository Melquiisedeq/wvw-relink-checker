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

// Loads every active match (NA + EU) in two requests and powers the
// standings rails. Results are cached, so a later guild check reuses them.
async function loadStandings() {
  try {
    const idList = await fetchJson(`${API_BASE}/wvw/matches`);
    if (!Array.isArray(idList) || idList.length === 0) {
      throw new Error('No active matches returned');
    }

    // Fetched per region so an issue with one region can't wipe out the other.
    const naIds = idList.filter((id) => id.startsWith('1-'));
    const euIds = idList.filter((id) => id.startsWith('2-'));

    const fetchRegion = async (ids) => {
      if (ids.length === 0) return [];
      const data = await fetchJson(`${API_BASE}/wvw/matches?ids=${ids.map(encodeURIComponent).join(',')}`);
      return Array.isArray(data) ? data : [];
    };

    const [naMatches, euMatches] = await Promise.all([fetchRegion(naIds), fetchRegion(euIds)]);

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

    for (const match of [...naMatches, ...euMatches]) {
      if (!match || typeof match.id !== 'string' || typeof match.all_worlds !== 'object') continue;
      matchDataCache.set(match.id, match);
      for (const color of COLORS) {
        const teamId = matchTeamId(match, color);
        if (teamId) teamToMatchId.set(teamId, match.id);
      }
    }

    renderStandingsRegion(standingsGridNA, naMatches);
    renderStandingsRegion(standingsGridEU, euMatches);
    updateRelinkFromMatches(naMatches, euMatches);
    const syncedAt = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const naOk = naMatches.length > 0;
    const euOk = euMatches.length > 0;
    setStandingsStatus(standingsStatusNA, naOk, naOk ? syncedAt : "Couldn't load NA standings.");
    setStandingsStatus(standingsStatusEU, euOk, euOk ? syncedAt : "Couldn't load EU standings.");
  } catch {
    // Clear the skeletons too, or they shimmer forever behind an error.
    standingsGridNA.textContent = '';
    standingsGridEU.textContent = '';
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
  badge.textContent = RANK_LABELS[rank] || `#${rank}`;

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

