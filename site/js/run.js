'use strict';
// The run: what happens when Check is pressed, and the saved input and copy buttons around it.

// Cleared before each run, so an earlier timeout cannot strip the class
// off a drop that has only just started.
let deployTimer = null;

// What a failed lookup says in the results table: a short phrase, decided by the error's fields, never its message.
function lookupErrorText(e) {
  if (e.notFound) return 'Guild not found (name must match exactly)';
  if (e.status === 429) return 'Server busy, try again';
  if (e.timedOut) return 'Server slow, try again';
  if (e.network) return 'Connection lost, try again';
  return 'Server error, try again';
}

async function run() {
  const { names, cut } = parseGuildNames(guildInput.value);
  // Cleared up front: every statusMsg after this one is progress or success and
  // would otherwise inherit the last failure's colour.
  statusMsg.classList.remove('status-err');

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
  // Goes with them: left up, they would still hold the previous run's
  // summary and copy it if pressed.
  copyRow.style.display = 'none';
  resultsPlaceholder.style.display = 'none';
  resultCard.style.display = 'block';

  const finish = () => {
    runBtn.disabled = false;
    runBtn.textContent = 'Check';
    // Panels drop in straight away; the siege finale plays over them. The class
    // comes off once it has played so the next run starts clean.
    pageEl.classList.remove('deploying');
    void pageEl.offsetWidth;
    pageEl.classList.add('deploying');
    clearTimeout(deployTimer);
    deployTimer = setTimeout(() => pageEl.classList.remove('deploying'), 1200);

    playFinale();
  };

  // Everything past the setup is inside the try, so that however it ends
  // finish() runs: otherwise the button stays disabled, the trebuchet
  // hauled back and followSling's rAF loop alive.
  try {
    let maps;
    try {
      maps = await getWvwMaps();
    } catch {
      // Not retried by itself: the search is the visitor's action. The
      // message says what to do, and the button does it.
      statusMsg.classList.add('status-err');
      statusMsg.textContent = "Couldn't load WvW data. The connection may be slow.";
      // A search already running is not started twice: Check is disabled
      // for the length of one.
      const again = buildRetryButton(() => { if (!runBtn.disabled) run(); });
      statusMsg.appendChild(again);
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
        renderRow({ originalName, error: lookupErrorText(e) });
      }

      await sleep(THROTTLE_MS);
    }

    // Match/score context for every distinct team found.
    if (teamsFound.size > 0) {
      statusMsg.innerHTML = '<span class="spinner"></span>Pulling in match details…';

      const panelsByMatchId = new Map(); // matchId -> { match, yourGuildsByColor }

      for (const [teamId, yourGuildNames] of teamsFound) {
        let match = null;
        let color = null;
        try {
          match = await getMatchForTeam(teamId);
          color = colorForTeam(match, teamId);
        } catch { /* said below, with the rest of the not-found cases */ }
        if (!match || !color) {
          const note = document.createElement('p');
          note.className = 'panel-note';
          note.textContent = `${getTeamName(teamId)}: this week's match isn't on the API yet.`;
          matchPanelsContainer.appendChild(note);
          // The dot stays grey (dot-pending); only its title changes.
          (dotsByTeam.get(teamId) || []).forEach((dot) => {
            if (dot) dot.title = 'Match not on the API yet';
          });
          await sleep(THROTTLE_MS);
          continue;
        }

        // A remembered line-up and a body can share an id; each keeps its panel.
        const key = match.fromMemory ? `${match.id} memory` : match.id;
        if (!panelsByMatchId.has(key)) {
          panelsByMatchId.set(key, { match, yourGuildsByColor: { red: [], blue: [], green: [] } });
        }
        panelsByMatchId.get(key).yourGuildsByColor[color].push(...yourGuildNames);
        (dotsByTeam.get(teamId) || []).forEach((dot) => {
          if (!dot) return;
          dot.className = `dot dot-${color}`;
          dot.title = `${color[0].toUpperCase()}${color.slice(1)} side`;
        });
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

    statusMsg.textContent = `Done, checked ${names.length} guild(s).` +
      (cut ? ` Only the first ${MAX_ENTRIES} guilds were checked.` : '');

    // The first guild of the list that landed on a team: that team's card.
    if (successEntries.length > 0) showGuildFound(successEntries[0].teamId, successEntries[0].name);
  } catch (err) {
    // Without this the run would stop with the spinner's last words on screen.
    // Rethrown so a real bug still reaches the console.
    statusMsg.classList.add('status-err');
    statusMsg.textContent = 'Something went wrong partway through. Give it another try.';
    throw err;
  } finally {
    finish();
  }
}

// The click and Ctrl+Enter are bound in boot.js, once everything run()
// calls has loaded.

// Keeps the pasted list across reloads. Every access is wrapped: localStorage can throw when site data is blocked.
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

// navigator.clipboard may be missing or refused; execCommand('copy') is the fallback.
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

