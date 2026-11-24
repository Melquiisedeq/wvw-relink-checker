// A fake Guild Wars 2 world with one timeline. Every URL the page reads a match
// from - the plain list of ids, ?ids=all, ?ids=<list>, ?id=, ?world=,
// /api/latest (and its summary), /api/history and /api/kills - is answered from the same
// timeline at the page's own time,
// so no two URLs contradict each other: bodies that disagree between URLs
// mislead the page into states the game never shows.
//
//   gw2.match('1-1')                      // the recording, as the 1-1 focus
//     .advance(12, { kills: { Center: 30 } })   // 12 min of play, one state a minute
//     .advance(6, { kills: {} })          // the score rises, the kills stand still
//     .advance(6, { every: 0.5 })         // a state each 30 s
//     .pageOpens()                        // the page's clock starts here
//     .olderPool(10).advance(20).olderPool(0)   // a server group 10 min behind
//     .olderPool(30, { every: true })     // the visitor's whole group 30 min behind
//     .latestHeld(true)                   // our copy keeps this moment's bodies
//     .freeze(40)                         // 40 min, nothing new from the API
//     .status(503).advance(8).status(null)      // the game moves, the API is down
//     .status(429, { visitor: true })     // only the visitor's reads refused
//     .latestStatus(503)                  // /api/latest down (or 'hang': never answers)
//     .seared()                           // the borderlands as the Seared Borderlands' ids
//     .seared({ untilWeek: true })        // the same until the week turns, the recorded ids after
//
// Immutable: every method returns a new timeline. Time is in minutes after the
// recording's instant (recordedAt). Only the focus match plays; the others keep
// their recorded bodies, apart from turning over to a new week at their end.
//
// The rules every body keeps, each from the code in site/js/ that relies on it:
// - id matches ^[12]-[1-9]$ (js/api.js, WEEK_ID_RE; /api/latest drops others).
// - start <= now < end for every body of the newest pool (js/config.js,
//   matchIsLive; js/stat-popovers.js, skirmishProgress); a week ends, the
//   next one starts at that end with every counter at zero.
// - Inside a week kills+deaths and the scores only grow (js/api.js,
//   matchIsBehind): the older pool serves a body behind, never a body that
//   went backwards.
// - The page reads only the last skirmish (js/panels.js, getSkirmishScore):
//   a new one is appended at each two-hour mark after the recording, and the
//   score of the minute goes into the last one.
// - A skirmish that ends gives its colours victory points by its score, in the
//   same body as the skirmish after it (js/standings.js, sideFigures; js/panels.js,
//   rankMatchByVictoryPoints). The points are the game's table for the region
//   (the id: 1-x NA, 2-x EU) and the UTC hour the skirmish starts, the week's
//   start hour plus two per skirmish (WAR_VP, skirmishPoints; source
//   https://wiki.guildwars2.com/wiki/World_versus_World, "Skirmishes"). Colours
//   that tie take the points of the highest place among them. The recorded
//   bodies are checked against the table once (baseBodies): a mismatch throws.
// - A flip changes `owner` and `last_flipped` together (js/maps-early.js,
//   missedOwnerChanges and missedBodyChanged; js/maps.js, riLeft).
// - The maps add up to the match: kills, deaths and scores per colour are the
//   sums over maps[] (js/maps-early.js, fightTotals and missedKillTotal, read
//   the maps; js/api.js, matchActivity, the totals).
//   The skirmishes add up to the scores too.
// - An objective is worth what the War Score says (js/maps.js: the objective's
//   "Per tick" row, shown only when it ticks, and the board's PPT, the ticks
//   added up; the score bar counts each objective by its type and tier, not by these ticks):
//   points_capture by tier, T0 to T3, Camp 2/10/15/25, Tower 25/125/200/250,
//   Keep 100/200/400/500, Castle 200/250/300/400; points_tick
//   only at T3, Keep 10, Tower 7, Castle 20, every other type 0. The recorded
//   tick (the old rule: Camp 2/3/4/5, Tower 4/6/8/10, Keep 8/12/16/20, Castle
//   12/16/20/24) names the recorded tier. A flip, and a week begun, take the
//   objective back to T0, as in the game.
// The server checks the bodies it serves against these (served() below) and
// reports a break as a problem of the test.
import { createHmac } from 'node:crypto';
import { recording } from './recordings.mjs';

const MIN = 60 * 1000;
const SKIRMISH_MS = 2 * 60 * MIN;
const WEEK_MS = 7 * 24 * 60 * MIN;
const RESET_LAG_MS = 2 * MIN;              // the recorded end_time to the reset the page keeps
const KILLS_WINDOW_MS = 30 * MIN;           // what /api/kills serves (js/maps-early.js, readOwnKills)
const COLORS = ['red', 'blue', 'green'];
const MAPS = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];   // js/config.js, KILLS_MAP_ORDER
const NEXT_OWNER = Object.freeze({ Red: 'Blue', Blue: 'Green', Green: 'Red', Neutral: 'Red' });
const FLIPPABLE = new Set(['Camp', 'Tower', 'Keep']);
const ID_RE = /^[12]-[1-9]$/;
const API = 'https://api.guildwars2.com/v2/wvw/matches?';
const TACTICS = 'https://api.guildwars2.com/v2/guild/upgrades?ids=';
const SHEET_RESET_RATIO = 0.5;   // apps-script/kills/kills.gs, RESET_RATIO
const SHEET_KILLS_URL = 'https://docs.google.com/spreadsheets/d/1Lh6dGhlYVvvKlXT_tofEUKZhYGW71Jij1IstbdPF2fg/gviz/tq?tqx=out:csv&sheet=kills';   // js/config.js, KILLS_SHEET_URL
const DEFAULT_SCORE = Object.freeze({ red: 120, blue: 80, green: 60 });   // per minute
const DEFAULT_KILLS = Object.freeze({ Center: 30 });                     // per minute: a fight on EBG

// The old rule's tick by tier, to read the tier a recorded objective had; the War Score's
// points by tier.
const OLD_TICK = Object.freeze({ Camp: [2, 3, 4, 5], Tower: [4, 6, 8, 10], Keep: [8, 12, 16, 20], Castle: [12, 16, 20, 24] });
const WAR_CAPTURE = Object.freeze({ Camp: [2, 10, 15, 25], Tower: [25, 125, 200, 250], Keep: [100, 200, 400, 500], Castle: [200, 250, 300, 400] });
const WAR_TICK = Object.freeze({ Tower: 7, Keep: 10, Castle: 20 });   // at T3 only
// Victory points of a skirmish [1st, 2nd, 3rd], by region and the UTC hour it starts.
const VP_TIERS = { a: [15, 14, 12], b: [22, 18, 14], c: [31, 24, 17], d: [51, 37, 24], e: [43, 32, 21], f: [23, 18, 14], g: [19, 16, 13] };
const WAR_VP = Object.freeze({
  1: 'eecfgggffffc'.split('').map(k => VP_TIERS[k]),   // NA, hours 0, 2, ... 22
  2: 'aaaabbbccddc'.split('').map(k => VP_TIERS[k]),   // EU
});
// The victory points a finished skirmish gives each colour. `startMs` is its week's start,
// `skirmish` its body ({ id, scores }); an odd start hour is a break of the test.
function skirmishPoints(matchId, startMs, skirmish) {
  const table = WAR_VP[matchId.split('-')[0]];
  if (!table) throw new Error(`gw2: no victory point table for ${matchId}`);
  const hour = (Math.round(startMs / 3600000) + 2 * (skirmish.id - 1)) % 24;   // a week begun a minute or two off the hour counts as on it
  if (hour % 2) throw new Error(`gw2: skirmish ${skirmish.id} of ${matchId} starts at an odd hour (${hour})`);
  const sc = skirmish.scores;
  return Object.fromEntries(COLORS.map(c => [c, table[hour / 2][COLORS.filter(o => sc[o] > sc[c]).length]]));
}

const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sum = o => COLORS.reduce((n, c) => n + (Number(o && o[c]) || 0), 0);
const byId = (a, b) => a.localeCompare(b, 'en', { numeric: true });
// n split over the three colours, the remainder to the first.
const thirds = n => { const b = Math.floor(n / 3); return [n - 2 * b, b, b]; };

// The recorded bodies, the furthest along of ?ids=all and ?id= for each match
// (the recording's ?id=2-5 is behind its ?ids=all).
let based = null;
function baseBodies() {
  if (based) return based;
  const { entries } = recording();
  const read = url => { const e = entries.get(url); return e ? JSON.parse(Buffer.from(e[2], e[3] ? 'base64' : 'utf8').toString('utf8')) : null; };
  const all = read(API + 'ids=all');
  if (!Array.isArray(all)) throw new Error('gw2: ids=all not recorded');
  based = new Map();
  for (const m of all) {
    const one = read(API + 'id=' + m.id);
    const act = x => sum(x.kills) + sum(x.deaths);
    based.set(m.id, one && (act(one) > act(m) || (act(one) === act(m) && sum(one.scores) > sum(m.scores))) ? one : m);
  }
  for (const [id, b] of based) {
    const got = { red: 0, blue: 0, green: 0 };
    for (const sk of b.skirmishes.slice(0, -1)) {
      const vp = skirmishPoints(id, Date.parse(b.start_time), sk);
      for (const c of COLORS) got[c] += vp[c];
    }
    for (const c of COLORS) {
      if (got[c] !== b.victory_points[c]) throw new Error(`gw2: the victory point table (WAR_VP) gives ${id} ${c} ${got[c]}, the recording has ${b.victory_points[c]}`);
    }
  }
  const kills = read('https://wvwrelink.com/api/kills');
  based.rows = kills && Array.isArray(kills.rows) ? kills.rows : [];
  // Every guild tactic the recording holds: which ones the maps ask for
  // depends on the match open and on what changed hands.
  based.tactics = new Map();
  for (const url of entries.keys()) {
    if (url.startsWith(TACTICS)) for (const u of read(url) || []) based.tactics.set(String(u.id), u);
  }
  return based;
}

// The Seared Borderlands: the map ids the game gives each borderland. 1654 and
// 1651 number their objectives as the Alpine 96 and 95 do; 1652 too, so the
// Desert's objectives take the Alpine numbers type by type, in id order.
const SEARED = Object.freeze({ RedHome: 1652, BlueHome: 1654, GreenHome: 1651 });
const objectiveNumber = id => Number(id.split('-')[1]);
let seared = null;
function searedBodies() {
  if (seared) return seared;
  const base = baseBodies();
  seared = new Map();
  for (const [id, recorded] of base) {
    const b = structuredClone(recorded);
    const alpine = b.maps.find(m => m.type === 'BlueHome').objectives;
    for (const m of b.maps) {
      const to = SEARED[m.type];
      if (!to) continue;
      const numbers = new Map();
      for (const type of new Set(m.objectives.map(o => o.type))) {
        const mine = m.objectives.filter(o => o.type === type).sort((x, y) => objectiveNumber(x.id) - objectiveNumber(y.id));
        const theirs = alpine.filter(o => o.type === type)
          .map(o => objectiveNumber(o.id)).sort((x, y) => x - y);
        if (mine.length !== theirs.length) throw new Error(`gw2: ${id} ${m.type} has ${mine.length} ${type}, the Alpine ${theirs.length}`);
        mine.forEach((o, i) => numbers.set(o, theirs[i]));
      }
      m.id = to;
      for (const o of m.objectives) o.id = `${to}-${numbers.get(o)}`;
    }
    seared.set(id, b);
  }
  seared.rows = base.rows;
  seared.tactics = base.tactics;
  return seared;
}

// A week of one match: its start, end and teams. `zero`: a week this timeline
// began, every counter at zero; otherwise the recorded week.
const weekOf = (b, lag = 0) => ({ start: Date.parse(b.start_time), end: Date.parse(b.end_time) + lag, all_worlds: b.all_worlds, worlds: b.worlds, zero: false });

// The cumulative state of a match since its week began: kills, deaths per map
// and colour, score per skirmish, map and colour, new skirmishes, flips.
const freshState = (week, skirmishes) => ({ week, kills: {}, deaths: {}, score: {}, skirmishes, flips: new Map() });
const copyState = s => ({ week: s.week, kills: structuredClone(s.kills), deaths: structuredClone(s.deaths),
  score: structuredClone(s.score), skirmishes: s.skirmishes, flips: new Map(s.flips) });

class Timeline {
  #focus; #ops; #cursor; #opensAt; #weekEnd;

  constructor(focus, ops, cursor, opensAt, weekEnd) {
    this.#focus = focus;
    this.#ops = Object.freeze(ops);
    this.#cursor = cursor;
    this.#opensAt = opensAt;
    this.#weekEnd = weekEnd;
    Object.freeze(this);
  }

  #with(ops, cursor = this.#cursor, opensAt = this.#opensAt, weekEnd = this.#weekEnd) {
    return new Timeline(this.#focus, [...this.#ops, ...ops], cursor, opensAt, weekEnd);
  }

  get focus() { return this.#focus; }
  // Milliseconds after the recording at which the page's clock starts.
  get opensAt() { return this.#opensAt; }
  // Milliseconds after the recording of the last thing this timeline says.
  get end() { return this.#cursor; }

  // `min` minutes of play on the focus match, one state a minute. kills: per
  // map type and minute, split over the colours, each kill a death of the next
  // colour. flips: how many objectives change hands, spread over the span, or
  // the objective ids. score: per colour and minute, on EBG and the skirmish.
  // `every`: minutes between states (0.5: one each 30 s, kills and score split
  // between them); it must divide 1 and leave whole kills and points.
  advance(min, { kills = DEFAULT_KILLS, flips = 0, score = DEFAULT_SCORE, every = 1 } = {}) {
    if (!(min > 0)) throw new Error('gw2: advance needs minutes');
    const steps = Math.round(min / every);
    const part = o => Object.fromEntries(Object.entries(o).map(([k, n]) => [k, n * every]));
    if (!(every > 0 && every <= 1) || !Number.isInteger(1 / every) || Math.abs(steps * every - min) > 1e-9
      || ![...Object.values(kills), ...Object.values(score)].every(n => Number.isInteger(n * every))) {
      throw new Error('gw2: advance needs `every` to split the minutes, kills and score whole');
    }
    const list = typeof flips === 'number' ? Array.from({ length: flips }, () => null) : [...flips];
    const flipAt = new Map(list.map((obj, j) => [Math.max(1, Math.round((j + 1) * steps / (list.length + 1))), obj]));
    const ops = [];
    let weekEnd = this.#weekEnd;
    const stepKills = every === 1 ? kills : part(kills);
    const stepScore = every === 1 ? score : part(score);
    for (let i = 1; i <= steps; i++) {
      const at = this.#cursor + i * every * MIN;
      while (recording().recordedAt + at >= weekEnd) weekEnd += WEEK_MS;
      ops.push({ kind: 'minute', at, kills: stepKills, score: stepScore, flip: flipAt.has(i) ? (flipAt.get(i) || true) : null });
    }
    return this.#with(ops, this.#cursor + min * MIN, this.#opensAt, weekEnd);
  }

  // `min` minutes in which the API answers the same body.
  freeze(min) {
    if (!(min > 0)) throw new Error('gw2: freeze needs minutes');
    return this.#with([], this.#cursor + min * MIN);
  }

  // From here on, a server group `min` minutes behind answers every match URL
  // in every second minute; 0 ends it.
  // `every`: every read, in every minute: the visitor's IP is on the group behind.
  olderPool(min, { every = false } = {}) {
    return this.#with([{ kind: 'pool', at: this.#cursor, lag: Math.max(0, min) * MIN, every }]);
  }

  // From here on, every match URL answers `code` (503, 429) or never ('hang');
  // null ends it. /api/latest keeps the last body read before (our readers
  // read the same API); /api/kills gets no rows meanwhile.
  // `visitor`: only the visitor's reads (their server group down, their IP
  // refused); our readers, on the other group, go on, and so do /api/latest
  // and /api/kills.
  status(code, { visitor = false } = {}) {
    if (code !== null && code !== 'hang' && !(code >= 400 && code < 600)) throw new Error(`gw2: status ${code}`);
    return this.#with([{ kind: 'status', at: this.#cursor, code, visitor }]);
  }

  // From here on, /api/kills gets no rows while the API goes on (our readers
  // stopped); true ends it. The rows of those minutes never come back.
  killHistory(on) {
    return this.#with([{ kind: 'history', at: this.#cursor, on: !!on }]);
  }

  // From here on, /api/latest and its summary answer `code` (503: the Worker
  // with nothing recent kept) or never ('hang'); null ends it.
  latestStatus(code) {
    if (code !== null && code !== 'hang' && !(code >= 400 && code < 600)) throw new Error(`gw2: latest status ${code}`);
    return this.#with([{ kind: 'latest', at: this.#cursor, code }]);
  }

  // For the whole timeline /api/kills as the Worker builds it (worker/index.mjs,
  // rebuildRecent and READS): besides the last thirty minutes, each match's newest
  // row before them (up to 3 h back) and its kills' last move (the first row with
  // the newest total, the row before it, the newest row 10 min before the move,
  // within 2.5 h); a 503 once no row came in for 20 min.
  workerKills() {
    return this.#with([{ kind: 'worker-kills' }]);
  }

  // For the whole timeline the kills sheet as kills.gs writes it (apps-script/kills/kills.gs):
  // each minute in which the score its read gets rose, a row stamped with that minute, the
  // kills, start and score of that body; each write drops the rows over 2 h older than it.
  // `visitor`: kills.gs reads what the visitor's group answers (olderPool, a visitor's stall),
  // not what our readers do.
  sheetKills({ visitor = false } = {}) {
    return this.#with([{ kind: 'sheet-kills', visitor }]);
  }

  // From here on the API answers every match URL with the bodies of this moment
  // while the game plays on (a server group stuck); false ends it, and the next
  // read gets the game as it stands, every kill of the stall at once. Our readers
  // are stuck with it: /api/latest keeps this moment's bodies and /api/kills gets
  // no rows. `visitor`: only the visitor's group; our readers, on the other one,
  // go on, and so do /api/latest and /api/kills.
  stall(on, { visitor = false } = {}) {
    return this.#with([{ kind: 'stall', at: this.#cursor, on: !!on, visitor }]);
  }

  // From here on our readers push nothing (each stuck on a group that stands
  // still): /api/latest and its summary keep the bodies of this moment, with
  // the time each last rose, and /api/kills gets no rows; false ends it.
  latestHeld(held) {
    return this.#with([{ kind: 'held', at: this.#cursor, held: !!held }]);
  }

  // Every match plays its three borderlands as the Seared Borderlands (1652,
  // 1654, 1651) instead of the recorded Desert and Alpine ones, for the whole
  // timeline. Ownership and every counter stay the recorded ones.
  // `untilWeek`: only the weeks under way when the timeline starts; every week
  // that begins within it plays the recorded borderlands (1099, 96, 95), so a
  // read across the turn brings other map ids for the same map types.
  seared({ untilWeek = false } = {}) {
    return this.#with([{ kind: 'seared', at: this.#cursor, untilWeek }]);
  }

  // For the whole timeline the game's weeks end at the reset the page keeps (js/relink.js,
  // RESET_SCHEDULE), not at the recorded end_time, which is 2 min earlier.
  resetOnTime() {
    if (this.#ops.some(o => o.kind === 'minute' || o.kind === 'week')) throw new Error('gw2: resetOnTime comes before the first advance or newWeek');
    return this.#with([{ kind: 'on-time' }], this.#cursor, this.#opensAt, this.#weekEnd + RESET_LAG_MS);
  }

  // The page's clock starts here.
  pageOpens() {
    return this.#with([], this.#cursor, this.#cursor);
  }

  // The focus region's week ends: time jumps to the end and every match of the
  // region starts the next one, counters at zero.
  newWeek({ relink = false } = {}) {
    const at = Math.max(this.#cursor, this.#weekEnd - recording().recordedAt);
    return this.#with([{ kind: 'week', at, region: this.#focus[0], relink }], at, this.#opensAt, this.#weekEnd + WEEK_MS);
  }

  // A relink: the new week with the red teams moved one tier down the region,
  // and for an hour the older group serving last week's bodies (js/api.js, WEEK_HOLD_MS).
  relinkNight() {
    return this.newWeek({ relink: true }).olderPool(60);
  }

  // ---- reading the timeline -------------------------------------------
  // The compiled frames, for the server in this file.
  static compiled(tl) { return tl.#compile(); }

  #compiled = null;
  #compile() {
    if (this.#compiled) return this.#compiled;
    const searedOp = this.#ops.find(o => o.kind === 'seared');
    const base = searedOp ? searedBodies() : baseBodies();
    // The recorded body a state of the match is built on: its week's borderlands.
    const bodyOf = (id, week) => (searedOp && searedOp.untilWeek && week.zero ? baseBodies() : base).get(id);
    const anchor = recording().recordedAt;
    const ids = [...base.keys()].sort(byId);
    const lag = this.#ops.some(o => o.kind === 'on-time') ? RESET_LAG_MS : 0;
    const frames = new Map();   // id -> [{ at, state }], at in ms after the recording
    const cur = new Map();
    for (const id of ids) {
      const s = freshState(weekOf(base.get(id), lag), 0);
      cur.set(id, s);
      frames.set(id, [{ at: -Infinity, state: copyState(s) }]);
    }
    const push = (id, at) => frames.get(id).push({ at, state: copyState(cur.get(id)) });
    const turnWeek = (id, at, week) => { cur.set(id, freshState(week, 0)); push(id, at); };
    // Every match past its week's end, up to `at`, starts the next one.
    const roll = (id, at) => {
      for (let w = cur.get(id).week; w.end <= anchor + at; w = cur.get(id).week) {
        turnWeek(id, w.end - anchor, { ...w, start: w.end, end: w.end + WEEK_MS, zero: true });
      }
    };
    const flipped = new Set();
    for (const op of this.#ops) {
      if (op.kind === 'minute') {
        roll(this.#focus, op.at);
        const s = cur.get(this.#focus);
        const body = bodyOf(this.#focus, s.week);
        const sk = skirmishCount(body, s.week, anchor + op.at, anchor);
        s.skirmishes = sk.added;
        for (const [type, n] of Object.entries(op.kills)) {
          const k = thirds(n);
          s.kills[type] ||= [0, 0, 0];
          s.deaths[type] ||= [0, 0, 0];
          for (let c = 0; c < 3; c++) { s.kills[type][c] += k[c]; s.deaths[type][(c + 1) % 3] += k[c]; }
        }
        const key = `${sk.last}:Center`;
        s.score[key] ||= [0, 0, 0];
        COLORS.forEach((c, i) => { s.score[key][i] += Number(op.score[c]) || 0; });
        if (op.flip) {
          const obj = op.flip === true ? pickObjective(body, flipped) : op.flip;
          if (!obj) throw new Error('gw2: no objective left to flip');
          flipped.add(obj);
          const was = s.flips.get(obj)?.owner || ownerIn(body, obj, s.week);
          s.flips.set(obj, { owner: NEXT_OWNER[was] || 'Red', at: anchor + op.at });
        }
        push(this.#focus, op.at);
      } else if (op.kind === 'week') {
        const region = ids.filter(id => id[0] === op.region);
        for (const id of region) roll(id, op.at - 1);
        const teams = new Map(region.map(id => [id, cur.get(id).week]));
        region.forEach((id, i) => {
          const w = teams.get(id);
          const down = teams.get(region[(i + 1) % region.length]);
          const all = op.relink ? { ...w.all_worlds, red: down.all_worlds.red } : w.all_worlds;
          const worlds = op.relink ? { ...w.worlds, red: down.worlds.red } : w.worlds;
          turnWeek(id, op.at, { start: w.end, end: w.end + WEEK_MS, all_worlds: all, worlds, zero: true });
        });
      }
    }
    const horizon = Math.max(this.#cursor, this.#opensAt) + 24 * 60 * MIN;
    for (const id of ids) roll(id, horizon);
    for (const list of frames.values()) list.sort((a, b) => a.at - b.at);
    const windows = kind => this.#ops.filter(o => o.kind === kind).sort((a, b) => a.at - b.at);
    this.#compiled = { anchor, base, bodyOf, ids, frames, pools: windows('pool'), statuses: windows('status'), latest: windows('latest'), history: windows('history'), held: windows('held'), stalls: windows('stall'), workerKills: this.#ops.some(o => o.kind === 'worker-kills'), sheetKills: this.#ops.find(o => o.kind === 'sheet-kills') || null };
    return this.#compiled;
  }

  #frame(id, t) {
    const list = this.#compile().frames.get(id);
    let lo = 0;
    for (let i = 0; i < list.length && list[i].at <= t; i++) lo = i;
    return list[lo];
  }

  // The last window op at or before t.
  #windowAt(list, t) {
    let hit = null;
    for (const w of list) if (w.at <= t) hit = w;
    return hit;
  }

  // What the match URLs answer at t (ms after the recording): null when up.
  statusAt(t) {
    const w = this.#windowAt(this.#compile().statuses, t);
    return w && w.code !== null ? w.code : null;
  }

  // What our readers' reads answer at t: null when up.
  readersStatusAt(t) {
    const w = this.#windowAt(this.#compile().statuses, t);
    return w && w.code !== null && !w.visitor ? w.code : null;
  }

  // The newest time at or before t the API was up: what our readers last read.
  lastUp(t) {
    const list = this.#compile().statuses;
    let down = null;
    for (const w of list) {
      if (w.at > t) break;
      if (w.code === null || w.visitor) down = null;
      else if (down === null) down = w.at;
    }
    return down === null ? t : down;
  }

  // What /api/latest answers at t: null when up.
  latestStatusAt(t) {
    const w = this.#windowAt(this.#compile().latest, t);
    return w ? w.code : null;
  }

  // The time /api/latest's bodies are of at t: the start of a latestHeld that
  // holds at t, else t.
  heldAt(t) {
    let from = t;
    for (const w of this.#compile().held) {
      if (w.at > t) break;
      if (!w.held) from = t;
      else if (from === t) from = w.at;
    }
    return from;
  }

  // The stall that holds at t ({ from, visitor }), or null.
  stallAt(t) {
    const w = this.#windowAt(this.#compile().stalls, t);
    return w && w.on ? { from: w.at, visitor: w.visitor } : null;
  }

  // The time our readers' bodies are of at t: what they last read before the API
  // went down, the copy held, or the stall's start when they are stuck in it.
  readersUp(t) {
    const s = this.stallAt(t);
    return Math.min(this.lastUp(t), this.heldAt(t), s && !s.visitor ? s.from : t);
  }

  // Whether /api/kills takes rows at t.
  historyAt(t) {
    const w = this.#windowAt(this.#compile().history, t);
    return w ? w.on : true;
  }

  // How far behind the older group is at t, 0 for none.
  lagAt(t) {
    const w = this.#windowAt(this.#compile().pools, t);
    return w ? w.lag : 0;
  }

  // Whether the older group answers every read at t, not every second minute.
  everyAt(t) {
    const w = this.#windowAt(this.#compile().pools, t);
    return !!(w && w.every);
  }

  // The newest body of a match at t (ms after the recording), as a new object.
  body(id, t) {
    const { state } = this.#frame(id, t);
    return materialise(this.#compile().bodyOf(id, state.week), state);
  }

  // When the newest body of a match at t last changed, in page time (ms).
  changedAt(id, t) {
    const f = this.#frame(id, t);
    return Number.isFinite(f.at) ? this.#compile().anchor + f.at : this.#compile().anchor;
  }

  // Kills per map type of the newest body at t.
  killsByMap(id, t) {
    const b = this.body(id, t);
    return Object.fromEntries(b.maps.map(m => [m.type, sum(m.kills)]));
  }

  // The id of the last skirmish of the newest body at t.
  skirmishAt(id, t) {
    const s = this.body(id, t).skirmishes;
    return s.length ? s[s.length - 1].id : null;
  }

  // Objectives this timeline flipped in (from, to], ms after the recording:
  // [{ id, owner, at }] with `at` in page time.
  flipsBetween(id, from, to) {
    const before = this.#frame(id, from).state.flips;
    const out = [];
    for (const [obj, f] of this.#frame(id, to).state.flips) {
      if (before.get(obj)?.at !== f.at) out.push({ id: obj, owner: f.owner, at: f.at });
    }
    return out;
  }

  // The server the fixture answers through: answer(url, pageNow) is null for a
  // URL the timeline does not hold, 'hang', or { status, type, body }.
  // `problem(text)` gets any break of the rules above in a body served.
  serve(problem = () => {}) {
    return new Server(this, problem);
  }
}

// Skirmishes the week holds at `now`: the recorded week appends one at each
// two-hour mark after the recording; a new week has one per two hours begun.
function skirmishCount(body, week, now, anchor) {
  const lastId = week.zero ? 0 : body.skirmishes[body.skirmishes.length - 1].id;
  const marks = week.zero
    ? Math.floor((now - week.start) / SKIRMISH_MS) + 1
    : Math.max(0, Math.floor((now - week.start) / SKIRMISH_MS) - Math.floor((anchor - week.start) / SKIRMISH_MS));
  return { added: marks, last: lastId + marks };
}

function ownerIn(body, obj, week) {
  for (const m of body.maps) for (const o of m.objectives) {
    if (o.id === obj) return week.zero && o.type !== 'Spawn' ? 'Neutral' : o.owner;
  }
  throw new Error(`gw2: no objective ${obj} in ${body.id}`);
}

// The next objective to flip: camps, towers and keeps, map by map, each once.
function pickObjective(body, flipped) {
  for (const type of MAPS) {
    const map = body.maps.find(m => m.type === type);
    for (const o of (map && map.objectives) || []) if (FLIPPABLE.has(o.type) && !flipped.has(o.id)) return o.id;
  }
  return null;
}

// The body of a match for a state: the recorded one, or its new week at zero,
// with the state's counters, skirmishes and flips added; totals summed from
// the maps.
function materialise(recorded, state) {
  const w = state.week;
  const b = structuredClone(recorded);
  const reset = new Set();   // the objectives taken back to T0
  if (w.zero) {
    b.start_time = iso(w.start);
    b.end_time = iso(w.end);
    b.all_worlds = structuredClone(w.all_worlds);
    b.worlds = structuredClone(w.worlds);
    b.victory_points = { red: 0, blue: 0, green: 0 };
    b.skirmishes = [];
    for (const m of b.maps) {
      m.kills = { red: 0, blue: 0, green: 0 };
      m.deaths = { red: 0, blue: 0, green: 0 };
      m.scores = { red: 0, blue: 0, green: 0 };
      for (const o of m.objectives) {
        if (o.type !== 'Spawn') { o.owner = 'Neutral'; unclaim(o, reset); }
        o.last_flipped = iso(w.start);
      }
    }
  }
  const had = b.skirmishes.length;
  const lastId = had ? b.skirmishes[had - 1].id : 0;
  for (let i = 1; i <= state.skirmishes; i++) {
    b.skirmishes.push({ id: lastId + i, scores: { red: 0, blue: 0, green: 0 },
      map_scores: MAPS.map(type => ({ type, scores: { red: 0, blue: 0, green: 0 } })) });
  }
  for (const m of b.maps) {
    COLORS.forEach((c, i) => {
      m.kills[c] += state.kills[m.type]?.[i] || 0;
      m.deaths[c] += state.deaths[m.type]?.[i] || 0;
    });
    for (const o of m.objectives) {
      const f = state.flips.get(o.id);
      if (f) { o.owner = f.owner; o.last_flipped = iso(f.at); unclaim(o, reset); }
    }
  }
  for (const [key, add] of Object.entries(state.score)) {
    const [sid, type] = key.split(':');
    const sk = b.skirmishes.find(s => String(s.id) === sid);
    const map = b.maps.find(m => m.type === type);
    if (!sk || !map) throw new Error(`gw2: no skirmish ${sid} or map ${type} in ${b.id}`);
    const ms = sk.map_scores.find(x => x.type === type);
    COLORS.forEach((c, i) => { sk.scores[c] += add[i]; ms.scores[c] += add[i]; map.scores[c] += add[i]; });
  }
  for (const m of b.maps) for (const o of m.objectives) if (!reset.has(o)) warScore(o, tierOf(o));
  for (const f of ['kills', 'deaths', 'scores']) {
    b[f] = Object.fromEntries(COLORS.map(c => [c, b.maps.reduce((n, m) => n + m[f][c], 0)]));
  }
  for (let i = Math.max(0, had - 1); i < b.skirmishes.length - 1; i++) {
    const vp = skirmishPoints(b.id, Date.parse(b.start_time), b.skirmishes[i]);
    for (const c of COLORS) b.victory_points[c] += vp[c];
  }
  return b;
}

// The tier a recorded objective had; T0 when it has no owner. A recording of the War Score names it by its
// capture (no old-rule capture equals one of those); an older one, by its tick.
function tierOf(o) {
  const war = WAR_CAPTURE[o.type] ? WAR_CAPTURE[o.type].indexOf(o.points_capture) : -1;
  if (war >= 0) return o.owner === 'Neutral' ? 0 : war;
  const at = OLD_TICK[o.type] ? OLD_TICK[o.type].indexOf(o.points_tick) : -1;
  return o.owner === 'Neutral' || at < 0 ? 0 : at;
}

// What the War Score pays for an objective at a tier. Types without a table keep their recorded capture.
function warScore(o, tier) {
  if (!WAR_CAPTURE[o.type]) { o.points_tick = 0; return; }
  o.points_tick = tier === 3 ? WAR_TICK[o.type] ?? 0 : 0;
  o.points_capture = WAR_CAPTURE[o.type][tier];
}

// Taken, an objective loses its guild, its tactics and its yaks, and goes back to T0.
function unclaim(o, reset) {
  reset.add(o);
  warScore(o, 0);
  if ('claimed_by' in o) { o.claimed_by = null; o.claimed_at = null; }
  if ('guild_upgrades' in o) o.guild_upgrades = [];
  if ('yaks_delivered' in o) o.yaks_delivered = 0;
}

// The rules a served body keeps (see the top of this file); the broken ones.
function broken(b, now, prev) {
  const out = [];
  if (!ID_RE.test(b.id)) out.push(`id ${b.id}`);
  const start = Date.parse(b.start_time), end = Date.parse(b.end_time);
  if (!(start <= now && now < end)) out.push(`${b.id} not running at ${iso(now)} (${b.start_time} to ${b.end_time})`);
  for (const f of ['kills', 'deaths', 'scores']) {
    for (const c of COLORS) {
      if (b.maps.reduce((n, m) => n + m[f][c], 0) !== b[f][c]) out.push(`${b.id} ${f}.${c}: the maps do not add up to the total`);
    }
  }
  for (const c of COLORS) {
    if (b.skirmishes.reduce((n, s) => n + s.scores[c], 0) !== b.scores[c]) out.push(`${b.id} scores.${c}: the skirmishes do not add up`);
  }
  if (prev && prev.start_time === b.start_time) {
    const act = x => sum(x.kills) + sum(x.deaths);
    if (act(b) < act(prev) || sum(b.scores) < sum(prev.scores)) out.push(`${b.id} went backwards inside its week`);
  }
  return out;
}

// A body as our readers split it (supabase/reader.mjs, splitMatch): the live part keeps only
// the running skirmish, /api/history the finished ones, 1 to n.
export const liveOf = b => ({ ...b, skirmishes: b.skirmishes.slice(-1) });
export const historyOf = b => b.skirmishes.slice(0, -1);

const json = (status, value) => ({ status, type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify(value)) });

// /api/kills as the Worker serves it at `now` (ms) from every row written up to then, oldest first
// (worker/index.mjs, rebuildRecent): null for its 503.
const WORKER_BASE_MS = 3 * 60 * MIN;
const WORKER_MOVE_MS = 150 * MIN;
const WORKER_STALE_MS = 20 * MIN;
const rowSum = r => r[2] + r[3] + r[4] + r[5];
function workerWindow(rows, now) {
  if (!rows.length || now - rows[rows.length - 1][0] > WORKER_STALE_MS) return null;
  const cut = now - KILLS_WINDOW_MS, floor = cut - WORKER_BASE_MS, reach = now - WORKER_MOVE_MS;
  const out = new Map();
  for (const m of new Set(rows.map(r => r[1]))) {
    const own = rows.filter(r => r[1] === m && r[0] > floor);
    if (!own.length) continue;
    const add = r => { if (r) out.set(r[0] + ' ' + m, r); };
    own.filter(r => r[0] > cut).forEach(add);
    add(own.findLast(r => r[0] <= cut));
    const tot = rowSum(own[own.length - 1]);
    const before = own.findLast(r => rowSum(r) < tot);
    if (before && before[0] > reach) {
      const move = own.find(r => r[0] > before[0]);
      add(before);
      add(move);
      add(own.findLast(r => r[0] <= move[0] - 10 * MIN));
    } else {
      const first = own.find(r => r[0] > reach);
      if (first && rowSum(first) === tot) add(first);
    }
  }
  return [...out.values()].sort((a, b) => a[0] - b[0] || byId(a[1], b[1]));
}

class Server {
  #tl; #problem; #newest = new Map(); #planted = new Set(); #cache = new Map();

  constructor(timeline, problem) {
    this.#tl = timeline;
    this.#problem = problem;
  }

  // URLs answered with an error on purpose: their console lines are expected.
  planted(url) { return this.#planted.has(url); }

  // The newest body at t (ms after the recording), checked once per state.
  #body(id, t, now, check) {
    const key = `${id}@${this.#tl.changedAt(id, t)}`;
    let b = this.#cache.get(key);
    if (!b) {
      b = this.#tl.body(id, t);
      this.#cache.set(key, b);
      if (this.#cache.size > 64) this.#cache.delete(this.#cache.keys().next().value);
    }
    if (check) {
      for (const text of broken(b, now, this.#newest.get(id))) this.#problem(`gw2 timeline: ${text}`);
      this.#newest.set(id, b);
    }
    return b;
  }

  // Which body a match URL gets: the older group's in the odd minutes while
  // one is behind.
  #at(t) {
    const s = this.#tl.stallAt(t);
    if (s) return { t: Math.min(s.from, t - this.#tl.lagAt(t)), older: true };
    const lag = this.#tl.lagAt(t);
    const minute = Math.floor(t / MIN);
    if (lag && this.#tl.everyAt(t)) return { t: t - lag, older: true };
    if (!lag || minute % 2 !== 1) return { t, older: false };
    return { t: t - lag, older: true };
  }

  answer(url, pageNow) {
    const { anchor, ids } = Timeline.compiled(this.#tl);
    const t = pageNow - anchor;
    if (url === API.slice(0, -1) || url.startsWith(API)) {
      const q = new URLSearchParams(url.slice(API.length));
      const code = this.#tl.statusAt(t);
      if (code === 'hang') return 'hang';
      if (code) {
        this.#planted.add(url);
        return json(code, { text: code === 429 ? 'too many requests' : 'ErrBadData' });
      }
      if (url.length < API.length) return json(200, ids);
      const pick = this.#at(t);
      const get = id => this.#body(id, pick.t, pageNow, !pick.older);
      if (q.has('ids')) {
        const want = q.get('ids') === 'all' ? ids : q.get('ids').split(',');
        if (!want.every(id => ID_RE.test(id) && ids.includes(id))) {
          this.#planted.add(url);
          return json(404, { text: 'all ids provided are invalid' });
        }
        return json(200, want.map(get));
      }
      if (q.has('id') && ID_RE.test(q.get('id')) && ids.includes(q.get('id'))) return json(200, get(q.get('id')));
      if (q.has('world') && /^\d{4,5}$/.test(q.get('world'))) {
        const team = Number(q.get('world'));
        const id = ids.find(i => Object.values(get(i).all_worlds).some(l => l.includes(team)));
        if (id) return json(200, get(id));
      }
      this.#planted.add(url);
      return json(404, { text: 'no such id' });
    }
    if (url.startsWith(TACTICS)) {
      const want = url.slice(TACTICS.length).split(',');
      if (want.every(i => /^\d{1,6}$/.test(i))) return json(200, want.filter(i => baseBodies().tactics.has(i)).map(i => baseBodies().tactics.get(i)));
    }
    const path = (() => { try { return new URL(url).pathname; } catch { return ''; } })();
    const history = /^\/api\/history\/([12])$/.exec(path);
    if (path === '/api/latest' || path === '/api/latest/summary' || history) {
      const down = this.#tl.latestStatusAt(t);
      if (down === 'hang') return 'hang';
      if (down) {
        this.#planted.add(url);
        return { ...json(down, { error: 'down' }), date: pageNow };
      }
      const up = this.#tl.readersUp(t);
      // `at`, in seconds as the Worker gives it: when the body's score last rose.
      const at = id => Math.floor(this.#tl.changedAt(id, up) / 1000);
      const bodies = ids.map(id => this.#body(id, up, anchor + up, false));
      if (history) {
        // The matches of the region at the version asked; a 404 when none is, as the Worker answers.
        const v = Number(new URL(url).searchParams.get('v'));
        const region = bodies.filter(b => b.id[0] === history[1]);
        const start = Math.max(...region.map(b => Date.parse(b.start_time)));
        const held = region.filter(b => Date.parse(b.start_time) === start && historyOf(b).length === v);
        if (!held.length) {
          this.#planted.add(url);
          return json(404, { error: 'not found' });
        }
        return json(200, { v, start, matches: Object.fromEntries(held.map(b => [b.id, historyOf(b)])) });
      }
      if (path === '/api/latest/summary') {
        return { ...json(200, Object.fromEntries(bodies.map(b => [b.id, { start: Date.parse(b.start_time), score: sum(b.scores), at: at(b.id), by: 'a' }]))), date: pageNow };
      }
      // ?v=: only the newest `at`, with its tag, is a version; any other is the Worker's 404.
      const newest = Math.max(...ids.map(at));
      const v = new URL(url).searchParams.get('v');
      if (v !== null && v !== versionName(newest)) {
        this.#planted.add(url);
        return json(404, { error: 'not found' });
      }
      return { ...json(200, { at: newest, matches: bodies.map(b => ({ id: b.id, start: Date.parse(b.start_time), score: sum(b.scores), at: at(b.id), by: 'a',
        v: 2, body: liveOf(b) })) }), date: pageNow };
    }
    const { sheetKills } = Timeline.compiled(this.#tl);
    if (sheetKills && url === SHEET_KILLS_URL) return { status: 200, type: 'text/csv; charset=utf-8', body: Buffer.from(this.#sheet(t, sheetKills.visitor)) };
    if (path === '/api/kills') {
      const rows = this.#rows(t);
      if (rows) return json(200, { rows });
      this.#planted.add(url);
      return json(503, { error: 'stale' });
    }
    return null;
  }

  // What the push socket sends at pageNow (worker/index.mjs, Live): each match of
  // /api/latest's summary, without `by`; null while /api/latest is down.
  told(pageNow) {
    const { anchor, ids } = Timeline.compiled(this.#tl);
    const t = pageNow - anchor;
    if (this.#tl.latestStatusAt(t)) return null;
    const up = this.#tl.readersUp(t);
    const matches = ids.map(id => {
      const b = this.#body(id, up, anchor + up, false);
      return { id, start: Date.parse(b.start_time), score: sum(b.scores), at: Math.floor(this.#tl.changedAt(id, up) / 1000) };
    });
    return { matches, version: versionName(Math.max(...matches.map(m => m.at))) };
  }

  // The kills sheet at t (sheetKills): the focus match's rows as CSV, every column quoted as gviz does.
  #sheet(t, visitor) {
    const { anchor } = Timeline.compiled(this.#tl);
    const id = this.#tl.focus;
    let rows = [];
    let last = -Infinity;
    for (let m = 0; m <= t; m += MIN) {
      if (this.#tl.statusAt(m) !== null && (visitor || this.#tl.readersStatusAt(m) !== null)) continue;
      const b = this.#body(id, visitor ? this.#at(m).t : this.#tl.readersUp(m), anchor + m, false);
      const score = sum(b.scores);
      if (!(score > last)) continue;
      last = score;
      const at = anchor + m;
      rows = rows.filter(r => r[0] >= at - 120 * MIN);
      const k = Object.fromEntries(b.maps.map(x => [x.type, sum(x.kills)]));
      const prev = rows[rows.length - 1];
      const st = Date.parse(b.start_time);
      if (prev && st < prev[6]) continue;
      // kills.gs, rowFor_: each map's running maximum over the row before, unless a new week or a drop below half.
      const keep = prev && st === prev[6];
      rows.push([at, id, ...MAPS.map((type, i) => {
        const n = k[type] || 0;
        return keep && n >= prev[2 + i] * SHEET_RESET_RATIO ? Math.max(n, prev[2 + i]) : n;
      }), st, score]);
    }
    return rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
  }

  // /api/kills: the recorded rows and a row per state of the timeline, the
  // last thirty minutes, none while the API was down (the readers read it too)
  // or while killHistory(false) or latestHeld(true) holds.
  #rows(t) {
    const { anchor, ids, frames, workerKills } = Timeline.compiled(this.#tl);
    const from = t - (workerKills ? KILLS_WINDOW_MS + WORKER_BASE_MS : KILLS_WINDOW_MS);
    const rows = baseBodies().rows.filter(r => r[0] - anchor > from && r[0] - anchor <= t);
    for (const id of ids) {
      for (const f of frames.get(id)) {
        if (!(f.at > from && f.at <= t) || this.#tl.readersStatusAt(f.at) !== null || !this.#tl.historyAt(f.at)
          || this.#tl.heldAt(f.at) !== f.at || this.#tl.readersUp(f.at) !== f.at) continue;
        const k = this.#tl.killsByMap(id, f.at);
        rows.push([anchor + f.at, id, ...MAPS.map(type => k[type] || 0)]);
      }
    }
    rows.sort((a, b) => a[0] - b[0] || byId(a[1], b[1]));
    return workerKills ? workerWindow(rows, anchor + t) : rows;
  }
}

// A version as the Worker names it (worker/index.mjs, versionName), under this world's own key.
export const versionName = at => at + '.' + createHmac('sha256', 'e2e version key').update('latest-version:' + at).digest('hex').slice(0, 32);

export const gw2 = Object.freeze({
  // The recording, with `id` as the match that plays.
  match(id) {
    if (!ID_RE.test(id) || !baseBodies().has(id)) throw new Error(`gw2: no match ${id} in the recording`);
    return new Timeline(id, [], 0, 0, Date.parse(baseBodies().get(id).end_time));
  },
});
