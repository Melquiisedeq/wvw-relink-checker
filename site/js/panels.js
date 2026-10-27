'use strict';
// Result rows and match panels: the per-guild answer rows, the match panel under them, and their formatters.

// The cards of a region, in the order they stand: one per tier.
function standingsBoard(matches) {
  // One late tier among live ones shows the teams left over (deduceLineup):
  // that is the API's own data, so it goes first. Otherwise a body behind
  // the week this browser remembers, and a tier of that week the API left
  // out, show the remembered line-up instead (weekLineup).
  const region = matches[0].id.split('-')[0];
  const apiTiers = matches.map((m) => Number(m.id.split('-')[1])).filter(Number.isInteger);
  const line = deduceLineup(matches, regionTeamIds(region), Math.max(0, ...apiTiers));
  const shown = matches.map((m) => (line && m.id === line.id ? line : (weekAhead(m) && weekLineup(m.id)) || m));
  for (const id of weekHeldIds(region)) {
    if (!shown.some((m) => m.id === id)) shown.push(weekLineup(id));
  }

  const tierOf = (m) => Number((m.waitingId || m.id).split('-')[1]);
  const tiers = shown.map(tierOf).filter(Number.isInteger);
  // A gap in the tiers (1-2 and 1-3 without 1-1) is a tier the API left out
  // of every read and this page never saw: its card stays, waiting.
  const waiting = [];
  for (let t = 1; t < Math.max(0, ...tiers); t++) {
    if (!tiers.includes(t)) waiting.push({ waitingId: `${region}-${t}` });
  }
  return [...shown, ...waiting].sort((a, b) => tierOf(a) - tierOf(b));
}

// A new score is written into the cards on the page when the board has the
// same shape (patchStandingsRegion); otherwise every card is built again.
function renderStandingsRegion(gridEl, matches) {
  const sorted = matches.length ? standingsBoard(matches) : [];
  if (patchStandingsRegion(gridEl, sorted)) return;
  gridEl.textContent = '';
  if (!sorted.length) return;
  const region = matches[0].id.split('-')[0];

  for (const match of sorted) {
    if (match.waitingId) {
      gridEl.appendChild(buildWaitingTier(match.waitingId));
      continue;
    }
    if (match.lineupOnly) {
      gridEl.appendChild(buildLineupTier(match));
      continue;
    }
    const tierNum = match.id.split('-')[1];
    const regionName = REGION_NAMES[region] || `Region ${region}`;

    const box = document.createElement('div');
    box.className = 'standing-match';
    box.dataset.matchId = match.id;

    const label = document.createElement('div');
    label.className = 'standing-match-title';
    const tierText = document.createElement('span');
    tierText.textContent = `Tier ${tierNum || '?'}`;
    label.appendChild(tierText);
    label.appendChild(buildTierMapButton(match, regionName, tierNum || '?'));
    box.appendChild(label);

    // Last week's score is not an answer to this week, and a stale one looks
    // exactly like a live one. The tier keeps its name, maps button, team names and
    // guild lists; only the numbers wait.
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
  flashChanges();
}

const sideColorOf = (el) => COLORS.find((c) => el.classList.contains(`side-${c}`));

// The new score written into the cards already on the page, so their elements
// and their animations stay. False, with nothing touched, when the board's
// shape differs from what is there: a tier came or went, a card is a line-up,
// waiting or stale, other teams, a skirmish score came or went.
function patchStandingsRegion(gridEl, sorted) {
  const boxes = gridEl.children;
  if (!sorted.length || boxes.length !== sorted.length) return false;
  const plans = [];
  for (let i = 0; i < sorted.length; i++) {
    const m = sorted[i];
    const box = boxes[i];
    if (m.waitingId || m.lineupOnly || !matchIsLive(m)) return false;
    const sides = {};
    for (const s of box.children) {
      if (s.classList.contains('standing-side')) sides[sideColorOf(s)] = s;
    }
    const leaderScore = getSkirmishLeaderScore(m);
    for (const c of COLORS) {
      const s = sides[c];
      if (!s) return false;
      if (s.querySelector('.standing-side-name').textContent !== getTeamName(matchTeamId(m, c))) return false;
      // The bar comes and goes with the skirmish score, and its button with it.
      if ((getSkirmishScore(m, c) !== null) !== !!s.querySelector('.activity-btn')) return false;
    }
    plans.push({ m, box, sides, leaderScore });
  }
  for (const p of plans) patchStandingMatch(p);
  flashChanges();
  return true;
}

function patchStandingMatch({ m, box, sides, leaderScore }) {
  const [region, tierNum] = m.id.split('-');
  const mapBtn = box.querySelector(':scope > .standing-match-title .tier-map-btn');
  if (mapBtn) {
    tierMapButtons.set(mapBtn, { match: m, regionName: REGION_NAMES[region] || `Region ${region}`, tierNum: tierNum || '?' });
    paintMapBadge(mapBtn);
  }

  const rankByColor = rankMatchByVictoryPoints(m);
  const leaders = getStatLeaders(m);
  const ranked = [...COLORS].sort((a, b) => rankByColor[a] - rankByColor[b]);
  slideFirst(box, ranked, sides);

  // A side overtook: the cards move, not rebuilt. The guild-found strip hangs
  // from its card, so it goes and paintGuildFound hangs it again. moveBefore
  // keeps a moved card's style; insertBefore drops it, and the card's bar then
  // has no width to travel from (patchStandingSide gives it one).
  const order = [...box.children].filter((e) => e.classList.contains('standing-side'));
  const restyled = new Set();
  if (ranked.some((c, i) => order[i] !== sides[c])) {
    for (const s of box.querySelectorAll(':scope > .guild-found-strip')) s.remove();
    const keeps = typeof box.moveBefore === 'function';
    let ref = box.querySelector(':scope > .standing-match-title').nextSibling;
    for (const c of ranked) {
      if (sides[c] === ref) { ref = ref.nextSibling; continue; }
      if (keeps) box.moveBefore(sides[c], ref);
      else { box.insertBefore(sides[c], ref); restyled.add(c); }
    }
  }
  for (const c of COLORS) patchStandingSide(m, c, sides[c], rankByColor, leaders, leaderScore, restyled.has(c));
  slidePlay(box);
}

// The cards of a tier slide to their new places when a side overtakes: each place is
// read before the move (slideFirst) and after it (slideRun, in a microtask, once
// paintGuildFound has hung the strip again), then only transform and opacity animate.
// Places are relative to the tier's own box, so a tier above that grew in the same
// repaint does not read as a slide.
const slideBefore = new Map(); // tier box -> { boxTop, tops: Map(card -> top), index: Map(card -> i), stripTop }
const slideLive = new Map();   // tier box -> { anims, marked, shadow }
const slideQueue = [];
let slideQueued = false;
const SLIDE_EASE = 'ease-in-out';

function slideFirst(box, ranked, sides) {
  const order = [...box.children].filter((e) => e.classList.contains('standing-side'));
  if (!ranked.some((c, i) => order[i] !== sides[c])) return;
  // A slide still running is where the eye is: its transform is part of the place read.
  const strip = box.querySelector(':scope > .guild-found-strip');
  slideBefore.set(box, {
    boxTop: box.getBoundingClientRect().top,
    tops: new Map(order.map((s) => [s, s.getBoundingClientRect().top])),
    index: new Map(order.map((s, i) => [s, i])),
    stripTop: strip ? strip.getBoundingClientRect().top : null,
  });
}

function slidePlay(box) {
  if (!slideBefore.has(box)) return;
  slideQueue.push(box);
  if (!slideQueued) { slideQueued = true; queueMicrotask(slideRun); }
}

function slideStop(box) {
  const live = slideLive.get(box);
  if (!live) return;
  slideLive.delete(box);
  for (const a of live.anims) a.cancel();
  for (const el of live.marked) el.classList.remove('slide-over', 'slide-under');
  if (live.shadow) live.shadow.remove();
  box.classList.remove('slide-host');
}

function slideRun() {
  slideQueued = false;
  const boxes = slideQueue.splice(0);
  for (const box of boxes) slideStop(box);
  // Every place is read before any animation starts: one layout for all the tiers.
  const plans = [];
  for (const box of boxes) {
    const before = slideBefore.get(box);
    slideBefore.delete(box);
    if (!before || !box.isConnected) continue;
    const boxRect = box.getBoundingClientRect();
    const order = [...box.children].filter((e) => e.classList.contains('standing-side'));
    const moves = [];
    order.forEach((side, i) => {
      if (!before.tops.has(side)) return;
      const rect = side.getBoundingClientRect();
      const dy = (before.tops.get(side) - before.boxTop) - (rect.top - boxRect.top);
      if (Math.abs(dy) < 0.5) return;
      moves.push({ side, dy, rect, up: i < before.index.get(side) });
    });
    const strip = box.querySelector(':scope > .guild-found-strip');
    let stripMove = null;
    if (strip && before.stripTop !== null) {
      const dy = (before.stripTop - before.boxTop) - (strip.getBoundingClientRect().top - boxRect.top);
      if (Math.abs(dy) >= 0.5) stripMove = { strip, dy, card: strip.previousElementSibling };
    }
    if (moves.length) plans.push({ box, boxRect, moves, stripMove, border: [box.clientLeft, box.clientTop] });
  }
  for (const p of plans) slideAnimate(p);
  if (plans.length) requestAnimationFrame(slideFollowDeltas);
}

function slideAnimate({ box, boxRect, moves, stripMove, border }) {
  const live = { anims: [], marked: [], shadow: null };
  slideLive.set(box, live);
  const timing = { duration: SWAP_MS, easing: SLIDE_EASE };
  // The tier clips its chamfer at its 10px padding: on a wide rail 3% would reach it.
  const grow = (width) => Math.min(1.03, 1 + 12 / width);
  const mark = (el, cls) => { el.classList.add(cls); live.marked.push(el); };
  const climbers = new Set();
  for (const m of moves) {
    if (m.up) {
      mark(m.side, 'slide-over');
      climbers.add(m.side);
      live.anims.push(m.side.animate([
        { transform: `translateY(${m.dy}px) scale(1)` },
        { transform: `translateY(${m.dy / 2}px) scale(${grow(m.rect.width)})`, offset: 0.5 },
        { transform: 'none' },
      ], timing));
    } else {
      mark(m.side, 'slide-under');
      live.anims.push(m.side.animate([
        { transform: `translateY(${m.dy}px)`, opacity: 1 },
        { transform: `translateY(${m.dy / 2}px)`, opacity: 0.6, offset: 0.5 },
        { transform: 'none', opacity: 1 },
      ], timing));
    }
  }
  // The strip goes with its card, at the same z-index.
  if (stripMove) {
    mark(stripMove.strip, climbers.has(stripMove.card) ? 'slide-over' : 'slide-under');
    live.anims.push(stripMove.strip.animate(
      [{ transform: `translateY(${stripMove.dy}px)` }, { transform: 'none' }], timing));
  }
  // The climber's shadow, between it and the side it passes.
  if (climbers.size) {
    const m = moves.find((x) => climbers.has(x.side));
    const shadow = document.createElement('div');
    shadow.className = 'slide-shadow';
    shadow.setAttribute('aria-hidden', 'true');
    shadow.style.left = `${m.rect.left - boxRect.left - border[0]}px`;
    shadow.style.top = `${m.rect.top - boxRect.top - border[1]}px`;
    shadow.style.width = `${m.rect.width}px`;
    shadow.style.height = `${m.rect.height}px`;
    box.classList.add('slide-host');
    box.appendChild(shadow);
    live.shadow = shadow;
    live.anims.push(shadow.animate([
      { transform: `translateY(${m.dy}px)`, opacity: 0 },
      { transform: `translateY(${m.dy / 2}px) scale(${grow(m.rect.width)})`, opacity: 1, offset: 0.5 },
      { transform: 'none', opacity: 0 },
    ], timing));
  }
  Promise.all(live.anims.map((a) => a.finished)).then(() => {
    if (slideLive.get(box) === live) slideStop(box);
  }, () => { /* cancelled by a newer slide, which cleaned up */ });
}

// A delta floats from <body> at the place its number had in the first frame, which
// is the card's old place: one that started over a sliding card goes with it.
// Runs after flashChanges' own frame callback has parked the deltas.
const slideFollowed = new WeakSet();
function slideFollowDeltas() {
  const tags = [...document.querySelectorAll('body > .delta')].filter((t) => !slideFollowed.has(t));
  if (!tags.length) return;
  const sliding = [];
  for (const live of slideLive.values()) {
    for (const a of live.anims) {
      const el = a.effect && a.effect.target;
      if (!el || !el.classList.contains('standing-side')) continue;
      const dy = Number(/translateY\((-?[\d.]+)px\)/.exec(a.effect.getKeyframes()[0].transform)?.[1]);
      if (Number.isFinite(dy)) sliding.push({ a, rect: el.getBoundingClientRect(), dy });
    }
  }
  for (const t of tags) {
    const x = parseFloat(t.style.left);
    const y = parseFloat(t.style.top) + 5;
    const hit = sliding.find(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    if (!hit) continue;
    slideFollowed.add(t);
    t.animate([{ translate: '0 0' }, { translate: `0 ${-hit.dy}px` }],
      { duration: Math.max(0, SWAP_MS - (Number(hit.a.currentTime) || 0)), easing: SLIDE_EASE, fill: 'forwards' });
  }
}

// The card of a tier with no body at all: its number and a line, no map
// button (there is no match to draw).
function buildWaitingTier(matchId) {
  const box = document.createElement('div');
  box.className = 'standing-match';
  box.dataset.matchId = matchId;
  const label = document.createElement('div');
  label.className = 'standing-match-title';
  const tierText = document.createElement('span');
  tierText.textContent = `Tier ${matchId.split('-')[1]}`;
  label.appendChild(tierText);
  box.appendChild(label);
  const note = document.createElement('p');
  note.className = 'standings-waiting';
  note.textContent = 'Waiting on the API';
  box.appendChild(note);
  return box;
}

// A tier painted as a line-up only (deduced, or from this browser's memory):
// its number and the three names, no map button (the only body to draw is
// last week's) and nothing that reads as a standing.
function buildLineupTier(line) {
  forgetSideStats(line.id);
  const box = document.createElement('div');
  box.className = 'standing-match';
  box.dataset.matchId = line.id;
  const label = document.createElement('div');
  label.className = 'standing-match-title';
  const tierText = document.createElement('span');
  tierText.textContent = `Tier ${line.id.split('-')[1]}`;
  label.appendChild(tierText);
  box.appendChild(label);
  box.appendChild(buildStandingsStale(line));
  return box;
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

// Highest current-skirmish score among the three sides; sizes the
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
  // A tie is not a lead: comparing with > alone would hand the underline to the first colour checked.
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
    // No deaths, no ratio: formatKd shows a dash, so nobody leads.
    return [c, d > 0 ? k / d : null];
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

  // A card built again gets a fresh fill, which would appear at its final width
  // and the CSS transition would never run. Starting at the previous width gives
  // it somewhere to travel from.
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
// tier. They tie often, so VP alone would leave ties in COLORS order; war score
// breaks them.
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

// Projects where a side lands after the next weekly reset from its rank within
// the tier: 1st promotes, 2nd always stays, 3rd relegates, unless there is
// nowhere further up or down to go. Reset, not relink: the relink rebuilds the
// teams and moves nobody between tiers.
function getRelinkMovement(rank, tierNum, maxTierForRegion) {
  const tier = Number(tierNum);
  if (rank === 1) {
    if (tier === 1) return { dir: 'stay', label: 'Already the top tier' };
    return { dir: 'up', label: 'Moves up next reset' };
  }
  if (rank === 2) return { dir: 'stay', label: 'Stays in this tier next reset' };
  if (maxTierForRegion != null && tier === maxTierForRegion) {
    return { dir: 'stay', label: 'Already the bottom tier' };
  }
  return { dir: 'down', label: 'Moves down next reset' };
}

// True when another side of the match has the same VP as this one.
function isTiedOnVp(match, color) {
  const vp = Number(match.victory_points?.[color] ?? 0);
  return COLORS.some((c) => c !== color && Number(match.victory_points?.[c] ?? 0) === vp);
}

// Small movement badge next to a side's VP: arrow up, arrow down, or a
// flat bar for "stays". Full wording lives in the tooltip only.
function buildMovementIndicator(regionCode, tierNum, rank, tied) {
  if (tied) {
    // Kept (empty) so the VP column does not shift; a tied rank is only
    // the tiebreak's order, not a standing to project from.
    const el = document.createElement('span');
    el.className = 'movement-indicator movement-tied';
    el.title = 'Tied on VP';
    return el;
  }
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
  return '\u2013';
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
  // The maps button takes the space of the region and match id; its tooltip carries what the text said.
  header.appendChild(tierEl);
  // A remembered line-up has no body of its own to draw.
  if (!match.fromMemory) header.appendChild(buildTierMapButton(match, regionName, tierNum || '?'));
  panel.appendChild(header);

  // The same rule as the standings rail: the three teams and their guild lists
  // stay, everything that reads as a standing goes. The pin stays: the team comes
  // from wvw/guilds, which turns over with the relink.
  if (match.fromMemory || !matchIsLive(match)) {
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
    vpEl.appendChild(buildMovementIndicator(regionCode, tierNum, rank, isTiedOnVp(match, color)));
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
