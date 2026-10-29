'use strict';
// The part of the tier maps the page needs before anyone opens one: the map
// buttons and their swords badge, the fight log every standings refresh
// writes, and the "What happened" bookkeeping every match body passes
// through. The drawing code is js/maps.js, which index.html does not load:
// loadMapsScript asks for it as the first standings are drawn, or at the
// first click on a map button, whichever comes first. maps.js reads what
// this file declares, so this file stays where index.html loads it
// (check-structure.py fails if the quoted path is missing).

// Tab order. Red last: it is the heaviest of the three, and sitting second
// it fought EBG for the eye.
const MAP_PANEL_ORDER = ['Center', 'BlueHome', 'GreenHome', 'RedHome'];
const MAP_TAB_NAME = Object.freeze({
  Center: 'EBG', RedHome: 'Red BL', BlueHome: 'Blue BL', GreenHome: 'Green BL',
});
// How often open tier maps re-read their own match. One match is 82KB, and
// this runs only while the maps are open and the page is visible. A faster
// read only catches sooner the update of the copy this IP gets; a copy that
// lags is fetchMatches' job (js/api.js).
const MAP_REFRESH_MS = 30 * 1000;
// Past this, the corner stops calling the map "updated" and says how long
// its data has not moved, frozen or unanswered: one 5-min score tick
// missed, plus a minute. Not lower without checking a quiet tier at night.
const HUD_STALE_MS = 6 * 60 * 1000;

// ---- the fight log --------------------------------------------------
// What puts the crossed swords on a map tab. The API publishes kills only
// as running totals for the week, so which map is busy takes two readings,
// apart in time. Every standings refresh (wvw/matches) drops a snapshot
// here on its way past; no extra request. It survives a reload; the swords
// stay off until two samples exist. The other half comes from the kills
// sheet - see KILLS_SHEET_ID in js/config.js.
const FIGHT_KEY = 'wvw-fight-v1';
const FIGHT_KEEP_MS = 40 * 60 * 1000;
const FIGHT_MAX_SAMPLES = 12;
const FIGHT_MIN_GAP_MS = 60 * 1000;
// A sample older than this is not a baseline, it is history. Guards
// against a dead sheet: its rows would keep ageing and the rate computed
// off them would look plausible and be meaningless.
const FIGHT_STALE_MS = 3 * 60 * 60 * 1000;

// Player kills per map, and only those: deaths also count everyone who
// died to a lord, a guard or a fall, which would lift an empty map.
function fightTotals(match) {
  const out = {};
  for (const m of (match && match.maps) || []) {
    let n = 0;
    for (const c of COLORS) n += Number((m.kills || {})[c] || 0);
    out[m.type] = n;
  }
  return out;
}

function readFightLog() {
  // A private window, cleared site data or a browser set to block
  // storage all throw here rather than returning null.
  try {
    const raw = localStorage.getItem(FIGHT_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === 'object' ? obj : {};
  } catch { return {}; }
}

// The earliest reading this browser logged for the match's week, under
// FIGHT_KEEP_MS old, with more kills on some map than `match`: the body is
// from before it. A reload forgets newestMatches but not this log, so it
// lets fetchMatches catch a first body from the group behind (js/api.js,
// matchesToReread). 0 when there is none. The log is text anything on this
// origin can write: whatever is malformed counts as no reading.
function fightLogAheadAt(match) {
  if (!match || typeof match.id !== 'string' || !matchIsLive(match)) return 0;
  const log = readFightLog();
  const list = Object.prototype.hasOwnProperty.call(log, match.id) ? log[match.id] : null;
  if (!Array.isArray(list)) return 0;
  const week = Date.parse(match.start_time);
  if (!Number.isFinite(week)) return 0;
  const now = Date.now();
  const have = fightTotals(match);
  let first = 0;
  for (const s of list.slice(-FIGHT_MAX_SAMPLES)) {
    const at = s && typeof s === 'object' ? Number(s.at) : NaN;
    // Before the week began: last week's kills, or another match's after a relink.
    if (!Number.isFinite(at) || at < week || at > now || now - at > FIGHT_KEEP_MS) continue;
    const n = s.n && typeof s.n === 'object' ? s.n : null;
    if (!n || !Object.keys(have).some((t) => { const v = Number(n[t]); return Number.isFinite(v) && v > have[t]; })) continue;
    if (!first || at < first) first = at;
  }
  return first;
}

// Called by whoever holds fresh match data, with `asked`: when the request
// went out. A body is stamped with that, not with the moment it is written
// - a slow answer or a sleeping computer would otherwise carry the time of
// the waking up. Only bodies whose score this page watched rise since
// `asked` are written: a first sight may be the copy of the group that is
// behind at that moment and would become the window's base. It declines
// samples that arrive too close together.
function recordFightSamples(matches, asked) {
  const log = readFightLog();
  const now = Date.now();
  const seen = new Set();
  for (const match of matches) {
    if (!match || typeof match.id !== 'string' || !Array.isArray(match.maps)) continue;
    seen.add(match.id);
    // Ageing counts from the real now, not from `asked`.
    const kept = (log[match.id] || []).filter((s) => s && now - s.at <= FIGHT_KEEP_MS);
    const newest = newestMatches.get(match.id);
    const last = kept[kept.length - 1];
    // A negative gap (an answer overtaken by a later one) is refused too.
    if (newest && newest.rose && newest.at >= asked && now - asked <= FIGHT_KEEP_MS
      && (!last || asked - last.at >= FIGHT_MIN_GAP_MS)) kept.push({ at: asked, n: fightTotals(match) });
    log[match.id] = kept.slice(-FIGHT_MAX_SAMPLES);
  }
  // Matches this call did not mention are only dropped once they age out,
  // not immediately: the maps popover records a single match at a time
  // and must not wipe the other eight.
  for (const id of Object.keys(log)) {
    if (seen.has(id)) continue;
    const kept = log[id].filter((s) => s && now - s.at <= FIGHT_KEEP_MS);
    if (kept.length) log[id] = kept; else delete log[id];
  }
  try { localStorage.setItem(FIGHT_KEY, JSON.stringify(log)); } catch { /* storage off */ }
}


// The shared half of the fight log: snapshots taken whether or not anyone
// was looking - half an hour from this project's API, two hours from the
// sheet when that fails - which is the only way a first-ever visitor
// can be told which map is busy. Cached, so tab switches and the
// thirty-second poll never refetch it.
let killSheet = null;
let killSheetAt = 0;
let killSheetInFlight = null;

// A match whose only age is "first seen here" is backdated to the history's
// newest line for it, so opening during a freeze is amber at once. Only when
// the history itself is alive: a general freeze and a stopped trigger look
// the same from here, and without certainty nothing is claimed. A body
// with fewer kills than the history's newest line is backdated either way.
const HISTORY_LIVE_MS = 10 * 60 * 1000;

function ageFromHistory(byMatch) {
  ageBehindHistory(byMatch, fightTotals);
  const now = Date.now();
  let alive = false;
  for (const list of byMatch.values()) {
    const last = list && list[list.length - 1];
    if (last && now - last.at <= HISTORY_LIVE_MS) { alive = true; break; }
  }
  if (alive) ageFirstSightFromHistory(byMatch, HUD_STALE_MS, fightTotals);
}

async function getKillSheet() {
  if (killSheet && Date.now() - killSheetAt < KILLS_SHEET_TTL_MS) return killSheet;
  if (killSheetInFlight) return killSheetInFlight;

  killSheetInFlight = (async () => {
    try {
      killSheet = await readOwnKills().catch(readKillSheet);
      killSheetAt = Date.now();
      ageFromHistory(killSheet);
    } catch {
      // The local log still answers for anyone who has been here a
      // while; only the cold visit loses out, and it loses quietly.
      if (!killSheet) killSheet = new Map();
    }
    killSheetInFlight = null;
    return killSheet;
  })();
  return killSheetInFlight;
}

// One reading into the map both sources fill: match id to samples.
function addKillSample(by, at, id, counts) {
  if (!Number.isFinite(at) || !at || !id) return;
  const n = {};
  KILLS_MAP_ORDER.forEach((t, i) => { n[t] = Number(counts[i]) || 0; });
  if (!by.has(id)) by.set(id, []);
  by.get(id).push({ at, n });
}

function sortKillSamples(by) {
  for (const list of by.values()) list.sort((a, b) => a.at - b.at);
  return by;
}

// The last thirty minutes, as [at, match, Center, RedHome, BlueHome,
// GreenHome] - the sheet's columns, as numbers. An empty answer is a
// failure too: the Worker says 503 when its copy stops moving, and nothing
// at all is no better.
async function readOwnKills() {
  const data = await fetchOwnApi(OWN_KILLS_URL);
  const rows = data && data.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error('no rows');
  const by = new Map();
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 2 + KILLS_MAP_ORDER.length) continue;
    addKillSample(by, Number(r[0]), typeof r[1] === 'string' ? r[1] : '', r.slice(2));
  }
  if (!by.size) throw new Error('no usable rows');
  return sortKillSamples(by);
}

async function readKillSheet() {
  // The deadline every other request on this page already gets. A
  // connection that accepts and then goes quiet would leave this
  // pending for good - and killSheetInFlight hands that same promise to
  // every later caller, so the shared history would be gone for the
  // rest of the session with nothing having failed.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(KILLS_SHEET_URL,
      { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const by = new Map();
    for (const r of parseCsv(await res.text())) {
      if (!r || r.length < 2 + KILLS_MAP_ORDER.length) continue;
      addKillSample(by, Number(r[0]), String(r[1] || ''), r.slice(2));
    }
    return sortKillSamples(by);
  } finally {
    clearTimeout(timer);
  }
}

// Both halves as one series. The sheet covers the cold visit at
// five-minute resolution, localStorage covers an open session at thirty
// seconds; sorted together, picking a baseline never has to care which
// is which. Only the match's own week: kills restart at the reset, and a
// line from last week as a baseline would read as no fight at all.
function fightSamples(match) {
  const id = match && match.id;
  const local = readFightLog()[id] || [];
  const shared = (killSheet && killSheet.get(id)) || [];
  // Anything older than this is thrown away rather than used as a
  // baseline. If the sheet's trigger ever dies, its newest row keeps
  // ageing, and a rate taken over three days would be a number that
  // looks real and means nothing. Better to show no swords at all.
  const week = Date.parse(match && match.start_time);
  const floor = Math.max(Date.now() - FIGHT_STALE_MS, Number.isFinite(week) ? week : 0);
  return [...shared, ...local]
    .filter((s) => s && s.at >= floor)
    .sort((a, b) => a.at - b.at);
}

// When a match's kills last moved: the time of the first reading - the
// shared history, this browser's log, or the body in hand - whose total over
// the four maps had reached the newest total. The API moves the four in the
// same answer, so it is one clock per match. The body counts as a reading
// from when this page first saw its total, not from every repaint.
const killFirstSeen = new Map(); // match id -> { total, at }
const killCountingSince = new Map(); // match id -> when killView first found no window for it

// Silent past this, the corner says only how far the kill data goes ("data
// up to HH:MM"): no claim yet about why.
const KILLS_QUIET_MS = 5.5 * 60 * 1000;
// A silence up to this long can still be one of the API's own kill steps,
// which come while the score rises every minute, plus the delay before this
// page learns of the next (js/api.js, LATEST_QUIET_MS + LATEST_GAP_MS).
// "Quiet map" and the late-kills warning (view.strange), which also puts the
// swords out, start only past it.
const KILLS_STEP_MS = 9 * 60 * 1000;
// "Quiet map" is claimed only when the game's API is known to be moving:
// this page saw the match's score go up within this long. A stopped API
// freezes the kills and the score together, and from outside that looks
// exactly like a quiet map; a live match's score rises far more often.
const KILLS_ALIVE_MS = 3 * 60 * 1000;
// Past KILLS_STEP_MS plus the time the match takes to make this many kills
// at its own pace in the window: silent longer, and the kills are late, not
// the map quiet. 15 raises no false alarm on the recorded history.
const KILLS_LATE_KILLS = 15;
// A step that lands after more than this of still kills is the source
// catching up: when it happened is unknown, so it lights no swords until the
// next step...
const KILLS_CATCHUP_MS = 10 * 60 * 1000;
// ...unless the stall was short and the jump is big even spread over all of
// it: up to this, the swords light when the kills over the longer of the
// window and the stall still reach HOT_FLOOR per 10 min.
const KILLS_CATCHUP_MAX_MS = 20 * 60 * 1000;

function sumKills(n) {
  let t = 0;
  for (const k in n) t += Number(n[k]) || 0;
  return t;
}

// Which map is busy, and how much the corner may say, in one place: the
// map's corner, the tab's swords and the tier button's badge all read this,
// so they cannot part. `types`: the maps to pick from, in the order a tie
// keeps. The rates window aims at 10 min back, never under 8 nor over 15
// (the history has a line every 5 min).
const HOT_WANT_MS = 10 * 60 * 1000;
const WINDOW_MIN_MS = 8 * 60 * 1000;
const WINDOW_MAX_MS = 15 * 60 * 1000;
const HOT_NOW_MS = 60 * 1000;  // a kept body this fresh paints the swords without waiting for the read
const HOT_FLOOR = 50;      // kills per ten minutes: a real fight, not API noise

function killView(match, types, now = Date.now()) {
  const view = { clock: 0, atLeast: false, silence: 0, prevRun: Infinity, rates: null, pace: 0,
    strange: false, frozen: false, alive: false, hot: null, jumpHeld: false, noWindow: 'data', counting: null, long: false, longOk: false, gap: null, still: false, upTo: 0 };
  // Nothing is claimed on a match that is not running: between the reset
  // and the API publishing the new one, the rest of the popover is neutral.
  if (!match || !matchIsLive(match)) return view;
  const rose = matchScoreRoseAt(match.id);
  view.frozen = now - rose > HUD_STALE_MS;
  const kept = newestMatches.get(match.id);
  view.alive = !!kept && !!kept.rose && now - kept.at <= KILLS_ALIVE_MS;

  const list = fightSamples(match);
  const body = fightTotals(match);
  const bodyTotal = sumKills(body);
  const series = list.map((s) => ({ at: s.at, total: sumKills(s.n) }));
  const listTop = series.reduce((m, s) => Math.max(m, s.total), 0);
  if (!series.length || bodyTotal > listTop) {
    let seen = killFirstSeen.get(match.id);
    if (!seen || seen.total !== bodyTotal) {
      seen = { total: bodyTotal, at: now };
      killFirstSeen.set(match.id, seen);
    }
    // A body's kills are as old as its score: one body carries both.
    series.push({ at: rose > 0 ? Math.min(seen.at, rose) : seen.at, total: bodyTotal });
    series.sort((a, b) => a.at - b.at);
  }
  const top = Math.max(bodyTotal, listTop);
  const first = series.findIndex((s) => s.total >= top);
  view.clock = series[first].at;
  view.atLeast = first === 0;
  view.silence = Math.max(0, now - view.clock);
  if (first > 0) {
    const before = series[first - 1].total;
    view.prevRun = view.clock - series.find((s) => s.total >= before).at;
  }

  let base = null;
  for (const s of list) {
    const back = view.clock - s.at;
    if (back < WINDOW_MIN_MS || back > WINDOW_MAX_MS) continue;
    if (!base || Math.abs(back - HOT_WANT_MS) < Math.abs(view.clock - base.at - HOT_WANT_MS)) base = s;
  }
  if (!base) {
    for (const s of list) if (s.at <= view.clock - HOT_WANT_MS) base = s;
  }
  if (!base) {
    const start = Date.parse(match.start_time);
    // Right after the reset or a relink there is nothing earlier to count from.
    if (Number.isFinite(start) && view.clock - start < WINDOW_MAX_MS + HOT_WANT_MS) view.noWindow = 'reset';
    else if (view.atLeast && list.length && list[list.length - 1].at - view.clock >= HOT_WANT_MS) {
      // Every reading holds the newest total, over 10 minutes or more: none in
      // them, and the last kill came before the oldest, when is unknown.
      killCountingSince.delete(match.id);
      view.still = true;
      view.upTo = series[series.length - 1].at;
      view.rates = { per: new Map(Object.keys(body).map((type) => [type, 0])), span: HOT_WANT_MS };
    } else {
      // Mid-week with no history to lean on: this page's own readings fill in.
      if (!killCountingSince.has(match.id)) killCountingSince.set(match.id, now);
      const since = Math.min(killCountingSince.get(match.id), list.length ? list[0].at : now);
      view.counting = { since, ready: since + HOT_WANT_MS };
    }
  } else {
    killCountingSince.delete(match.id);
    const span = view.clock - base.at;
    view.long = span > WINDOW_MAX_MS;
    // A long window still counts for the swords up to the catch-up limit: the rates are per 10 min.
    view.longOk = view.long && span <= KILLS_CATCHUP_MAX_MS;
    const next = list.find((s) => s.at > base.at);
    view.gap = { from: base.at, to: next ? Math.min(next.at, view.clock) : view.clock };
    const per = new Map();
    let moved = 0;
    for (const type in body) {
      // Inside a week kills only rise: the highest reading of a map is its newest.
      let high = body[type];
      for (const s of list) high = Math.max(high, Number(s.n[type]) || 0);
      const d = Math.max(0, high - (Number(base.n[type]) || 0));
      moved += d;
      per.set(type, d * (600000 / span));
    }
    view.rates = { per, span };
    view.pace = moved / (span / 60000);
  }
  if (view.pace > 0) {
    view.strange = view.silence > KILLS_STEP_MS + (KILLS_LATE_KILLS / view.pace) * 60000;
  }

  const catching = view.prevRun > KILLS_CATCHUP_MS;
  if (view.rates && (!view.long || view.longOk) && !view.strange && !view.frozen && view.silence <= HOT_WANT_MS) {
    // After a stall the kills are spread over all of it, the window or the stall, whichever is longer.
    const spread = catching ? view.rates.span / Math.max(view.rates.span, view.prevRun) : 1;
    const canLight = !catching || view.prevRun <= KILLS_CATCHUP_MAX_MS;
    const pick = types || MAP_PANEL_ORDER.filter((t) => (match.maps || []).some((m) => m.type === t));
    let bestN = 0;
    let rawBest = 0;
    // Taken on a strict win, so a tie keeps whichever map comes first rather
    // than swapping the swords on every refresh.
    for (const type of pick) {
      const raw = view.rates.per.get(type) || 0;
      rawBest = Math.max(rawBest, raw);
      const n = raw * spread;
      if (canLight && n > bestN) { bestN = n; view.hot = type; }
    }
    if (bestN < HOT_FLOOR) view.hot = null;
    // True when the jump would light the swords were it not for the stall.
    view.jumpHeld = catching && !view.hot && rawBest >= HOT_FLOOR;
  }
  return view;
}

// killView's pick and window, under the name the tab and the badge call.
function hotMapOf(match, types) {
  const view = killView(match, types);
  return { hot: view.hot, rates: view.rates, view };
}


// ---- what happened while the data was away -----------------------------
// Two gaps get a summary at the top of the maps' right-hand column: the
// game's API answering the same body past HUD_STALE_MS while this page went
// on asking (a "pause"), and this tab hidden past MISSED_AWAY_MS (a
// "return"). Either way it is the body kept before the gap against the
// first one after it: the objectives that changed hands, as chips, and the
// kills between the two. Nothing changed, nothing shows. Every body passes
// through missedMatchOffered, called from keepNewestMatch in api.js.
const MISSED_SHOW_MS = 10 * 60 * 1000;      // the summary stays this long after the data came back
const MISSED_RING_MS = 7 * 1000;            // four pulses of the ring (css/maps.css)
const MISSED_ASLEEP_MS = 3 * 60 * 1000;     // no read for this long: the page was not asking (a laptop asleep)
const MISSED_AWAY_MS = 3 * 60 * 1000;       // a tab hidden this long gets the summary on its return
const MISSED_RETURN_WAIT_MS = 2 * 60 * 1000;
const MISSED_CHANGES_MAX = 40;
const MISSED_CHIPS_WIDE = 4;   // per map
const MISSED_CHIPS_NARROW = 3;
const MISSED_NARROW = '(max-width: 480px)';
const MISSED_SHORT_NAME = Object.freeze({ 'Stonemist Castle': 'SM' });
const MISSED_MAP_TINT = Object.freeze({ RedHome: 'red', BlueHome: 'blue', GreenHome: 'green' });
const MISSED_NO_FLIP = new Set(['Ruins', 'Spawn']);

const missedLastOffer = new Map();   // match id -> ms of the last body offered
const missedNotes = new Map();       // match id -> the summary
const missedRings = new Map();       // match id -> { ids: Set, until }
let missedHidden = null;             // { at, bodies } while the tab is hidden
let missedReturn = null;             // { since, back, bodies } until each match answers once
let missedOpen = null;               // { matchId, trigger } of the maps popover

const missedOwner = (s) => {
  const c = String(s || '').toLowerCase();
  return COLORS.includes(c) ? c : 'neutral';
};
const missedMaps = (m) => (m && Array.isArray(m.maps) ? m.maps : []);
const missedObjectives = (map) => (map && Array.isArray(map.objectives) ? map.objectives : []);
const missedKillTotal = (m) => missedMaps(m).reduce((n, map) => n + colorSum(map && map.kills), 0);

function missedMapOpenFor(matchId) {
  return !!missedOpen && missedOpen.matchId === matchId && activeTrigger === missedOpen.trigger
    && document.visibilityState === 'visible';
}

// Every objective whose owner differs between the two bodies, by map.
function missedOwnerChanges(before, after) {
  const was = new Map();
  for (const map of missedMaps(before)) for (const o of missedObjectives(map)) if (o) was.set(o.id, o);
  const out = [];
  for (const map of missedMaps(after)) {
    for (const o of missedObjectives(map)) {
      const p = o && was.get(o.id);
      if (!p || typeof o.id !== 'string' || MISSED_NO_FLIP.has(o.type)) continue;
      const from = missedOwner(p.owner);
      const to = missedOwner(o.owner);
      if (from !== to) out.push({ id: o.id, map: map.type, type: o.type, from, to, flipped: Date.parse(o.last_flipped) });
    }
  }
  return out;
}

// The kills moved, or an objective changed hands or was flipped back.
function missedBodyChanged(a, b) {
  if (missedKillTotal(a) !== missedKillTotal(b)) return true;
  const was = new Map();
  for (const map of missedMaps(a)) for (const o of missedObjectives(map)) if (o) was.set(o.id, o);
  for (const map of missedMaps(b)) {
    for (const o of missedObjectives(map)) {
      const p = o && was.get(o.id);
      if (p && (p.owner !== o.owner || p.last_flipped !== o.last_flipped)) return true;
    }
  }
  return false;
}

function missedRingFor(matchId, changes) {
  if (!changes.length || !missedMapOpenFor(matchId)) return;
  missedRings.set(matchId, { ids: new Set(changes.map((c) => c.id)), until: Date.now() + MISSED_RING_MS });
}

// The ring's end on an objective of an open map, or 0.
function missedRingUntil(matchId, objId) {
  const ring = missedRings.get(matchId);
  return ring && ring.until > Date.now() && ring.ids.has(objId) ? ring.until : 0;
}

// When the kills between two bodies were made, from the data and not from this
// page's clock: the start is when the history (the shared rows and this
// browser's log) first showed the total of the body before; the end, when it
// first showed the total of the body after, or `back` for a body the history
// has not seen. The body before happened between the reading just under its
// total and the one that reached it: the start is sure when that total is
// exact, the two readings are close, or the page's own time is close. Without
// a reading under it (the oldest there is) or with a wide gap and an old body,
// the start is only an upper bound: sure is false and the text says "since
// before". Never later than the page's own `since`.
// And never later than the oldest `last_flipped` among the objectives listed
// (`changes`): that is the game's own time for the flip, so a body that was old
// when the tab hid or the API stalled cannot leave a listed flip outside the
// period written. When that flip is older than what the history proves, the
// start is the flip itself and it is sure: the time is exact data, not a bound.
// A time that is not a number, or past `end`, says nothing and is skipped.
// The end is likewise never earlier than the newest of those flips.
// The history's rows bound when a total first showed: within this of the
// page's own reading, or this close to the row before it, the start is fixed.
const MISSED_BOUND_MS = 3 * 60 * 1000;

function missedPeriod(before, after, since, back, changes = []) {
  const need = missedKillTotal(before);
  const got = missedKillTotal(after);
  const list = fightSamples(after);
  const total = (s) => sumKills(s.n);
  const i = list.findIndex((s) => total(s) >= need);
  let start = since;
  let sure = false;
  if (i >= 0) {
    start = Math.min(since, list[i].at);
    sure = i > 0 && (total(list[i]) === need || list[i].at - list[i - 1].at <= MISSED_BOUND_MS
      || list[i].at >= since - MISSED_BOUND_MS);
  }
  let oldest = Infinity;
  let newest = -Infinity;
  for (const c of changes) {
    if (!Number.isFinite(c.flipped) || c.flipped > back) continue;
    oldest = Math.min(oldest, c.flipped);
    newest = Math.max(newest, c.flipped);
  }
  if (oldest < start) { start = oldest; sure = true; }
  let end = back;
  if (got > need) {
    const j = list.findIndex((s) => total(s) === got && s.at > start);
    if (j >= 0) end = Math.min(back, list[j].at);
  }
  // The history may show the new total before a listed flip happened (its
  // rows are 30 to 60 s apart): the end is never before the newest of them.
  return { start, end: Math.max(end, newest), sure };
}

function missedMakeNote(before, after, since, back, kind, endAt = back) {
  const changes = missedOwnerChanges(before, after).slice(0, MISSED_CHANGES_MAX);
  const name = (c) => {
    const id = COLORS.includes(c) ? matchTeamId(after, c) : null;
    return id ? getTeamName(id) : 'Neutral';
  };
  for (const c of changes) { c.toName = name(c.to); c.fromName = name(c.from); }
  // The whole match, before against after: the number a reader can check.
  const kills = Math.max(0, missedKillTotal(after) - missedKillTotal(before));
  // The same difference map by map, the maps that moved, in the tabs' order.
  const was = new Map(missedMaps(before).map((m) => [m && m.type, colorSum(m && m.kills)]));
  const order = Object.keys(MAP_TAB_NAME);
  const perMap = missedMaps(after)
    .map((m) => ({ type: m && m.type, n: Math.max(0, colorSum(m && m.kills) - (was.get(m && m.type) || 0)) }))
    .filter((m) => m.n > 0 && typeof m.type === 'string')
    .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const period = missedPeriod(before, after, since, endAt, changes);
  // The body is kept only after this call: until then the end is the period's,
  // then the time the kept body's data is from, which the history may still
  // move earlier. A later body moves that time on, so the earliest end
  // seen stands (missedMatchOffered reads it before keepNewestMatch writes).
  const newest = Math.max(period.start, ...changes.map((c) => (c.flipped <= endAt ? c.flipped : -Infinity)));
  let earliest = period.end;
  const end = () => {
    const kept = newestMatches.get(after.id);
    if (kept && !missedBodyChanged(kept.match, after)) earliest = Math.min(earliest, kept.at);
    return Math.max(earliest, newest);
  };
  missedNotes.set(after.id, { kind, since: period.start, get end() { return end(); }, sure: period.sure, back,
    before, rawSince: since, after,
    until: back + MISSED_SHOW_MS, changes, kills, perMap,
    open: false, wideOpen: true, moreMaps: new Set() });
  if (endAt === back) missedRingFor(after.id, changes);
}

// A newer body while the summary is up (the first answer after a gap may come
// from the server group that is behind): the same body before, against this
// one, so the kills and the period follow the newest data. What the reader
// opened or folded stays, and so does the time it goes away.
function missedRefreshNote(match, now) {
  const note = missedNoteFor(match.id);
  if (!note || !note.before || !missedBodyChanged(note.after, match)) return false;
  const old = note;
  missedMakeNote(old.before, match, old.rawSince, old.back, old.kind, now);
  const fresh = missedNotes.get(match.id);
  Object.assign(fresh, { until: old.until, open: old.open, wideOpen: old.wideOpen, moreMaps: old.moreMaps });
  return true;
}

// Called by keepNewestMatch with every body offered and the one kept before it.
function missedMatchOffered(match, kept) {
  const now = Date.now();
  const lastOffer = missedLastOffer.get(match.id) || 0;
  missedLastOffer.set(match.id, now);
  const standing = missedNotes.get(match.id);
  // Reading the end fixes it before keepNewestMatch moves `at` on.
  if (standing) void standing.end;
  if (!kept || matchIsBehind(match, kept.match)) return;
  if (match.start_time !== kept.match.start_time || !matchIsLive(match)) return;
  if (missedReturn && now - missedReturn.back > MISSED_RETURN_WAIT_MS) missedReturn = null;
  if (missedReturn && missedReturn.bodies.has(match.id)) {
    const before = missedReturn.bodies.get(match.id);
    missedReturn.bodies.delete(match.id);
    if (before.start_time === match.start_time && missedBodyChanged(before, match)) {
      missedMakeNote(before, match, missedReturn.since, now, 'return');
      return;
    }
  }
  if (now - kept.at > HUD_STALE_MS && lastOffer > kept.at && now - lastOffer < MISSED_ASLEEP_MS
      && missedBodyChanged(kept.match, match)) {
    missedMakeNote(kept.match, match, kept.at, now, 'pause');
    return;
  }
  if (missedRefreshNote(match, now)) return;
  // Any other update: the ring alone, on what changed hands under your eyes.
  missedRingFor(match.id, missedOwnerChanges(kept.match, match));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    missedHidden = { at: Date.now(), bodies: new Map([...newestMatches].map(([id, k]) => [id, k.match])) };
    return;
  }
  if (missedHidden && Date.now() - missedHidden.at > MISSED_AWAY_MS) {
    missedReturn = { since: missedHidden.at, back: Date.now(), bodies: missedHidden.bodies };
  }
  missedHidden = null;
});

function missedNoteFor(matchId) {
  const note = missedNotes.get(matchId);
  if (note && Date.now() > note.until) { missedNotes.delete(matchId); return null; }
  return note || null;
}

// ---- loading js/maps.js ---------------------------------------------------
// One request, shared by the start after the standings and a click. A download that fails
// is forgotten, so the next try asks again; a file that loaded is never
// inserted twice (its top-level declarations would throw).
const MAPS_SCRIPT = 'js/maps.js';
let mapsScriptLoad = null;

function loadMapsScript() {
  if (typeof fillTierMaps === 'function') return Promise.resolve();
  if (!mapsScriptLoad) {
    mapsScriptLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = MAPS_SCRIPT;
      s.onload = () => (typeof fillTierMaps === 'function' ? resolve() : reject(new Error('maps.js has no fillTierMaps')));
      s.onerror = () => {
        s.remove();
        mapsScriptLoad = null;
        reject(new Error('maps.js did not load'));
      };
      document.head.appendChild(s);
    });
  }
  return mapsScriptLoad;
}

function showMapsLoading(el) {
  const loading = document.createElement('p');
  loading.className = 'hint';
  loading.style.margin = '0';
  loading.innerHTML = '<span class="spinner"></span>Loading maps…';
  el.appendChild(loading);
}

async function toggleTierMaps(match, regionName, tierNum, triggerEl) {
  const popover = openPopover(triggerEl, `${regionName} Tier ${tierNum} maps`, showMapsLoading, 'info-popover--maps');
  if (!popover) return; // it was already open; openPopover just closed it

  // Four maps and a detail panel do not fit in an anchored popover, so
  // this one opens the way the guild list looks once expanded.
  setPopoverExpanded(popover, triggerEl, true);
  await fillWhenLoaded(popover, match, regionName, tierNum, triggerEl);
}

// With maps.js already in, the opening goes on in the same click.
async function fillWhenLoaded(popover, match, regionName, tierNum, triggerEl) {
  if (typeof fillTierMaps !== 'function') {
    try {
      await loadMapsScript();
    } catch {
      if (activePopover !== popover) return;
      popover.textContent = '';
      const msg = document.createElement('p');
      msg.className = 'hint';
      msg.style.margin = '0';
      msg.textContent = "Couldn't load the maps right now. ";
      msg.appendChild(buildRetryButton((e) => {
        // Kept from the document's handler, which would take the detached
        // button for a click outside and close the popover.
        e.stopPropagation();
        popover.textContent = '';
        showMapsLoading(popover);
        fillWhenLoaded(popover, match, regionName, tierNum, triggerEl);
      }));
      popover.appendChild(msg);
      return;
    }
    // Closed while loading. The trigger is not enough: closed and opened
    // again, the same button holds a new popover, and this one is gone.
    if (activePopover !== popover) return;
  }
  await fillTierMaps(popover, match, regionName, tierNum, triggerEl);
}

// The match each tier button opens and paints its badge from: the one it
// was built with, until a score written into its card in place
// (patchStandingMatch) gives it the new one. A WeakMap: a board built again
// drops the old buttons.
const tierMapButtons = new WeakMap();
let mapBadgesAsked = false;

// The newest body the page holds for the match (keepNewestMatch). The badge
// and the open map's tabs both judge this one, or they part: the button's
// own body is up to five minutes older than the map's.
function newestBodyOf(match) {
  const kept = match && newestMatches.get(match.id);
  return kept ? kept.match : match;
}

function paintMapBadge(btn) {
  const info = tierMapButtons.get(btn);
  const { regionName, tierNum } = info;
  const match = newestBodyOf(info.match);
  const types = MAP_PANEL_ORDER.filter((t) => (match.maps || []).some((m) => m.type === t));
  const { hot } = hotMapOf(match, types);
  const had = btn.querySelector('.tier-map-badge');
  const name = hot ? (MAP_TAB_NAME[hot] || hot) : '';
  btn.setAttribute('aria-label', `Show the live map for ${regionName} Tier ${tierNum}` + (name ? ` \u2014 busiest: ${name}` : ''));
  btn.title = `Live map \u00b7 ${regionName} Tier ${tierNum}` + (name ? ` \u00b7 busiest: ${name}` : '');
  btn.classList.toggle('has-badge', !!hot);
  if (!hot) { if (had) had.remove(); return; }
  if (had) return;
  const badge = document.createElement('span');
  badge.className = 'tier-map-badge';
  const im = document.createElement('img');
  im.src = 'assets/icons/Event_Swords.webp';
  im.alt = '';
  im.width = 11;
  im.height = 11;
  badge.appendChild(im);
  btn.appendChild(badge);
}

// Every tier button on the page, or only those of one match (a server card
// carries one too).
function paintMapBadges(matchId) {
  for (const btn of document.querySelectorAll('.tier-map-btn')) {
    const info = tierMapButtons.get(btn);
    if (info && (!matchId || info.match.id === matchId)) paintMapBadge(btn);
  }
}

// Once, after the first standings: the badge needs the shared history,
// which is otherwise read only when a map opens. Cached and with its own
// fallback, so this is the one extra read of /api/kills. Then repainted
// every 30 s from what the page already holds - the rate's window moves
// and the data ages without a new reading - with no request of its own.
// Started here, so one timer however many times the table is rebuilt.
// Also where js/maps.js is first asked for: right away, not when the
// browser is idle, because the ember canvas keeps it from ever being idle
// and a click soon after the standings would wait on the whole download.
function primeMapBadges() {
  if (mapBadgesAsked) return;
  mapBadgesAsked = true;
  loadMapsScript().catch(() => { /* the click asks again */ });
  getKillSheet().then(() => {
    paintMapBadges();
    setInterval(() => paintMapBadges(), MAP_REFRESH_MS);
  });
}

// The first map's terrain picture, asked for when the mouse reaches a map
// button or it takes focus, so it is in the cache by the click. The same URL
// fillTierMaps asks for, so the <image> finds it there. MAP_IMAGE lives in
// js/maps.js: if that is not in yet, the picture waits for it.
const mapPicturesAsked = new Set();

function askFirstMapPicture(btn) {
  const info = tierMapButtons.get(btn);
  if (!info) return;
  // The same connection test as the terrain warm-up in js/maps.js.
  const conn = navigator.connection;
  if (conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return;
  const maps = newestBodyOf(info.match).maps || [];
  const type = MAP_PANEL_ORDER.find((t) => maps.some((m) => m.type === t));
  const first = maps.find((m) => m.type === type);
  if (!first) return;
  const ask = () => {
    const pic = MAP_IMAGE[first.id];
    if (!pic || mapPicturesAsked.has(pic.lite)) return;
    mapPicturesAsked.add(pic.lite);
    new Image().src = pic.lite;
  };
  if (typeof MAP_IMAGE !== 'undefined') ask();
  else loadMapsScript().then(ask, () => { /* the click asks again */ });
}

document.addEventListener('pointerover', (e) => {
  const btn = e.pointerType === 'mouse' && e.target.closest && e.target.closest('.tier-map-btn');
  if (btn) askFirstMapPicture(btn);
});
document.addEventListener('focusin', (e) => {
  const btn = e.target.closest && e.target.closest('.tier-map-btn');
  if (btn) askFirstMapPicture(btn);
});

function buildTierMapButton(match, regionName, tierNum) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn tier-map-btn';
  btn.setAttribute('aria-label', `Show the live map for ${regionName} Tier ${tierNum}`);
  btn.title = `Live map · ${regionName} Tier ${tierNum}`;
  markPopoverTrigger(btn);
  // The folded map. No miniature of the territory: four coloured patches
  // at this size read as a badge, not a map. The dot does the same job as
  // the zigzag: the zigzag says the sheet is folded, the dot says something
  // is drawn on it. Word first, glyph after, matching the server cards.
  btn.innerHTML = '<span class="tier-map-label">Live maps</span>' +
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<g stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6.5 9 3l6 3.5 6-3.5v14.5l-6 3.5-6-3.5-6 3.5Z"/>' +
    '<path d="M9 3v14.5M15 6.5V21"/>' +
    '</g>' +
    '<circle cx="12" cy="9.2" r="1.6" fill="currentColor"/>' +
    '</svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTierMaps(tierMapButtons.get(btn).match, regionName, tierNum, btn);
  });
  tierMapButtons.set(btn, { match, regionName, tierNum });
  paintMapBadge(btn);
  return btn;
}
