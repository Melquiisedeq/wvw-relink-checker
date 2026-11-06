'use strict';
// LAB (never merged). Design A, the match room: each tier is one card that opens a modal
// <dialog> with the tier's teams and three tabs, drawn by the site's own functions.
// The maps tab is the site's maps popover itself, opened on an anchor inside the room and
// moved into it (afterPopoverOpen): fillTierMaps keeps it live while activeTrigger is that
// anchor, so nothing here may let popover.js close it (the room swallows its clicks).
LAB_DESIGNS.a = (() => {
  const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'maps', label: 'Maps' },
    { id: 'guilds', label: 'Guilds' },
    { id: 'stats', label: 'Stats', soon: 'E4' },
  ];
  const state = { matchId: null, tab: 'overview', color: null, guildColor: null, overviewOf: null };
  let room = null;

  const cards = () => [...document.querySelectorAll('.standings-grid .standing-match.lab-a-card')];
  const cardOf = (id) => cards().find((b) => b.dataset.matchId === id) || null;

  // What the card's own maps button holds: kept current by patchStandingMatch.
  function infoOf(id) {
    const card = cardOf(id);
    const btn = card && card.querySelector(':scope > .standing-match-title .tier-map-btn');
    return (btn && tierMapButtons.get(btn)) || null;
  }

  function ranked(match) {
    const rankBy = rankMatchByVictoryPoints(match);
    return [...COLORS].sort((a, b) => rankBy[a] - rankBy[b]).map((c) => ({ color: c, rank: rankBy[c] }));
  }

  function teamMark(color, rank) {
    const frag = document.createDocumentFragment();
    frag.append(labEl('span', `rank-badge rank-${rank}`, String(rank)), labEl('span', `dot dot-${color}`));
    return frag;
  }

  // ---- the board ------------------------------------------------------------------
  function decorate(gridEl) {
    for (const box of gridEl.querySelectorAll(':scope > .standing-match')) {
      const title = box.querySelector(':scope > .standing-match-title');
      const mapBtn = title && title.querySelector('.tier-map-btn');
      const live = !!box.querySelector(':scope > .standing-side');
      box.classList.toggle('lab-a-card', !!mapBtn && live);
      if (!mapBtn || !live) continue;
      if (!title.querySelector('.lab-a-open')) {
        const tier = title.querySelector(':scope > span:first-child');
        const open = labEl('button', 'lab-a-open lab-more');
        open.type = 'button';
        open.setAttribute('aria-haspopup', 'dialog');
        if (tier) open.appendChild(tier);
        title.prepend(open);
      }
      const info = tierMapButtons.get(mapBtn);
      const open = title.querySelector('.lab-a-open');
      if (info) open.setAttribute('aria-label', `Open ${info.regionName} Tier ${info.tierNum}`);
      const word = mapBtn.querySelector('.tier-map-label');
      if (word && word.textContent !== 'Maps') word.textContent = 'Maps';
    }
  }

  // Ahead of the buttons' own listeners: on a card, both open the room.
  function onGridClick(e) {
    const t = e.target.closest && e.target.closest('.lab-a-open, .tier-map-btn');
    const box = t && t.closest('.lab-a-card');
    if (!box) return;
    e.stopPropagation();
    e.preventDefault();
    openRoom(box.dataset.matchId, t.classList.contains('tier-map-btn') ? 'maps' : 'overview');
  }

  // ---- the room -------------------------------------------------------------------
  function build() {
    const dlg = labEl('dialog', 'lab-a-room');
    dlg.setAttribute('closedby', 'any');
    dlg.setAttribute('aria-labelledby', 'labARoomTitle');
    const shell = labEl('div', 'lab-a-shell');
    const head = labEl('div', 'lab-a-head');
    const top = labEl('div', 'lab-a-top');
    const title = labEl('h2', 'lab-a-title');
    title.id = 'labARoomTitle';
    const close = labEl('button', 'lab-a-close lab-tap');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the match');
    close.appendChild(labIcon(LAB_CROSS, 20));
    close.addEventListener('click', () => dlg.close());
    top.append(title, close);
    const teams = labEl('ol', 'lab-a-teams');
    const tablist = labEl('div', 'lab-a-tabs');
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Match');
    head.append(top, teams, tablist);
    const body = labEl('div', 'lab-a-body');
    const tabs = {};
    const panels = {};
    for (const t of TABS) {
      const b = labEl('button', 'lab-a-tab');
      b.type = 'button';
      b.id = `labATab-${t.id}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', `labAPanel-${t.id}`);
      b.appendChild(labEl('span', 'lab-a-tab-word', t.label));
      if (t.soon) {
        b.disabled = true;
        b.appendChild(labEl('span', 'lab-a-soon', t.soon));
      } else {
        b.addEventListener('click', () => select(t.id, false));
      }
      tablist.appendChild(b);
      tabs[t.id] = b;
      const p = labEl('div', 'lab-a-panel');
      p.id = `labAPanel-${t.id}`;
      p.setAttribute('role', 'tabpanel');
      p.setAttribute('aria-labelledby', b.id);
      p.hidden = true;
      body.appendChild(p);
      panels[t.id] = p;
    }
    tablist.addEventListener('keydown', onTabKey);
    // The maps popover's anchor: in the room, so it is never out of sight.
    const anchor = labEl('span', 'lab-a-anchor');
    panels.maps.appendChild(anchor);
    const mapsHost = labEl('div', 'lab-a-maps');
    panels.maps.appendChild(mapsHost);
    shell.append(head, body);
    dlg.appendChild(shell);
    // popover.js closes the open popover on any click outside it; the maps live in here.
    dlg.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === dlg) dlg.close();
    });
    dlg.addEventListener('close', onClose);
    document.body.appendChild(dlg);
    room = { dlg, title, teams, tabs, panels, body, anchor, mapsHost };
  }

  function onTabKey(e) {
    const order = TABS.filter((t) => !room.tabs[t.id].disabled && !room.tabs[t.id].hidden).map((t) => t.id);
    const i = order.indexOf(state.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = order[(i + 1) % order.length];
    else if (e.key === 'ArrowLeft') next = order[(i - 1 + order.length) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order[order.length - 1];
    if (!next) return;
    e.preventDefault();
    select(next, true);
  }

  function openRoom(matchId, tab) {
    if (!room) build();
    const same = state.matchId === matchId;
    if (!same) {
      if (activeTrigger === room.anchor) closePopover();
      state.matchId = matchId;
      state.color = null;
      state.guildColor = null;
      state.overviewOf = null;
      for (const p of Object.values(room.panels)) p.dataset.drawn = '';
    }
    const na = matchId.startsWith('1-');
    room.tabs.guilds.hidden = !na;
    paintHead();
    if (!room.dlg.open) room.dlg.showModal();
    select(na || tab !== 'guilds' ? tab : 'overview', true);
    room.body.scrollTop = 0;
  }

  function onClose() {
    if (activeTrigger === room.anchor) closePopover();
    for (const p of Object.values(room.panels)) p.dataset.drawn = '';
  }

  function select(tab, moveFocus) {
    const was = state.tab;
    state.tab = tab;
    if (was === 'maps' && tab !== 'maps' && activeTrigger === room.anchor) closePopover();
    for (const t of TABS) {
      const on = t.id === tab;
      room.tabs[t.id].setAttribute('aria-selected', on ? 'true' : 'false');
      room.tabs[t.id].tabIndex = on ? 0 : -1;
      room.panels[t.id].hidden = !on;
    }
    if (tab === 'overview') drawOverview();
    else if (tab === 'maps') drawMaps();
    else if (tab === 'guilds') drawGuilds();
    if (moveFocus) room.tabs[tab].focus({ preventScroll: true });
  }

  function paintHead() {
    const info = infoOf(state.matchId);
    const [code, tierNum] = state.matchId.split('-');
    room.title.textContent = `${REGION_NAMES[code] || 'Region'} · Tier ${tierNum}`;
    if (!info) return;
    const m = info.match;
    room.teams.textContent = '';
    for (const { color, rank } of ranked(m)) {
      const li = labEl('li', `lab-a-team side-${color}`);
      li.appendChild(teamMark(color, rank));
      li.appendChild(labEl('span', 'lab-a-team-name', getTeamName(matchTeamId(m, color))));
      const vp = labEl('span', 'lab-a-team-vp');
      vp.append(labEl('span', 'stat-label', 'VP '), labEl('span', 'stat-value',
        Number(m.victory_points?.[color] ?? 0).toLocaleString()));
      vp.appendChild(buildMovementIndicator(code, tierNum, rank, isTiedOnVp(m, color)));
      li.appendChild(vp);
      room.teams.appendChild(li);
    }
  }

  // Three teams to choose from; `stats` adds the card's three numbers as text.
  function picker(m, current, stats, onPick) {
    const wrap = labEl('div', 'lab-a-picker');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Team');
    for (const { color, rank } of ranked(m)) {
      const b = labEl('button', `lab-a-pick side-${color}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', color === current ? 'true' : 'false');
      const top = labEl('span', 'lab-a-pick-top');
      top.appendChild(teamMark(color, rank));
      top.appendChild(labEl('span', 'lab-a-pick-name', getTeamName(matchTeamId(m, color))));
      b.appendChild(top);
      if (stats) {
        const kills = Number(m.kills?.[color] ?? 0);
        const deaths = Number(m.deaths?.[color] ?? 0);
        const skirmish = getSkirmishScore(m, color);
        const pairs = [];
        if (skirmish !== null) pairs.push(['Skirmish', formatCompact(skirmish)]);
        pairs.push(['Activity', formatCompact(kills + deaths)], ['K/D', formatKd(kills, deaths)]);
        b.appendChild(buildStatsLine(pairs, 'lab-a-pick-stats'));
      }
      b.addEventListener('click', () => onPick(color));
      wrap.appendChild(b);
    }
    return wrap;
  }

  function drawOverview() {
    const p = room.panels.overview;
    const info = infoOf(state.matchId);
    if (!info) { if (!p.dataset.drawn) p.textContent = 'This match is not on the board right now.'; return; }
    const m = info.match;
    const order = ranked(m).map((r) => r.color);
    if (!order.includes(state.color)) state.color = order[0];
    if (p.dataset.drawn && state.overviewOf === m && p.dataset.color === state.color) return;
    state.overviewOf = m;
    p.dataset.drawn = '1';
    p.dataset.color = state.color;
    const hadFocus = p.contains(document.activeElement) && document.activeElement.closest('.lab-a-pick');
    p.textContent = '';
    p.appendChild(picker(m, state.color, true, (c) => { state.color = c; drawOverview(); focusPick(p, c); }));
    const name = getTeamName(matchTeamId(m, state.color));
    const panes = labEl('div', 'lab-a-panes');
    for (const [cls, draw] of [
      ['lab-a-pane--trend', renderSkirmishTrendPopoverContent],
      ['lab-a-pane--activity', renderActivityInfoPopoverContent],
      ['lab-a-pane--kd', renderMapKdPopoverContent],
    ]) {
      const pane = labEl('section', `lab-a-pane ${cls}`);
      draw(pane, name, m, state.color);
      const h = pane.querySelector('.info-popover-header > span');
      if (h) pane.setAttribute('aria-label', h.textContent);
      panes.appendChild(pane);
    }
    p.appendChild(panes);
    if (hadFocus) focusPick(p, state.color);
  }

  function focusPick(p, color) {
    const b = p.querySelector(`.lab-a-pick.side-${color}`);
    if (b) b.focus({ preventScroll: true });
  }

  function drawMaps() {
    const info = infoOf(state.matchId);
    if (!info) { room.mapsHost.textContent = 'This match is not on the board right now.'; return; }
    if (activeTrigger === room.anchor) return;
    room.mapsHost.textContent = '';
    const popover = openPopover(room.anchor, `${info.regionName} Tier ${info.tierNum} maps`,
      showMapsLoading, 'info-popover--maps');
    if (!popover) return;
    room.tabs.maps.focus({ preventScroll: true });
    fillWhenLoaded(popover, info.match, info.regionName, info.tierNum, room.anchor);
  }

  function drawGuilds() {
    const p = room.panels.guilds;
    const info = infoOf(state.matchId);
    if (!info) { p.textContent = 'This match is not on the board right now.'; return; }
    const m = info.match;
    const order = ranked(m).map((r) => r.color);
    if (!order.includes(state.guildColor)) state.guildColor = order[0];
    if (p.dataset.drawn === state.guildColor) return;
    p.dataset.drawn = state.guildColor;
    const color = state.guildColor;
    const hadFocus = p.contains(document.activeElement);
    p.textContent = '';
    const pick = picker(m, color, false, (c) => { state.guildColor = c; drawGuilds(); focusPick(p, c); });
    const list = labEl('div', 'lab-a-guilds');
    const wait = labEl('p', 'hint lab-a-wait');
    wait.append(labEl('span', 'spinner'), document.createTextNode('Loading community list…'));
    list.appendChild(wait);
    p.append(pick, list);
    if (hadFocus) focusPick(p, color);
    const teamName = getTeamName(matchTeamId(m, color));
    loadCommunityGuilds().then((byTeam) => {
      if (!list.isConnected) return;
      renderGuildsPopoverContent(list, teamName, byTeam.get(teamName), pick.querySelector(`.side-${color}`));
      layoutGuilds();
    }, () => {
      if (list.isConnected) list.textContent = "Couldn't load the community guild list right now.";
    });
  }

  // The columns of the site's expanded list, at the room's width.
  function layoutGuilds() {
    const list = room && room.panels.guilds.querySelector('.lab-a-guilds');
    const grid = list && list.querySelector('.alliance-grid');
    if (grid && list.__allianceData && !room.panels.guilds.hidden) layoutAllianceGrid(grid, list.__allianceData, true);
  }

  // ---- the search -------------------------------------------------------------------
  function matchOfTeam(teamName) {
    for (const card of cards()) {
      const info = infoOf(card.dataset.matchId);
      if (info && COLORS.some((c) => getTeamName(matchTeamId(info.match, c)) === teamName)) return card.dataset.matchId;
    }
    return null;
  }

  function addOpenMatch() {
    for (const cell of resultBody.querySelectorAll('tr > td:last-child')) {
      const name = cell.querySelector('.server-cell .status-ok');
      if (!name || cell.querySelector('.lab-a-openmatch')) continue;
      const id = matchOfTeam(name.textContent);
      if (!id) continue;
      const b = labEl('button', 'lab-a-openmatch lab-more', 'Open match');
      b.type = 'button';
      b.setAttribute('aria-haspopup', 'dialog');
      b.addEventListener('click', () => openRoom(id, 'overview'));
      cell.appendChild(b);
    }
  }

  return {
    boot() {
      for (const g of [standingsGridNA, standingsGridEU]) g.addEventListener('click', onGridClick, true);
      let w = window.innerWidth;
      window.addEventListener('resize', () => {
        if (Math.abs(window.innerWidth - w) < 2) return;
        w = window.innerWidth;
        if (room && room.dlg.open && state.tab === 'guilds') layoutGuilds();
      });
    },
    afterStandings(gridEl) {
      decorate(gridEl);
      if (!room || !room.dlg.open || !gridEl.querySelector(':scope > .lab-a-card')) return;
      if (!cards().some((c) => c.dataset.matchId === state.matchId && gridEl.contains(c))) return;
      paintHead();
      if (state.tab === 'overview') drawOverview();
    },
    afterRun() {
      addOpenMatch();
    },
    afterPopoverOpen(popover, triggerEl) {
      if (!room || triggerEl !== room.anchor) return;
      // In the room's flow; "expanded" keeps popover.js from closing it on a resize.
      popover.classList.add('lab-a-inroom', 'info-popover--expanded');
      popover.style.left = '';
      popover.style.top = '';
      room.mapsHost.appendChild(popover);
    },
  };
})();
