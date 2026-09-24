'use strict';
// ---------------------------------------------------------------------
// Server guild lists
// The alliance grid and solo list shown from a standings row, and the
// button that opens it.
// ---------------------------------------------------------------------

const EXPAND_ICON_EXPAND = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M15 4H20V9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M9 20H4V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M20 4L13 11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M4 20L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EXPAND_ICON_COLLAPSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M20 9H15V4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M4 15H9V20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M15 9L21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M9 15L3 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function buildAllianceCard(alliance) {
  const block = document.createElement('div');
  block.className = 'alliance-block';
  const name = document.createElement('div');
  name.className = 'alliance-name';
  name.textContent = alliance.tag ? `[${alliance.tag}] ${alliance.name}` : alliance.name;
  block.appendChild(name);
  block.appendChild(buildGuildList(alliance.members));
  return block;
}

// Compact mode: plain stacked list. Expanded mode: columns bin-packed
// by measured card height (largest first, into the shortest column),
// so columns stay even even when alliance sizes vary a lot.
function layoutAllianceGrid(grid, alliances, expanded) {
  grid.textContent = '';
  if (!expanded) {
    for (const alliance of alliances) grid.appendChild(buildAllianceCard(alliance));
    return;
  }

  const COL_WIDTH = 220, GAP = 12, MAX_COLS = 4;
  const gridWidth = grid.getBoundingClientRect().width || 0;
  const numCols = Math.max(1, Math.min(
    MAX_COLS, alliances.length, Math.floor((gridWidth + GAP) / (COL_WIDTH + GAP)) || 1
  ));

  const columns = [];
  for (let i = 0; i < numCols; i++) {
    const col = document.createElement('div');
    col.className = 'alliance-grid-col';
    grid.appendChild(col);
    columns.push(col);
  }

  if (numCols === 1) {
    for (const alliance of alliances) columns[0].appendChild(buildAllianceCard(alliance));
    return;
  }

  // Build every card into the first column so all of them share the same
  // final column width, then read their real heights in one batch.
  const cards = alliances.map(a => ({ el: buildAllianceCard(a), height: 0 }));
  for (const c of cards) columns[0].appendChild(c.el);
  for (const c of cards) c.height = c.el.getBoundingClientRect().height;
  cards.sort((a, b) => b.height - a.height);

  const colHeights = new Array(numCols).fill(0);
  for (const c of cards) {
    let target = 0;
    for (let i = 1; i < numCols; i++) {
      if (colHeights[i] < colHeights[target]) target = i;
    }
    columns[target].appendChild(c.el); // moves it out of column 0 automatically
    colHeights[target] += c.height + GAP;
  }
}

function buildGuildList(entries) {
  const list = document.createElement('div');
  list.className = 'guild-list';
  for (const entry of entries) {
    const line = document.createElement('div');
    line.className = 'guild-line';
    if (entry.tag) {
      const tag = document.createElement('span');
      tag.className = 'guild-tag';
      tag.textContent = `[${entry.tag}] `;
      line.appendChild(tag);
    }
    line.appendChild(document.createTextNode(entry.name));
    if (entry.region) {
      const region = document.createElement('span');
      region.className = 'guild-region';
      region.textContent = ` (${entry.region})`;
      line.appendChild(region);
    }
    list.appendChild(line);
  }
  return list;
}

function renderGuildsPopoverContent(popover, teamName, data, triggerEl) {
  popover.textContent = '';
  popover.classList.remove('info-popover--expanded');

  const header = document.createElement('div');
  header.className = 'info-popover-header';
  const title = document.createElement('span');
  title.textContent = teamName;
  header.appendChild(title);

  const actions = document.createElement('div');
  actions.className = 'info-popover-header-actions';

  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'info-popover-expand';
  expandBtn.innerHTML = EXPAND_ICON_EXPAND;
  expandBtn.setAttribute('aria-label', 'Expand for a full-list screenshot');
  expandBtn.title = expandBtn.getAttribute('aria-label');
  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const nowExpanded = !popover.classList.contains('info-popover--expanded');
    setPopoverExpanded(popover, triggerEl, nowExpanded);
  });
  actions.appendChild(expandBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'info-popover-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.addEventListener('click', closePopover);
  actions.appendChild(closeBtn);

  header.appendChild(actions);
  popover.appendChild(header);

  // Everything except header/footer lives in this container so the
  // expanded (screenshot) mode can lay it out in multiple columns.
  const body = document.createElement('div');
  body.className = 'info-popover-body';

  const hasAlliances = data && data.alliances.length > 0;
  const hasSolo = data && data.solo.length > 0;

  if (!hasAlliances && !hasSolo) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.style.margin = '0';
    empty.textContent = 'No guilds listed for this server in the community sheet yet.';
    body.appendChild(empty);
  } else {
    if (hasAlliances) {
      const wrap = document.createElement('div');
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'info-popover-section-title';
      sectionTitle.textContent = 'Alliances';
      wrap.appendChild(sectionTitle);
      const grid = document.createElement('div');
      grid.className = 'alliance-grid';
      wrap.appendChild(grid);
      body.appendChild(wrap);
      popover.__allianceData = data.alliances;
      layoutAllianceGrid(grid, data.alliances, false);
    }
    if (hasSolo) {
      const wrap = document.createElement('div');
      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'info-popover-section-title';
      sectionTitle.textContent = 'Solo guilds';
      wrap.appendChild(sectionTitle);
      wrap.appendChild(buildGuildList(data.solo));
      body.appendChild(wrap);
    }
  }
  popover.appendChild(body);

  const footer = document.createElement('p');
  footer.className = 'info-popover-footer';
  footer.textContent = 'Community-maintained, may be incomplete or outdated. ';
  const link = document.createElement('a');
  link.href = SHEET_HUMAN_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Open sheet';
  footer.appendChild(link);
  popover.appendChild(footer);
}

async function toggleGuildsPopover(teamName, triggerEl) {
  const popover = openPopover(triggerEl, `Guilds on ${teamName}`, (el) => {
    const loading = document.createElement('p');
    loading.className = 'hint';
    loading.style.margin = '0';
    loading.innerHTML = '<span class="spinner"></span>Loading community list…';
    el.appendChild(loading);
  }, 'info-popover--guilds');
  if (!popover) return; // it was already open; openPopover just closed it

  let byTeam;
  try {
    byTeam = await loadCommunityGuilds();
  } catch {
    if (activeTrigger !== triggerEl) return;
    popover.textContent = '';
    const msg = document.createElement('p');
    msg.className = 'hint';
    msg.style.margin = '0';
    msg.textContent = "Couldn't load the community guild list right now.";
    popover.appendChild(msg);
    return;
  }

  if (activeTrigger !== triggerEl) return; // closed while loading
  renderGuildsPopoverContent(popover, teamName, byTeam.get(teamName), triggerEl);
  positionPopover(popover, triggerEl);
}

// Small shield icon with an info mark inside, next to NA server names
// only. Opens the community guild list popover on click.
function buildServerGuildsButton(teamName) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn server-guilds-btn';
  btn.setAttribute('aria-label', `Show guilds on ${teamName}`);
  btn.title = `Show guilds on ${teamName}`;
  markPopoverTrigger(btn);
  btn.innerHTML = '<svg width="17" height="19" viewBox="0 0 24 27" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M12 2 L21 4.5 V13 C21 19 17 23.5 12 25.5 C7 23.5 3 19 3 13 V4.5 Z" ' +
    'fill="currentColor" fill-opacity=".18" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>' +
    '<circle cx="12" cy="9.5" r="1.6" fill="currentColor"/>' +
    '<rect x="10.4" y="13.2" width="3.2" height="8" rx="1.6" fill="currentColor"/></svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleGuildsPopover(teamName, btn);
  });
  return btn;
}

