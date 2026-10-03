/**
 * Per-map WvW kills snapshot, for wvwrelink.com.
 *
 * Columns, no header row:
 *   epoch ms | match id | Center | RedHome | BlueHome | GreenHome | start_time
 * The four numbers are kills summed over the three teams: deaths caused by an
 * enemy player. deaths is left out on purpose - it also counts whoever dies to
 * a lord, a guard or a fall, which is a roamer soloing a camp, and that would
 * inflate exactly the empty borderland.
 * The site reads columns 0 to 5; the 7th is for this script only.
 *
 * A match's row is written only when its score has risen since its last
 * written row. The GW2 API serves old answers for stretches (a whole match
 * frozen up to ~60 min, seen 02-03/10/2026), and a row stamped with the tick's
 * time over frozen numbers reads as "no kills". The clock is the sum of the
 * match's scores - it rises every few seconds in a live match and by about one
 * tick's points every 5 minutes; kills cannot serve as a clock. When no match
 * moved, nothing is written and nothing is sent: that is not a failure.
 *
 * After the sheet, the same rows go to wvwrelink.com/api, signed - see push_.
 * Run killsSecret() once by hand before that starts; until then the sheet is
 * all there is, as before.
 */
const SHEET_NAME  = 'kills';
const KEEP_MS     = 2 * 60 * 60 * 1000;   // window kept in the sheet
const MAPS        = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];
const COLORS      = ['red', 'blue', 'green'];
const RESET_RATIO = 0.5;                  // below this it is the weekly reset
const ALARM_AFTER = 6;                    // 6 ticks ~ 30 min to the 1st alarm
const ALARM_EVERY = 72;                   // then a reminder every ~6 h
const API         = 'https://api.guildwars2.com/v2/wvw/matches';
// Three small routes instead of the whole match: stats carries the kills per
// map, overview the start_time, scores the clock. ~15 KB for stats+overview
// (measured 29/09/2026) plus ~175 KB for scores (curl, 03/10/2026), ~190 KB
// per tick instead of ~700 KB, same numbers. Each can come from a different API node;
// the rules in rowFor_ correct themselves within a tick (see there).
const ROUTES      = [API + '/stats?ids=all', API + '/overview?ids=all',
                     API + '/scores?ids=all'];
// Without this a hung request waits 360 s, the whole execution, and spends
// the daily trigger quota this script shares with the relink one.
const TIMEOUT_S   = 20;
const ENTRADA     = 'https://wvwrelink.com';
const ENTRADA_PATH = '/api/entrada/kills';
// Rows not yet accepted are sent again with the next tick, so a failed push
// costs nothing if the one after it lands. Past this age they are dropped:
// the Worker refuses rows much older than the message anyway.
const PENDING_MS  = 30 * 60 * 1000;
// A property value holds at most 9 KB; nine matches a tick are ~600 characters.
const PENDING_MAX_CHARS = 8000;

function snapshot() {
  // Triggers are not queued: if a tick runs long, the next one starts on top
  // of it and both read getLastRow() together. Gives up rather than waits -
  // the next tick is 5 minutes away.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    run_();
  } finally {
    lock.releaseLock();
  }
}

function run_() {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();

  let matches;
  const sums = {};
  try {
    const got = fetchAllJson_(ROUTES);
    const stats = got[0];
    const overview = got[1];
    const scores = got[2];
    if (!Array.isArray(stats) || !stats.length) throw new Error('stats empty');
    if (!Array.isArray(overview)) throw new Error('overview empty');
    if (!Array.isArray(scores)) throw new Error('scores empty');
    const start = {};
    for (const o of overview) if (o && o.id) start[o.id] = o.start_time;
    for (const o of scores) if (o && o.id) sums[o.id] = scoreSum_(o.scores);
    // A match without a start_time is left out of this tick rather than
    // written without the date that guards against a lagging node.
    // Nor one without a score sum: without it there is no telling live from frozen.
    matches = stats.filter(function (m) { return m && start[m.id] && sums[m.id] !== undefined; })
      .map(function (m) { return { id: m.id, maps: m.maps, start_time: start[m.id] }; });
    if (!matches.length) throw new Error('stats and overview share no match');
  } catch (e) {
    alarm_(props, e);
    return;
  }
  if (props.getProperty('fails')) props.deleteProperty('fails');

  // Recreates the tab if it disappears or is renamed, instead of dying.
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  // One read, used for two things: each matchup's last value and the
  // window's cut. Google's documentation is explicit: alternating reads and
  // writes is what makes it slow.
  const width = 3 + MAPS.length;
  const lastRow = sh.getLastRow();
  const old = lastRow > 0 ? sh.getRange(1, 1, lastRow, width).getValues() : [];

  const prev = {};
  for (const r of old) prev[String(r[1])] = r;

  const saved = readSaved_(props);
  const rows = [];
  const moved = {};
  for (const m of matches) {
    const st = Date.parse(m.start_time) || 0;
    if (!moved_(saved[m.id], sums[m.id], st)) continue;
    const row = rowFor_(m, prev[String(m && m.id)], now);
    if (row) {
      rows.push(row);
      moved[m.id] = [sums[m.id], st];
    }
  }
  if (!rows.length) {
    // Nothing moved (or everything is frozen): nothing to write, but rows an
    // earlier push did not land are still owed to the Worker.
    if (props.getProperty('pending')) push_(props, [], now);
    return;
  }

  // deleteRows REMOVES rows, so the sheet's total shrinks on every run, and
  // getRange does not grow it by itself. Without this the total reaches the
  // used rows in ~7 h and writing starts failing silently.
  const start = lastRow + 1;
  const need = start + rows.length - 1 - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 100);
  sh.getRange(start, 1, rows.length, width).setValues(rows);
  // Only once the rows are in the sheet, so a failed write is tried again.
  for (const id in moved) saved[id] = moved[id];
  props.setProperty('scores', JSON.stringify(saved));

  // Always clean up after writing, and never reach what was just written,
  // even if everything that was there is old.
  let cut = 0;
  while (cut < old.length && Number(old[cut][0]) < now - KEEP_MS) cut++;
  cut = Math.min(cut, lastRow);
  if (cut > 0) sh.deleteRows(1, cut);

  // Last, so nothing here can stop the sheet the page reads from being written.
  push_(props, rows, now);
}

/**
 * Sends this tick's rows, with any earlier ones not yet accepted, and never
 * throws: a push that fails is logged and retried next tick, and the one
 * watching for it is outside this script - the Worker's health route.
 */
function push_(props, rows, now) {
  const secret = props.getProperty('entrada');
  if (!secret) return;
  let pending = [];
  try {
    pending = JSON.parse(props.getProperty('pending') || '[]');
  } catch (e) {
    pending = [];
  }
  pending = pending.filter(function (r) { return Number(r[0]) >= now - PENDING_MS; })
    .concat(rows);
  while (JSON.stringify(pending).length > PENDING_MAX_CHARS && pending.length > rows.length) {
    pending.shift();
  }
  try {
    const t = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ rows: pending });
    const sig = hex_(Utilities.computeHmacSha256Signature(
      Utilities.newBlob(t + '\n' + ENTRADA_PATH + '\n' + body).getBytes(),
      Utilities.newBlob(secret).getBytes()));
    const res = UrlFetchApp.fetch(ENTRADA + ENTRADA_PATH, {
      method: 'post',
      contentType: 'application/json',
      payload: body,
      headers: { 'x-wvw-time': String(t), 'x-wvw-sig': sig },
      muteHttpExceptions: true,
      followRedirects: false,
      timeoutSeconds: TIMEOUT_S
    });
    if (res.getResponseCode() === 200) pending = [];
    else Logger.log('push: HTTP ' + res.getResponseCode());
  } catch (e) {
    Logger.log('push: ' + e);
  }
  if (pending.length) props.setProperty('pending', JSON.stringify(pending));
  else props.deleteProperty('pending');
}

/**
 * Run once by hand. Creates the secret the kills messages are signed with and
 * logs it this once, to be pasted into the Worker's ENTRADA_KILLS secret and
 * nowhere else. To change it: delete the "entrada" script property, run this
 * again, paste the new one.
 */
function killsSecret() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('entrada')) {
    Logger.log('A secret already exists. Delete the "entrada" script property first to replace it.');
    return;
  }
  // getUuid is java.util.UUID.randomUUID, a cryptographically strong
  // generator: four of them, hashed into 512 bits.
  let bytes = [];
  for (let i = 0; i < 2; i++) {
    bytes = bytes.concat(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      Utilities.getUuid() + Utilities.getUuid() + Date.now()));
  }
  const secret = hex_(bytes);
  props.setProperty('entrada', secret);
  Logger.log('Paste this into the Worker secret ENTRADA_KILLS, and nowhere else:');
  Logger.log(secret);
}

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function scoreSum_(sc) {
  if (!sc || typeof sc !== 'object') return undefined;
  let n = 0;
  for (const c of COLORS) {
    if (typeof sc[c] !== 'number' || !isFinite(sc[c])) return undefined;
    n += sc[c];
  }
  return n;
}

function readSaved_(props) {
  try {
    const v = JSON.parse(props.getProperty('scores') || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    return {};
  }
}

/**
 * Is this match's data newer than its last written row? saved is
 * [score sum, start_time ms] of that row. A new start_time (new week, relink)
 * always counts; otherwise only a higher sum does. The saved sum only ever
 * rises within a week, so equal or lower is the API repeating itself or a
 * lagging node - never written under the tick's time.
 */
function moved_(saved, sum, st) {
  if (!Array.isArray(saved)) return true;
  if (st > num_(saved[1])) return true;
  return sum > num_(saved[0]);
}

function rowFor_(m, prevRow, now) {
  if (!m || typeof m.id !== 'string' || !Array.isArray(m.maps)) return null;

  const by = {};
  for (const map of m.maps) {
    if (!map || MAPS.indexOf(map.type) < 0) continue;
    let n = 0;
    for (const c of COLORS) {
      n += num_((map.kills || {})[c]);
    }
    by[map.type] = n;
  }
  // All four or none. A partial answer would look like a reset to the rule
  // below and wipe the baseline with zeros.
  if (MAPS.some(function (t) { return by[t] === undefined; })) return null;

  const st = Date.parse(m.start_time) || 0;
  const pst = prevRow ? num_(prevRow[2 + MAPS.length]) : 0;

  // A lagging node serves last week's start_time. That is how it gives
  // itself away. Dropping the whole tick is safer than letting the running
  // maximum pin last week's total over the new one, early on Saturday. With
  // kills and start_time coming from separate routes, only one of the two may
  // lag at the reset: the next tick corrects it, because the big drop is
  // treated as a reset just below.
  if (st && pst && st < pst) return null;

  const newWeek = !!(st && pst && st > pst);
  const vals = MAPS.map(function (t, i) {
    const nv = by[t];
    const pv = prevRow ? num_(prevRow[2 + i]) : 0;
    // Kills only rise. A big drop is the weekly reset and the new number
    // stands; a small drop is the API answering from a lagging node, and the
    // true number is the one we already had.
    if (newWeek || nv < pv * RESET_RATIO) return nv;
    return nv > pv ? nv : pv;
  });
  return [now, m.id].concat(vals).concat([st]);
}

function fetchAllJson_(urls) {
  // Two attempts: a dropped connection is the most common failure and
  // retrying costs nothing, while giving up costs a 5-minute hole in the data.
  const reqs = urls.map(function (url) {
    return { url: url, muteHttpExceptions: true, timeoutSeconds: TIMEOUT_S };
  });
  let err;
  for (let i = 0; i < 2; i++) {
    try {
      return UrlFetchApp.fetchAll(reqs).map(function (res, k) {
        const code = res.getResponseCode();
        if (code !== 200) throw new Error('HTTP ' + code + ' ' + urls[k]);
        return JSON.parse(res.getContentText());
      });
    } catch (e) {
      err = e;
      if (i === 0) Utilities.sleep(2000);
    }
  }
  throw err;
}

function alarm_(props, e) {
  // Quiet for a hiccup, loud for a real outage, and never loud on every
  // tick: Apps Script sends an email on every exception, and a trigger that
  // fails for hours on end is a trigger Google may switch off.
  const n = num_(props.getProperty('fails')) + 1;
  props.setProperty('fails', String(n));
  if (n === ALARM_AFTER || (n > ALARM_AFTER && (n - ALARM_AFTER) % ALARM_EVERY === 0)) {
    throw new Error('GW2 API down for ' + n + ' ticks (~' + (n * 5) + ' min): ' + e);
  }
}

function num_(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
