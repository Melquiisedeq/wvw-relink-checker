// The one door to the page's insides. Every name of site/js a test needs is here,
// each behind a function named for what it reads or does; specs and the other
// support files find the page by its roles, its text, its requests and its clock,
// and come here only for what none of those shows. tests/unit/spec-port.test.mjs
// fails on a name of site/js anywhere else. What a function hands the page runs
// there: it can only use its own arguments. A spy here returns its own reader, so
// no spec touches the window.__ it writes.

// ---- the matches the page holds ---------------------------------------
// The body the page keeps for a tier (the newest seen), as a copy.
export const keptBody = (page, id) => page.evaluate(i => newestMatches.get(i).match, id);

// The same, its score last rising now.
export const keptMatch = (page, id) =>
  page.evaluate(i => { const k = newestMatches.get(i); k.at = Date.now(); return JSON.parse(JSON.stringify(k.match)); }, id);

// The total score of the body kept for `id`.
export const keptScore = (page, id) => page.evaluate(i => colorSum(newestMatches.get(i).match.scores), id);

// The week (start_time) of the body kept for `id`, and of the one the board draws.
export const weekOf = (page, id) =>
  page.evaluate(i => ({ list: matchDataCache.get(i)?.start_time, map: newestMatches.get(i)?.match.start_time }), id);

export const keptLive = (page, id) => page.evaluate(i => matchIsLive(newestMatches.get(i).match), id);

// How long since the score of `id` last rose, by the page's reckoning (ms).
export const quietFor = (page, id) => page.evaluate(i => Date.now() - newestMatches.get(i).at, id);

// When the page last saw the score of `id` rise.
export const scoreRoseAt = (page, id) => page.evaluate(i => matchScoreRoseAt(i), id);

// Every match but `except` seen rising now (in the game all nine move).
export const othersRisingNow = (page, except) =>
  page.evaluate(id => { for (const [k, kept] of newestMatches) if (k !== id) kept.at = Date.now(); }, except);

// Every match seen rising now, none marked as just risen.
export const allQuietNow = page =>
  page.evaluate(() => { for (const k of newestMatches.values()) { k.rose = false; k.at = Date.now(); } });

// `body` handed to the page as if a read had brought it.
export const keepNewest = (page, body) => page.evaluate(m => { keepNewestMatch(m); }, body);

// ---- the board ------------------------------------------------------------
// The score `id` has on the page's board, or -1 while it has no body for it.
export const scoreOf = (page, id) => page.evaluate(i => { const m = matchDataCache.get(i); return m ? colorSum(m.scores) : -1; }, id);

// Every body the board draws, as copies.
export const boardBodies = page => page.evaluate(() => [...matchDataCache.values()].map(m => JSON.parse(JSON.stringify(m))));

// The first live match the board draws, as a copy, with its id, start and total score.
export const liveOnBoard = page => page.evaluate(() => {
  const m = [...matchDataCache.values()].find(x => matchIsLive(x));
  return { id: m.id, start: Date.parse(m.start_time), score: colorSum(m.scores), body: JSON.parse(JSON.stringify(m)) };
});

// A load of the standings now, as `origin` would start it ('cycle' by default).
export const loadNow = (page, origin) => page.evaluate(o => { loadStandings(o); }, origin);

// The refresh a standings tick runs; what it returns (false: skipped).
export const refreshBoard = page => page.evaluate(() => refreshStandings());

// Resolves once no load of the standings is in flight.
export const loadSettled = page => page.waitForFunction(() => !standingsInFlight);

export const retryWaiting = page => page.evaluate(() => !!standingsRetry);

// Counts the regions the board redraws from here on; returns the count's reader.
// No outside sign: a redraw of the same data patches the cards in place and writes
// nothing, and the "Synced" time is to the minute.
export async function countRegionDraws(page) {
  await page.evaluate(() => {
    window.__shown = 0;
    const show = showRegion;
    showRegion = function (...a) { window.__shown++; return show.apply(this, a); };
  });
  return () => page.evaluate(() => window.__shown);
}

// The last reset of each region (by its number), less the time the API takes to turn.
export const lastResets = page =>
  page.evaluate(() => ({ 1: lastResetOf('NA', steadyNow()) - RESET_ARRIVAL_MS, 2: lastResetOf('EU', steadyNow()) - RESET_ARRIVAL_MS }));

// ---- the copy (/api/latest) and the peek ----------------------------------
// One read of /api/latest, offered to the page as the cycle offers it.
export const readCopy = page => page.evaluate(() => latestRead().then(bodies => { offerLatest(bodies); }));

// The page's first read of /api/latest/summary after this call is held in the page
// (no timeout, whatever the clock does); later reads go through. Returns held(),
// 1 once it is out, and release(object), which answers it.
export async function holdSummary(page) {
  await page.evaluate(() => {
    window.__summaryHeld = 0;
    const read = fetchOwnApi;
    fetchOwnApi = function (url, ...a) {
      if (url !== LATEST_SUMMARY_URL || window.__summaryHeld) return read.call(this, url, ...a);
      window.__summaryHeld++;
      return new Promise((resolve) => { window.__releaseSummary = resolve; });
    };
  });
  return {
    held: () => page.evaluate(() => window.__summaryHeld),
    release: sum => page.evaluate(v => window.__releaseSummary(v), sum),
  };
}

// Counts the peek timers the page sets from here on; returns the count's reader.
export async function countPeekTimers(page) {
  await page.evaluate(() => {
    window.__armed = 0;
    const set = window.setTimeout;
    window.setTimeout = function (fn, ...rest) {
      if (typeof fn === 'function' && fn.name === 'runPeek') window.__armed++;
      return set.call(this, fn, ...rest);
    };
  });
  return () => page.evaluate(() => window.__armed);
}

// Whether the last standings tick found a popover open and was skipped.
export const tickSkipped = page => page.evaluate(() => standingsSkipped);

// The skipped tick forgotten: nothing is owed.
export const forgetSkippedTick = page => page.evaluate(() => { standingsSkipped = false; });

// The next peek `ms` from now, in place of the one scheduled.
export const nextPeekIn = (page, ms) => page.evaluate(t => { clearTimeout(peekTimer); peekTimer = setTimeout(runPeek, t); }, ms);

// ---- the maps -------------------------------------------------------------
export const mapsScriptIn = page => page.evaluate(() => typeof fillTierMaps === 'function');

// Appended to js/maps.js as it is served: logs, for each popover the late script
// fills, whether it is the one open; scriptFills(page) reads the log.
export const LOG_SCRIPT_FILLS = '\n;(() => { const fill = fillTierMaps; window.__fills = [];' +
  ' fillTierMaps = function (p, ...rest) { window.__fills.push(p === activePopover); return fill.call(this, p, ...rest); }; })();\n';
export const scriptFills = page => page.evaluate(() => window.__fills);

// The objective catalogue held until release(); fills() reads, for each popover the
// maps are drawn into, whether it is the one open.
export async function holdCatalogueAndLogFills(page) {
  await page.evaluate(() => {
    let go;
    const gate = new Promise(ok => { go = ok; });
    window.__release = go;
    window.__fills = [];
    const catalogue = getObjectiveCatalogue;
    getObjectiveCatalogue = async () => { await gate; return catalogue(); };
    const fill = renderTierMapsContent;
    renderTierMapsContent = function (p, ...rest) { window.__fills.push(p === activePopover); return fill.call(this, p, ...rest); };
  });
  return { release: () => page.evaluate(() => window.__release()), fills: () => page.evaluate(() => window.__fills) };
}

// Logs the total score each map opening draws from; returns the log's reader.
export async function logOpeningScores(page) {
  await page.evaluate(() => {
    window.__opened = [];
    const fill = renderTierMapsContent;
    renderTierMapsContent = function (p, m, ...rest) { window.__opened.push(colorSum(m.scores)); return fill.call(this, p, m, ...rest); };
  });
  return () => page.evaluate(() => window.__opened);
}

// The total score a reopening of the map would start from (null: nothing recalled).
export const recalledScore = page => page.evaluate(() => freshRecall.data && colorSum(freshRecall.data.scores));

// The game's list of `id` read as the map's refresh reads it: each body's total score.
export const readMatchList = (page, id) => page.evaluate(i => fetchMatches(`${API_BASE}/wvw/matches?ids=${i}`, 8000, ['1'])
  .then(l => l.map(m => colorSum(m.scores))), id);

export const upgradeLines = page => page.evaluate(() => upgradeCatalogue?.size ?? 0);

// The emblem catalogue forgotten, as on a page that never read it.
export const forgetEmblems = page => page.evaluate(() => { emblemPieces = null; emblemPiecesPromise = null; });

// How many layers the emblem of guild `id` is drawn with.
export const emblemLayerCount = (page, id) => page.evaluate(i => guildEmblem(i).then(e => e.layers.length), id);

// The community guild list forgotten, as on a page that never read it.
export const forgetCommunityGuilds = page => page.evaluate(() => { communityGuildsCache = null; });

// ---- the kill history -----------------------------------------------------
// One line per match the page holds, `id` last seen `age` ms ago and the others
// `othersAge`, with the kills of the body kept (support/scenarios.mjs, killRows).
export const killLines = (page, id, age, othersAge) =>
  page.evaluate(([target, a, b]) => [...newestMatches.entries()].map(([k, kept]) => {
    const n = fightTotals(kept.match);
    return [Date.now() - (k === target ? a : b), k, ...KILLS_MAP_ORDER.map(t => n[t] || 0)];
  }), [id, age, othersAge]);

// One ask of the kill history, as the map asks: how many matches it gives.
// `stale`: the copy in hand counts as old; `forget`: there is none.
export const askKills = (page, { stale = false, forget = false } = {}) => page.evaluate(async ([s, f]) => {
  if (f) killSheet = null;
  if (s || f) killSheetAt = 0;
  return (await getKillSheet()).size;
}, [stale, forget]);

// No kill history in hand nor stored, as on a first visit.
export const forgetKillHistory = page => page.evaluate(() => { localStorage.removeItem(FIGHT_KEY); killSheet = null; });

// Logs the title of the open "what you missed" block right after the page's own
// handlers on each read of the kill history (null: no block); returns the log's reader.
export async function logTitlesAtKillReads(page) {
  await page.evaluate(() => {
    const read = getKillSheet;
    window.__titles = [];
    getKillSheet = () => {
      const p = read().then(v => v);
      p.then(() => queueMicrotask(() => queueMicrotask(() => {
        const t = document.querySelector('.info-popover .wvw-missed:not(.is-leaving) .wvw-missed-title');
        window.__titles.push(t ? [...t.childNodes].filter(n => !(n.classList && n.classList.contains('wvw-missed-counts'))).map(n => n.textContent).join('').trim() : null);
      })));
      return p;
    };
  });
  return () => page.evaluate(() => window.__titles);
}

// ---- what you missed ------------------------------------------------------
export const missedNoted = (page, id) => page.evaluate(i => missedNotes.has(i), id);

// Resolves once the note of `id` is held (mouse or focus on it) as `want` says.
export const missedHeld = (page, id, want) => page.waitForFunction(([i, w]) => missedNotes.get(i)?.held === w, [id, want]);

// Whether the note of `id` is past its ten minutes.
export const missedOverdue = (page, id) => page.evaluate(i => missedNotes.has(i) && steadyNow() > missedNotes.get(i).until, id);

// The note of `id` no longer marked as held: only a repaint writes it again.
export const unholdMissed = (page, id) => page.evaluate(i => { missedNotes.get(i).held = null; }, id);

// The note of `id` dated to an older week.
export const missedFromOlderWeek = (page, id) =>
  page.evaluate(i => { missedNotes.get(i).after = { ...missedNotes.get(i).after, start_time: 'an older week' }; }, id);

export const missedWeekLive = (page, id) => page.evaluate(i => missedNotes.has(i) && matchIsLive(missedNotes.get(i).after), id);

// Counts the repaints of the block from here on; returns the count's reader. No
// outside sign: a repaint that would draw the same block returns before the DOM.
export async function countMissedPaints(page) {
  await page.evaluate(() => {
    const paint = paintMissed;
    window.__missedPaints = 0;
    paintMissed = (...a) => { window.__missedPaints++; return paint(...a); };
  });
  return () => page.evaluate(() => window.__missedPaints);
}

// For `id`: how far the kill history is ahead of the body kept (kills), the kills
// the block should count from the body before the absence to the newest data, and
// the corner's end time as the block writes it.
export const missedAgainstHistory = (page, id) => page.evaluate(i => {
  const kept = newestMatches.get(i).match;
  const note = missedNotes.get(i);
  const history = Math.max(0, ...fightSamples(kept).map(s => sumKills(s.n)));
  return {
    behind: history - missedKillTotal(kept),
    want: Math.max(history, missedKillTotal(kept)) - missedKillTotal(note.before),
    end: missedHhmm(killView(kept).clock),
  };
}, id);

// ---- the teams notice -----------------------------------------------------
// The teams notice raised the way the page raises it: NA's teams assigned, one guild list published.
export const raiseNotice = page => page.evaluate(() => {
  const win = 1900000000;
  lockoutTime = Date.now() - 60000; assignNA = win * 1000;
  relinkState = { window: win, published: 1 }; relinkStateAt = Date.now();
  localStorage.removeItem('wvw-relink-checker:teams-notice');
  updateRelinkBanner();
});
