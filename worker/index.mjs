// wvwrelink.com/api. What it accepts, and what is worth reporting: SECURITY.md.
//
//   POST /api/ingest/kills    the kills script, after every tick
//   POST /api/ingest/relink   the teams notice script, after every tick
//   POST /api/ingest/latest-supa-us, latest-supa-eu, latest-vercel-eu, latest-vercel-us
//                              the outside readers of the game API, the newest match bodies
//   GET  /api/health            when each last reported; nothing else
//   GET  /api/kills            the last 30 minutes of kills plus each match's newest older row (up to 3 h back), for the map swords
//   GET  /api/relink           relink!A1 as numbers, for the teams notice
//   GET  /api/latest            each match's newest body, as the readers pushed it
//   GET  /api/latest/summary     the same without the bodies: id, start, score, at, by
//   daily, on a schedule       kills older than KEEP_DAYS are deleted
//
// A message is signed by its script with a secret of its own:
//   x-wvw-time  epoch seconds
//   x-wvw-sig   hex HMAC-SHA256 of  time + "\n" + path + "\n" + body
// The path is in the signature so a message for one source cannot be replayed
// against the other, and each source has its own secret so one leaking does
// not open the other.
//
// The latest entrance never opens a match body (the free plan gives 10 ms of CPU
// a request and unpacking 484 KB costs ~17): it decides by the signed summary
// that comes before the bodies and by the match's score, never by a reader's clock.

const MAX_BYTES = 64 * 1024;      // kills sends at most 30 min of rows, ~4 KB
const MAX_BYTES_LATEST = 256 * 1024; // up to 18 gzipped match bodies
const MAX_SKEW_S = 300;
// One match body is ~28 KB, ~4.5 KB gzipped (9 matches, 04/10/2026). The Worker
// never opens a slice, so these bound what a page may be handed to unpack: a
// gzip bomb of 16 KB still unpacks to ~16 MB, and the page stops at raw.
const MAX_SLICE = 16 * 1024;
const MAX_RAW = 256 * 1024;
const SOURCES = {
  kills: 'INGEST_KILLS', relink: 'INGEST_RELINK',
  'latest-supa-us': 'INGEST_LATEST_SUPA_US', 'latest-supa-eu': 'INGEST_LATEST_SUPA_EU',
  'latest-vercel-eu': 'INGEST_LATEST_VERCEL_EU', 'latest-vercel-us': 'INGEST_LATEST_VERCEL_US'
};
// When a region's weekly match starts, UTC (day 0 = Sunday), checked against the
// live API on 04/10/2026: 2-x 2026-10-02T18:00Z, 1-x 2026-10-03T02:00Z.
const RESET = { 1: { day: 6, hour: 2 }, 2: { day: 5, hour: 18 } };
// Past this a match has had no update and its tier is gone; /api/latest drops it.
const LATEST_KEEP_S = 2 * 3600;
// The newest body older than this and /api/latest answers 503.
const STALE_LATEST_S = 10 * 60;
// A match's score cannot rise faster than this a minute (PPT tops out far below),
// with room on top. A message past it is a damaged read or a stolen secret.
const MAX_SCORE_PER_MIN = 1000;
const SCORE_SLACK = 2000;
const LATEST_KEY = 'https://wvwrelink.com/api/latest';
const SUMMARY_KEY = 'https://wvwrelink.com/api/latest/summary';
// The max-age of each read, both in its answer and on a copy served from the cache.
const LATEST_MAX_AGE = 30;
const SUMMARY_MAX_AGE = 15;
// The scripts make 128 hex characters. Anything much shorter was pasted in
// half, and a weak secret that works is worse than one that fails loudly.
const MIN_SECRET = 64;
// The running match and the one before it (the owner, 30/09/2026). Raising it
// keeps more from then on; what was already deleted does not come back.
const KEEP_DAYS = 14;
// What GET /api/kills carries in full. The page wants the newest reading at
// least ten minutes old, which with a tick every five is 10-15 minutes back;
// the rest is room for a late tick. But kills.gs writes a match only when its
// score rose and the GW2 API froze one for up to ~65 minutes (03/10/2026), so
// each match also carries its newest older row, up to BASE_MS back.
const RECENT_MS = 30 * 60e3;
const BASE_MS = 3 * 3600e3;
// Past these a source counts as stopped, and the reads answer 503 so the
// page goes to the sheet rather than show a copy that stopped moving. Kills
// ticks every 5 minutes, relink every 15.
const STALE_KILLS_S = 20 * 60;
const STALE_RELINK_S = 45 * 60;
// Every match id the entrance accepts, so the rebuild below reads the kills
// table by its key. By time alone it would scan the whole table.
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
    const r = await env.DB.prepare('DELETE FROM kills WHERE at < ?1')
      .bind(Date.now() - KEEP_DAYS * 86400e3).run();
    console.log(JSON.stringify({ cleanup: true, deleted: r.meta && r.meta.changes }));
  }
};

async function accept(request, env, source, path) {
  const secret = Object.hasOwn(SOURCES, source) && env[SOURCES[source]];
  if (!secret) return refuse(404, source, 'unknown source or no secret');
  if (secret.length < MIN_SECRET) return refuse(404, source, 'secret too short');

  // Everything up to the signature costs no database access, so an unsigned
  // flood costs CPU milliseconds and nothing else.
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

  // Signed from here on, so a failure below is our bug or Google's, not an
  // attack - but it is still never written.
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

// The latest entrance: <summary JSON, one line> "\n" <gzip body of each match,
// in the summary's order>. Only the summary and the slices' hashes are read.
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
  for (const m of ms) {
    m.slice = body.subarray(at, at + m.bytes);
    at += m.bytes;
    if (toHex(await crypto.subtle.digest('SHA-256', m.slice)) !== m.sha256) return refuse(422, source, 'sha256 ' + m.id);
  }

  if (!await claimTime(env.DB, source, t, now)) return refuse(409, source, 'replay or out of order');

  // One command per match, atomic in SQLite: two readers at once cannot make a
  // match go back. A first write enters (it passed the checks above); after
  // that a newer week wins, and in the same week a higher score, but not past
  // what a score can rise since the stored one. Compared to the Worker's clock.
  const applied = [];
  const lost = [];
  for (const m of ms) {
    const r = await env.DB.prepare(
      'INSERT INTO latest (id, start, score, at, reader, gz, sha, raw) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ' +
      'ON CONFLICT (id) DO UPDATE SET start = excluded.start, score = excluded.score, at = excluded.at, ' +
      'reader = excluded.reader, gz = excluded.gz, sha = excluded.sha, raw = excluded.raw ' +
      'WHERE excluded.start > latest.start OR (excluded.start = latest.start AND excluded.score > latest.score ' +
      'AND excluded.score <= latest.score + ' + MAX_SCORE_PER_MIN + ' * ((?9 - latest.at) / 60.0) + ' + SCORE_SLACK + ')'
    ).bind(m.id, m.start, m.score, now, source, toBase64(m.slice), m.sha256, m.raw, now).run();
    (r.meta && r.meta.changes === 1 ? applied : lost).push(m);
  }
  if (lost.length) await logJumps(env.DB, source, lost, now);

  // The kills lines of the matches that moved, through the same rule as the
  // sheet's. Stamped by the Worker's clock: a reader's runs up to 5 min off, and
  // a line in its future would keep out every source's lines until then.
  let entered = 0;
  if (applied.length) {
    const at = Date.now();
    const rows = applied.map((m) => [m.id, at, ...m.kills, m.start, m.score]);
    entered = (await killsInsert(env.DB, rows).run()).meta.changes;
  }
  console.log(JSON.stringify({ source, ok: true, applied: applied.length, lost: lost.length }));
  if (entered) {
    try {
      await rebuildRecent(env.DB, now);
    } catch (e) {
      console.log(JSON.stringify({ source, recent: 'failed', why: String(e) }));
    }
  }
  return new Response(JSON.stringify({ applied: applied.map((m) => m.id) }) + '\n', {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
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
  if (!s || typeof s !== 'object' || s.v !== 1) return 'version';
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
    if (!isIntList(m.scores, 3) || !isIntList(m.kills, 4)) return 'counts';
    if (!isInt(m.bytes) || m.bytes < 18 || m.bytes > MAX_SLICE) return 'bytes';
    if (!isInt(m.raw) || m.raw < 1 || m.raw > MAX_RAW) return 'raw';
    if (typeof m.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.sha256)) return 'sha256 form';
    const score = m.scores[0] + m.scores[1] + m.scores[2];
    // Independent of what is stored: a week that has just begun cannot hold a big score.
    if (score > MAX_SCORE_PER_MIN * Math.max(0, (nowMs - m.start) / 60e3) + SCORE_SLACK) return 'score for the week';
    total += m.bytes;
    out.push({ id: m.id, start: m.start, score, kills: m.kills.slice(), bytes: m.bytes, raw: m.raw, sha256: m.sha256 });
  }
  if (total !== rest) return 'bytes do not add up';
  return out;
}

function isIntList(a, n) {
  return Array.isArray(a) && a.length === n && a.every((x) => isInt(x) && x >= 0 && x <= 1e7);
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Text, not a BLOB: D1 and node:sqlite hand BLOBs back differently, and a
// read can put the string straight into JSON.
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// The one row GET /api/kills reads. Built here, once per tick, so a read
// costs one row of D1's 5 million a day however many there are: the cheapest
// query over the kills table itself costs ~60, and 100,000 of those a day -
// the Worker's own limit - would pass it and stop every query, writes
// included, until midnight UTC.
// It holds the last RECENT_MS plus, per match, the newest row before that
// window (at most BASE_MS back, same start as the match's newest row, so the
// same week), so a frozen match keeps a base. Driven by the list of matches,
// each lookup bounds `at` as well as the match: a correlated `k.at = (...)`
// would walk every row of each match. A test checks the plan for it. The
// fake D1 does not count rows read, so no figure here.
function rebuildRecent(db, now) {
  const keys = MATCHES.map((_, i) => '?' + (i + 4)).join(', ');
  const ids = MATCHES.map((_, i) => '(?' + (i + 4) + ')').join(', ');
  const cut = now * 1000 - RECENT_MS;
  return db.prepare(
    'INSERT INTO recent (id, at, rows) ' +
    'WITH ids(m) AS (VALUES ' + ids + '), ' +
    'base AS (SELECT m, ' +
      '(SELECT at FROM kills WHERE match = ids.m AND at <= ?2 AND at > ?3 ORDER BY at DESC LIMIT 1) AS bat, ' +
      '(SELECT start FROM kills WHERE match = ids.m AND at > ?3 ORDER BY at DESC LIMIT 1) AS st FROM ids) ' +
    'SELECT 1, ?1, json_group_array(json_array(at, match, center, red, blue, green)) ' +
    'FROM (' +
      'SELECT * FROM kills WHERE match IN (' + keys + ') AND at > ?2 ' +
      'UNION ALL ' +
      'SELECT k.* FROM base JOIN kills k ON k.match = base.m AND k.at = base.bat WHERE k.start = base.st ' +
      'ORDER BY at) WHERE true ' +
    'ON CONFLICT (id) DO UPDATE SET at = excluded.at, rows = excluded.rows'
  ).bind(now, cut, cut - BASE_MS, ...MATCHES).run();
}

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
// Anything off is the whole message refused rather than the row skipped, so a
// change of shape on the Google side is seen at once and not as a thin history.
// One statement for all of them, through json_each: a batch of one INSERT per
// row would reach the 50 queries a free invocation may make after an outage,
// and then fail on every retry, since the backlog only grows.
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
// (a test checks two rows of one match in one batch).
function killsInsert(db, rows) {
  return db.prepare(
    'INSERT OR IGNORE INTO kills (match, at, center, red, blue, green, start, score) ' +
    'WITH n AS (SELECT ' +
    "json_extract(value, '$[0]') AS m, json_extract(value, '$[1]') AS at, json_extract(value, '$[2]') AS c, " +
    "json_extract(value, '$[3]') AS r, json_extract(value, '$[4]') AS b, json_extract(value, '$[5]') AS g, " +
    "json_extract(value, '$[6]') AS st, json_extract(value, '$[7]') AS sc FROM json_each(?1)) " +
    'SELECT m, at, c, r, b, g, st, sc FROM n WHERE NOT EXISTS (' +
      'SELECT 1 FROM kills o WHERE o.match = n.m ' +
      'AND o.at = (SELECT at FROM kills WHERE match = n.m ORDER BY at DESC LIMIT 1) ' +
      'AND NOT (n.at > o.at AND (n.st > o.start OR (n.st = o.start AND ' +
        'CASE WHEN n.sc IS NOT NULL AND o.score IS NOT NULL THEN n.sc > o.score ' +
        'ELSE n.c + n.r + n.b + n.g >= o.center + o.red + o.blue + o.green END))))'
  ).bind(JSON.stringify(rows));
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

// Each read is one row of D1 (health: two), whatever anyone asks, and takes
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
    if (!r || nowS() - r.at > STALE_KILLS_S || r.rows === '[]') return text(503, 'stale');
    // Built by rebuildRecent from rows the entrance checked, as JSON by SQLite.
    return json('{"rows":' + r.rows + '}', 60);
  },

  '/api/relink': async (env) => {
    const r = await env.DB.prepare('SELECT beat, window_at, published FROM relink WHERE id = 1').first();
    // A1 not parsing is refused here as the page refuses it from the sheet.
    if (!r || nowS() - r.beat > STALE_RELINK_S || r.window_at === null) return text(503, 'stale');
    return json(JSON.stringify({ window: r.window_at, published: r.published }), 60);
  },

  // One query, and the answer kept for 30 s by Cloudflare's cache under a fixed
  // key, so a query string cannot make a request of its own: a visitor costs D1
  // nothing while the copy lives.
  '/api/latest': (env, ctx) => cached(ctx, LATEST_KEY, LATEST_MAX_AGE, async () => {
    const { results } = await env.DB.prepare('SELECT id, start, score, at, reader, gz FROM latest').all();
    // Two hours without an update: a tier that no longer exists.
    const live = results.filter((r) => nowS() - r.at <= LATEST_KEEP_S);
    const newest = Math.max(0, ...live.map((r) => r.at));
    if (!live.length || nowS() - newest > STALE_LATEST_S) return text(503, 'stale');
    return json(JSON.stringify({
      at: newest,
      matches: live.map((r) => ({ id: r.id, start: r.start, score: r.score, at: r.at, by: r.reader, gz: r.gz }))
    }), LATEST_MAX_AGE);
  }),

  // Always 200, {} when empty: the readers need it to begin.
  '/api/latest/summary': (env, ctx) => cached(ctx, SUMMARY_KEY, SUMMARY_MAX_AGE, async () => {
    const { results } = await env.DB.prepare('SELECT id, start, score, at, reader FROM latest').all();
    const out = {};
    for (const r of results) {
      if (nowS() - r.at <= LATEST_KEEP_S) out[r.id] = { start: r.start, score: r.score, at: r.at, by: r.reader };
    }
    return json(JSON.stringify(out), SUMMARY_MAX_AGE);
  })
};

// Only a 200 is kept. No Cache API outside Cloudflare (Node, the tests).
async function cached(ctx, key, maxAge, make) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) {
      // A hit comes back with max-age=14400, measured 09/10/2026 with curl on
      // cf-cache-status HIT. That is probably the zone's Browser Cache TTL; the
      // docs do not say so. The route's own max-age is put back here.
      const out = new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: hit.headers });
      out.headers.set('cache-control', 'public, max-age=' + maxAge);
      return out;
    }
  }
  const res = await make();
  if (cache && res.status === 200) {
    const put = cache.put(key, res.clone()).catch(() => {});
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
