// wvwrelink.com/api. What it accepts, and what is worth reporting: SECURITY.md.
//
//   POST /api/entrada/kills    the kills script, after every tick
//   POST /api/entrada/relink   the teams notice script, after every tick
//   GET  /api/saude            when each last reported; nothing else
//   GET  /api/kills            the last 30 minutes of kills, for the map swords
//   GET  /api/relink           relink!A1 as numbers, for the teams notice
//   daily, on a schedule       kills older than KEEP_DAYS are deleted
//
// A message is signed by its script with a secret of its own:
//   x-wvw-time  epoch seconds
//   x-wvw-sig   hex HMAC-SHA256 of  time + "\n" + path + "\n" + body
// The path is in the signature so a message for one source cannot be replayed
// against the other, and each source has its own secret so one leaking does
// not open the other.

const MAX_BYTES = 64 * 1024;      // kills sends at most 30 min of rows, ~4 KB
const MAX_SKEW_S = 300;
const SOURCES = { kills: 'ENTRADA_KILLS', relink: 'ENTRADA_RELINK' };
// The scripts make 128 hex characters. Anything much shorter was pasted in
// half, and a weak secret that works is worse than one that fails loudly.
const MIN_SECRET = 64;
// The running match and the one before it (the owner, 30/09/2026). Raising it
// keeps more from then on; what was already deleted does not come back.
const KEEP_DAYS = 14;
// What GET /api/kills carries. The page wants the newest reading at least
// ten minutes old, which with a tick every five is 10-15 minutes back; the
// rest is room for a late tick.
const RECENT_MS = 30 * 60e3;
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = /^\/api\/entrada\/([a-z]+)$/.exec(url.pathname);
    if (m) {
      if (request.method !== 'POST') return text(405, 'method');
      return accept(request, env, m[1], url.pathname);
    }
    // hasOwn, so a path like /api/constructor is not a read.
    if (Object.hasOwn(READS, url.pathname)) {
      if (request.method !== 'GET') return text(405, 'method');
      // Any failure is a 503: the page reads the sheet on any failure, and a
      // 500 would say nothing more.
      try {
        return await READS[url.pathname](env);
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
  if (Number(request.headers.get('content-length') || 0) > MAX_BYTES) return refuse(413, source, 'declared size');
  const body = await readCapped(request, MAX_BYTES);
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
  const claim = await env.DB.prepare(
    'UPDATE source SET t = ?1, received = ?2 WHERE name = ?3 AND t < ?1'
  ).bind(Number(t), now, source).run();
  if (!claim.meta || claim.meta.changes !== 1) return refuse(409, source, 'replay or out of order');

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

// The one row GET /api/kills reads. Built here, once per tick, so a read
// costs one row of D1's 5 million a day however many there are: the cheapest
// query over the kills table itself costs ~60, and 100,000 of those a day -
// the Worker's own limit - would pass it and stop every query, writes
// included, until midnight UTC.
function rebuildRecent(db, now) {
  const keys = MATCHES.map((_, i) => '?' + (i + 3)).join(', ');
  return db.prepare(
    'INSERT INTO recent (id, at, rows) ' +
    'SELECT 1, ?1, json_group_array(json_array(at, match, center, red, blue, green)) ' +
    'FROM (SELECT * FROM kills WHERE match IN (' + keys + ') AND at > ?2 ORDER BY at) WHERE true ' +
    'ON CONFLICT (id) DO UPDATE SET at = excluded.at, rows = excluded.rows'
  ).bind(now, now * 1000 - RECENT_MS, ...MATCHES).run();
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

// Rows as the sheet has them: [at, match, center, red, blue, green, start].
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
    if (!Array.isArray(r) || r.length !== 7) return 'row shape';
    const [at, match, c, red, blue, green, start] = r;
    if (!isInt(at) || at > tms + 60e3 || at < tms - 45 * 60e3) return 'row time';
    if (typeof match !== 'string' || !/^[12]-[1-9]$/.test(match)) return 'match id';
    for (const n of [c, red, blue, green]) if (!isInt(n) || n < 0 || n > 1e7) return 'count';
    if (!isInt(start) || start > at || start < at - 8 * 86400e3) return 'start';
    // Rebuilt from the checked values, so nothing unchecked reaches SQL.
    out.push([match, at, c, red, blue, green, start]);
  }
  return db.prepare(
    'INSERT OR IGNORE INTO kills (match, at, center, red, blue, green, start) ' +
    "SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), " +
    "json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]'), " +
    "json_extract(value, '$[6]') FROM json_each(?1)"
  ).bind(JSON.stringify(out));
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

// Each read is one row of D1 (saude: two), whatever anyone asks, and takes
// nothing from the request - no parameter reaches a query.
const READS = {
  '/api/saude': async (env) => {
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
  }
};

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
