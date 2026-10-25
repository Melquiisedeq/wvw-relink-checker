// A fake Guild Wars 2 world with one timeline. Every URL the page reads a match
// from - ?ids=all, ?ids=<list>, ?id=, ?world=, /api/latest (and its summary)
// and /api/kills - is answered from the same timeline at the page's own time,
// so no two URLs contradict each other: bodies that disagree between URLs
// mislead the page into states the game never shows.
//
//   gw2.match('1-1')                      // the recording, as the 1-1 focus
//     .advance(12, { kills: { Center: 30 } })   // 12 min of play, one state a minute
//     .pageOpens()                        // the page's clock starts here
//     .olderPool(10).advance(20).olderPool(0)   // a server group 10 min behind
//     .olderPool(10, { first: true })     // the same, for the first read of its minutes only
//     .freeze(40)                         // 40 min, nothing new from the API
//     .status(503).advance(8).status(null)      // the game moves, the API is down
//     .latestStatus(503)                  // /api/latest down (or 'hang': never answers)
//
// Immutable: every method returns a new timeline. Time is in minutes after the
// recording's instant (recordedAt). Only the focus match plays; the others keep
// their recorded bodies, apart from turning over to a new week at their end.
//
// The rules every body keeps, each from the code in site/js/ that relies on it:
// - id matches ^[12]-[1-9]$ (js/api.js:309, WEEK_ID_RE; /api/latest drops others).
// - start <= now < end for every body of the newest pool (js/config.js:67,
//   matchIsLive; js/stat-popovers.js:168, skirmishProgress); a week ends, the
//   next one starts at that end with every counter at zero.
// - Inside a week kills+deaths and the scores only grow (js/api.js,
//   matchIsBehind): the older pool serves a body behind, never a body that
//   went backwards.
// - The page reads only the last skirmish (js/panels.js, getSkirmishScore):
//   a new one is appended at each two-hour mark after the recording, and the
//   score of the minute goes into the last one. Victory points stay as recorded.
// - A flip changes `owner` and `last_flipped` together (js/maps-early.js,
//   missedOwnerChanges and missedBodyChanged; js/maps.js, riLeft).
// - The maps add up to the match: kills, deaths and scores per colour are the
//   sums over maps[] (js/maps-early.js, fightTotals and missedKillTotal, read
//   the maps; js/api.js, matchActivity, the totals).
//   The skirmishes add up to the scores too.
// The server checks the bodies it serves against these (served() below) and
// reports a break as a problem of the test.
import { gzipSync } from 'node:zlib';
import { recording } from './recordings.mjs';

const MIN = 60 * 1000;
const SKIRMISH_MS = 2 * 60 * MIN;
const WEEK_MS = 7 * 24 * 60 * MIN;
const KILLS_WINDOW_MS = 30 * MIN;           // what /api/kills serves (js/maps-early.js, readOwnKills)
const COLORS = ['red', 'blue', 'green'];
const MAPS = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];   // js/config.js, KILLS_MAP_ORDER
const NEXT_OWNER = Object.freeze({ Red: 'Blue', Blue: 'Green', Green: 'Red', Neutral: 'Red' });
const FLIPPABLE = new Set(['Camp', 'Tower', 'Keep']);
const ID_RE = /^[12]-[1-9]$/;
const API = 'https://api.guildwars2.com/v2/wvw/matches?';
const TACTICS = 'https://api.guildwars2.com/v2/guild/upgrades?ids=';
const DEFAULT_SCORE = Object.freeze({ red: 120, blue: 80, green: 60 });   // per minute
const DEFAULT_KILLS = Object.freeze({ Center: 30 });                     // per minute: a fight on EBG

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

// A week of one match: its start, end and teams. `zero`: a week this timeline
// began, every counter at zero; otherwise the recorded week.
const weekOf = b => ({ start: Date.parse(b.start_time), end: Date.parse(b.end_time), all_worlds: b.all_worlds, worlds: b.worlds, zero: false });

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
  advance(min, { kills = DEFAULT_KILLS, flips = 0, score = DEFAULT_SCORE } = {}) {
    if (!(min > 0)) throw new Error('gw2: advance needs minutes');
    const list = typeof flips === 'number' ? Array.from({ length: flips }, () => null) : [...flips];
    const flipAt = new Map(list.map((obj, j) => [Math.max(1, Math.round((j + 1) * min / (list.length + 1))), obj]));
    const ops = [];
    let weekEnd = this.#weekEnd;
    for (let i = 1; i <= min; i++) {
      const at = this.#cursor + i * MIN;
      while (recording().recordedAt + at >= weekEnd) weekEnd += WEEK_MS;
      ops.push({ kind: 'minute', at, kills, score, flip: flipAt.has(i) ? (flipAt.get(i) || true) : null });
    }
    return this.#with(ops, this.#cursor + min * MIN, this.#opensAt, weekEnd);
  }

  // `min` minutes in which the API answers the same body.
  freeze(min) {
    if (!(min > 0)) throw new Error('gw2: freeze needs minutes');
    return this.#with([], this.#cursor + min * MIN);
  }

  // From here on, a server group `min` minutes behind answers every match URL
  // in every second minute (reads in a row come back from the same server,
  // js/api.js:498); 0 ends it.
  // `first`: only the first match URL read in each of those minutes; the reads
  // after it get the newer group. A page whose first read lands on the older one.
  olderPool(min, { first = false } = {}) {
    return this.#with([{ kind: 'pool', at: this.#cursor, lag: Math.max(0, min) * MIN, first }]);
  }

  // From here on, every match URL answers `code` (503, 429) or never ('hang');
  // null ends it. /api/latest keeps the last body read before (our readers
  // read the same API); /api/kills gets no rows meanwhile.
  status(code) {
    if (code !== null && code !== 'hang' && !(code >= 400 && code < 600)) throw new Error(`gw2: status ${code}`);
    return this.#with([{ kind: 'status', at: this.#cursor, code }]);
  }

  // From here on, /api/latest and its summary answer `code` (503: the Worker
  // with nothing recent kept) or never ('hang'); null ends it.
  latestStatus(code) {
    if (code !== null && code !== 'hang' && !(code >= 400 && code < 600)) throw new Error(`gw2: latest status ${code}`);
    return this.#with([{ kind: 'latest', at: this.#cursor, code }]);
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
  // and for an hour the older group serving last week's bodies (js/api.js:295).
  relinkNight() {
    return this.newWeek({ relink: true }).olderPool(60);
  }

  // ---- reading the timeline -------------------------------------------
  // The compiled frames, for the server in this file.
  static compiled(tl) { return tl.#compile(); }

  #compiled = null;
  #compile() {
    if (this.#compiled) return this.#compiled;
    const base = baseBodies();
    const anchor = recording().recordedAt;
    const ids = [...base.keys()].sort(byId);
    const frames = new Map();   // id -> [{ at, state }], at in ms after the recording
    const cur = new Map();
    for (const id of ids) {
      const s = freshState(weekOf(base.get(id)), 0);
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
        const body = base.get(this.#focus);
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
    this.#compiled = { anchor, base, ids, frames, pools: windows('pool'), statuses: windows('status'), latest: windows('latest') };
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

  // The newest time at or before t the API was up: what our readers last read.
  lastUp(t) {
    const list = this.#compile().statuses;
    let down = null;
    for (const w of list) {
      if (w.at > t) break;
      if (w.code === null) down = null;
      else if (down === null) down = w.at;
    }
    return down === null ? t : down;
  }

  // What /api/latest answers at t: null when up.
  latestStatusAt(t) {
    const w = this.#windowAt(this.#compile().latest, t);
    return w ? w.code : null;
  }

  // How far behind the older group is at t, 0 for none.
  lagAt(t) {
    const w = this.#windowAt(this.#compile().pools, t);
    return w ? w.lag : 0;
  }

  // Whether the older group answers only the first read of its minutes at t.
  firstOnlyAt(t) {
    const w = this.#windowAt(this.#compile().pools, t);
    return !!(w && w.first);
  }

  // The newest body of a match at t (ms after the recording), as a new object.
  body(id, t) {
    return materialise(this.#compile().base.get(id), this.#frame(id, t).state);
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
        if (o.type !== 'Spawn') { o.owner = 'Neutral'; unclaim(o); }
        o.last_flipped = iso(w.start);
      }
    }
  }
  const lastId = b.skirmishes.length ? b.skirmishes[b.skirmishes.length - 1].id : 0;
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
      if (f) { o.owner = f.owner; o.last_flipped = iso(f.at); unclaim(o); }
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
  for (const f of ['kills', 'deaths', 'scores']) {
    b[f] = Object.fromEntries(COLORS.map(c => [c, b.maps.reduce((n, m) => n + m[f][c], 0)]));
  }
  return b;
}

// Taken, an objective loses its guild, its tactics and its yaks.
function unclaim(o) {
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

const json = (status, value) => ({ status, type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify(value)) });

class Server {
  #tl; #problem; #newest = new Map(); #planted = new Set(); #cache = new Map(); #olderIn = null;

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
    const lag = this.#tl.lagAt(t);
    const minute = Math.floor(t / MIN);
    if (!lag || minute % 2 !== 1) return { t, older: false };
    if (this.#tl.firstOnlyAt(t)) {
      if (this.#olderIn === minute) return { t, older: false };
      this.#olderIn = minute;
    }
    return { t: t - lag, older: true };
  }

  answer(url, pageNow) {
    const { anchor, ids } = Timeline.compiled(this.#tl);
    const t = pageNow - anchor;
    if (url.startsWith(API)) {
      const q = new URLSearchParams(url.slice(API.length));
      const code = this.#tl.statusAt(t);
      if (code === 'hang') return 'hang';
      if (code) {
        this.#planted.add(url);
        return json(code, { text: code === 429 ? 'too many requests' : 'ErrBadData' });
      }
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
    if (path === '/api/latest' || path === '/api/latest/summary') {
      const down = this.#tl.latestStatusAt(t);
      if (down === 'hang') return 'hang';
      if (down) {
        this.#planted.add(url);
        return json(down, { error: 'down' });
      }
      const up = this.#tl.lastUp(t);
      const at = Math.floor(pageNow / 1000);
      const bodies = ids.map(id => this.#body(id, up, anchor + up, false));
      if (path === '/api/latest/summary') {
        return json(200, Object.fromEntries(bodies.map(b => [b.id, { start: Date.parse(b.start_time), score: sum(b.scores), at, by: 'a' }])));
      }
      return json(200, { matches: bodies.map(b => ({ id: b.id, start: Date.parse(b.start_time), score: sum(b.scores), at, by: 'a',
        gz: gzipSync(Buffer.from(JSON.stringify(b))).toString('base64') })) });
    }
    if (path === '/api/kills') return json(200, { rows: this.#rows(t) });
    return null;
  }

  // /api/kills: the recorded rows and a row per state of the timeline, the
  // last thirty minutes, none while the API was down (the readers read it too).
  #rows(t) {
    const { anchor, ids, frames } = Timeline.compiled(this.#tl);
    const from = t - KILLS_WINDOW_MS;
    const rows = baseBodies().rows.filter(r => r[0] - anchor > from && r[0] - anchor <= t);
    for (const id of ids) {
      for (const f of frames.get(id)) {
        if (!(f.at > from && f.at <= t) || this.#tl.statusAt(f.at) !== null) continue;
        const k = this.#tl.killsByMap(id, f.at);
        rows.push([anchor + f.at, id, ...MAPS.map(type => k[type] || 0)]);
      }
    }
    return rows.sort((a, b) => a[0] - b[0] || byId(a[1], b[1]));
  }
}

export const gw2 = Object.freeze({
  // The recording, with `id` as the match that plays.
  match(id) {
    if (!ID_RE.test(id) || !baseBodies().has(id)) throw new Error(`gw2: no match ${id} in the recording`);
    return new Timeline(id, [], 0, 0, Date.parse(baseBodies().get(id).end_time));
  },
});
