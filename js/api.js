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
// the honest thing is to fail and let the next background refresh try
// again, rather than hold a page that looks frozen.
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
async function fetchJson(url, attempt = 0, cacheMode = 'no-store') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal, cache: cacheMode });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      await sleep(retryAfterMs(res.headers.get('Retry-After')));
      return fetchJson(url, attempt + 1, cacheMode);
    }
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(500 * (attempt + 1));
      return fetchJson(url, attempt + 1, cacheMode);
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
      return fetchJson(url, attempt + 1, cacheMode);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// The static catalogues - objectives, upgrades, sectors, tactics, emblem
// foregrounds - are all served with `Cache-Control: public, max-age=3600`,
// and the blanket 'no-store' above threw every bit of it away on each
// page load. These go through 'default' so the browser's own cache can
// answer for the hour the API says it may. Live match data keeps
// 'no-store', and there was nothing to win there anyway: wvw/matches is
// served with max-age=1.
const fetchJsonCached = (url) => fetchJson(url, 0, 'default');

// Guild-to-team assignment only changes at the weekly relink, far less
// often than this cache expires. Harmless over-fetching, kept simple by
// reusing the same timer interval instead of tracking the relink date.
async function getWvwMaps() {
  if (wvwMapCache && Date.now() - wvwMapCachedAt < TIMERS_REFRESH_MS) return wvwMapCache;

  const [na, eu] = await Promise.all([
    fetchJson(`${API_BASE}/wvw/guilds/na`),
    fetchJson(`${API_BASE}/wvw/guilds/eu`)
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

async function getGuildInfo(guildId) {
  if (guildNameCache.has(guildId)) {
    const cached = guildNameCache.get(guildId);
    if (cached.ok) return cached.data;
    throw new Error(cached.error);
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

// Fetches the current match for a team ID, cached by team and match ID
// so guilds sharing a team never trigger duplicate requests.
async function getMatchForTeam(teamId) {
  if (teamToMatchId.has(teamId)) {
    return matchDataCache.get(teamToMatchId.get(teamId));
  }

  const raw = await fetchJson(`${API_BASE}/wvw/matches?world=${encodeURIComponent(teamId)}`);
  const match = Array.isArray(raw) ? raw[0] : raw;

  if (!match || typeof match.id !== 'string' || typeof match.all_worlds !== 'object') {
    throw new Error('No active match found for this team');
  }

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
