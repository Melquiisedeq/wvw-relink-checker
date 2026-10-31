// wvwrelink.com/api. What it accepts, and what is worth reporting: SECURITY.md.
//
//   POST /api/ingest/kills    the kills script, after every tick
//   POST /api/ingest/relink   the teams notice script, after every tick
//   POST /api/ingest/latest-supa-us, latest-supa-eu
//                              the outside readers of the game API, the newest match bodies,
//                              each match's finished skirmishes into history (format 2),
//                              and its last two into board (kept for good)
//   GET  /api/health            when each last reported; nothing else
//   GET  /api/kills            the last 30 minutes of kills, each match's newest older row (up to 3 h back) and its kills' last move, for the map corner and swords
//   GET  /api/relink           relink!A1 as numbers, for the teams notice
//   GET  /api/latest            each match's newest body, as the readers pushed it
//   GET  /api/latest/summary     the same without the bodies: id, start, score, at, by, hist
//   GET  /api/history/<1|2>?v=<n>  a region's finished skirmishes, n of them, this week
//   daily, on a schedule       kills older than KEEP_DAYS are deleted
//
// A message is signed by its script with a secret of its own:
//   x-wvw-time  epoch seconds
//   x-wvw-sig   hex HMAC-SHA256 of  time + "\n" + path + "\n" + body
// The path is signed so a message cannot be replayed against another source.
//
// The latest entrance never unpacks a gzipped body (CPU time per request is limited), and parses
// format 2's plain JSON only to check it: it decides by the signed summary and the match's score,
// never by a reader's clock.

const MAX_BYTES = 64 * 1024;
// The HMAC, each part's hash and format 2's parse all run over the whole message, inside
// the CPU limit: a reader sends more than this in several messages.
const MAX_BYTES_LATEST = 256 * 1024;
const MAX_SKEW_S = 300;
// The Worker never opens a slice, so these bound what a page may be handed to
// unpack. (MAX_RAW matches LATEST_BODY_MAX in js/api.js). One over either refuses the reader's whole push.
const MAX_SLICE = 16 * 1024;
const MAX_RAW = 256 * 1024;
// Format 2, plain JSON: a match's body without its finished skirmishes, and those apart.
const MAX_LIVE = 64 * 1024;
const MAX_HIST = 64 * 1024;
const SOURCES = {
  kills: 'INGEST_KILLS', relink: 'INGEST_RELINK',
  'latest-supa-us': 'INGEST_LATEST_SUPA_US', 'latest-supa-eu': 'INGEST_LATEST_SUPA_EU'
};
// When a region's weekly match starts, UTC (day 0 = Sunday).
const RESET = { 1: { day: 6, hour: 2 }, 2: { day: 5, hour: 18 } };
// Past this a match has had no update and its tier is gone; /api/latest drops it.
const LATEST_KEEP_S = 2 * 3600;
// The newest body older than this and /api/latest answers 503.
const STALE_LATEST_S = 10 * 60;
// A match's score cannot rise faster than this a minute (PPT tops out far below),
// with room on top. A message past it is a damaged read or a stolen secret.
const MAX_SCORE_PER_MIN = 1000;
const SCORE_SLACK = 2000;
// A week is 84 skirmishes of 2 hours.
const SKIRMISH_MS = 2 * 3600e3;
const SKIRMISHES = 84;
const MAX_VP_PER_SKIRMISH = 60;
const LATEST_KEY = 'https://wvwrelink.com/api/latest';
const SUMMARY_KEY = 'https://wvwrelink.com/api/latest/summary';
// The max-age of each read, both in its answer and on a copy served from the cache.
const LATEST_MAX_AGE = 5;
const SUMMARY_MAX_AGE = 5;
const HISTORY_KEY = 'https://wvwrelink.com/api/history/';
// A version whose every match is in: it never changes. One with a match missing or behind: a minute.
const HISTORY_MAX_AGE = 4 * 3600;
const HISTORY_PARTIAL_MAX_AGE = 60;
// What a version that is not the current one, or not there yet, answers.
const HISTORY_MISS_MAX_AGE = 10;
// The scripts make 128 hex characters; a short secret fails loudly rather than work weakly.
const MIN_SECRET = 64;
// The daily cleanup deletes kills older than this: two weeks keeps the running match and the one before it.
const KEEP_DAYS = 14;
// What GET /api/kills carries in full: the page wants a reading at least ten minutes old, and the
// rest is room for a late tick. kills.gs writes a match only when its score rose, so a frozen
// match also carries its newest older row, up to BASE_MS back.
const RECENT_MS = 30 * 60e3;
const BASE_MS = 3 * 3600e3;
// The page's kills window: it counts from a reading this much older than the
// match's clock, so a stopped match also needs one that far behind its newest.
const KILLS_WINDOW_MS = 10 * 60e3;
// How far back the kills' last move is sent: under the page's FIGHT_STALE_MS in js/maps-early.js,
// less the base's lead and the body's age.
const MOVE_MS = 2.5 * 3600e3;
// Past these a source counts as stopped, and the reads answer 503 so the page goes to the sheet.
const STALE_KILLS_S = 20 * 60;
const STALE_RELINK_S = 45 * 60;
// Every match id the entrance accepts, so the rebuild and the cleanup read the kills table by its key.
const MATCHES = [];
for (const r of [1, 2]) for (let t = 1; t <= 9; t++) MATCHES.push(r + '-' + t);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const m = /^\/api\/ingest\/([a-z]+(?:-[a-z]+)*)$/.exec(url.pathname);
    if (m) {
      if (request.method !== 'POST') return text(405, 'method');
      return accept(request, env, m[1], url.pathname);
    }
    if (url.pathname.startsWith('/api/history/')) {
      if (request.method !== 'GET') return text(405, 'method');
      try {
        return await readHistory(env, ctx, url);
      } catch (e) {
        console.log(JSON.stringify({ read: 'history', failed: String(e) }));
        return text(503, 'unavailable');
      }
    }
    // hasOwn: only a route named below is a read, never something inherited.
    if (Object.hasOwn(READS, url.pathname)) {
      if (request.method !== 'GET') return text(405, 'method');
      // Any failure is a 503: the page reads the sheet on any failure, and a
      // 500 would say nothing more.
      try {
        return await READS[url.pathname](env, ctx);
      } catch (e) {
        console.log(JSON.stringify({ read: url.pathname, failed: String(e) }));
        return text(503, 'unavailable');
      }
    }
    return text(404, 'not found');
  },

  async scheduled(event, env) {
    const r = await env.DB.prepare(cleanupSql)
      .bind(Date.now() - KEEP_DAYS * 86400e3, ...MATCHES).run();
    console.log(JSON.stringify({ cleanup: true, deleted: r.meta && r.meta.changes }));
    // Only a cleanup that ran to here moves the mark; check-worker.py reads it.
    await env.DB.prepare(
      "INSERT INTO source (name, t, received) VALUES ('cleanup', 0, ?1) " +
      'ON CONFLICT (name) DO UPDATE SET received = ?1'
    ).bind(nowS()).run();
  }
};

async function accept(request, env, source, path) {
  const secret = Object.hasOwn(SOURCES, source) && env[SOURCES[source]];
  if (!secret) return refuse(404, source, 'unknown source or no secret');
  if (secret.length < MIN_SECRET) return refuse(404, source, 'secret too short');

  // Nothing up to the signature touches the database.
  const t = request.headers.get('x-wvw-time') || '';
  const sig = request.headers.get('x-wvw-sig') || '';
  if (!/^\d{10}$/.test(t) || !/^[0-9a-f]{64}$/.test(sig)) return refuse(401, source, 'no signature');
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(t)) > MAX_SKEW_S) return refuse(401, source, 'time skew ' + (now - Number(t)));
  const max = source.startsWith('latest-') ? MAX_BYTES_LATEST : MAX_BYTES;
  if (Number(request.headers.get('content-length') || 0) > max) return refuse(413, source, 'declared size');
  const body = await readCapped(request, max);
  if (!body) return refuse(413, source, 'size');

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const head = enc.encode(t + '\n' + path + '\n');
  const signed = new Uint8Array(head.length + body.length);
  signed.set(head, 0);
  signed.set(body, head.length);
  // verify() compares in constant time.
  if (!await crypto.subtle.verify('HMAC', key, fromHex(sig), signed)) {
    return refuse(401, source, 'bad signature');
  }

  if (source.startsWith('latest-')) return acceptLatest(env, source, body, Number(t), now);

  // Signed from here on, so a failure below is our bug or Google's; it is still never written.
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return refuse(400, source, 'not JSON');
  }
  const statement = source === 'kills'
    ? killsStatement(env.DB, data, Number(t))
    : relinkStatement(env.DB, data, Number(t));
  if (typeof statement === 'string') return refuse(422, source, statement);

  // Replay guard, alone and first: only a message signed after the last one
  // accepted gets through, and it claims its place before writing anything.
  if (!await claimTime(env.DB, source, Number(t), now)) return refuse(409, source, 'replay or out of order');

  await statement.run();
  console.log(JSON.stringify({ source, ok: true }));
  // Apart from the insert, and after it: the rows are kept even if this
  // fails, and the next message rebuilds it.
  if (source === 'kills') {
    try {
      await rebuildRecent(env.DB, now);
    } catch (e) {
      console.log(JSON.stringify({ source, recent: 'failed', why: String(e) }));
    }
  }
  return text(200, 'ok');
}

async function claimTime(db, source, t, now) {
  const claim = await db.prepare(
    'UPDATE source SET t = ?1, received = ?2 WHERE name = ?3 AND t < ?1'
  ).bind(t, now, source).run();
  return !!claim.meta && claim.meta.changes === 1;
}

// The latest entrance: <summary JSON, one line> "\n" <the parts, in the summary's order>.
// Format 1 (v 1): one gzipped body per match, never opened; only its hash is checked.
// Format 2 (v 2): per match the live part (the body with only its running skirmish) when the
// entry has `live`, then its finished skirmishes when it has `hist`; both plain JSON. Each part
// is checked alone, and one that fails is left out with the reason logged, the others kept.
async function acceptLatest(env, source, body, t, now) {
  const nl = body.indexOf(10);
  if (nl < 0) return refuse(400, source, 'no summary line');
  let summary;
  try {
    summary = JSON.parse(new TextDecoder().decode(body.subarray(0, nl)));
  } catch {
    return refuse(400, source, 'summary not JSON');
  }
  const ms = checkSummary(summary, Date.now(), body.length - nl - 1);
  if (typeof ms === 'string') return refuse(422, source, ms);
  let at = nl + 1;
  const cut = (n) => body.subarray(at, at += n);
  if (summary.v === 1) {
    for (const m of ms) {
      const slice = cut(m.bytes);
      if (await sha256(slice) !== m.sha256) return refuse(422, source, 'sha256 ' + m.id);
      m.stored = { text: toBase64(slice), sha256: m.sha256, raw: m.raw };
    }
  } else {
    const off = [];
    for (const m of ms) {
      if (m.live) {
        const live = await partOf(cut(m.live.bytes), m.live.sha256, (x, text) => liveShape(x, text, m));
        if (live.why) off.push(m.id + ' live ' + live.why);
        else m.stored = { text: live.text, sha256: m.live.sha256, raw: m.live.bytes };
      }
      if (!m.hist) continue;
      const hist = await partOf(cut(m.hist.bytes), m.hist.sha256, (x) => histShape(x, m.hist.n));
      if (hist.why) off.push(m.id + ' history ' + hist.why);
      else m.hist.text = hist.text;
    }
    if (off.length) console.log(JSON.stringify({ source, parts: 'left out', why: off }));
    if (ms.every((m) => !m.stored && !(m.hist && m.hist.text))) return refuse(422, source, 'no part');
  }

  if (!await claimTime(env.DB, source, t, now)) return refuse(409, source, 'replay or out of order');

  // One command per match, atomic in SQLite: two readers at once cannot make a
  // match go back. A first write enters (it passed the checks above); after
  // that a newer week wins, and in the same week a higher score, but not past
  // what a score can rise since the stored one. Compared to the Worker's clock.
  // `gz` holds format 1's gzip as base64, or format 2's live part as JSON text,
  // which begins with "{" as base64 never does: /api/latest tells them apart by it.
  const applied = [];
  const lost = [];
  for (const m of ms) {
    if (!m.stored) continue;
    const r = await env.DB.prepare(
      'INSERT INTO latest (id, start, score, at, reader, gz, sha, raw) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ' +
      'ON CONFLICT (id) DO UPDATE SET start = excluded.start, score = excluded.score, at = excluded.at, ' +
      'reader = excluded.reader, gz = excluded.gz, sha = excluded.sha, raw = excluded.raw ' +
      'WHERE excluded.start > latest.start OR (excluded.start = latest.start AND excluded.score > latest.score ' +
      'AND excluded.score <= latest.score + ' + MAX_SCORE_PER_MIN + ' * ((?9 - latest.at) / 60.0) + ' + SCORE_SLACK + ')'
    ).bind(m.id, m.start, m.score, now, source, m.stored.text, m.stored.sha256, m.stored.raw, now).run();
    (r.meta && r.meta.changes === 1 ? applied : lost).push(m);
  }
  if (lost.length) await logJumps(env.DB, source, lost, now);

  // Every match of the message, applied or not: the other reader may have the
  // same score and the same skirmish. Its failure only logs: without
  // schema-005 the message still goes in.
  const off = ms.filter((m) => typeof m.board === 'string');
  if (off.length) console.log(JSON.stringify({ source, board: 'left out', why: off.map((m) => m.id + ' ' + m.board) }));
  let board = null;
  try {
    board = await boardInsert(env.DB, ms, Date.now());
  } catch (e) {
    console.log(JSON.stringify({ source, board: 'failed', why: String(e) }));
  }
  // The same: without schema-006 only the history is lost.
  let history = null;
  try {
    history = await historyInsert(env.DB, ms, now);
  } catch (e) {
    console.log(JSON.stringify({ source, history: 'failed', why: String(e) }));
  }

  // The kills lines of the matches that moved, through the same rule as the
  // sheet's. Stamped by the Worker's clock: a reader's runs up to 5 min off, and
  // a line in its future would keep out every source's lines until then.
  let entered = 0;
  if (applied.length) {
    const at = Date.now();
    const rows = applied.map((m) => [m.id, at, ...m.kills, m.start, m.score]);
    entered = (await killsInsert(env.DB, rows, true).run()).meta.changes;
  }
  console.log(JSON.stringify({ source, ok: true, applied: applied.length, lost: lost.length, board, history }));
  if (entered) {
    try {
      await rebuildRecent(env.DB, now, true);
    } catch (e) {
      console.log(JSON.stringify({ source, recent: 'failed', why: String(e) }));
    }
  }
  return new Response(JSON.stringify({ applied: applied.map((m) => m.id) }) + '\n', {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}

async function sha256(bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

// A format 2 part: {text}, or {why} it is left out. The text is kept as it came,
// so it must parse whole and pass `shape`.
async function partOf(bytes, sha, shape) {
  if (await sha256(bytes) !== sha) return { why: 'sha256' };
  let value;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    return { why: 'not JSON' };
  }
  const why = shape(value, text);
  return why ? { why } : { text };
}

// The live part is the match the summary describes: its id, week and scores.
function liveShape(x, text, m) {
  if (text[0] !== '{' || !x || typeof x !== 'object' || Array.isArray(x)) return 'not an object';
  if (x.id !== m.id || typeof x.start_time !== 'string' || Date.parse(x.start_time) !== m.start) return 'not this match';
  const s = x.scores;
  if (!s || typeof s !== 'object' || !isIntList([s.red, s.blue, s.green], 3) || s.red + s.blue + s.green !== m.score) return 'scores';
  if (!Array.isArray(x.maps)) return 'maps';
  return null;
}

// The finished skirmishes 1 to n, in order.
function histShape(x, n) {
  if (!Array.isArray(x) || x.length !== n) return 'length';
  if (!x.every((s, i) => s && typeof s === 'object' && s.id === i + 1)) return 'ids';
  return null;
}

// One statement for every history of the message. A row moves only to a newer
// week, or the same week and more finished skirmishes; only that version is kept.
// The parts go in as JSON values, not strings, so nothing is escaped twice.
async function historyInsert(db, ms, at) {
  const parts = ms.filter((m) => m.hist && m.hist.text);
  if (!parts.length) return null;
  const list = '[' + parts.map((m) => '[' + JSON.stringify(m.id) + ',' + m.start + ',' + m.hist.n + ',' + m.hist.text + ']').join(',') + ']';
  const r = await db.prepare(
    'INSERT INTO history (match, start, n, at, body) SELECT ' +
    "json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), ?2, json_extract(value, '$[3]') " +
    'FROM json_each(?1) WHERE true ' +
    'ON CONFLICT (match) DO UPDATE SET start = excluded.start, n = excluded.n, at = excluded.at, body = excluded.body ' +
    'WHERE excluded.start > history.start OR (excluded.start = history.start AND excluded.n > history.n)'
  ).bind(list, at).run();
  return { changes: r.meta.changes };
}

// A score above what the stored one allows is the sign worth a log line; a
// plain older or equal reading is the ordinary way to lose. One read, only
// when something lost, and only for the log.
async function logJumps(db, source, lost, now) {
  const { results } = await db.prepare('SELECT id, start, score, at FROM latest').all();
  for (const m of lost) {
    const o = results.find((r) => r.id === m.id);
    if (o && o.start === m.start && m.score > o.score + MAX_SCORE_PER_MIN * ((now - o.at) / 60) + SCORE_SLACK) {
      console.log(JSON.stringify({ source, jump: m.id, score: m.score, had: o.score, seconds: now - o.at }));
    }
  }
}

// Whole summary or nothing. Returns the checked matches, or the reason.
function checkSummary(s, nowMs, rest) {
  if (!s || typeof s !== 'object' || (s.v !== 1 && s.v !== 2)) return 'version';
  const list = s.matches;
  if (!Array.isArray(list) || !list.length || list.length > 18) return 'matches';
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const m of list) {
    if (!m || typeof m !== 'object') return 'match shape';
    if (typeof m.id !== 'string' || !/^[12]-[1-9]$/.test(m.id) || seen.has(m.id)) return 'match id';
    seen.add(m.id);
    if (!isInt(m.start) || m.start > nowMs + 300e3 || m.start < nowMs - 8 * 86400e3) return 'start';
    const d = new Date(m.start);
    const r = RESET[m.id[0]];
    if (d.getUTCDay() !== r.day || d.getUTCHours() !== r.hour || d.getUTCMinutes() || d.getUTCSeconds() || d.getUTCMilliseconds()) {
      return 'start not a reset';
    }
    const e = { id: m.id, start: m.start, board: null };
    // Format 2's history-only entry carries no counts: it changes neither latest, nor kills, nor board.
    if (s.v === 1 || m.live !== undefined) {
      if (!isIntList(m.scores, 3) || !isIntList(m.kills, 4)) return 'counts';
      e.score = m.scores[0] + m.scores[1] + m.scores[2];
      // Independent of what is stored: a week that has just begun cannot hold a big score.
      if (e.score > MAX_SCORE_PER_MIN * Math.max(0, (nowMs - m.start) / 60e3) + SCORE_SLACK) return 'score for the week';
      e.kills = m.kills.slice();
      // A board field out of shape leaves only the board out (the reason, a string, is logged).
      e.board = checkBoard(m, nowMs);
    }
    if (s.v === 1) {
      if (!isInt(m.bytes) || m.bytes < 18 || m.bytes > MAX_SLICE) return 'bytes';
      if (!isInt(m.raw) || m.raw < 1 || m.raw > MAX_RAW) return 'raw';
      if (!isSha(m.sha256)) return 'sha256 form';
      Object.assign(e, { bytes: m.bytes, raw: m.raw, sha256: m.sha256 });
      total += m.bytes;
    } else {
      const live = m.live;
      if (live !== undefined) {
        if (!live || !isInt(live.bytes) || live.bytes < 2 || live.bytes > MAX_LIVE || !isSha(live.sha256)) return 'live';
        e.live = { bytes: live.bytes, sha256: live.sha256 };
        total += live.bytes;
      } else if (m.hist === undefined) {
        return 'no part';
      }
      if (m.hist !== undefined) {
        const h = m.hist;
        // Finished ones only: the running skirmish is n + 1, begun by the Worker's clock with the signature's room.
        if (!h || !isInt(h.n) || h.n < 1 || h.n >= SKIRMISHES + 1
          || h.n > Math.floor((nowMs - m.start + MAX_SKEW_S * 1000) / SKIRMISH_MS)) return 'hist';
        if (!isInt(h.bytes) || h.bytes < 2 || h.bytes > MAX_HIST || !isSha(h.sha256)) return 'hist';
        e.hist = { n: h.n, bytes: h.bytes, sha256: h.sha256 };
        total += h.bytes;
      }
    }
    out.push(e);
  }
  if (total !== rest) return 'bytes do not add up';
  return out;
}

const isSha = (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);

// vp [red, blue, green] and skirmishes [[id, red, blue, green], ...], both or
// neither (a reader older than them sends neither). The last of skirmishes is
// the running one, the one before it the last finished. Returns the rows to
// keep, null, or the reason they are not kept.
function checkBoard(m, nowMs) {
  if (m.vp === undefined && m.skirmishes === undefined) return null;
  if (!isIntList(m.vp, 3)) return 'vp';
  const s = m.skirmishes;
  if (!Array.isArray(s) || !s.length || s.length > 2 || !s.every((x) => isIntList(x, 4))) return 'skirmishes';
  const id = s[s.length - 1][0];
  // Not one that has not begun by the Worker's clock, with the signature's 5 minutes of room.
  if (id < 1 || id > SKIRMISHES || id > Math.floor((nowMs - m.start + MAX_SKEW_S * 1000) / SKIRMISH_MS) + 1) return 'skirmish';
  if (s.length !== Math.min(2, id) || (s.length === 2 && s[0][0] !== id - 1)) return 'skirmish order';
  if (s.some((x) => x[1] + x[2] + x[3] > MAX_SCORE_PER_MIN * SKIRMISH_MS / 60e3 + SCORE_SLACK)) return 'skirmish score';
  // A row only rises, so a VP no week can reach would stay: a skirmish gives a team far less than this.
  if (m.vp.some((v) => v > MAX_VP_PER_SKIRMISH * id)) return 'vp for the week';
  const rows = s.length === 2 ? [s[0].slice()] : [];
  // The week's last may never be shown finished: it is kept while it runs.
  if (id === SKIRMISHES) rows.push(s[1].slice());
  return { vp: m.vp.slice(), rows };
}

// One statement for the whole message. A row changes only when its score or VP rose
// and neither fell, so a repeat from either reader changes nothing. Returns the run's meta, for the log.
async function boardInsert(db, ms, at) {
  const rows = [];
  for (const m of ms) if (m.board && typeof m.board === 'object') for (const s of m.board.rows) rows.push([m.id, m.start, ...s, ...m.board.vp]);
  if (!rows.length) return null;
  const sum = (t, p) => t + '.' + p + 'red + ' + t + '.' + p + 'blue + ' + t + '.' + p + 'green';
  const r = await db.prepare(
    'INSERT INTO board (match, start, skirmish, red, blue, green, vp_red, vp_blue, vp_green, at) SELECT ' +
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => "json_extract(value, '$[" + i + "]')").join(', ') +
    ', ?2 FROM json_each(?1) WHERE true ' +
    'ON CONFLICT (match, start, skirmish) DO UPDATE SET red = excluded.red, blue = excluded.blue, ' +
    'green = excluded.green, vp_red = excluded.vp_red, vp_blue = excluded.vp_blue, vp_green = excluded.vp_green, ' +
    'at = excluded.at WHERE ' + sum('excluded', '') + ' >= ' + sum('board', '') + ' AND ' +
    sum('excluded', 'vp_') + ' >= ' + sum('board', 'vp_') + ' AND (' + sum('excluded', '') + ' > ' + sum('board', '') +
    ' OR ' + sum('excluded', 'vp_') + ' > ' + sum('board', 'vp_') + ')'
  ).bind(JSON.stringify(rows), at).run();
  return { changes: r.meta.changes, rows_written: r.meta.rows_written };
}

function isIntList(a, n) {
  return Array.isArray(a) && a.length === n && a.every((x) => isInt(x) && x >= 0 && x <= 1e7);
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Text, not a BLOB: D1 and node:sqlite hand BLOBs back differently.
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const KILLS_LINE_MS = 55e3;

// The readers' rebuilds go on from the last body within one slot of this
// length; the first of the next slot is the full read, so an error does not last.
const FULL_EVERY_MS = 10 * 60e3;

// The one row GET /api/kills reads, built once per tick so a read costs one D1 row.
// Per match, of its newest week: the last RECENT_MS; the newest row before
// that (at most BASE_MS back), so a frozen match keeps a base; and the kills' last
// move: the first row with the newest total, the row before it, and the newest at
// least KILLS_WINDOW_MS before the move. When the row before the move is past
// MOVE_MS, the first row within MOVE_MS instead.
// The move is carried forward from the last body, because the walk back over a still
// stretch reads every row of it. The walk (walkSql) runs only when there is no last
// body, it does not join up with this one (a gap of over RECENT_MS), it holds no move
// where kills shows one, or a late batch reached behind this window. Every query reads
// kills by its key, `at` bounded as well as the match; a test checks their plans.
//
// With `incremental` (the readers' entrance) the window is the last body, its rows
// since the cut, plus the lines newer than the body's newest of each match. That holds
// only because killsInsert lets in nothing behind the newest line of a match, kills.gs
// included. The full read runs instead (logged with its reason) when there is no body,
// it does not join up, it is from another slot, a line to read is missing, or a write
// another rebuild overtook. kills.gs never asks for it: its batches reach behind the window.
// tests/unit/worker.test.mjs checks the body equals the full read's.
async function rebuildRecent(db, now, incremental = false) {
  const started = Date.now();
  const nowMs = now * 1000;
  const cut = nowMs - RECENT_MS;
  const floor = cut - BASE_MS;
  const reach = nowMs - MOVE_MS;
  const last = await db.prepare('SELECT at, rows FROM recent WHERE id = 1').first();
  // The last body joins up when its window reaches this one's. A late row (kills.gs sends
  // batches up to 45 minutes back, killsStatement) older than this window means the newest
  // row before the window is one the last body did not hold: then the match is walked.
  // A row of the week before is dropped from the body by design, so it is no sign of one.
  const carried = last && last.at >= cut ? JSON.parse(last.rows) : null;
  const held = new Set(carried ? carried.map((r) => r[1] + ' ' + r[0]) : []);
  let why = !last ? 'no body' : !carried ? 'body does not join up' : nowMs < last.at ? 'clock behind the body'
    : Math.floor(last.at / FULL_EVERY_MS) !== Math.floor(started / FULL_EVERY_MS) ? 'new slot' : null;
  const fast = incremental && !why ? await incrementalWindow(db, carried, cut, floor) : null;
  if (incremental && !why && !fast) why = 'line missing';
  if (incremental && why) console.log(JSON.stringify({ recent: 'full', why }));
  const results = fast || (await db.prepare(windowSql).bind(cut, floor, ...MATCHES).all()).results;
  const plan = new Map();
  for (const m of MATCHES) {
    const own = results.filter((r) => r.match === m);
    if (!own.length) continue;
    const top = own[own.length - 1];
    // The base must be of the week of the match's newest row; the window is taken whole.
    const rows = own.filter((r) => r.at > cut || r.start === top.start).map(rowOf);
    const p = { m, st: top.start, tot: sum(top), top: top.at, rows, move: null, before: null, base: null, first: false };
    // A row of another week is no reading of this one: at the week's start or after.
    const seen = new Map(p.rows.map((r) => [r[0], r]));
    if (carried) {
      for (const r of carried) if (r[1] === m && r[0] >= p.st && r[0] > floor && !seen.has(r[0])) seen.set(r[0], r);
    }
    p.known = [...seen.values()].sort((a, b) => a[0] - b[0]);
    p.bat = own.find((r) => r.at <= cut) || null;
    p.late = !!p.bat && p.bat.start === p.st && !held.has(m + ' ' + p.bat.at);
    plan.set(m, p);
  }

  const walk = [], lookBase = [];
  for (const p of plan.values()) {
    if (!carried || p.late) { walk.push(p); continue; }
    const before = p.known.findLast((r) => sum(r) < p.tot);
    const move = before && p.known.find((r) => r[0] > before[0]);
    if (move && before[0] > reach) {
      p.before = before;
      p.move = move;
      // A move new since the last body whose base lies behind the newest row
      // before this window: the rows there were dropped, so it is looked up.
      if (!held.has(p.m + ' ' + move[0]) && p.bat && move[0] - KILLS_WINDOW_MS < p.bat.at) lookBase.push(p);
      else p.base = p.known.findLast((r) => r[0] <= move[0] - KILLS_WINDOW_MS) || null;
    } else {
      p.first = true;
    }
  }
  const looked = await rowsAt(db, lookBase.map((p) => [p.m, p.move[0] - KILLS_WINDOW_MS, 'le']), floor);
  for (const p of lookBase) p.base = looked.get(p.m) || null;
  // Still since before MOVE_MS (or the move not known): the first row within it.
  await firstWithin(db, [...plan.values()].filter((p) => p.first), reach, walk);

  if (walk.length) {
    const { results: walked } = await db.prepare(walkSql).bind(JSON.stringify(walk.map((p) => [p.m, p.st, p.tot, p.top])), reach).all();
    const back = new Map(walked.map((w) => [w.m, w.pat]));
    const before = await rowsAt(db, walk.filter((p) => back.get(p.m) != null).map((p) => [p.m, back.get(p.m), 'le']), floor);
    const moves = await rowsAt(db, walk.map((p) => [p.m, back.get(p.m) ?? Math.max(reach, p.st - 1), 'gt']), floor);
    for (const p of walk) {
      p.before = before.get(p.m) || null;
      p.move = moves.get(p.m) || null;
      if (p.move && sum(p.move) !== p.tot) p.move = null;
    }
    const bases = await rowsAt(db, walk.filter((p) => p.before && p.move).map((p) => [p.m, p.move[0] - KILLS_WINDOW_MS, 'le']), floor);
    for (const p of walk) p.base = bases.get(p.m) || null;
  }

  const out = [];
  for (const p of plan.values()) {
    const add = new Map(p.rows.map((r) => [r[0], r]));
    for (const r of [p.base, p.before, p.move]) {
      if (r && r[0] >= p.st && !add.has(r[0])) add.set(r[0], r);
    }
    out.push(...add.values());
  }
  out.sort((a, b) => a[0] - b[0]);
  if (fast) {
    const w = await db.prepare('UPDATE recent SET at = ?1, rows = ?2 WHERE id = 1 AND at = ?3')
      .bind(started, JSON.stringify(out), last.at).run();
    if (w.meta && w.meta.changes === 1) return;
    console.log(JSON.stringify({ recent: 'full', why: 'write overtaken' }));
    return rebuildRecent(db, now);
  }
  // `at` is the start in milliseconds: two readers push in the same second, and
  // the one that began earlier writes nothing over the one that began later.
  await db.prepare(
    'INSERT INTO recent (id, at, rows) VALUES (1, ?1, ?2) ' +
    'ON CONFLICT (id) DO UPDATE SET at = excluded.at, rows = excluded.rows WHERE excluded.at >= recent.at'
  ).bind(started, JSON.stringify(out)).run();
}

// What windowSql gives, from the last body: per match its rows after the cut,
// the newest at or before it (after the floor), and the lines of the table
// newer than the body's newest of the match. The week (`start`) is read only
// for the two rows that need it. null: a row to read is not there.
async function incrementalWindow(db, carried, cut, floor) {
  const newest = new Map();
  for (const r of carried) newest.set(r[1], r[0]);
  const { results: fresh } = await db.prepare(newSql)
    .bind(JSON.stringify(MATCHES.map((m) => [m, newest.get(m) ?? floor]))).all();
  const have = new Map(MATCHES.map((m) => [m, []]));
  for (const r of carried) have.get(r[1]).push({ at: r[0], match: r[1], center: r[2], red: r[3], blue: r[4], green: r[5] });
  for (const r of fresh) have.get(r.match).push(r);
  const out = [], asks = [];
  for (const rows of have.values()) {
    rows.sort((a, b) => a.at - b.at);
    const inside = rows.filter((r) => r.at > cut);
    const bat = rows.findLast((r) => r.at <= cut && r.at > floor);
    const own = bat ? [bat, ...inside] : inside;
    for (const r of [bat, own[own.length - 1]]) if (r && r.start === undefined) asks.push([r.match, r.at]);
    out.push(...own);
  }
  if (asks.length) {
    const { results } = await db.prepare(startSql).bind(JSON.stringify(asks)).all();
    const weeks = new Map(results.map((r) => [r.match + ' ' + r.at, r.start]));
    for (const [m, at] of asks) if (!weeks.has(m + ' ' + at)) return null;
    for (const r of out) if (r.start === undefined && weeks.has(r.match + ' ' + r.at)) r.start = weeks.get(r.match + ' ' + r.at);
  }
  return out.sort((a, b) => a.at - b.at);
}

function sum(r) {
  return Array.isArray(r) ? r[2] + r[3] + r[4] + r[5] : r.center + r.red + r.blue + r.green;
}

function rowOf(r) {
  return [r.at, r.match, r.center, r.red, r.blue, r.green];
}

// p.first: the first row of the week within MOVE_MS. If it is below the newest
// total, the kills moved inside MOVE_MS and the last body did not say where:
// the match goes to the walk.
async function firstWithin(db, list, reach, walk) {
  if (!list.length) return;
  const got = await rowsAt(db, list.map((p) => [p.m, Math.max(reach, p.st - 1), 'gt']), reach);
  for (const p of list) {
    const r = got.get(p.m);
    if (r && sum(r) < p.tot) walk.push(p);
    else if (r && sum(r) === p.tot) p.move = r;
  }
}

// One row per ask [match, at, 'le' | 'gt']: the newest at or before `at` (and
// after `floor`), or the first after it.
async function rowsAt(db, asks, floor) {
  const got = new Map();
  if (!asks.length) return got;
  const { results } = await db.prepare(rowsAtSql).bind(JSON.stringify(asks), floor).all();
  for (const r of results) got.set(r.match, rowOf(r));
  return got;
}

const cleanupSql = 'DELETE FROM kills WHERE at < ?1 AND match IN (' + MATCHES.map((_, i) => '?' + (i + 2)).join(', ') + ')';

// The window, and each match's newest row before it.
const windowSql = 'WITH ids(m) AS (VALUES ' + MATCHES.map((_, i) => '(?' + (i + 3) + ')').join(', ') + ') ' +
  'SELECT at, match, center, red, blue, green, start FROM (' +
    'SELECT k.* FROM kills k WHERE k.match IN (' + MATCHES.map((_, i) => '?' + (i + 3)).join(', ') + ') AND k.at > ?1 ' +
    'UNION ALL ' +
    'SELECT k.* FROM ids JOIN kills k ON k.match = ids.m AND k.at = ' +
      '(SELECT at FROM kills WHERE match = ids.m AND at <= ?1 AND at > ?2 ORDER BY at DESC LIMIT 1)' +
  ') ORDER BY at';

// Per [match, at]: that match's lines after `at`.
const newSql = 'WITH a(m, t) AS (SELECT json_extract(j.value, \'$[0]\'), json_extract(j.value, \'$[1]\') FROM json_each(?1) j) ' +
  'SELECT k.at, k.match, k.center, k.red, k.blue, k.green, k.start FROM a JOIN kills k ON k.match = a.m AND k.at > a.t';

// Per [match, at]: the week of that line.
const startSql = 'SELECT k.at, k.match, k.start FROM json_each(?1) j JOIN kills k ' +
  "ON k.match = json_extract(j.value, '$[0]') AND k.at = json_extract(j.value, '$[1]')";

const ask = (i) => "json_extract(j.value, '$[" + i + "]')";
const rowsAtSql = 'WITH a(m, t, op) AS (SELECT ' + ask(0) + ', ' + ask(1) + ', ' + ask(2) + ' FROM json_each(?1) j), ' +
  'p(m, at) AS (SELECT m, CASE op WHEN \'le\' THEN ' +
    '(SELECT at FROM kills WHERE match = a.m AND at <= a.t AND at > ?2 ORDER BY at DESC LIMIT 1) ELSE ' +
    '(SELECT at FROM kills WHERE match = a.m AND at > a.t ORDER BY at LIMIT 1) END FROM a) ' +
  'SELECT k.at, k.match, k.center, k.red, k.blue, k.green FROM p JOIN kills k ON k.match = p.m AND k.at = p.at';

// Per [match, start, newest total, newest at]: the newest row of the week
// within MOVE_MS below that total, the row before the move. It reads every row
// of the still stretch, so only when nothing can be carried.
const walkSql = 'SELECT ' + ask(0) + ' AS m, ' +
  '(SELECT at FROM kills WHERE match = ' + ask(0) + ' AND at < ' + ask(3) + ' AND at > ?2 AND start = ' + ask(1) + ' ' +
    'AND center + red + blue + green < ' + ask(2) + ' ORDER BY at DESC LIMIT 1) AS pat FROM json_each(?1) j';

// Reads at most max bytes and gives up past that, so a chunked body with no
// content-length cannot make the Worker hold a hundred megabytes. null = over.
async function readCapped(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

// Rows as the sheet has them: [at, match, center, red, blue, green, start] and
// optionally [..., score] (a line without a score is the sheet's older script).
// Anything off refuses the whole message, so a change of shape on the Google side is seen at once.
// One statement for all of them, through json_each: one INSERT per row could pass
// the per-invocation query limit after an outage and then fail on every retry.
function killsStatement(db, data, t) {
  const rows = data && data.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > 300) return 'rows';
  const tms = t * 1000;
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r) || (r.length !== 7 && r.length !== 8)) return 'row shape';
    const [at, match, c, red, blue, green, start, score] = r;
    if (!isInt(at) || at > tms + 60e3 || at < tms - 45 * 60e3) return 'row time';
    if (typeof match !== 'string' || !/^[12]-[1-9]$/.test(match)) return 'match id';
    for (const n of [c, red, blue, green]) if (!isInt(n) || n < 0 || n > 1e7) return 'count';
    if (!isInt(start) || start > at || start < at - 8 * 86400e3) return 'start';
    if (r.length === 8 && (!isInt(score) || score < 0 || score > 3e7)) return 'score';
    // Rebuilt from the checked values, so nothing unchecked reaches SQL.
    out.push([match, at, c, red, blue, green, start, r.length === 8 ? score : null]);
  }
  return killsInsert(db, out);
}

// Rows [match, at, center, red, blue, green, start, score|null], one statement.
// A row enters only if it is newer than the match's newest stored row and not
// of an older week, and in the same week its score rose (its kills total did
// not fall, if either row has no score): a stale body cannot put old numbers
// above newer ones. SQLite reads the whole SELECT before the first insert
// (a test checks two rows of one match in one batch). `thin` (the readers'
// lines) also keeps out a row whose four kills equal the newest's and which
// is under KILLS_LINE_MS after it.
function killsInsert(db, rows, thin = false) {
  return db.prepare(
    'INSERT OR IGNORE INTO kills (match, at, center, red, blue, green, start, score) ' +
    'WITH n AS (SELECT ' +
    "json_extract(value, '$[0]') AS m, json_extract(value, '$[1]') AS at, json_extract(value, '$[2]') AS c, " +
    "json_extract(value, '$[3]') AS r, json_extract(value, '$[4]') AS b, json_extract(value, '$[5]') AS g, " +
    "json_extract(value, '$[6]') AS st, json_extract(value, '$[7]') AS sc FROM json_each(?1)) " +
    'SELECT m, at, c, r, b, g, st, sc FROM n WHERE NOT EXISTS (' +
      'SELECT 1 FROM kills o WHERE o.match = n.m ' +
      'AND o.at = (SELECT at FROM kills WHERE match = n.m ORDER BY at DESC LIMIT 1) ' +
      'AND (NOT (n.at > o.at AND (n.st > o.start OR (n.st = o.start AND ' +
        'CASE WHEN n.sc IS NOT NULL AND o.score IS NOT NULL THEN n.sc > o.score ' +
        'ELSE n.c + n.r + n.b + n.g >= o.center + o.red + o.blue + o.green END))) ' +
      'OR (?2 = 1 AND n.at - o.at < ' + KILLS_LINE_MS + ' AND n.st = o.start AND ' +
        'n.c = o.center AND n.r = o.red AND n.b = o.blue AND n.g = o.green)))'
  ).bind(JSON.stringify(rows), thin ? 1 : 0);
}

// { beat, window, published, fails }; window and published are null together
// when relink!A1 does not parse, which the page would refuse too.
function relinkStatement(db, d, t) {
  if (!d || typeof d !== 'object') return 'shape';
  if (!isInt(d.beat) || d.beat > t + 60 || d.beat < t - 3600) return 'beat';
  if (!isInt(d.fails) || d.fails < 0 || d.fails > 1e6) return 'fails';
  const none = d.window === null && d.published === null;
  if (!none) {
    if (!isInt(d.window) || d.window < 1.7e9 || d.window > 4.1e9) return 'window';
    if (!isInt(d.published) || d.published < 0 || d.published > t + 60) return 'published';
  }
  return db.prepare(
    'INSERT INTO relink (id, beat, window_at, published, fails) VALUES (1, ?1, ?2, ?3, ?4) ' +
    'ON CONFLICT (id) DO UPDATE SET beat = ?1, window_at = ?2, published = ?3, fails = ?4'
  ).bind(d.beat, none ? null : d.window, none ? null : d.published, d.fails);
}

// Each read touches a fixed set of D1 rows, whatever anyone asks, and takes
// nothing from the request - no parameter reaches a query.
const READS = {
  '/api/health': async (env) => {
    const { results } = await env.DB.prepare('SELECT name, received FROM source').all();
    const out = {};
    for (const r of results) out[r.name] = r.received;
    return json(JSON.stringify(out), 30);
  },

  '/api/kills': async (env) => {
    const r = await env.DB.prepare('SELECT at, rows FROM recent WHERE id = 1').first();
    if (!r || Date.now() - r.at > STALE_KILLS_S * 1000 || r.rows === '[]') return text(503, 'stale');
    // Built by rebuildRecent from rows the entrance checked, as JSON by SQLite.
    return json('{"rows":' + r.rows + '}', 60);
  },

  '/api/relink': async (env) => {
    const r = await env.DB.prepare('SELECT beat, window_at, published FROM relink WHERE id = 1').first();
    // A1 not parsing is refused here as the page refuses it from the sheet.
    if (!r || nowS() - r.beat > STALE_RELINK_S || r.window_at === null) return text(503, 'stale');
    return json(JSON.stringify({ window: r.window_at, published: r.published }), 60);
  },

  // One query, and the answer kept by Cloudflare's cache under a fixed
  // key, so a query string cannot make a request of its own: a visitor costs D1
  // nothing while the copy lives.
  // Each entry in the format it came in: format 1 {id, start, score, at, by, gz}, the gzip
  // as base64; format 2 {id, start, score, at, by, v: 2, body}, the live part as JSON.
  '/api/latest': (env, ctx) => cached(ctx, LATEST_KEY, async () => {
    const { results } = await env.DB.prepare('SELECT id, start, score, at, reader, gz FROM latest').all();
    // Two hours without an update: a tier that no longer exists.
    const live = results.filter((r) => nowS() - r.at <= LATEST_KEEP_S);
    const newest = Math.max(0, ...live.map((r) => r.at));
    if (!live.length || nowS() - newest > STALE_LATEST_S) return text(503, 'stale');
    // Format 2's text was parsed whole by the entrance, so it goes in as it is.
    const entry = (r) => {
      const head = JSON.stringify({ id: r.id, start: r.start, score: r.score, at: r.at, by: r.reader }).slice(0, -1);
      return r.gz.startsWith('{') ? head + ',"v":2,"body":' + r.gz + '}' : head + ',"gz":' + JSON.stringify(r.gz) + '}';
    };
    return json('{"at":' + newest + ',"matches":[' + live.map(entry).join(',') + ']}', LATEST_MAX_AGE);
  }),

  // Always 200, {} when empty: the readers need it to begin. `hist`: the finished
  // skirmishes the history table holds for that match and week, when it holds them.
  '/api/latest/summary': (env, ctx) => cached(ctx, SUMMARY_KEY, async () => {
    let results;
    try {
      ({ results } = await env.DB.prepare('SELECT l.id, l.start, l.score, l.at, l.reader, h.n AS hist FROM latest l ' +
        'LEFT JOIN history h ON h.match = l.id AND h.start = l.start').all());
    } catch {
      // Without schema-006.
      ({ results } = await env.DB.prepare('SELECT id, start, score, at, reader FROM latest').all());
    }
    const out = {};
    for (const r of results) {
      if (nowS() - r.at > LATEST_KEEP_S) continue;
      out[r.id] = { start: r.start, score: r.score, at: r.at, by: r.reader };
      if (Number.isInteger(r.hist)) out[r.id].hist = r.hist;
    }
    return json(JSON.stringify(out), SUMMARY_MAX_AGE);
  })
};

// GET /api/history/<region>?v=<n>: the region's finished skirmishes of this week. n is how
// many have finished by the clock, or one fewer (a reader sends them a little after the
// turn); anything else is a miss before D1 is read, so a parameter costs no row.
// {v, start, matches: {id: [skirmish 1, ..., skirmish n]}}, only the matches at n.
async function readHistory(env, ctx, url) {
  const region = /^\/api\/history\/([12])$/.exec(url.pathname);
  const v = /^\?v=([1-9]\d?)$/.exec(url.search);
  if (!region || !v) return miss();
  const nowMs = Date.now();
  const start = weekStart(region[1], nowMs);
  const n = Math.floor((nowMs - start) / SKIRMISH_MS);
  const want = Number(v[1]);
  if (want !== n && want !== n - 1) return miss();
  const ids = MATCHES.filter((id) => id[0] === region[1]);
  const key = HISTORY_KEY + region[1] + '?v=' + want + '&start=' + start;
  // Every answer is kept for as long as it says: a stranger repeating a valid version costs
  // D1 one read per key and max-age, whatever it found.
  return cached(ctx, key, async () => {
    // The matches of this week in latest, and the history each holds at this version.
    const { results } = await env.DB.prepare(
      'SELECT l.id AS match, CASE WHEN h.start = ?1 AND h.n = ?2 THEN h.body END AS body FROM latest l ' +
      'LEFT JOIN history h ON h.match = l.id WHERE l.start = ?1 AND l.id IN (' + ids.map((_, i) => '?' + (i + 3)).join(', ') + ')'
    ).bind(start, want, ...ids).all();
    const at = results.filter((r) => r.body !== null).sort((a, b) => (a.match < b.match ? -1 : 1));
    if (!at.length) return miss();
    const whole = at.length === results.length;
    const body = '{"v":' + want + ',"start":' + start + ',"matches":{' +
      at.map((r) => JSON.stringify(r.match) + ':' + r.body).join(',') + '}}';
    return json(body, whole ? HISTORY_MAX_AGE : HISTORY_PARTIAL_MAX_AGE);
  });
}

// The start of the region's week that holds nowMs, epoch ms.
function weekStart(region, nowMs) {
  const r = RESET[region];
  const d = new Date(nowMs);
  const s = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), r.hour) - ((d.getUTCDay() - r.day + 7) % 7) * 86400e3;
  return s > nowMs ? s - 7 * 86400e3 : s;
}

function miss() {
  return new Response('not found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=' + HISTORY_MISS_MAX_AGE, 'x-content-type-options': 'nosniff' }
  });
}

// An answer that says `public, max-age=N` is kept N seconds (a 503 says no-store). No Cache API
// outside Cloudflare (Node, the tests).
async function cached(ctx, key, make) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      // The answer's own max-age is put back from x-max-age: a cached copy can carry another one.
      const out = new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hit.headers });
      out.headers.set('cache-control', 'public, max-age=' + (out.headers.get('x-max-age') || '5'));
      out.headers.delete('x-max-age');
      return out;
    }
  }
  const res = await make();
  const age = /^public, max-age=(\d+)$/.exec(res.headers.get('cache-control') || '');
  if (cache && age) {
    const kept = res.clone();
    kept.headers.set('x-max-age', age[1]);
    const put = cache.put(key, kept).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

function nowS() {
  return Math.floor(Date.now() / 1000);
}

function json(body, maxAge) {
  return new Response(body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=' + maxAge,
      'x-content-type-options': 'nosniff'
    }
  });
}

function isInt(n) {
  return Number.isSafeInteger(n);
}

function fromHex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Outsiders get a status and one word; the reason goes to Workers Logs.
function refuse(status, source, why) {
  console.log(JSON.stringify({ source, refused: status, why }));
  return text(status, 'refused');
}

function text(status, body) {
  return new Response(body + '\n', {
    status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
}
