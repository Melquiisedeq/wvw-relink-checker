'use strict';
// GW2 API: every request to api.guildwars2.com goes through fetchJson (timeout, retry on 429) and the caches that keep a run from asking twice.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry-After is either a number of seconds or an HTTP date. Both are read; the
// wait is capped, because past half a minute the next background refresh retries.
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
// foregrounds - are served with max-age=3600, so they go through 'default' and
// the browser's own cache answers for the hour. Live match data keeps 'no-store'.
const fetchJsonCached = (url) => fetchJson(url, 0, 'default');

// Guild-to-team assignment only changes at the monthly relink; the same timer
// interval is reused rather than tracking that date. A table kept from before
// the teams notice went up (teamsNoticeUpAt, js/relink.js) is the old month's, whatever its age.
async function getWvwMaps() {
  if (wvwMapCache && wvwMapCachedAt >= teamsNoticeUpAt
    && Date.now() - wvwMapCachedAt < TIMERS_REFRESH_MS) return wvwMapCache;
  const askedAt = Date.now();

  const [na, eu] = await Promise.all([
    fetchJson(`${API_BASE}/wvw/guilds/na`, 0, 'no-store', SLOW_REQUEST_TIMEOUT_MS),
    fetchJson(`${API_BASE}/wvw/guilds/eu`, 0, 'no-store', SLOW_REQUEST_TIMEOUT_MS)
  ]);

  if (typeof na !== 'object' || typeof eu !== 'object' || na === null || eu === null) {
    throw new Error('Unexpected API response shape for wvw/guilds');
  }

  wvwMapCache = { na, eu };
  wvwMapCachedAt = askedAt;   // when it was asked: a notice raised mid-flight outdates it
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

// Guild name, tag and emblem, kept between visits. About as static as this API
// gets, and the maps ask for dozens at once. The API sends them no-store, so the
// browser's own cache never keeps one; this does.
const GUILD_STORE_KEY = 'wvw-guilds-v1';
const GUILD_STORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Enough for a season of WvW without unbounded growth: a guild seen once and never again is dropped by the trim below.
const GUILD_STORE_MAX = 400;

let guildStore = null;
let guildStoreTimer = null;

function guildStoreRead() {
  if (guildStore) return guildStore;
  guildStore = new Map();
  try {
    const cut = Date.now() - GUILD_STORE_TTL_MS;
    for (const [id, v] of Object.entries(JSON.parse(localStorage.getItem(GUILD_STORE_KEY)) || {})) {
      // Shape-checked on the way in: storage may hold what an older version, or
      // anything else on this origin, wrote.
      if (v && typeof v.n === 'string' && typeof v.t === 'string'
        && typeof v.at === 'number' && v.at > cut) guildStore.set(id, v);
    }
  } catch { /* off, full, or corrupt - an empty store is the right answer */ }
  return guildStore;
}

// One write per burst, not one per guild: each write serialises the whole store.
function guildStoreFlush() {
  if (guildStoreTimer) return;
  guildStoreTimer = setTimeout(() => {
    guildStoreTimer = null;
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

  // Only for callers that said so - the maps, which want the emblem. The relink
  // checker is not one: it prints back a name resolved from what the user typed,
  // and a renamed guild would show its old name. A hit here deliberately does not
  // fill guildNameCache.
  if (allowStored) {
    const kept = guildStoreRead().get(guildId);
    if (kept) return { name: kept.n, tag: kept.t, emblem: kept.e || null };
  }

  try {
    const info = await fetchJson(`${API_BASE}/guild/${encodeURIComponent(guildId)}`);
    if (!info || typeof info.tag !== 'string' || typeof info.name !== 'string') {
      throw new Error('Unexpected guild data from API');
    }
    // The emblem comes along: the WvW maps draw it on claimed objectives.
    const result = { name: info.name, tag: info.tag, emblem: info.emblem || null };
    guildNameCache.set(guildId, { ok: true, data: result });
    guildStoreRead().set(guildId,
      { n: result.name, t: result.tag, e: result.emblem, at: Date.now() });
    guildStoreFlush();
    return result;
  } catch (err) {
    // Only a definite answer is remembered: a timeout, a dropped connection or a
    // 429 says nothing about the guild, and caching it would replay the error on
    // every Check until reload.
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
// The API answers from two groups of servers, picked by where the caller is,
// and either can serve a body frozen in the past while the other moves on; the
// body is pinned to the caller's IP, so a re-read stays on the same view. No
// header gives the data's age. Painted, an older body walks the maps, the
// scores and the kill rate backwards. Every reader of a match goes through
// fetchMatches, which never hands out a body behind one already seen, and
// /api/latest offers our copy, the newest our readers got from both groups.
// matchId -> { match, at }; `at` is when the match's score last went up, as
// this page saw it or as our copy dates its body. A frozen server repeats the
// same body, so the time of an answer says nothing about the data's age; the
// score sum of a live match rises every 20-40 s and jumps at each 5-min tick.
const newestMatches = new Map();
// Body from /api/latest -> when our readers saw its score go up (ms). A body
// of our copy can be older than the moment it wins here.
const latestBodyAt = new WeakMap();
// When this page last got an answer for each match, any body, a frozen repeat
// included (newestMatches keeps only when the score rose): the map's "checked".
const matchAnsweredAt = new Map();
// Longer without an answer is a gap; answers closer than the burst are one read.
const MATCH_GAP_MS = 2 * STANDINGS_REFRESH_MS;
const GAP_BURST_MS = 5000;

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
  const answeredBefore = matchAnsweredAt.get(match.id);
  matchAnsweredAt.set(match.id, Date.now());
  const kept = newestMatches.get(match.id);
  // Every offer, a frozen repeat included, with the body it would replace:
  // the maps' "What happened" summary (js/maps-early.js, loaded after this file).
  // Every match body passes here, so a fault there must not cost the page
  // its data: it is caught and the body is kept as if it had not run.
  if (typeof missedMatchOffered === 'function') {
    try { missedMatchOffered(match, kept); } catch { /* the summary only */ }
  }
  // An answer that does not move the data still ends a gap - a read asked
  // before a sleep can land after it - so the rise after it in the same burst
  // happened inside the gap too: it keeps `gapFrom` (tests/page-rules.test.mjs).
  const gapped = !(Date.now() - answeredBefore <= MATCH_GAP_MS);
  if (kept && matchIsBehind(match, kept.match)) {
    if (gapped) kept.gapFrom = answeredBefore;
    return kept.match;
  }
  // First sight, a new week, or a higher score: the data moved. The same
  // body again keeps the old time.
  const moved = !kept || match.start_time !== kept.match.start_time
    || colorSum(match.scores) > colorSum(kept.match.scores);
  // `rose`: this page watched the score go up, or our readers saw it within
  // KILLS_ALIVE_MS (below). False while `at` is only the
  // time of the first sight, which the kill history may know to be older.
  // A rise after a gap (a sleep, a hidden tab) happened somewhere in it, not
  // now: it is a first sight again, and `gapFrom` lets a history line from
  // inside the gap date it (ageBehindHistory). Bodies of the same burst (the
  // game's answer, /api/latest, a re-read) share the gap.
  const same = !!kept && match.start_time === kept.match.start_time;
  const risen = same && colorSum(match.scores) > colorSum(kept.match.scores);
  const now = Date.now();
  const burst = !!kept && kept.gapFrom !== undefined && now - answeredBefore <= GAP_BURST_MS;
  let gapFrom;
  let rose = same && kept.rose;
  if (risen) {
    gapFrom = burst ? kept.gapFrom : (gapped ? answeredBefore : undefined);
    rose = !burst && !gapped;
  } else if (same && !moved) {
    gapFrom = gapped ? answeredBefore : kept.gapFrom;
  }
  let at = moved ? now : kept.at;
  // While `at` is only a first sight, a copy with the same score dates it.
  const copyAt = moved || (same && !kept.rose) ? latestBodyAt.get(match) : undefined;
  if (copyAt !== undefined && (moved || copyAt < at)) {
    // Our copy dates its body, a gap or not; "rose" only as recent as the
    // quiet-map claim needs (KILLS_ALIVE_MS, js/maps-early.js).
    at = Math.min(now, copyAt);
    rose = now - at <= (typeof KILLS_ALIVE_MS === 'number' ? KILLS_ALIVE_MS : 0);
  }
  newestMatches.set(match.id, { match, at, rose, gapFrom });
  weekStoreOffer(match);
  return match;
}

// ---- The week's line-up between loads --------------------------------
// On a relink night the API can serve a tier's new week and then last week's
// again for about an hour; a reload would forget the new one.
// Kept per match: start, end, the three team ids, when written - not the body.
// Threat model: only this origin writes it (a script of ours, or the user's own extension).
// Nothing in it becomes text: only team ids that exist in TEAM_NAMES, which supplies the names.
// Worst case: a wrong line-up for up to WEEK_HOLD_MS, in this browser only.
const WEEK_STORE_KEY = 'wvw-weeks-v1';
// The memory overrules the API only this long after its week began, and only
// over a body of an earlier week. 2 h covers the hour or so the API serves last week's body again.
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
  const v = weekHeld(body.id);
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
// this page saw, never from a line older than the match's own week, never
// for a body with more kills on a map than the line: its rise is one no
// reader of ours wrote down (one dropped the match), not the game's API behind.
// `byMatch`: Map matchId -> samples [{at, n}] oldest first. Returns how many
// changed.
function ageFirstSightFromHistory(byMatch, staleMs, totalsOf) {
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
    const totals = totalsOf(kept.match);
    if (Object.keys(totals).some((t) => totals[t] > (Number(last.n && last.n[t]) || 0))) continue;
    kept.at = last.at;
    n++;
  }
  return n;
}

// A first-sight body with fewer kills on some map than a line of the
// history is older than that line (kills only rise in a week), so its `at`
// goes back to the oldest line of its week that is ahead of it: the lines
// ahead are a suffix of the list, and a newer one would date old data as
// recent. "Updated" must not say now. Needs no live history, unlike the
// above: the line proves it on its own.
// `totalsOf(match)`: kills per map type, the keys of the lines' `n`.
function ageBehindHistory(byMatch, totalsOf) {
  let n = 0;
  for (const [id, kept] of newestMatches) {
    if (kept.rose) continue;
    const list = byMatch.get(id);
    const last = list && list.length ? list[list.length - 1] : null;
    if (!last || !Number.isFinite(last.at) || last.at >= kept.at) continue;
    const week = Date.parse(kept.match.start_time);
    if (!Number.isFinite(week) || last.at < week) continue;
    const now = totalsOf(kept.match);
    const isAhead = (line) => Object.keys(now).some((t) => now[t] < (Number(line.n && line.n[t]) || 0));
    const firstAhead = isAhead(last)
      ? list.find((line) => line.at >= week && isAhead(line))
      : null;
    if (firstAhead) {
      kept.at = firstAhead.at;
      n++;
      continue;
    }
    // The score rose inside a gap this page did not watch: a line written
    // since its last answer is the rise's own, unless a map is ahead of it.
    const ahead = Object.keys(now).some((t) => now[t] > (Number(last.n && last.n[t]) || 0));
    if (!(kept.gapFrom && last.at > kept.gapFrom && !ahead)) continue;
    kept.at = last.at;
    n++;
  }
  return n;
}

// When the match's score last went up, as this page or our copy saw it; 0 if never.
function matchScoreRoseAt(matchId) {
  const kept = newestMatches.get(matchId);
  return kept ? kept.at : 0;
}

// fetchJson for any wvw/matches URL that returns match bodies, one or a
// list, same shape back. Reads again, in parallel, only in the window of the
// reset, when a body of last week or an unfinished list can differ from
// the next read; a body behind within its week comes from the visitor's group,
// pinned to their IP, and a read repeats it (see "The newest body per match"):
// /api/latest is asked instead.
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

// The time of this browser's fight log reading a body is behind (js/maps-early.js,
// loaded after this file), else 0. A fault there costs only the check.
function loggedAheadAt(match) {
  if (typeof fightLogAheadAt !== 'function') return 0;
  try { return fightLogAheadAt(match) || 0; } catch { return 0; }
}

// A first-sight body still behind the fight log after /api/latest, when it was asked, is from
// before the log's reading, so "Updated" starts there, never later. Only
// the `ids` matchesToReread named for the log: a body this visit watched rise
// keeps its own time.
function ageBehindLog(ids) {
  for (const id of ids) {
    const kept = newestMatches.get(id);
    if (!kept || kept.rose) continue;
    const at = loggedAheadAt(kept.match);
    if (at && at < kept.at) kept.at = at;
  }
}

const sameStart = (a, b) => Date.parse(a.start_time) === Date.parse(b.start_time);

// Which ids of a list answer to read again: a body behind the kept one from
// an earlier week, a body whose week is over, a body behind the week this browser remembers. `regions` ('1' NA, '2' EU) says the URL lists
// whole regions, and then also a tier this page holds that the answer left
// out, and a gap in the tiers (1-2 and 1-3 without 1-1). Relink nights serve
// partial lists and tiers from both weeks. `holes`: the gaps,
// tiers that certainly exist. `behind`: bodies behind the kept one in the same
// week; `logged`: first sights behind this browser's fight log (what a reload
// forgot). Neither is read again: they are the cases for /api/latest.
function matchesToReread(list, regions) {
  const got = new Set(list.filter(isMatchBody).map((m) => m.id));
  const need = new Set();
  const holes = [];
  const logged = [];
  const behind = [];
  for (const m of list) {
    if (!isMatchBody(m)) continue;
    const kept = newestMatches.get(m.id);
    if (!kept && loggedAheadAt(m)) logged.push(m.id);
    if (kept && matchIsBehind(m, kept.match)) {
      if (sameStart(m, kept.match)) behind.push(m.id);
      else need.add(m.id);
    }
    if (!matchIsLive(m) || weekAhead(m)) need.add(m.id);
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
  return { need: [...need].sort(byId), holes, logged, behind };
}

// A single body behind the kept one from an earlier week: the URL is read
// twice more at once and the furthest along wins. A list: only the ids
// matchesToReread names are read again, twice at once, and the answer is the
// union by id, the newest body of each, in id order; a gap still missing gets
// the last body seen, if any. Nothing to read again, nothing more is asked.
// A body behind in its own week, or a first sight behind the fight log, is
// not read again: /api/latest is asked instead, if it was not in the last
// LATEST_GAP_MS.
async function fetchMatches(url, timeoutMs = REQUEST_TIMEOUT_MS, regions = []) {
  // The first read of a visit, the first after the tab was hidden, and a
  // single match gone quiet (the maps popover's poll), ask /api/latest beside
  // the game, not after it.
  const one = new URL(url).searchParams.get('id');
  const early = regions.length ? (latestAsked && !latestMissed ? null : startLatest())
    : (one && latestWanted([one]) ? startLatest() : null);
  const latestFor = (behind) => early
    || (behind && Date.now() - latestAskedAt >= LATEST_GAP_MS ? startLatest() : null);
  const raw = await fetchJson(url, 0, 'no-store', timeoutMs);
  if (!Array.isArray(raw)) {
    const known = isMatchBody(raw) && newestMatches.has(raw.id);
    const logged = isMatchBody(raw) && !known && loggedAheadAt(raw) > 0;
    const keptRaw = known && newestMatches.get(raw.id).match;
    const behind = logged || (known && matchIsBehind(raw, keptRaw) && sameStart(raw, keptRaw));
    const reading = latestFor(behind);
    if (known && matchIsBehind(raw, keptRaw) && !sameStart(raw, keptRaw)) {
      for (const m of await rereadMatches(url, timeoutMs)) keepNewestMatch(m);
    }
    let kept = keepNewestMatch(raw);
    if (reading && !isMatchBody(kept)) reading.then(offerLatest);
    else if (reading) kept = (await mergeLatest([kept], reading))[0];
    // A newer body can land while mergeLatest waits: a map reopened by the
    // same button takes this answer of the closed one as its own.
    const newest = isMatchBody(kept) && newestMatches.get(kept.id);
    if (newest && matchIsBehind(kept, newest.match)) kept = newest.match;
    if (logged) ageBehindLog([raw.id]);
    return kept;
  }
  const { need, holes, logged, behind } = matchesToReread(raw, regions);
  const reading = latestFor(logged.length > 0 || behind.length > 0);
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
  if (regions.length || reading) list = await mergeLatest(list, reading);
  // A newer body can land while mergeLatest waits (see the one-match path).
  list = list.map((m) => {
    const newest = newestMatches.get(m.id);
    return newest && matchIsBehind(m, newest.match) ? newest.match : m;
  });
  ageBehindLog(logged);
  for (const region of regions) weekStoreRegion(region, list);
  return list;
}

// ---- /api/latest: a second read of the matches ------------------------
// The game's own answer can sit still for minutes while the match moves.
// /api/latest holds the same match bodies as the game gave them, gzipped and
// base64, taken by our own scripts. Asked on the visit's first read, on the
// first after the tab was hidden, and whenever any live match read has not
// risen here for LATEST_QUIET_MS, at most once per LATEST_GAP_MS (any one
// match, not all nine: one of nine almost always rises, so asking only when
// all stood still would be once a visit). Each body goes through
// keepNewestMatch like any other, so it wins only by being further
// along. Threat model: anyone able to answer on this origin can hand us a
// body, so: only ids the game already gave this visit, id and start must
// match the body's own, the inflated size is capped while it streams, and
// the body is data, as always. Any failure is silence: the page is then as it
// was without this read.
const LATEST_URL = '/api/latest';
const LATEST_SUMMARY_URL = '/api/latest/summary';
const LATEST_QUIET_MS = 90 * 1000;
const LATEST_GAP_MS = 30 * 1000;
const LATEST_WAIT_MS = 1200;           // how long a read holds the paint; a late answer waits for the next one
const LATEST_BODY_MAX = 256 * 1024;    // inflated bytes per match
const LATEST_GZ_MAX = 96 * 1024;       // base64 characters per match
const LATEST_MATCHES_MAX = 20;
let latestAsked = false;
let latestAskedAt = 0;
// Set while the tab is hidden, from the start in a tab opened in the
// background, until a read of /api/latest with it shown. The peek
// (js/standings.js) watched nothing meanwhile, and the read the tab's return
// brings sees every match risen since it left, so latestWanted asks nothing:
// a server group behind would be painted, a skirmish's victory points
// missing, until the next peek.
let latestMissed = document.visibilityState === 'hidden';
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') latestMissed = true;
});

async function latestInflate(b64) {
  if (typeof b64 !== 'string' || b64.length > LATEST_GZ_MAX) return null;
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > LATEST_BODY_MAX) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { joined.set(c, at); at += c.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
}

// Resolves, never rejects, to the bodies that passed every check.
async function latestRead() {
  try {
    const data = await fetchOwnApi(LATEST_URL);
    const list = data && Array.isArray(data.matches) ? data.matches.slice(0, LATEST_MATCHES_MAX) : [];
    const out = [];
    for (const e of list) {
      try {
        if (!e || typeof e.id !== 'string' || !WEEK_ID_RE.test(e.id)) continue;
        const body = await latestInflate(e.gz);
        if (!body || body.id !== e.id || typeof body.all_worlds !== 'object' || !body.all_worlds
          || typeof body.scores !== 'object' || !body.scores || !Array.isArray(body.maps)) continue;
        if (!Number.isFinite(e.start) || Date.parse(body.start_time) !== e.start) continue;
        if (Number.isFinite(e.at) && e.at > 0) latestBodyAt.set(body, e.at * 1000);
        out.push(body);
      } catch { /* this match has no data */ }
    }
    return out;
  } catch {
    return [];
  }
}

function startLatest() {
  if (typeof DecompressionStream !== 'function') return null;
  latestAsked = true;
  latestAskedAt = Date.now();
  if (document.visibilityState !== 'hidden') latestMissed = false;
  return latestRead();
}

// True when one of `ids` is a live match this page has not seen rise for
// LATEST_QUIET_MS, and the last ask is LATEST_GAP_MS old.
function latestWanted(ids) {
  const now = Date.now();
  if (now - latestAskedAt < LATEST_GAP_MS) return false;
  return ids.some((id) => {
    const k = newestMatches.get(id);
    return !!k && matchIsLive(k.match) && now - k.at >= LATEST_QUIET_MS;
  });
}

// Offers the bodies of ids this visit already read from the game; returns
// id -> the body kept.
function offerLatest(bodies) {
  const out = new Map();
  for (const body of bodies) if (newestMatches.has(body.id)) out.set(body.id, keepNewestMatch(body));
  return out;
}

// `early`: a read already in the air. Waits only a moment
// for it: a hung /api must not slow the page, and what comes late is offered
// all the same, for the next paint.
async function mergeLatest(list, early) {
  let reading = early;
  if (!reading && latestWanted(list.map((m) => m.id))) reading = startLatest();
  if (!reading) return list;
  const timedOut = Symbol('late');
  const got = await Promise.race([reading, sleep(LATEST_WAIT_MS).then(() => timedOut)]);
  if (got === timedOut) {
    reading.then(offerLatest);
    return list;
  }
  const kept = offerLatest(got);
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
// Returns the run, for a caller that owes one (the same guards apply).
function schedulePeriodicRefresh(fn, intervalMs) {
  let inFlight = false;
  // Seeded with "now": callers load right before scheduling, and without it a quick
  // tab away and back would duplicate that refresh.
  let lastRun = Date.now();

  const run = async () => {
    if (inFlight || document.visibilityState === 'hidden') return;
    // The slack: a tick that ran a few ms late leaves the next one a few ms short
    // of the interval, and the guard would drop it.
    if (Date.now() - lastRun < intervalMs - 1000) return;
    inFlight = true;
    // Stamped before the work, not after: setInterval fires on exact multiples of
    // intervalMs, so stamping at the end puts the next tick just under the guard
    // above and drops every other one.
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
  return run;
}
