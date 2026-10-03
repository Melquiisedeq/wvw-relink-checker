'use strict';
// ---------------------------------------------------------------------
// GW2 API
// Every request to api.guildwars2.com goes through fetchJson: timeout,
// retry on 429, and the caches that keep a run from asking twice.
// ---------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry-After comes as either a number of seconds or an HTTP date, and a
// server is free to name a delay longer than anyone will sit through.
// Both forms are read; the wait is capped, because past half a minute
// the honest thing is to fail and let the next background refresh try.
const RETRY_AFTER_FALLBACK_MS = 1500;
const RETRY_AFTER_MAX_MS = 30000;

function retryAfterMs(header) {
  if (!header) return RETRY_AFTER_FALLBACK_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return RETRY_AFTER_FALLBACK_MS;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

/**
 * Fetch JSON with a timeout and a small retry budget. Retries on 429
 * (respecting Retry-After), 5xx server errors, and network failures.
 * Does not retry other 4xx codes since those won't succeed on retry.
 */
async function fetchJson(url, attempt = 0, cacheMode = 'no-store', timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal, cache: cacheMode });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(retryAfterMs(res.headers.get('Retry-After')));
      return fetchJson(url, attempt + 1, cacheMode, timeoutMs);
    }
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(500 * (attempt + 1));
      return fetchJson(url, attempt + 1, cacheMode, timeoutMs);
    }
    if (!res.ok) {
      const err = new Error(`API request failed (HTTP ${res.status})`);
      err.status = res.status;   // so a caller can tell 404 from 503
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    if (err instanceof TypeError && attempt < MAX_RETRIES) {
      await sleep(500 * (attempt + 1));
      return fetchJson(url, attempt + 1, cacheMode, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// wvwrelink.com/api, the reads that stand in for the two project sheets. One
// try, no retry: the caller's retry is the sheet. Throws on anything but a
// 200 carrying JSON.
async function fetchOwnApi(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OWN_API_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// The static catalogues - objectives, upgrades, sectors, tactics, emblem
// foregrounds - are served with max-age=3600, and the blanket 'no-store'
// threw all of it away on every page load. These go through 'default' so
// the browser's own cache can answer for the hour the API says it may.
// Live match data keeps 'no-store'; wvw/matches is served max-age=1.
const fetchJsonCached = (url) => fetchJson(url, 0, 'default');

// Guild-to-team assignment only changes at the monthly relink, so this is
// far less volatile than the cache it sits behind. Harmless
// over-fetching, kept simple by reusing the same timer interval instead
// of tracking that date.
async function getWvwMaps() {
  if (wvwMapCache && Date.now() - wvwMapCachedAt < TIMERS_REFRESH_MS) return wvwMapCache;

  const [na, eu] = await Promise.all([
    fetchJson(`${API_BASE}/wvw/guilds/na`, 0, 'no-store', SLOW_REQUEST_TIMEOUT_MS),
    fetchJson(`${API_BASE}/wvw/guilds/eu`, 0, 'no-store', SLOW_REQUEST_TIMEOUT_MS)
  ]);

  if (typeof na !== 'object' || typeof eu !== 'object' || na === null || eu === null) {
    throw new Error('Unexpected API response shape for wvw/guilds');
  }

  wvwMapCache = { na, eu };
  wvwMapCachedAt = Date.now();
  return wvwMapCache;
}

async function resolveGuildId(rawName) {
  const name = rawName.trim();
  if (GUID_RE.test(name)) return name; // user already pasted a GUID

  const url = `${API_BASE}/guild/search?name=${encodeURIComponent(name)}`;
  const ids = await fetchJson(url); // array of GUIDs (usually 0 or 1)

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('Guild not found (name must match exactly)');
  }
  return ids[0];
}

// Guild name, tag and emblem, kept between visits. About as static as
// this API gets, and the maps ask for a great many at once: measured on
// a real session, opening the popover and walking the four tabs made 42
// lookups at a median of 294ms - 14.2 seconds of summed waiting, three
// quarters of everything that popover asked for. The API sends them
// no-store, so the browser's own cache never keeps one. This does.
const GUILD_STORE_KEY = 'wvw-guilds-v1';
const GUILD_STORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Enough for a season of WvW without the entry growing without bound:
// 42 guilds in one sitting, and a guild seen once and never again is
// dropped by the trim below before it costs anything.
const GUILD_STORE_MAX = 400;

let guildStore = null;
let guildStoreDirty = false;
let guildStoreTimer = null;

function guildStoreRead() {
  if (guildStore) return guildStore;
  guildStore = new Map();
  try {
    const cut = Date.now() - GUILD_STORE_TTL_MS;
    for (const [id, v] of Object.entries(JSON.parse(localStorage.getItem(GUILD_STORE_KEY)) || {})) {
      // Shape-checked on the way in. What comes out of storage was
      // written by an older version of this file, or by anything else
      // with the same origin.
      if (v && typeof v.n === 'string' && typeof v.t === 'string'
        && typeof v.at === 'number' && v.at > cut) guildStore.set(id, v);
    }
  } catch { /* off, full, or corrupt - an empty store is the right answer */ }
  return guildStore;
}

// One write per burst, not one per guild: those 42 lookups land within
// a second of each other and each would serialise the whole store.
function guildStoreFlush() {
  if (guildStoreTimer) return;
  guildStoreTimer = setTimeout(() => {
    guildStoreTimer = null;
    if (!guildStoreDirty || !guildStore) return;
    guildStoreDirty = false;
    try {
      // Newest first, so a trim drops whatever has gone longest unseen.
      const rows = [...guildStore.entries()].sort((a, b) => b[1].at - a[1].at);
      localStorage.setItem(GUILD_STORE_KEY,
        JSON.stringify(Object.fromEntries(rows.slice(0, GUILD_STORE_MAX))));
    } catch { /* storage off or full; the session cache still answers */ }
  }, 2000);
}

async function getGuildInfo(guildId, allowStored = false) {
  if (guildNameCache.has(guildId)) {
    const cached = guildNameCache.get(guildId);
    if (cached.ok) return cached.data;
    throw new Error(cached.error);
  }

  // Only for callers that said so - the maps, which want the emblem. The
  // relink checker is not one: it resolves a name the user typed into an
  // id and prints the name back, and a guild that renamed last week
  // would have it printed as it was a month ago. A hit here deliberately
  // does not fill guildNameCache.
  if (allowStored) {
    const kept = guildStoreRead().get(guildId);
    if (kept) return { name: kept.n, tag: kept.t, emblem: kept.e || null };
  }

  try {
    const info = await fetchJson(`${API_BASE}/guild/${encodeURIComponent(guildId)}`);
    if (!info || typeof info.tag !== 'string' || typeof info.name !== 'string') {
      throw new Error('Unexpected guild data from API');
    }
    // emblem comes along for the ride: the WvW maps draw it on claimed
    // objectives, and this is the same lookup and the same cache the
    // guild checker already uses, so it costs nothing extra.
    const result = { name: info.name, tag: info.tag, emblem: info.emblem || null };
    guildNameCache.set(guildId, { ok: true, data: result });
    guildStoreRead().set(guildId,
      { n: result.name, t: result.tag, e: result.emblem, at: Date.now() });
    guildStoreDirty = true;
    guildStoreFlush();
    return result;
  } catch (err) {
    // Only a definite answer is worth remembering. A timeout or a dropped
    // connection says nothing about the guild, and caching those meant a
    // single bad moment kept it failing until the page was reloaded -
    // pressing Check again just replayed the cached error.
    if (err.status >= 400 && err.status < 500) {
      guildNameCache.set(guildId, { ok: false, error: err.message || 'Guild lookup failed' });
    }
    throw err;
  }
}

// Uses hasOwnProperty so a crafted key like "__proto__" can't resolve
// through the prototype chain.
function findLink(guildId, maps) {
  if (Object.prototype.hasOwnProperty.call(maps.na, guildId)) {
    return { region: 'NA', teamId: maps.na[guildId] };
  }
  if (Object.prototype.hasOwnProperty.call(maps.eu, guildId)) {
    return { region: 'EU', teamId: maps.eu[guildId] };
  }
  return null;
}

// ---- The newest body per match ---------------------------------------
// Some of the API's servers answer wvw/matches with a body frozen in the
// past (measured 02/10/2026 over 2207 reads: ~35% of answers for 1-1,
// ~60% for 2-1, one stuck over 67 min; no header tells the servers
// apart). Painted, it walks the maps, the scores and the kill rate
// backwards. Every reader of a match goes through fetchMatches, which
// never hands out a body behind one already seen.
// matchId -> { match, at }; `at` is when this page last saw the match's
// score go up. A frozen server repeats the same body, so the time of an
// answer says nothing about the data's age; the score sum of a live match
// rises every 20-40 s and jumps at each 5-min tick (measured 02-03/10/2026).
const newestMatches = new Map();

const colorSum = (obj) => COLORS.reduce((n, c) => n + (Number(obj && obj[c]) || 0), 0);
const matchActivity = (m) => colorSum(m.kills) + colorSum(m.deaths);

// True only when `fresh` is certainly behind `kept`. A later start_time is
// a new week and wins with every counter at zero; an earlier one is last
// week's, frozen. Inside one week kills+deaths and the scores only grow.
// An unreadable start_time cannot be judged, so the fresh body is taken:
// guessing wrong the other way would freeze the match for good.
function matchIsBehind(fresh, kept) {
  const a = Date.parse(fresh.start_time);
  const b = Date.parse(kept.start_time);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a !== b) return a < b;
  const actA = matchActivity(fresh);
  const actB = matchActivity(kept);
  if (actA !== actB) return actA < actB;
  return colorSum(fresh.scores) < colorSum(kept.scores);
}

// Offers one body; returns the one kept for its match. Anything that is
// not a match passes through untouched.
function keepNewestMatch(match) {
  if (!match || typeof match.id !== 'string') return match;
  const kept = newestMatches.get(match.id);
  if (kept && matchIsBehind(match, kept.match)) return kept.match;
  // First sight, a new week, or a higher score: the data moved. The same
  // body again keeps the old time.
  const moved = !kept || match.start_time !== kept.match.start_time
    || colorSum(match.scores) > colorSum(kept.match.scores);
  // `rose`: this page watched the score go up. False while `at` is only the
  // time of the first sight, which the kill history may know to be older.
  const rose = !!kept && match.start_time === kept.match.start_time
    ? (colorSum(match.scores) > colorSum(kept.match.scores) || kept.rose)
    : false;
  newestMatches.set(match.id, { match, at: moved ? Date.now() : kept.at, rose });
  return match;
}

// Backdates `at` for matches whose `at` is only a first sight, using the
// newest line the shared history holds for them (the script writes a line
// when a score rose). Never newer than the current `at`, never over a rise
// this page saw, never from a line older than the match's own week.
// `byMatch`: Map matchId -> samples [{at}] oldest first. Returns how many
// changed.
function ageFirstSightFromHistory(byMatch, staleMs) {
  if (!(byMatch instanceof Map)) return 0;
  const now = Date.now();
  let n = 0;
  for (const [id, kept] of newestMatches) {
    if (kept.rose) continue;
    const list = byMatch.get(id);
    const last = list && list.length ? list[list.length - 1] : null;
    if (!last || !Number.isFinite(last.at)) continue;
    if (now - last.at <= staleMs || last.at >= kept.at) continue;
    const week = Date.parse(kept.match.start_time);
    if (Number.isFinite(week) && last.at < week) continue;
    kept.at = last.at;
    n++;
  }
  return n;
}

// When this page last saw the match's score go up; 0 if never.
function matchScoreRoseAt(matchId) {
  const kept = newestMatches.get(matchId);
  return kept ? kept.at : 0;
}

// fetchJson for any wvw/matches URL that returns match bodies, one or a
// list, same shape back. In parallel, not in turn: reads in a row come back
// from the same server (24 of 28 identical, 02/10/2026).
const MATCH_REREADS = 2;

const isMatchBody = (m) => !!m && typeof m.id === 'string';
const byId = (a, b) => {
  const [ra, ta] = a.split('-').map(Number);
  const [rb, tb] = b.split('-').map(Number);
  return ra - rb || ta - tb;
};

const rereadMatches = async (url, timeoutMs) => (await Promise.allSettled(
  Array.from({ length: MATCH_REREADS }, () => fetchJson(url, 0, 'no-store', timeoutMs))))
  .flatMap((r) => (r.status !== 'fulfilled' ? [] : Array.isArray(r.value) ? r.value : [r.value]));

// Which ids of a list answer to read again: a body behind the kept one, a
// body whose week is over. `regions` ('1' NA, '2' EU) says the URL lists
// whole regions, and then also a tier this page holds that the answer left
// out, and a gap in the tiers (1-2 and 1-3 without 1-1). Relink nights serve
// partial lists and tiers from both weeks (03/10/2026). `holes`: the gaps,
// tiers that certainly exist.
function matchesToReread(list, regions) {
  const got = new Set(list.filter(isMatchBody).map((m) => m.id));
  const need = new Set();
  const holes = [];
  for (const m of list) {
    if (!isMatchBody(m)) continue;
    const kept = newestMatches.get(m.id);
    if ((kept && matchIsBehind(m, kept.match)) || !matchIsLive(m)) need.add(m.id);
  }
  for (const region of regions) {
    for (const id of matchDataCache.keys()) {
      if (id.startsWith(`${region}-`) && !got.has(id)) need.add(id);
    }
    const tiers = [...got].filter((id) => id.startsWith(`${region}-`))
      .map((id) => Number(id.split('-')[1])).filter(Number.isInteger);
    for (let t = 1; t < Math.max(0, ...tiers); t++) {
      if (!got.has(`${region}-${t}`)) { need.add(`${region}-${t}`); holes.push(`${region}-${t}`); }
    }
  }
  return { need: [...need].sort(byId), holes };
}

// A single body behind the kept one: the URL is read twice more at once and
// the furthest along wins. A list: only the ids matchesToReread names are
// read again, twice at once, and the answer is the union by id, the newest
// body of each, in id order; a gap still missing gets the last body seen,
// if any. Nothing to read again, nothing more is asked.
async function fetchMatches(url, timeoutMs = REQUEST_TIMEOUT_MS, regions = []) {
  const raw = await fetchJson(url, 0, 'no-store', timeoutMs);
  if (!Array.isArray(raw)) {
    if (isMatchBody(raw) && newestMatches.has(raw.id) && matchIsBehind(raw, newestMatches.get(raw.id).match)) {
      for (const m of await rereadMatches(url, timeoutMs)) keepNewestMatch(m);
    }
    return keepNewestMatch(raw);
  }
  const { need, holes } = matchesToReread(raw, regions);
  if (need.length === 0) return raw.map(keepNewestMatch);
  const again = await rereadMatches(
    `${API_BASE}/wvw/matches?ids=${need.map(encodeURIComponent).join(',')}`, timeoutMs);
  const out = new Map();
  for (const m of [...raw, ...again]) if (isMatchBody(m)) out.set(m.id, keepNewestMatch(m));
  for (const id of holes) if (!out.has(id) && newestMatches.has(id)) out.set(id, newestMatches.get(id).match);
  return [...out.values()].sort((a, b) => byId(a.id, b.id));
}

// True when `offered` should take the place of `kept` as a team's match:
// never an earlier week over a later one; the same week, the live body over
// an ended one. An unreadable start_time falls to the same-week rule.
function matchReplaces(offered, kept) {
  const a = Date.parse(offered.start_time);
  const b = Date.parse(kept.start_time);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  return !(matchIsLive(kept) && !matchIsLive(offered));
}

const matchHasTeam = (m, teamId) => !!m && typeof m.id === 'string'
  && !!m.all_worlds && typeof m.all_worlds === 'object' && colorForTeam(m, teamId) !== null;

// The newest-week body already in hand that holds the team, or null.
function keptMatchWithTeam(teamId) {
  let best = null;
  const bodies = [...matchDataCache.values(), ...[...newestMatches.values()].map((k) => k.match)];
  for (const m of bodies) {
    if (matchHasTeam(m, teamId) && (!best || matchReplaces(m, best))) best = m;
  }
  return best;
}

// Fetches the current match for a team ID, cached by team and match ID
// so guilds sharing a team never trigger duplicate requests. Only a match
// that holds the team is returned or remembered: ?world= has answered with
// another team's match during a relink. Order: the cached pair, bodies
// already in hand, then ?world= (read again, in parallel, when the first
// answer lacks the team); otherwise it throws and keeps nothing.
async function getMatchForTeam(teamId) {
  if (teamToMatchId.has(teamId)) {
    const cached = matchDataCache.get(teamToMatchId.get(teamId));
    if (matchHasTeam(cached, teamId)) return cached;
    teamToMatchId.delete(teamId);
  }

  let match = keptMatchWithTeam(teamId);
  if (!match) {
    const url = `${API_BASE}/wvw/matches?world=${encodeURIComponent(teamId)}`;
    const firstWith = (raw) => (Array.isArray(raw) ? raw : [raw]).find((m) => matchHasTeam(m, teamId));
    match = firstWith(await fetchMatches(url));
    if (!match) {
      const again = await Promise.allSettled(
        Array.from({ length: MATCH_REREADS }, () => fetchJson(url, 0, 'no-store')));
      for (const r of again) {
        if (r.status !== 'fulfilled') continue;
        const kept = firstWith((Array.isArray(r.value) ? r.value : [r.value]).map(keepNewestMatch));
        if (kept) { match = kept; break; }
      }
    }
  }

  if (!match) throw new Error('No match holds this team yet');
  teamToMatchId.set(teamId, match.id);
  matchDataCache.set(match.id, match);
  return match;
}

function colorForTeam(match, teamId) {
  return COLORS.find((c) => matchTeamId(match, c) === String(teamId)) || null;
}

// Runs `fn` on an interval while the tab is visible, and catches up
// immediately when focus returns if enough time has passed. Skips a run
// if the previous one is still in flight.
function schedulePeriodicRefresh(fn, intervalMs) {
  let inFlight = false;
  // Seeded with "now" because callers do an initial load right before
  // scheduling; without it, tabbing away and back a second later would
  // fire a duplicate refresh of data that just arrived.
  let lastRun = Date.now();

  const run = async () => {
    if (inFlight || document.visibilityState === 'hidden') return;
    if (Date.now() - lastRun < intervalMs) return;
    inFlight = true;
    // Stamped before the work, not after. setInterval fires on exact
    // multiples of intervalMs, so stamping at the end pushes the next
    // tick just under the guard above and drops every other one - which
    // silently turned a 3-minute refresh into a 6-minute one.
    lastRun = Date.now();
    try {
      await fn();
    } catch {
      // fn() is expected to handle its own errors; this is just a safety
      // net so a future mistake can't leave an unhandled rejection.
    } finally {
      inFlight = false;
    }
  };

  setInterval(run, intervalMs);
  document.addEventListener('visibilitychange', run);
}
