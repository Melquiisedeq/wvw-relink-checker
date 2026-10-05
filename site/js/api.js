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
    // Only a definite answer is worth remembering. A timeout, a dropped
    // connection or a 429 says nothing about the guild, and caching those
    // meant a single bad moment kept it failing until the page was reloaded -
    // pressing Check again just replayed the cached error.
    if (err.status === 404) {
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
  weekStoreOffer(match);
  return match;
}

// ---- The week's line-up between loads --------------------------------
// On a relink night the API can serve a tier's new week and then last week's
// again for about an hour (03/10/2026); a reload would forget the new one.
// Kept per match: start, end, the three team ids, when written - not the body.
// Threat model: only this origin writes it (a script of ours, or the user's own extension).
// Nothing in it becomes text: only team ids that exist in TEAM_NAMES, which supplies the names.
// Worst case: a wrong line-up for up to WEEK_HOLD_MS, in this browser only.
const WEEK_STORE_KEY = 'wvw-weeks-v1';
// The memory overrules the API only this long after its week began, and only
// over a body of an earlier week. The window measured on 03/10/2026: 1 h 04.
const WEEK_HOLD_MS = 2 * 60 * 60 * 1000;
const WEEK_MAX_MS = 8 * 24 * 60 * 60 * 1000;
const WEEK_CLOCK_SLACK_MS = 5 * 60 * 1000;
const WEEK_AHEAD_MS = 60 * 60 * 1000;    // a clock that far behind still keeps a memory
const WEEK_STORE_MAX = 12;           // NA 4 + EU 5, with room
const WEEK_STORE_MAX_CHARS = 4096;   // twelve entries are under 1.2 KB
const WEEK_ID_RE = /^[12]-[1-9]$/;

let weekStore = null;   // matchId -> { s, e, t: { red, blue, green }, v }

const weekTime = (n) => Number.isSafeInteger(n) && n > 0;
const weekTeam = (n) => Number.isInteger(n) && n > 0 && n < 100000
  && Object.prototype.hasOwnProperty.call(TEAM_NAMES, String(n));

// The exact shape or nothing: a week that has not ended, began at most an
// hour from now (a later start would hold for longer than WEEK_HOLD_MS, and
// past year 275760 it is no date at all), at most 8 days long, written no
// later than now, three distinct teams the table knows.
function weekEntryOk(v, now) {
  if (!v || typeof v !== 'object' || !v.t || typeof v.t !== 'object') return false;
  if (!weekTime(v.s) || !weekTime(v.e) || !weekTime(v.v)) return false;
  if (v.s > now + WEEK_AHEAD_MS) return false;
  if (v.e <= v.s || v.e - v.s > WEEK_MAX_MS || v.e <= now || v.v > now + WEEK_CLOCK_SLACK_MS) return false;
  const teams = COLORS.map((c) => v.t[c]);
  return teams.every(weekTeam) && new Set(teams).size === COLORS.length;
}

function weekStoreRead() {
  if (weekStore) return weekStore;
  weekStore = new Map();
  try {
    const text = localStorage.getItem(WEEK_STORE_KEY);
    if (!text || text.length > WEEK_STORE_MAX_CHARS) return weekStore;
    const all = JSON.parse(text);
    if (!all || typeof all !== 'object' || Array.isArray(all)) return weekStore;
    const now = Date.now();
    for (const [id, v] of Object.entries(all)) {
      if (weekStore.size >= WEEK_STORE_MAX) break;
      if (!WEEK_ID_RE.test(id) || !weekEntryOk(v, now)) continue;
      weekStore.set(id, { s: v.s, e: v.e, t: { red: v.t.red, blue: v.t.blue, green: v.t.green }, v: v.v });
    }
  } catch { /* off, full, or corrupt - an empty memory is the right answer */ }
  return weekStore;
}

function weekStoreSave() {
  const now = Date.now();
  for (const [id, v] of weekStore) if (v.e <= now) weekStore.delete(id);
  try {
    localStorage.setItem(WEEK_STORE_KEY, JSON.stringify(Object.fromEntries(
      [...weekStore].sort((a, b) => b[1].s - a[1].s).slice(0, WEEK_STORE_MAX))));
  } catch { /* storage off or full; the page works without it */ }
}

// A live body as an entry, or null when anything about it is off.
function weekEntryOf(m, now) {
  if (!isMatchBody(m) || !WEEK_ID_RE.test(m.id) || !matchIsLive(m)) return null;
  const t = {};
  for (const c of COLORS) t[c] = Number(matchTeamId(m, c));
  const entry = { s: Date.parse(m.start_time), e: Date.parse(m.end_time), t, v: now };
  return weekEntryOk(entry, now) ? entry : null;
}

const sameWeek = (a, b) => a.s === b.s && a.e === b.e && COLORS.every((c) => a.t[c] === b.t[c]);

// Every live body kept goes in, unless the memory holds a later week for the
// match that may still overrule it. The same start with other teams is the
// API correcting itself: it goes in.
function weekStoreOffer(m) {
  const now = Date.now();
  const entry = weekEntryOf(m, now);
  if (!entry) return;
  const store = weekStoreRead();
  const had = store.get(m.id);
  if (had && (sameWeek(had, entry) || (entry.s < had.s && now < had.s + WEEK_HOLD_MS))) return;
  store.set(m.id, entry);
  weekStoreSave();
}

// A whole region in one answer - every tier from 1 up, every one this page
// knows, all live and on one week - is the line-up, even where the memory
// disagrees: the region's entries are written from it alone.
function weekStoreRegion(region, list) {
  const mine = list.filter((m) => isMatchBody(m) && m.id.startsWith(`${region}-`));
  if (mine.length === 0) return;
  const now = Date.now();
  const entries = mine.map((m) => [m.id, weekEntryOf(m, now)]);
  if (entries.some(([, e]) => !e) || new Set(entries.map(([, e]) => e.s)).size !== 1) return;
  const ids = new Set(mine.map((m) => m.id));
  for (let t = 1; t <= ids.size; t++) if (!ids.has(`${region}-${t}`)) return;
  const known = [...matchDataCache.keys(), ...weekHeldIds(region)];
  if (known.some((id) => id.startsWith(`${region}-`) && !ids.has(id))) return;
  const store = weekStoreRead();
  const regionIds = [...store.keys()].filter((id) => id.startsWith(`${region}-`));
  if (regionIds.length === ids.size && entries.every(([id, e]) => store.has(id) && sameWeek(store.get(id), e))) return;
  for (const id of regionIds) store.delete(id);
  for (const [id, e] of entries) store.set(id, e);
  weekStoreSave();
}

// The entry for a match while it may still overrule the API, or null.
function weekHeld(id) {
  const v = weekStoreRead().get(id);
  return v && Date.now() < v.s + WEEK_HOLD_MS ? v : null;
}

function weekHeldIds(region) {
  return [...weekStoreRead().keys()].filter((id) => id.startsWith(`${region}-`) && weekHeld(id));
}

// True when this browser saw a later week of the match than `body`. An
// unreadable start_time cannot be judged, and the body is taken.
function weekAhead(body) {
  const v = isMatchBody(body) ? weekHeld(body.id) : null;
  const start = v ? Date.parse(body.start_time) : NaN;
  return Number.isFinite(start) && start < v.s;
}

// The remembered line-up in the shape the painters read: names only, never a
// score. Never put in newestMatches or matchDataCache - nothing that reads a
// score or a map may get it - and recognised by `fromMemory`.
function weekLineup(id) {
  const v = weekHeld(id);
  if (!v) return null;
  return {
    id, fromMemory: true, lineupOnly: true,
    start_time: new Date(v.s).toISOString(), end_time: new Date(v.e).toISOString(),
    all_worlds: { red: [v.t.red], blue: [v.t.blue], green: [v.t.green] },
  };
}

// The held entry that has the team in its line-up, the latest week first.
function weekLineupOfTeam(teamId) {
  let best = null;
  for (const id of weekStoreRead().keys()) {
    const v = weekHeld(id);
    if (v && COLORS.some((c) => String(v.t[c]) === String(teamId)) && (!best || v.s > best.v.s)) best = { id, v };
  }
  return best ? weekLineup(best.id) : null;
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

// A first-sight body with fewer kills on some map than the history's newest
// line for its week is older than that line (kills only rise in a week), so
// its `at` goes back to the line's time: "Updated" must not say now. Needs
// no live history, unlike the above: the line proves it on its own.
// `totalsOf(match)`: kills per map type, the keys of the lines' `n`.
function ageBehindHistory(byMatch, totalsOf) {
  if (!(byMatch instanceof Map)) return 0;
  let n = 0;
  for (const [id, kept] of newestMatches) {
    if (kept.rose) continue;
    const list = byMatch.get(id);
    const last = list && list.length ? list[list.length - 1] : null;
    if (!last || !Number.isFinite(last.at) || last.at >= kept.at) continue;
    const week = Date.parse(kept.match.start_time);
    if (!Number.isFinite(week) || last.at < week) continue;
    const now = totalsOf(kept.match);
    if (!Object.keys(now).some((t) => now[t] < (Number(last.n && last.n[t]) || 0))) continue;
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

// Which ids of a list answer to read again: a body behind the kept one or
// behind the week this browser remembers, a body whose week is over. `regions` ('1' NA, '2' EU) says the URL lists
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
    if ((kept && matchIsBehind(m, kept.match)) || !matchIsLive(m) || weekAhead(m)) need.add(m.id);
  }
  for (const region of regions) {
    for (const id of matchDataCache.keys()) {
      if (id.startsWith(`${region}-`) && !got.has(id)) need.add(id);
    }
    // A tier this browser saw this week certainly exists.
    for (const id of weekHeldIds(region)) {
      if (!got.has(id)) { need.add(id); holes.push(id); }
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
  // The first read of a visit asks /api/agora beside the game, not after it.
  const early = regions.length && !agoraAsked ? startAgora() : null;
  const raw = await fetchJson(url, 0, 'no-store', timeoutMs);
  if (!Array.isArray(raw)) {
    if (isMatchBody(raw) && newestMatches.has(raw.id) && matchIsBehind(raw, newestMatches.get(raw.id).match)) {
      for (const m of await rereadMatches(url, timeoutMs)) keepNewestMatch(m);
    }
    return keepNewestMatch(raw);
  }
  const { need, holes } = matchesToReread(raw, regions);
  let list;
  if (need.length === 0) list = raw.map(keepNewestMatch);
  else {
    const again = await rereadMatches(
      `${API_BASE}/wvw/matches?ids=${need.map(encodeURIComponent).join(',')}`, timeoutMs);
    const out = new Map();
    for (const m of [...raw, ...again]) if (isMatchBody(m)) out.set(m.id, keepNewestMatch(m));
    for (const id of holes) if (!out.has(id) && newestMatches.has(id)) out.set(id, newestMatches.get(id).match);
    list = [...out.values()].sort((a, b) => byId(a.id, b.id));
  }
  if (regions.length) list = await mergeAgora(list, early);
  for (const region of regions) weekStoreRegion(region, list);
  return list;
}

// ---- /api/agora: a second read of the matches ------------------------
// The game's own answer can sit still for minutes while the match moves.
// /api/agora holds the same match bodies as the game gave them, gzipped and
// base64, taken by our own scripts. Asked on the visit's first read and
// whenever no live match has risen here for AGORA_QUIET_MS. Each body goes
// through keepNewestMatch like any other, so it wins only by being further
// along. Threat model: anyone able to answer on this origin can hand us a
// body, so: only ids the game already gave this visit, id and start must
// match the body's own, the inflated size is capped while it streams, and
// the body is data, as always. Any failure is silence: the page is then as it
// was without this read.
const AGORA_URL = '/api/agora';
const AGORA_QUIET_MS = 90 * 1000;
const AGORA_WAIT_MS = 1200;           // how long a read holds the paint; a late answer waits for the next one
const AGORA_BODY_MAX = 256 * 1024;    // inflated bytes per match
const AGORA_GZ_MAX = 96 * 1024;       // base64 characters per match
const AGORA_MATCHES_MAX = 20;
let agoraAsked = false;

async function agoraInflate(b64) {
  if (typeof b64 !== 'string' || b64.length > AGORA_GZ_MAX) return null;
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > AGORA_BODY_MAX) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { joined.set(c, at); at += c.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
}

// Resolves, never rejects, to the bodies that passed every check.
async function agoraRead() {
  try {
    const data = await fetchOwnApi(AGORA_URL);
    const list = data && Array.isArray(data.matches) ? data.matches.slice(0, AGORA_MATCHES_MAX) : [];
    const out = [];
    for (const e of list) {
      try {
        if (!e || typeof e.id !== 'string' || !WEEK_ID_RE.test(e.id)) continue;
        const body = await agoraInflate(e.gz);
        if (!body || body.id !== e.id || typeof body.all_worlds !== 'object' || !body.all_worlds
          || typeof body.scores !== 'object' || !body.scores || !Array.isArray(body.maps)) continue;
        if (!Number.isFinite(e.start) || Date.parse(body.start_time) !== e.start) continue;
        out.push(body);
      } catch { /* this match has no data */ }
    }
    return out;
  } catch {
    return [];
  }
}

function startAgora() {
  if (typeof DecompressionStream !== 'function') return null;
  agoraAsked = true;
  return agoraRead();
}

// Offers the bodies of ids this visit already read from the game; returns
// id -> the body kept.
function offerAgora(bodies) {
  const out = new Map();
  for (const body of bodies) if (newestMatches.has(body.id)) out.set(body.id, keepNewestMatch(body));
  return out;
}

// `early`: a read already in the air (the visit's first). Waits only a moment
// for it: a hung /api must not slow the page, and what comes late is offered
// all the same, for the next paint.
async function mergeAgora(list, early) {
  let reading = early;
  if (!reading) {
    const now = Date.now();
    const moving = [...newestMatches.values()].some((k) => k.rose && matchIsLive(k.match) && now - k.at < AGORA_QUIET_MS);
    if (!moving) reading = startAgora();
  }
  if (!reading) return list;
  const timedOut = Symbol('late');
  const got = await Promise.race([reading, sleep(AGORA_WAIT_MS).then(() => timedOut)]);
  if (got === timedOut) {
    reading.then(offerAgora);
    return list;
  }
  const kept = offerAgora(got);
  return list.map((m) => kept.get(m.id) || m);
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
// answer lacks the team). A body behind the week this browser remembers for
// the team does not count; when nothing else does, the remembered line-up is
// returned, uncached (weekLineup). Otherwise it throws and keeps nothing.
async function getMatchForTeam(teamId) {
  let match = null;
  if (teamToMatchId.has(teamId)) {
    const cached = matchDataCache.get(teamToMatchId.get(teamId));
    if (matchHasTeam(cached, teamId)) match = cached;
    else teamToMatchId.delete(teamId);
  }
  if (!match) match = keptMatchWithTeam(teamId);

  const line = weekLineupOfTeam(teamId);
  const lineStart = line ? Date.parse(line.start_time) : NaN;
  const fits = (m) => matchHasTeam(m, teamId) && !(Date.parse(m.start_time) < lineStart);
  if (!match || !fits(match)) {
    match = null;
    const url = `${API_BASE}/wvw/matches?world=${encodeURIComponent(teamId)}`;
    const firstWith = (raw) => (Array.isArray(raw) ? raw : [raw]).find(fits);
    try {
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
    } catch { /* no answer: the line-up below, or the throw */ }
  }

  if (!match && line) return line;
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
// if the previous one is still in flight. An fn that returns false skipped
// its work, so the run does not count and the next tick or focus tries again.
function schedulePeriodicRefresh(fn, intervalMs) {
  let inFlight = false;
  // Seeded with "now" because callers do an initial load right before
  // scheduling; without it, tabbing away and back a second later would
  // fire a duplicate refresh of data that just arrived.
  let lastRun = Date.now();

  const run = async () => {
    if (inFlight || document.visibilityState === 'hidden') return;
    // The slack: a tick that ran a few ms late leaves the next one a few ms
    // short of the interval, and without it the guard dropped that one.
    if (Date.now() - lastRun < intervalMs - 1000) return;
    inFlight = true;
    // Stamped before the work, not after. setInterval fires on exact
    // multiples of intervalMs, so stamping at the end pushes the next
    // tick just under the guard above and drops every other one - which
    // silently turned a 3-minute refresh into a 6-minute one.
    const before = lastRun;
    lastRun = Date.now();
    try {
      if (await fn() === false) lastRun = before;
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
