'use strict';
// ---------------------------------------------------------------------
// Result rows and match panels
// The per-guild answer rows and the full match panel underneath them,
// plus the small formatters they share.
// ---------------------------------------------------------------------

function renderStandingsRegion(gridEl, matches) {
  gridEl.textContent = '';
  if (matches.length === 0) return;

  const sorted = [...matches].sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));

  for (const match of sorted) {
    const [regionCode, tierNum] = match.id.split('-');
    const regionName = REGION_NAMES[regionCode] || `Region ${regionCode}`;

    const box = document.createElement('div');
    box.className = 'standing-match';

    const label = document.createElement('div');
    label.className = 'standing-match-title';
    const tierText = document.createElement('span');
    tierText.textContent = `Tier ${tierNum || '?'}`;
    label.appendChild(tierText);
    label.appendChild(buildTierMapButton(match, regionName, tierNum || '?'));
    box.appendChild(label);

    // Last week's score is not an answer to what is happening this week,
    // and a stale one sat here looking exactly like a live one. The tier
    // keeps its name and its maps button - the ground has not moved,
    // only who holds it - and so do the team names and the guild lists
    // hanging off them. Only the numbers wait.
    if (!matchIsLive(match)) {
      forgetSideStats(match.id);
      box.appendChild(buildStandingsStale(match));
      gridEl.appendChild(box);
      continue;
    }

    const rankByColor = rankMatchByVictoryPoints(match);
    const leaders = getStatLeaders(match);
    const leaderScore = getSkirmishLeaderScore(match);

    const ranked = [...COLORS].sort((a, b) => rankByColor[a] - rankByColor[b]);
    for (const color of ranked) {
      box.appendChild(renderStandingSide(match, color, rankByColor, leaders, leaderScore));
    }

    gridEl.appendChild(box);
  }
}

// Uses DOM APIs and textContent only, no innerHTML with interpolated
// strings. Guild names from the API or the user can never be parsed as markup.
function renderRow({ originalName, tag, region, server, error }) {
  const tr = document.createElement('tr');

  const nameCell = document.createElement('td');
  nameCell.textContent = originalName;
  tr.appendChild(nameCell);

  if (error) {
    const tagCell = document.createElement('td');
    tagCell.className = 'muted';
    tagCell.textContent = '—';
    tr.appendChild(tagCell);

    const regionCell = document.createElement('td');
    regionCell.className = 'muted';
    regionCell.textContent = '—';
    tr.appendChild(regionCell);

    const errorCell = document.createElement('td');
    errorCell.className = 'status-err';
    errorCell.textContent = error;
    tr.appendChild(errorCell);
  } else {
    const tagCell = document.createElement('td');
    const tagSpan = document.createElement('span');
    tagSpan.className = 'tag';
    tagSpan.textContent = `[${tag}]`;
    tagCell.appendChild(tagSpan);
    tr.appendChild(tagCell);

    const regionCell = document.createElement('td');
    regionCell.textContent = region;
    tr.appendChild(regionCell);

    const serverCell = document.createElement('td');
    // The flex lives on a span inside the cell, never on the cell
    // itself - see .server-cell in css/panels.css for why.
    const serverInner = document.createElement('span');
    serverInner.className = 'server-cell';

    const dot = document.createElement('span');
    dot.className = 'dot dot-pending';
    dot.title = 'Working out which side this is…';

    const serverText = document.createElement('span');
    serverText.className = 'status-ok';
    serverText.textContent = server;

    serverInner.appendChild(dot);
    serverInner.appendChild(serverText);
    if (region === 'NA') serverInner.appendChild(buildServerGuildsButton(server));
    serverCell.appendChild(serverInner);
    tr.appendChild(serverCell);

    resultBody.appendChild(tr);
    return dot;
  }

  resultBody.appendChild(tr);
  return null;
}

// The match's cumulative "scores" field isn't what trackers show; players
// look at the current skirmish score and victory points instead.
function getSkirmishScore(match, color) {
  if (Array.isArray(match.skirmishes) && match.skirmishes.length > 0) {
    const last = match.skirmishes[match.skirmishes.length - 1];
    const value = last?.scores?.[color];
    if (typeof value === 'number') return value;
  }
  return null;
}

// Highest current-skirmish score among the three sides, used to size the
// score bar relative to whoever is leading right now.
function getSkirmishLeaderScore(match) {
  const scores = COLORS.map((c) => getSkirmishScore(match, c)).filter((s) => s !== null);
  return scores.length > 0 ? Math.max(...scores) : null;
}

function markStatLeader(valueEl) {
  valueEl.classList.add('stat-leader');
}

// Finds which color leads each stat, so that side's number can be
// underlined. Independent per stat (a side can lead Activity but not
// Skirmish).
function getStatLeaders(match) {
  // A tie is not a lead. Comparing with > alone kept the first colour
  // checked, so two sides level on Activity quietly handed red the
  // underline every time.
  const best = (values) => {
    let leader = null, max = -Infinity, tied = false;
    for (const [c, v] of values) {
      if (v === null) continue;
      if (v > max) { max = v; leader = c; tied = false; }
      else if (v === max) { tied = true; }
    }
    return tied ? null : leader;
  };
  const skirmishValues = COLORS.map((c) => [c, getSkirmishScore(match, c)]);
  const activityValues = COLORS.map((c) => [c, Number(match.kills?.[c] ?? 0) + Number(match.deaths?.[c] ?? 0)]);
  const kdValues = COLORS.map((c) => {
    const k = Number(match.kills?.[c] ?? 0);
    const d = Number(match.deaths?.[c] ?? 0);
    return [c, d > 0 ? k / d : (k > 0 ? Infinity : 0)];
  });
  return { skirmish: best(skirmishValues), activity: best(activityValues), kd: best(kdValues) };
}

// Thin bar showing this side's current skirmish score relative to the
// tier leader, in the side's own color. Purely visual, no popover.
function buildSkirmishBar(color, score, leaderScore, fromPct) {
  const row = document.createElement('div');
  row.className = 'skirmish-bar-row';
  row.title = 'Current skirmish score vs the tier leader';

  const track = document.createElement('div');
  track.className = 'skirmish-bar-track';
  const fill = document.createElement('div');
  const rawPct = leaderScore > 0 ? (score / leaderScore) * 100 : 0;
  const pct = Math.max(4, rawPct);
  fill.className = `skirmish-bar-fill skirmish-bar-${color}`;

  // The whole rail is rebuilt on every refresh, so a fresh element would
  // simply appear at its final width and the CSS transition would never
  // run. Starting it at the previous width gives the transition
  // somewhere to travel from, and the bar visibly slides instead.
  const shouldAnimate = typeof fromPct === 'number' && Math.abs(fromPct - rawPct) > 0.01;
  fill.style.width = `${shouldAnimate ? Math.max(4, fromPct) : pct}%`;
  if (shouldAnimate) {
    requestAnimationFrame(() => { fill.style.width = `${pct}%`; });
  }
  track.appendChild(fill);

  const label = document.createElement('span');
  label.className = 'skirmish-bar-pct';
  label.textContent = `${Math.round(rawPct)}%`;

  row.appendChild(track);
  row.appendChild(label);
  return row;
}

// Ranks the three sides by victory points, the standing that decides the
// tier. They tie often enough to matter, especially early in the week,
// and sorting on VP alone left those two in COLORS order - arbitrary and,
// worse, stable. War score is the natural second measure and is already
// in the match object.
function rankMatchByVictoryPoints(match) {
  const ranked = COLORS
    .map((color) => ({
      color,
      vp: Number(match.victory_points?.[color] ?? 0),
      score: Number(match.scores?.[color] ?? 0),
    }))
    .sort((a, b) => (b.vp - a.vp) || (b.score - a.score));

  const rankByColor = {};
  ranked.forEach((entry, i) => { rankByColor[entry.color] = i + 1; });
  return rankByColor;
}

// Highest tier active in a region, so a 3rd place can tell whether it's
// already at the bottom. Reads matches already cached by loadStandings,
// so no extra request.
function getMaxTierForRegion(regionCode) {
  let max = null;
  for (const id of matchDataCache.keys()) {
    if (!id.startsWith(`${regionCode}-`)) continue;
    const tier = Number(id.split('-')[1]);
    if (!Number.isNaN(tier) && (max === null || tier > max)) max = tier;
  }
  return max;
}

const MOVEMENT_SYMBOLS = { up: '▲', down: '▼' };

// Projects where a side lands after the next weekly relink from its
// rank within the tier: 1st promotes, 2nd always stays, 3rd relegates,
// unless there's nowhere further up or down to go.
function getRelinkMovement(rank, tierNum, maxTierForRegion) {
  const tier = Number(tierNum);
  if (rank === 1) {
    if (tier === 1) return { dir: 'stay', label: 'Already the top tier' };
    return { dir: 'up', label: 'Moves up next relink' };
  }
  if (rank === 2) return { dir: 'stay', label: 'Stays in this tier next relink' };
  if (maxTierForRegion != null && tier === maxTierForRegion) {
    return { dir: 'stay', label: 'Already the bottom tier' };
  }
  return { dir: 'down', label: 'Moves down next relink' };
}

// Small movement badge next to a side's VP: arrow up, arrow down, or a
// flat bar for "stays". Full wording lives in the tooltip only.
function buildMovementIndicator(regionCode, tierNum, rank) {
  const maxTier = getMaxTierForRegion(regionCode);
  const { dir, label } = getRelinkMovement(rank, tierNum, maxTier);
  const el = document.createElement('span');
  el.className = `movement-indicator movement-${dir}`;
  el.title = label;
  if (dir === 'stay') {
    const bar = document.createElement('span');
    bar.className = 'movement-bar';
    el.appendChild(bar);
  } else {
    el.textContent = MOVEMENT_SYMBOLS[dir];
  }
  return el;
}

function formatKd(kills, deaths) {
  if (deaths > 0) return (kills / deaths).toFixed(2);
  return kills > 0 ? '∞' : '0.00';
}

// Shortens large stat numbers (11,434 -> 11.4k) so the stats line fits
// without wrapping. Below 1,000 it just uses the normal separator.
function formatCompact(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

// Renders one match panel (tier header + one column per side).
// yourGuildsByColor maps each color to the queried guilds on that side.
function renderMatchPanel(match, yourGuildsByColor) {
  const [regionCode, tierNum] = match.id.split('-');
  const regionName = REGION_NAMES[regionCode] || `Region ${regionCode}`;

  const panel = document.createElement('div');
  panel.className = 'match-panel';

  const header = document.createElement('div');
  header.className = 'match-panel-header';
  const tierEl = document.createElement('span');
  tierEl.className = 'match-tier';
  tierEl.textContent = `Tier ${tierNum || '?'}`;
  // The region and match id were never worth the space - you just asked
  // for this match, so you know which one it is. The maps button earns
  // it. What the text said lives on in the button's tooltip.
  header.appendChild(tierEl);
  header.appendChild(buildTierMapButton(match, regionName, tierNum || '?'));
  panel.appendChild(header);

  // The same rule the standings rail follows, and the same answer: the
  // three teams and their guild lists stay, everything that would read
  // as a standing goes. The pin travels with it, because which of the
  // three is yours is the question this screen was opened to answer and
  // that part is not in doubt - the team comes from wvw/guilds, which
  // turns over with the relink.
  if (!matchIsLive(match)) {
    panel.appendChild(buildStandingsStale(match, yourGuildsByColor));
    return panel;
  }

  const cols = document.createElement('div');
  cols.className = 'team-cols';

  const rankByColor = rankMatchByVictoryPoints(match);
  const orderedColors = [...COLORS].sort((a, b) => rankByColor[a] - rankByColor[b]);
  const leaders = getStatLeaders(match);
  const leaderScore = getSkirmishLeaderScore(match);

  for (const color of orderedColors) {
    const teamId = matchTeamId(match, color);
    const serverName = getTeamName(teamId);
    const yours = yourGuildsByColor[color] || [];

    const kills = Number(match.kills?.[color] ?? 0);
    const deaths = Number(match.deaths?.[color] ?? 0);
    const kd = formatKd(kills, deaths);
    const vp = Number(match.victory_points?.[color] ?? 0).toLocaleString();
    const skirmish = getSkirmishScore(match, color);

    const col = document.createElement('div');
    col.className = `team-col col-${color}` + (yours.length ? ' is-yours' : '');

    const head = document.createElement('div');
    head.className = 'team-head';
    const rankBadge = document.createElement('span');
    const rank = rankByColor[color];
    rankBadge.className = `rank-badge rank-${rank}`;
    rankBadge.textContent = String(rank);
    const dot = document.createElement('span');
    dot.className = `dot dot-${color}`;
    const name = document.createElement('span');
    name.className = 'team-name';
    name.textContent = serverName;
    head.appendChild(rankBadge);
    head.appendChild(dot);
    head.appendChild(name);
    if (regionCode === '1') head.appendChild(buildServerGuildsButton(serverName));
    const vpEl = document.createElement('span');
    vpEl.className = 'standing-vp';
    vpEl.innerHTML = `<span class="stat-label">VP </span><span class="stat-value">${vp}</span>`;
    vpEl.appendChild(buildMovementIndicator(regionCode, tierNum, rank));
    head.appendChild(vpEl);
    col.appendChild(head);

    if (yours.length) {
      const pin = document.createElement('span');
      pin.className = 'pin-badge';
      pin.textContent = `📍 ${yours.join(', ')}`;
      col.appendChild(pin);
    }

    const statsLine = buildStandingStats(match, color,
      { kills, deaths, kd, skirmish, serverName, leaders }, 'team-stats');
    col.appendChild(statsLine);

    if (skirmish !== null && leaderScore !== null) {
      col.appendChild(buildSkirmishBar(color, skirmish, leaderScore));
    }

    cols.appendChild(col);
  }

  panel.appendChild(cols);
  return panel;
}
