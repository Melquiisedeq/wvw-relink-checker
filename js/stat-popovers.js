'use strict';
// ---------------------------------------------------------------------
// Stat popovers
// K/D by map, the skirmish score trend chart, and what Activity means.
// Built from the pieces in popover-parts.js.
// ---------------------------------------------------------------------

// Drawn and not typed. As emoji the two landed in different system
// fonts, each with its own idea of where the baseline is, and no amount
// of centring gets those onto the same line.
//
// "swords" and "skull" from Lucide (https://lucide.dev), ISC licence:
// Copyright (c) 2026 Lucide Icons and Contributors. Same 24x24 grid and
// 2px round stroke the buttons on this page are already drawn on, so
// nothing new is being introduced here except the shapes.
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

// The three column words travel as one group, the same group the three
// numbers travel in on every row below - which is what keeps a word over
// its own number.
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
    kills === deaths ? null : (kills > deaths ? 'good' : 'bad')));
  popover.appendChild(figures);

  // One row per map: the bar says where the fighting was, the numbers
  // say how it went. A K/D on its own hides the difference between a
  // 2.0 over six fights and a 2.0 over six hundred - the bar is what
  // puts that back.
  // No total beside the heading: the three column headings under it are
  // what that space is for now, and the cards at the top of the popover
  // already carry the kills and the deaths this would be adding up.
  popover.appendChild(popSection('Where the fighting was', [kdHeadCells()]));
  for (const r of rows) {
    const fought = r.kills + r.deaths;
    const row = document.createElement('div');
    row.className = 'pop-bar-row pop-kd-row';

    const label = popBarLabel(MAP_LABELS[r.type], MAP_LABEL_CLASS[r.type]);

    // The bar is how much of the week's fighting happened on this map, which
    // is what the heading asks. It used to be the share of that map's fights
    // this side won, with the volume smuggled into the bar's opacity - two
    // unrelated quantities in one element, one of them unreadable - and it
    // duplicated the K/D at the end of the row.
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
    if (r.kills !== r.deaths) ratio.classList.add(r.kills > r.deaths ? 'kd-good' : 'kd-bad');

    // The three numbers travel together in their own group, so the bar
    // takes the slack instead of it being shared out between them and
    // pushing them to opposite ends of the row.
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

// Small crossed-swords icon next to the K/D value, opening a per-map breakdown.
// Data is already in `match`, so this needs no fetch, unlike the guild list.
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
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, `${serverName} K/D by map`, (popover) => {
      renderMapKdPopoverContent(popover, serverName, match, color);
    }, 'info-popover--data');
  });
  return btn;
}

// How far into a block the projection is allowed to start. ArenaNet
// publishes a running block's score about fifteen minutes late, so an
// early estimate divides their lagging number by our honest clock and
// lands far too low: measured at 2,690 against a weekly average of
// 4,771 for the same side. Past three quarters of an hour the lag is a
// small fraction of the time elapsed and the estimate settles - at 109
// minutes the same match projected 5,013 against that 4,771.
const LIVE_PROJECT_AFTER = 0.375;  // 45 of the 120 minutes

// Which skirmish block the match is in, and how far through it.
// Skirmishes are two hours each, counted from the match start, and the
// API publishes the running one alongside the finished ones with the
// score it has gathered so far - so a block that is 30 minutes old
// holds about a quarter of what a finished one holds, and anything
// comparing the last entry against the others is comparing a part to a
// series of wholes.
function skirmishProgress(match) {
  const start = Date.parse(match.start_time);
  if (!Number.isFinite(start)) return null;
  const end = Date.parse(match.end_time);
  const now = Math.min(Date.now(), Number.isFinite(end) ? end : Infinity);
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

  // All three sides, not just this one. A dip means nothing on its own -
  // it could be this server losing ground or all three going quiet at
  // four in the morning - and the only way to tell them apart is to see
  // the other two. The chosen side is the solid line; the others are
  // thin, in their own colours, on the same scale.
  const progress = skirmishProgress(match);
  const sides = COLORS.map((c) => ({ color: c, series: getSkirmishSeries(match, c) }));
  const total = sides[0].series.length;

  // The last block is usually still being played and the API scores it as
  // it goes, so plotting it beside finished ones ended every chart in a
  // cliff. It is left off the line and reported underneath instead.
  //
  // But the API does not append that block to every match at the same
  // moment: measured at 10:12 UTC, one EU match carried 69 skirmishes
  // while the other two carried 68. So whether the block is being played
  // and whether its score has been published are two different questions,
  // and asking only the second made the live band vanish.
  const live = progress && progress.index >= total && progress.fraction > 0;
  const scored = live && progress.index === total;
  const cut = scored ? total - 1 : total;
  for (const side of sides) side.done = side.series.slice(0, cut);

  const mine = sides.find((x) => x.color === color);
  if (!mine) return;

  // How much of this can be drawn. Only the chart needs two finished
  // blocks; the figures need one, and the band reporting the block being
  // played needs none. They used to share one gate, so for the first
  // four hours of every week the whole popover said there was nothing
  // here while the live band underneath had the only number anyone
  // wanted.
  const finished = mine.done.length;

  if (finished >= 1) {
    // Three figures, all about finished blocks; the running one is reported
    // separately below, where it cannot be mistaken for them. The average
    // is what gives the other two a meaning - a peak of 2,000 reads very
    // differently against an average of 1,900 than against one of 900.
    const avg = Math.round(mine.done.reduce((a, b) => a + b, 0) / mine.done.length);
    const figures = document.createElement('div');
    figures.className = 'pop-figures pop-figures--three';
    const fLast = popFigure('Last block', mine.done[mine.done.length - 1].toLocaleString());
    fLast.title = 'The most recent block that has finished - not the one being played now.';
    // An average needs something to average over and a peak needs
    // something to stand out from. With one finished block both report
    // that same block's score under labels that promise a comparison, so
    // they hold a dash instead - the same one the results table uses for
    // a value it does not have. The cards stay rather than disappearing:
    // they say the tool measures this, and that it is worth coming back
    // once the week has a few blocks in it.
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
    // A day is 12 blocks, and sixty-odd unlabelled points along an axis is
    // not something anyone can place in time. The ticks turn "somewhere in
    // the middle" into "Sunday".
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

    // The right-hand label is about the week, not about the block being
    // played - those are two different clocks, and a percentage sitting
    // next to "of 84" was being read as one.
    const hoursIn = progress ? (progress.index - 1) * 2 + progress.fraction * 2 : cut * 2;
    const weekPct = Math.min(100, Math.round((hoursIn / 168) * 100));
    const axis = document.createElement('div');
    axis.className = 'activity-axis';
    // Counted as blocks finished, not as "block N", because the band below
    // names the block being played right now - and "Block 64 of 84" next to
    // "Block 65" reads as a contradiction when it is simply the difference
    // between the last one that ended and the one in progress.
    axis.innerHTML = '<span>Reset</span>'
      + `<span title="The chart plots finished blocks only. ${cut} of the week's 84 have `
      + `ended; the one being played is reported below.">`
      + `${cut} of 84 finished · week ${weekPct}%</span>`;
    popover.appendChild(axis);

    // Which line is whose. Without this the two thin lines are decoration.
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
      // The lines say who is higher; this says by how much, across the
      // whole week rather than at whatever point the eye happens to land.
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
    // Says which panel is missing and why, rather than letting a gap
    // read as a fault. The rest of the popover carries on underneath.
    const why = document.createElement('p');
    why.className = 'hint';
    why.style.margin = '0';
    why.textContent = finished === 1
      ? 'Only one block done so far. The chart shows up once there are two.'
      : 'First block of the week is still being played.';
    popover.appendChild(why);
  }

  if (live) {
    // Reported as a pace rather than a total: "697 so far" invites a
    // comparison with finished blocks that is not a fair one, and what
    // it is on course for is. The clock is in minutes, not a percentage:
    // a percentage next to "block 64" gets read as the week, and this one
    // is about these two hours and has to be unmistakable about it.
    const mins = Math.round(progress.fraction * 120);
    const running = scored ? mine.series[total - 1] : null;
    const now = document.createElement('div');
    now.className = 'trend-live';
    // Says "the finished ones" rather than "the chart": this band is on
    // screen from the first minutes of a week, when there is no chart to
    // point at yet.
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
      // The clock is ours, the score is theirs. We know the block is
      // running because we can compute it; saying so beats an empty
      // space that reads as "nothing is happening" - and naming whose
      // delay it is stops the gap reading as a fault in this page.
      body.textContent = "ArenaNet hasn't posted this block yet";
    } else if (progress.fraction >= LIVE_PROJECT_AFTER) {
      // Two segments, not three. What the projection is read against is
      // the Average card above - repeating it here bought nothing and
      // cost the line its shape. In the first hours of a week there is no
      // Average yet, and the pace still stands on its own.
      body.innerHTML = `<b>${running.toLocaleString()}</b> so far · on pace for `
        + `<b>${Math.round(running / progress.fraction).toLocaleString()}</b>`;
    } else {
      body.innerHTML = `<b>${running.toLocaleString()}</b> so far · too early to project`;
    }
    now.appendChild(head);
    now.appendChild(body);
    popover.appendChild(now);
  }

  // Where the last finished block's points came from. This is the part
  // that tells a guild where to go: a side can be level on the total and
  // be getting all of it from one borderland.
  //
  // The last finished block when there is one, and the block being
  // played when there is not. Breaking a running block down by map is
  // fair in a way that comparing its total against finished ones is
  // not - these are shares of itself - which is why it can be shown
  // here while the chart still leaves it out.
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

  // The last sentence is about the chart, so it goes only where the
  // chart went. Without this the popover ended by explaining a panel
  // that is not on the screen - which is how it read all morning for
  // every NA side, one finished block into the week.
  const note = 'A skirmish is a 2-hour block - 84 of them in a week. Most of the score '
    + 'comes from holding objectives, not from kills, so a big number usually means '
    + 'map control.';
  popover.appendChild(popNote(
    finished >= 2 ? `${note} The chart shows finished blocks only.` : note));
}

// Trend icon on the Skirmish stat, opening the score-over-time chart we
// already built.
function buildSkirmishTrendButton(serverName, match, color) {
  const series = getSkirmishSeries(match, color);
  // One block is enough to open this. The chart inside needs two that
  // have finished, but it is one panel of several - the block being
  // played right now is reported whatever the chart can do, and that is
  // the part worth reading in the first hours of a week. Hiding the
  // whole control because one panel is short answered the wrong
  // question.
  if (!series.length) return null;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn activity-btn';
  btn.setAttribute('aria-label', `Show skirmish score trend for ${serverName}`);
  btn.title = `Show skirmish score trend for ${serverName}`;
  markPopoverTrigger(btn);
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M3 17 L9 10 L14 14 L21 5" stroke="currentColor" stroke-width="2.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, `${serverName} skirmish score trend`, (popover) => {
      renderSkirmishTrendPopoverContent(popover, serverName, match, color);
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

  // A number of fights means nothing on its own - it only says whether
  // this tier is busy. Against the other two it says who is actually
  // showing up.
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
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(btn, `What Activity means for ${serverName}`, (popover) => {
      renderActivityInfoPopoverContent(popover, serverName, match, color);
    }, 'info-popover--data');
  });
  return btn;
}

