'use strict';
// Stat popovers: K/D by map, the skirmish score trend chart, and what Activity means (pieces from popover-parts.js).

// Drawn, not typed: as emoji the two land in different system fonts with
// different baselines.
//
// "swords" and "skull" from Lucide (https://lucide.dev), ISC licence:
// Copyright (c) 2026 Lucide Icons and Contributors. Same 24x24 grid and
// 2px round stroke as the buttons on this page.
const GLYPH_ATTRS = ' viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const GLYPH_SWORD = '<svg class="glyph-sword" width="15" height="15"' + GLYPH_ATTRS
  + '<path d="m13 19 6-6"/>'
  + '<path d="M14.5 17.5 3.586 6.586A2 2 0 0 1 3 5.172V3h2.172a2 2 0 0 1 1.414.586L17.5 14.5"/>'
  + '<path d="m14.828 6.172 2.586-2.586A2 2 0 0 1 18.828 3H21v2.172a2 2 0 0 1-.586 1.414'
  + 'l-2.586 2.586"/>'
  + '<path d="m16 16 4 4"/><path d="m19 21 2-2"/>'
  + '<path d="m5 14 4 4"/><path d="m5 21-2-2"/><path d="M7.5 16.5 4 20"/></svg>';
const GLYPH_SKULL = '<svg class="glyph-skull" width="15" height="15"' + GLYPH_ATTRS
  + '<path d="m12.5 17-.5-1-.5 1h1z"/>'
  + '<path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1'
  + 'a1 1 0 0 0 1 1z"/>'
  + '<circle cx="15" cy="12" r="1"/><circle cx="9" cy="12" r="1"/></svg>';

// The three column words travel as one group, like the three numbers on every row below, so a word stays over its own number.
function kdHeadCells() {
  const nums = popCell('pop-kd-nums');
  nums.appendChild(popCell('pop-kd-kills', 'Kills'));
  nums.appendChild(popCell('pop-kd-deaths', 'Deaths'));
  nums.appendChild(popCell('pop-bar-pct pop-kd-ratio', 'K/D'));
  return nums;
}

function renderMapKdPopoverContent(popover, serverName, match, color) {
  popover.textContent = '';
  popHeader(popover, `${serverName} · K/D by map`);

  const maps = Array.isArray(match.maps) ? match.maps : [];
  const rows = MAP_ORDER.map((type) => {
    const mapData = maps.find((m) => m.type === type);
    return {
      type,
      kills: Number(mapData?.kills?.[color] ?? 0),
      deaths: Number(mapData?.deaths?.[color] ?? 0),
    };
  });
  const kills = rows.reduce((a, r) => a + r.kills, 0);
  const deaths = rows.reduce((a, r) => a + r.deaths, 0);

  const figures = document.createElement('div');
  figures.className = 'pop-figures pop-figures--three';
  figures.appendChild(popFigure('Kills', kills.toLocaleString()));
  figures.appendChild(popFigure('Deaths', deaths.toLocaleString()));
  figures.appendChild(popFigure('K/D', formatKd(kills, deaths),
    deaths === 0 || kills === deaths ? null : (kills > deaths ? 'good' : 'bad')));
  popover.appendChild(figures);

  // One row per map: the bar says where the fighting was, the numbers how it
  // went (a K/D alone hides a 2.0 over six fights versus six hundred). No total
  // beside the heading: the cards at the top carry the kills and deaths.
  popover.appendChild(popSection('Where the fighting was', [kdHeadCells()]));
  for (const r of rows) {
    const fought = r.kills + r.deaths;
    const row = document.createElement('div');
    row.className = 'pop-bar-row pop-kd-row';

    const label = popBarLabel(MAP_LABELS[r.type], MAP_LABEL_CLASS[r.type]);

    // The bar is how much of the week's fighting happened on this map, which is what the heading asks.
    const share = fought / ((kills + deaths) || 1);
    const track = document.createElement('span');
    track.className = 'pop-bar-track pop-bar-track--slim';
    track.title = fought
      ? `${fought.toLocaleString()} kills and deaths here, `
        + `${Math.round(share * 100)}% of this side's week`
      : 'No fighting here yet';
    const fill = document.createElement('span');
    fill.className = `pop-bar-fill own-${color}`;
    fill.style.width = `${share * 100}%`;
    track.appendChild(fill);

    const killsEl = document.createElement('span');
    killsEl.className = 'pop-kd-kills';
    killsEl.innerHTML = GLYPH_SWORD + r.kills.toLocaleString();
    const deathsEl = document.createElement('span');
    deathsEl.className = 'pop-kd-deaths';
    deathsEl.innerHTML = GLYPH_SKULL + r.deaths.toLocaleString();

    const ratio = document.createElement('span');
    ratio.className = 'pop-bar-pct pop-kd-ratio';
    ratio.textContent = formatKd(r.kills, r.deaths);
    if (r.deaths > 0 && r.kills !== r.deaths) ratio.classList.add(r.kills > r.deaths ? 'kd-good' : 'kd-bad');

    // The three numbers travel in their own group, so the bar takes the slack and
    // they are not pushed to opposite ends of the row.
    const nums = document.createElement('span');
    nums.className = 'pop-kd-nums';
    nums.appendChild(killsEl);
    nums.appendChild(deathsEl);
    nums.appendChild(ratio);

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(nums);
    popover.appendChild(row);
  }

  popover.appendChild(popNote('The bar is how much of this week\u2019s fighting happened on '
    + 'each map, so it shows where the war actually is. The K/D beside it says how that '
    + 'fighting went: above 1.00 means more kills than deaths there.'));
}

// The body each stat button opens with: the one it was built with, until a
// score written into its card in place (patchStandingSide) gives it the new one.
const popoverMatches = new WeakMap(); // button -> match
function rebindPopoverMatch(btn, match) {
  if (btn) popoverMatches.set(btn, match);
}

// Small crossed-swords icon next to the K/D value, opening a per-map breakdown.
// The data is already in `match`: no fetch.
function buildMapKdButton(serverName, match, color) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn map-kd-btn';
  btn.setAttribute('aria-label', `Show K/D by map for ${serverName}`);
  btn.title = `Show K/D by map for ${serverName}`;
  markPopoverTrigger(btn);
  btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<g transform="rotate(45 12 11)">' +
    '<line x1="12" y1="2" x2="12" y2="17"/>' +
    '<line x1="9" y1="16" x2="15" y2="16"/>' +
    '<circle cx="12" cy="20" r="1.3" fill="currentColor" stroke="none"/>' +
    '</g>' +
    '<g transform="rotate(-45 12 11)">' +
    '<line x1="12" y1="2" x2="12" y2="17"/>' +
    '<line x1="9" y1="16" x2="15" y2="16"/>' +
    '<circle cx="12" cy="20" r="1.3" fill="currentColor" stroke="none"/>' +
    '</g>' +
    '</g></svg>';
  popoverMatches.set(btn, match);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, `${serverName} K/D by map`, (popover) => {
      renderMapKdPopoverContent(popover, serverName, popoverMatches.get(btn), color);
    }, 'info-popover--data');
  });
  return btn;
}

// How far into a block the projection may start: the API publishes a running
// block's score late, so an early estimate lands far too low.
const LIVE_PROJECT_AFTER = 0.375;  // 45 of the 120 minutes

// Which skirmish block the match is in, and how far through it. Blocks are two
// hours each from the match start, and the API publishes the running one beside
// the finished ones with the score so far: comparing the last entry to the
// others compares a part to wholes.
function skirmishProgress(match, at = Date.now()) {
  const start = Date.parse(match.start_time);
  if (!Number.isFinite(start)) return null;
  const end = Date.parse(match.end_time);
  const now = Math.min(at, Number.isFinite(end) ? end : Infinity);
  const hours = (now - start) / 3600000;
  if (!(hours >= 0)) return null;
  return { index: Math.floor(hours / 2) + 1, fraction: (hours % 2) / 2 };
}

function getSkirmishSeries(match, color) {
  if (!Array.isArray(match.skirmishes)) return [];
  return match.skirmishes.map((s) => Number(s?.scores?.[color] ?? 0));
}

function renderSkirmishTrendPopoverContent(popover, serverName, match, color) {
  popover.textContent = '';
  popHeader(popover, `${serverName} · Skirmish score`);

  // All three sides: a dip alone could be this server losing ground or all three
  // going quiet. The chosen side is the solid line.
  const progress = skirmishProgress(match);
  const sides = COLORS.map((c) => ({ color: c, series: getSkirmishSeries(match, c) }));
  const total = sides[0].series.length;

  // The last block is usually still being played and scored as it goes, so
  // plotting it would end every chart in a cliff. It is left off the line and
  // reported underneath.
  //
  // The API does not append that block to every match at the same moment, so
  // whether a block is being played and whether its score has been published are
  // different questions.
  const live = progress && progress.index >= total && progress.fraction > 0;
  const scored = live && progress.index === total;
  // The clock can be a block ahead of the body: the API freezes a match for
  // half an hour or more, and its last entry is then a block cut off midway.
  // That entry counts as finished only if the body's own time (when this
  // page saw the score rise) is past its end. Time unknown (0) trusts it.
  const lastEnd = Date.parse(match.start_time) + total * 2 * 3600000;
  const dataAt = matchScoreRoseAt(match.id);
  const stalled = !!progress && total >= 1 && progress.index > total
    && dataAt > 0 && dataAt <= lastEnd;
  const cut = scored || stalled ? total - 1 : total;
  // The score is the body's, which may be minutes behind the clock: the pace
  // divides by how far into the block the body was. A body from before this
  // block says nothing of it, so it is at the start; the clock's fraction caps it.
  const dp = live && dataAt > 0 ? skirmishProgress(match, dataAt) : null;
  let dataFraction = progress ? progress.fraction : 0;
  if (dp) dataFraction = dp.index < progress.index ? 0 : Math.min(dp.fraction, progress.fraction);
  for (const side of sides) side.done = side.series.slice(0, cut);

  const mine = sides.find((x) => x.color === color);
  if (!mine) return;

  // How much of this can be drawn: the chart needs two finished blocks, the
  // figures one, the band reporting the block being played none.
  const finished = mine.done.length;

  if (finished >= 1) {
    // Three figures, all about finished blocks; the running one is reported
    // separately below. The average gives the other two their meaning.
    const avg = Math.round(mine.done.reduce((a, b) => a + b, 0) / mine.done.length);
    const figures = document.createElement('div');
    figures.className = 'pop-figures pop-figures--three';
    const fLast = popFigure('Last block', mine.done[mine.done.length - 1].toLocaleString());
    fLast.title = 'The most recent block that has finished - not the one being played now.';
    // An average needs something to average over and a peak something to stand out
    // from. With one finished block both would report the same score under labels
    // promising a comparison, so they hold a dash. The cards stay: they
    // say the tool measures this.
    const comparable = finished >= 2;
    const waiting = 'Needs two finished blocks to mean anything. There is one so far.';
    const fAvg = popFigure('Average', comparable ? avg.toLocaleString() : '—');
    fAvg.title = comparable
      ? `Mean score across the ${finished} finished blocks this week.`
      : waiting;
    const fPeak = popFigure('Peak',
      comparable ? Math.max(...mine.done).toLocaleString() : '—');
    fPeak.title = comparable ? 'The best single block this week.' : waiting;
    figures.appendChild(fLast);
    figures.appendChild(fAvg);
    figures.appendChild(fPeak);
    popover.appendChild(figures);
  }

  if (finished >= 2) {
    let min = Infinity;
    let max = -Infinity;
    for (const side of sides) {
      for (const v of side.done) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    // A plot area inset from the box, so the scale numbers have somewhere
    // to live that is not on top of the lines.
    const W = 380;
    const H = 132;
    const X0 = 50;
    const X1 = W - 8;
    const Y0 = 12;
    const Y1 = H - 18;
    const range = max - min || 1;
    const plot = (values) => values
      .map((v, i) => {
        const x = X0 + (i / (values.length - 1)) * (X1 - X0);
        const y = Y1 - ((v - min) / range) * (Y1 - Y0);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

    const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chart.setAttribute('viewBox', `0 0 ${W} ${H}`);
    chart.setAttribute('class', 'activity-chart');
    let markup = '';
    for (const [value, y] of [[max, Y0], [Math.round((max + min) / 2), (Y0 + Y1) / 2], [min, Y1]]) {
      markup += `<line x1="${X0}" y1="${y}" x2="${X1}" y2="${y}" class="trend-grid"/>`
        + `<text x="${X0 - 7}" y="${(y + 3).toFixed(1)}" class="trend-scale" text-anchor="end">`
        + `${value.toLocaleString()}</text>`;
    }
    // A day is 12 blocks; day ticks let the eye place points in time.
    const BLOCKS_PER_DAY = 12;
    for (let b = BLOCKS_PER_DAY; b < mine.done.length; b += BLOCKS_PER_DAY) {
      const x = (X0 + ((b - 1) / (mine.done.length - 1)) * (X1 - X0)).toFixed(1);
      markup += `<line x1="${x}" y1="${Y0}" x2="${x}" y2="${Y1}" class="trend-day"/>`
        + `<text x="${x}" y="${Y1 + 12}" class="trend-scale trend-day-label" `
        + `text-anchor="middle">${b / BLOCKS_PER_DAY}d</text>`;
    }
    for (const side of sides) {
      if (side.color === color) continue;
      markup += `<polyline points="${plot(side.done)}" class="trend-line trend-line--${side.color}"/>`;
    }
    markup += `<polyline points="${plot(mine.done)}" class="activity-line activity-line--${color}"/>`;
    const lastX = X1;
    const lastY = Y1 - ((mine.done[mine.done.length - 1] - min) / range) * (Y1 - Y0);
    markup += `<circle cx="${lastX}" cy="${lastY.toFixed(1)}" r="3.5" class="activity-dot activity-dot--${color}"/>`;
    chart.innerHTML = markup;
    popover.appendChild(chart);

    // The right-hand label is about the week, not the block being played: two
    // different clocks.
    const hoursIn = progress ? (progress.index - 1) * 2 + progress.fraction * 2 : cut * 2;
    const weekPct = Math.min(100, Math.round((hoursIn / 168) * 100));
    const axis = document.createElement('div');
    axis.className = 'activity-axis';
    // Counted as blocks finished, not "block N": the band below names the block in
    // progress, and "Block 64 of 84" beside "Block 65" reads as a contradiction.
    axis.innerHTML = '<span>Reset</span>'
      + `<span title="The chart plots finished blocks only. ${cut} of the week's 84 have `
      + `ended; the one being played is reported below.">`
      + `${cut} of 84 finished · week ${weekPct}%</span>`;
    popover.appendChild(axis);

    // Which line is whose; without it the two thin lines are decoration.
    const legend = document.createElement('div');
    legend.className = 'trend-legend';
    for (const side of sides) {
      const teamId = matchTeamId(match, side.color);
      const item = document.createElement('span');
      item.className = `trend-legend-item${side.color === color ? ' is-mine' : ''}`;
      const dot = document.createElement('i');
      dot.className = `trend-legend-dot trend-legend-dot--${side.color}`;
      item.appendChild(dot);
      item.appendChild(document.createTextNode(teamId ? getTeamName(teamId) : side.color));
      // The lines say who is higher; this says by how much, across the whole week.
      const sideAvg = Math.round(side.done.reduce((a, b) => a + b, 0) / side.done.length);
      const val = document.createElement('b');
      val.className = 'trend-legend-val';
      val.textContent = sideAvg.toLocaleString();
      item.appendChild(val);
      item.title = 'Average score per finished block this week';
      legend.appendChild(item);
    }
    popover.appendChild(legend);
  } else {
    // Says which panel is missing and why, so a gap does not read as a fault.
    const why = document.createElement('p');
    why.className = 'hint';
    why.style.margin = '0';
    why.textContent = finished === 1
      ? 'Only one block done so far. The chart shows up once there are two.'
      : 'First block of the week is still being played.';
    popover.appendChild(why);
  }

  if (live) {
    // Reported as a pace, not a total: "697 so far" invites an unfair comparison
    // with finished blocks. The clock is in minutes: a percentage next to
    // "block 64" is read as the week.
    const mins = Math.round(progress.fraction * 120);
    const running = scored ? mine.series[total - 1] : null;
    const now = document.createElement('div');
    now.className = 'trend-live';
    // Says "the finished ones", not "the chart": this band shows from the first
    // minutes of a week, before there is a chart.
    now.title = 'A skirmish is a 2-hour block, 84 of them from reset to reset. This one '
      + 'is still being played, so its score cannot be compared with the finished ones - '
      + 'the projection can. ArenaNet publishes a running block late, so no projection '
      + 'is offered before the 45-minute mark.';
    const head = document.createElement('span');
    head.className = 'trend-live-head';
    head.innerHTML = `<i class="trend-live-dot"></i>Block ${progress.index} playing · `
      + `${mins} of 120 min`;
    const body = document.createElement('span');
    if (running === null) {
      // The clock is ours, the score is theirs: say the block is running and whose
      // delay the gap is, so it reads neither as "nothing is happening" nor as a fault here.
      body.textContent = stalled
        ? `The game's data stopped partway through block ${total}`
        : "ArenaNet hasn't published this block yet";
    } else if (dataFraction >= LIVE_PROJECT_AFTER) {
      // Two segments, not three: the projection is read against the Average card
      // above. In the first hours of a week there is no Average and the pace stands alone.
      body.innerHTML = `<b>${running.toLocaleString()}</b> so far · on pace for `
        + `<b>${Math.round(running / dataFraction).toLocaleString()}</b>`;
    } else {
      body.innerHTML = `<b>${running.toLocaleString()}</b> so far · too early to project`;
    }
    now.appendChild(head);
    now.appendChild(body);
    popover.appendChild(now);
  }

  // Where the last finished block's points came from: a side level on the total
  // can be getting all of it from one borderland. The block being played stands in
  // when nothing has finished: shares of itself, unlike its total, compare fairly.
  const liveOnly = cut < 1 && scored;
  const block = match.skirmishes[(liveOnly ? total : cut) - 1];
  const mapScores = (block || {}).map_scores;
  if (Array.isArray(mapScores) && mapScores.length) {
    const byType = new Map(mapScores.map((x) => [x.type, x.scores]));
    const values = MAP_ORDER.map((t) => Number(byType.get(t)?.[color] ?? 0));
    const top = Math.max(...values) || 1;
    const sum = values.reduce((a, b) => a + b, 0) || 1;

    popover.appendChild(popSection(
      liveOnly ? 'This block by map' : 'Last block by map',
      [popCell('pop-bar-value', 'Points'), popCell('pop-bar-pct', 'Share')]));
    MAP_ORDER.forEach((type, i) => {
      popover.appendChild(popBarRow(MAP_LABELS[type], MAP_LABEL_CLASS[type],
        values[i] / top, values[i].toLocaleString(),
        `${Math.round((values[i] / sum) * 100)}%`, `own-${color}`));
    });
    popover.appendChild(popBarTotal('Total', null, sum.toLocaleString()));
  }

  // The last sentence is about the chart, so it goes only where the chart went.
  const note = 'A skirmish is a 2-hour block - 84 of them in a week. Most of the score '
    + 'comes from holding objectives, not from kills, so a big number usually means '
    + 'map control.';
  popover.appendChild(popNote(
    finished >= 2 ? `${note} The chart shows finished blocks only.` : note));
}

// Trend icon on the Skirmish stat, opening the score-over-time chart.
function buildSkirmishTrendButton(serverName, match, color) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn activity-btn';
  btn.setAttribute('aria-label', `Show skirmish score trend for ${serverName}`);
  btn.title = `Show skirmish score trend for ${serverName}`;
  markPopoverTrigger(btn);
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M3 17 L9 10 L14 14 L21 5" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  popoverMatches.set(btn, match);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, `${serverName} skirmish score trend`, (popover) => {
      renderSkirmishTrendPopoverContent(popover, serverName, popoverMatches.get(btn), color);
    }, 'info-popover--trend');
  });
  return btn;
}

function renderActivityInfoPopoverContent(popover, serverName, match, color) {
  popover.textContent = '';
  popHeader(popover, `${serverName} · Activity`);

  const kills = Number(match.kills?.[color] ?? 0);
  const deaths = Number(match.deaths?.[color] ?? 0);

  const figures = document.createElement('div');
  figures.className = 'pop-figures pop-figures--three';
  figures.appendChild(popFigure('Kills', kills.toLocaleString()));
  figures.appendChild(popFigure('Deaths', deaths.toLocaleString()));
  figures.appendChild(popFigure('Activity', (kills + deaths).toLocaleString()));
  popover.appendChild(figures);

  // A number of fights alone only says whether the tier is busy; against the
  // other two it says who is showing up.
  const sides = COLORS.map((c) => ({
    color: c,
    total: Number(match.kills?.[c] ?? 0) + Number(match.deaths?.[c] ?? 0),
  }));
  const top = Math.max(...sides.map((x) => x.total)) || 1;
  const all = sides.reduce((a, x) => a + x.total, 0) || 1;

  popover.appendChild(popSection('Against the tier',
    [popCell('pop-bar-value', 'Fights'), popCell('pop-bar-pct', 'Share')]));
  for (const side of sides) {
    const teamId = matchTeamId(match, side.color);
    const row = popBarRow(teamId ? getTeamName(teamId) : side.color, 'pop-bar-label--wide',
      side.total / top, side.total.toLocaleString(),
      `${Math.round((side.total / all) * 100)}%`, `own-${side.color}`);
    if (side.color === color) row.classList.add('is-mine');
    popover.appendChild(row);
  }
  // "Tier total" and not "Total": the three cards at the top of this
  // popover are one side's, and this is all three added up.
  popover.appendChild(popBarTotal('Tier total', 'pop-bar-label--wide',
    all.toLocaleString()));

  popover.appendChild(popNote('Activity is kills + deaths this week - a straightforward measure '
    + 'of combat, with none of the PPT ambiguity skirmish score has. It counts fights, not '
    + 'whether they were won; the K/D beside it says that.'));
}


// Info icon on the Activity stat, explaining what that number means.
// Distinct from the Skirmish trend icon and the K/D map icon on purpose.
function buildActivityInfoButton(serverName, match, color) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn activity-info-btn';
  btn.setAttribute('aria-label', `What is Activity for ${serverName}?`);
  btn.title = `What is Activity for ${serverName}?`;
  markPopoverTrigger(btn);
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M13 2 L4 14 h6 l-1 8 l9 -12 h-6 Z"/></svg>';
  popoverMatches.set(btn, match);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, `What Activity means for ${serverName}`, (popover) => {
      renderActivityInfoPopoverContent(popover, serverName, popoverMatches.get(btn), color);
    }, 'info-popover--data');
  });
  return btn;
}

