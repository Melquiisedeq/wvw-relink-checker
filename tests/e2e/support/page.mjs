// The one door to the page's insides. Every name of site/js a test needs is here,
// each behind a function named for what it reads or does; specs and the other
// support files find the page by its roles, its text, its requests and its clock,
// and come here only for what none of those shows. tests/unit/e2e/spec-port.test.mjs
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

// The id of the waypoint the map draws for objective `obj`, as the chat link carries it.
export const waypointIdOf = (page, obj) => page.evaluate(o => WAYPOINT_AT[o][2], obj);

// A kept body of a match other than `except` pushed 5000 ahead in scores and kills (the game's answer for it
// is behind), and the summary of `except` ahead of what is on show, the summary and its ask forgotten.
export const aheadOfGameAndSummary = (page, except) => page.evaluate(focus => {
  const m = JSON.parse(JSON.stringify([...matchDataCache.values()].find(x => x.id !== focus)));
  for (const k of Object.keys(m.scores)) m.scores[k] += 5000;
  for (const k of Object.keys(m.kills)) m.kills[k] += 5000;
  keepNewestMatch(m);
  latestSummary.get(focus).score += 5000;
  latestAskedAt = 0;
  latestSummaryAt = 0;
}, except);

// What the map's refresh starts each of its reads of the game as: twice, together.
export const doubleMapReads = page => page.evaluate(() => { const read = mapAhead; mapAhead = ids => { read(ids); read(ids); }; });

// The match the open map recalls (null: none).
export const recalledMatchId = page => page.evaluate(() => freshRecall && freshRecall.data && freshRecall.data.id);

// When the page last read the copy's summary (ms; 0: never), and the `at` it anchors the peek to.
export const summaryReadAt = page => page.evaluate(() => latestSummaryAt);
export const summaryAnchor = page => page.evaluate(() => peekAnchor);

// How far (px) the round gathering on the sling stands from the sling's tip; null: none gathering.
export const slingGap = page => page.evaluate(() => {
  const b = document.querySelector('.siege-charge.charging');
  return b ? Math.round(Math.abs(parseFloat(b.style.left) - slingTip().x)) : null;
});

// ---- weeks and line-ups -----------------------------------------------------
// The name the page gives the team `id` (a string), and of each of `ids`.
export const teamName = (page, id) => page.evaluate(i => getTeamName(i), id);
export const teamNames = (page, ids) => page.evaluate(t => t.map(getTeamName), ids);

// The line-up the page deduces from `list` (bodies) for `tiers` tiers out of the team ids `teams`: a body, or null.
export const lineupFrom = (page, list, teams, tiers) => page.evaluate(([l, t, n]) => deduceLineup(l, new Set(t), n), [list, teams, tiers]);

// The match the page keeps for team `t`, and whether it keeps one for `t` (a string or its number).
export const teamMatchKept = (page, t) => page.evaluate(i => teamToMatchId.get(i), t);
export const teamMatchRemembered = (page, t) => page.evaluate(m => teamToMatchId.has(m) || teamToMatchId.has(Number(m)), t);

// The Check's match for team `t`: its id, whether it came from the page's memory of the week, and whether
// a body from memory sits among those the page keeps.
export const matchForTeam = (page, t) => page.evaluate(x => getMatchForTeam(x).then(m => ({ id: m.id, memory: !!m.fromMemory,
  cached: [...matchDataCache.values(), ...[...newestMatches.values()].map(k => k.match)].some(b => b.fromMemory) })), t);

// The week and the name of the red team of the body kept for `id`.
export const keptWeekAndRed = (page, id) => page.evaluate(i => { const m = newestMatches.get(i).match; return { start: m.start_time, red: getTeamName(matchTeamId(m, 'red')) }; }, id);

// What the page has bound to the open map's reads of the focus and of the push.
export const mapHandlers = page => page.evaluate(() => [typeof mapCatchUp, typeof mapAhead]);

// Counts the failed loads of the standings the page plans a retry for, from its start;
// returns the count's reader. No outside sign: the retry heals the board within seconds.
export async function countFailedLoads(page) {
  await page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const plan = planStandingsRetry;
    window.__failedLoads = 0;
    window.planStandingsRetry = () => { window.__failedLoads++; plan(); };
  }));
  return () => page.evaluate(() => window.__failedLoads);
}

// ---- the corners and the skirmish trend ---------------------------------------
// The time (HH:MM, the viewer's) the kill history of `id` runs to, and the time its score last rose.
export const clockOfKillsAndScore = (page, id) => page.evaluate(i => {
  const hh = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return [hh(killView(newestMatches.get(i).match, null).clock), hh(matchScoreRoseAt(i))];
}, id);

// The text of the skirmish trend (red's) drawn for each case's `match` with the score of its kept body last
// rising at `at` (ms); with `fixedNow`, the page's clock stood still there while it draws.
export const trendTexts = (page, cases, fixedNow = null) => page.evaluate(([cases, fixed]) => {
  const RealDate = Date;
  if (fixed !== null) globalThis.Date = new Proxy(RealDate, { get: (t, p) => (p === 'now' ? () => fixed : Reflect.get(t, p, t)) });
  try {
    return Object.fromEntries(Object.entries(cases).map(([name, { match, at }]) => {
      const k = newestMatches.get(match.id);
      const was = k.at;
      k.at = at;
      const el = document.createElement('div');
      renderSkirmishTrendPopoverContent(el, 'X', match, 'red');
      k.at = was;
      return [name, el.textContent];
    }));
  } finally { globalThis.Date = RealDate; }
}, [cases, fixedNow]);

// ---- the push ---------------------------------------------------------------
// The newest version (the `at`, in seconds) the page heard by a push, and the one its own read of the copy holds.
export const pushHeardAt = page => page.evaluate(() => pushHeard);
export const latestHeldVersion = page => page.evaluate(() => latestHeldAt);
// The newest of the two: what the page knows of the world.
export const newestVersionKnown = page => page.evaluate(() => Math.max(pushHeard, latestHeldAt));

// Whether the page counts the push as live.
export const pushIsLive = page => page.evaluate(() => pushLive());

// The servers' time by the page's reckoning (whole seconds).
export const serverSecondsNow = page => page.evaluate(() => Math.floor((Date.now() - ownClockLead) / 1000));

// The peek run now, out of its turn.
export const runPeekNow = page => page.evaluate(() => { runPeek(); });

// A read of the copy as the page makes it when it asks for the newest, offered as a late one.
export const readLatestNow = page => page.evaluate(() => startLatest().then(offerLate));

// ---- time and the corners ------------------------------------------------------
// How long (ms) the kill history of `id` has been silent, and the kills per 10 min the corner rates Center at (0: none).
export const killViewOf = (page, id) => page.evaluate(i => {
  const kept = newestMatches.get(i);
  const view = kept ? killView(kept.match, null) : null;
  return { silence: view ? view.silence : 0, ebg: view && view.rates ? Math.round(view.rates.per.get('Center')) : 0 };
}, id);

// Resolves once the script of the periodic refresh has run.
export const periodicRefreshReady = page => page.waitForFunction(() => typeof schedulePeriodicRefresh === 'function');

// The periodic refresh armed on its own work, which counts its runs and answers `undefined` (done) until
// told otherwise; `step` is its interval (ms). Returns reads() (the runs so far), back() (the tab's return,
// then the runs so far) and answer(v), what the work answers next.
export async function seedPeriodicRefresh(page, step) {
  await page.evaluate(step => {
    globalThis.__reads = 0;
    globalThis.__answer = undefined;
    globalThis.__run = schedulePeriodicRefresh(() => { globalThis.__reads++; return globalThis.__answer; }, step);
  }, step);
  const reads = () => page.evaluate(() => globalThis.__reads);
  return {
    reads,
    back: async () => { await page.evaluate(() => globalThis.__run()); return reads(); },
    answer: v => page.evaluate(v => { globalThis.__answer = v; }, v),
  };
}

// ---- storage ----------------------------------------------------------------
// Storage that refuses every read and write, as with site data blocked; returns a reader of how many times
// the page tried to save the typed list (that key only: the page saves other things on load).
export async function refuseStorage(page) {
  await page.addInitScript(() => {
    window.__listSaves = 0;
    Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    Storage.prototype.setItem = function (key) {
      if (key === 'wvw-relink-checker:guilds') window.__listSaves++;
      throw new DOMException('blocked', 'SecurityError');
    };
  });
  return () => page.evaluate(() => window.__listSaves);
}

// How many requests one read of the game makes when every try fails (fetchJson).
export const triesPerRead = page => page.evaluate(() => MAX_RETRIES + 1);
