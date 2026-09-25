'use strict';
// ---------------------------------------------------------------------
// The run
// What happens when Check is pressed: parse, look up, render, and the
// saved input and copy buttons around it.
// ---------------------------------------------------------------------

// Cleared before each run, so an earlier timeout cannot strip the class
// off a drop that has only just started.
let deployTimer = null;

async function run() {
  const names = parseGuildNames(guildInput.value);

  if (names.length === 0) {
    statusMsg.textContent = 'Paste at least one guild name first.';
    return;
  }

  runBtn.disabled = true;
  runBtn.innerHTML = '<span class="btn-pips"><span></span><span></span><span></span></span>';
  sparkFromButton();
  startCharge();
  statusMsg.innerHTML = '<span class="spinner"></span>Talking to the GW2 API…';
  resultBody.textContent = '';
  matchPanelsContainer.textContent = '';
  resultsPlaceholder.style.display = 'none';
  resultCard.style.display = 'block';

  const finish = () => {
    runBtn.disabled = false;
    runBtn.textContent = 'Check';
    // Panels drop in straight away; the siege finale plays over the top
    // of them. The class comes off once it has played so it is not still
    // set the next time a check runs.
    pageEl.classList.remove('deploying');
    void pageEl.offsetWidth;
    pageEl.classList.add('deploying');
    clearTimeout(deployTimer);
    deployTimer = setTimeout(() => pageEl.classList.remove('deploying'), 1200);

    playFinale();
  };

  let maps;
  try {
    maps = await getWvwMaps();
  } catch {
    statusMsg.textContent = "Couldn't load WvW data right now, give it another try in a bit.";
    finish();
    return;
  }

  // teamId -> list of your queried guild names that landed there
  const teamsFound = new Map();
  // teamId -> list of dot elements in the table waiting to be colored in
  const dotsByTeam = new Map();
  // Every successfully resolved guild, kept around to build the copy summary
  const successEntries = [];

  // Sequential with a small delay between lookups, gentler on the public API.
  for (const originalName of names) {
    try {
      const guildId = await resolveGuildId(originalName);
      const info = await getGuildInfo(guildId);
      const link = findLink(guildId, maps);

      if (!link) {
        renderRow({ originalName, error: 'No WvW link registered yet' });
      } else {
        const server = getTeamName(link.teamId);
        const dot = renderRow({ originalName, tag: info.tag, region: link.region, server });

        if (!teamsFound.has(link.teamId)) teamsFound.set(link.teamId, []);
        teamsFound.get(link.teamId).push(info.name);

        if (!dotsByTeam.has(link.teamId)) dotsByTeam.set(link.teamId, []);
        dotsByTeam.get(link.teamId).push(dot);

        successEntries.push({ name: info.name, teamId: link.teamId });
      }
    } catch (e) {
      renderRow({ originalName, error: e.message || 'Lookup failed' });
    }

    await sleep(THROTTLE_MS);
  }

  // Fetches match/score context for every distinct team found. Usually
  // instant since these are already in the standings cache.
  if (teamsFound.size > 0) {
    statusMsg.innerHTML = '<span class="spinner"></span>Pulling in match details…';

    const panelsByMatchId = new Map(); // matchId -> { match, yourGuildsByColor }

    for (const [teamId, yourGuildNames] of teamsFound) {
      let match;
      try {
        match = await getMatchForTeam(teamId);
      } catch {
        const note = document.createElement('p');
        note.className = 'panel-note';
        note.textContent = `Match data unavailable for team ${getTeamName(teamId)}.`;
        matchPanelsContainer.appendChild(note);
        await sleep(THROTTLE_MS);
        continue;
      }

      const color = colorForTeam(match, teamId);
      if (!panelsByMatchId.has(match.id)) {
        panelsByMatchId.set(match.id, { match, yourGuildsByColor: { red: [], blue: [], green: [] } });
      }
      if (color) {
        panelsByMatchId.get(match.id).yourGuildsByColor[color].push(...yourGuildNames);
        const dots = dotsByTeam.get(teamId) || [];
        dots.forEach((dot) => {
          if (!dot) return;
          dot.className = `dot dot-${color}`;
          dot.title = `${color[0].toUpperCase()}${color.slice(1)} side`;
        });
      }
    }

    for (const { match, yourGuildsByColor } of panelsByMatchId.values()) {
      matchPanelsContainer.appendChild(renderMatchPanel(match, yourGuildsByColor));
    }
  }

  if (successEntries.length > 0) {
    const { compact, detailed } = await buildSummaryText(successEntries);
    copyChatBtn.dataset.summary = compact;
    copyDiscordBtn.dataset.summary = detailed;
    copyRow.style.display = 'flex';
    copyFeedback.textContent = '';
  } else {
    copyRow.style.display = 'none';
  }

  statusMsg.textContent = `Done, checked ${names.length} guild(s).`;
  finish();
}

runBtn.addEventListener('click', run);
// The button disables itself during a run, but the shortcut bypassed it and
// could start a second run that wiped the first one's rows mid-flight.
guildInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey && !runBtn.disabled) run();
});

// Keeps the pasted list across reloads - the same roster gets re-checked
// every relink. Stays in this browser: nothing is ever sent anywhere.
// Every access is wrapped because a private window, or a browser set to
// block site data, throws on localStorage rather than returning null.
const STORAGE_KEY = 'wvw-relink-checker:guilds';
let saveTimer = null;

function saveGuildInput() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, guildInput.value); }
    catch { /* no storage or over quota: the list just won't persist */ }
  }, 400);
}

function restoreGuildInput() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) guildInput.value = saved;
  } catch { /* no storage available: start with an empty box */ }
}

guildInput.addEventListener('input', saveGuildInput);
restoreGuildInput();

// execCommand('copy') is deprecated, but navigator.clipboard does not
// exist in a non-secure context and can be refused by permissions
// policy. This is the only fallback that still works there.
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

async function copySummary(btn) {
  const text = btn.dataset.summary || '';
  try {
    if (!navigator.clipboard) throw new Error('clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    copyFeedback.textContent = 'Copied to clipboard.';
    return;
  } catch {
    // Falls through to the legacy path below.
  }
  copyFeedback.textContent = legacyCopy(text)
    ? 'Copied to clipboard.'
    : "Couldn't copy automatically, select the text manually.";
}
copyChatBtn.addEventListener('click', () => copySummary(copyChatBtn));
copyDiscordBtn.addEventListener('click', () => copySummary(copyDiscordBtn));

