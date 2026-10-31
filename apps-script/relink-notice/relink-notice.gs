/**
 * @OnlyCurrentDoc
 *
 * Teams notice - the counting half, for wvwrelink.com
 * ---------------------------------------------------------------------------
 * The annotation above is load-bearing and stays the first line. Apps Script
 * works out its scopes by READING THE SOURCE, and one call that opens a
 * spreadsheet by id anywhere in the file makes it request every spreadsheet
 * in the account. No comment below spells such a call out either: the scan
 * reads the file, not the syntax tree.
 *
 * A hand-written oauthScopes in appsscript.json overrides the annotation and the scan, so the
 * manifest beside this file is pinned too: two scopes, currentonly and
 * external requests.
 * ---------------------------------------------------------------------------
 * BOUND to the relink spreadsheet (Extensions > Apps Script), with a
 * time-driven trigger on relinkTick() every 15 minutes. A standalone script
 * would have to reach the sheet by id, which is the broad grant above.
 *
 * A project of its own, not added to the kills script: an Apps Script project
 * shares ONE global scope across all of its files, so a `var API` here
 * against a `const API` there is a SyntaxError that stops the whole project,
 * and two functions with the same name are NOT an error - the last one
 * declared wins, silently. The 90 minutes a day of trigger time is a
 * per-ACCOUNT quota, shared with the kills trigger.
 *
 * Hence the closure. Exactly four names are global, three only because they
 * are run by name:
 *
 *   relinkTick    the function the trigger calls
 *   relinkSetup   the function you run once, by hand
 *   relinkSecret  the other function you run once, by hand
 *   RelinkNotice_ everything else, private inside it
 * ---------------------------------------------------------------------------
 *
 * What it is for. ArenaNet republishes /v2/wvw/guilds/{na,eu} with everyone's
 * new team and announces it nowhere: no timestamp, no ETag. The only signal is
 * the table itself moving, and seeing that means holding a copy of it and
 * comparing - half a megabyte - which the visitors' browsers must not do.
 *
 * What it writes. Two cells in the relink tab, both as text.
 *
 * relink!A1, "window:published" - the answer the site reads:
 *
 *   window     the NA teamAssignment these numbers are about, epoch seconds
 *   published  when the table was seen to have moved, epoch seconds, or 0
 *
 * `window` is what ends the notice with nothing having to switch it off: the
 * page compares it against the relink it is counting down to.
 *
 * Text, not two number cells: the CSV export renders a numeric cell in
 * whatever format the sheet uses, and a thousands separator is a comma inside
 * a comma-separated file.
 *
 * relink!A2, one epoch integer - the heartbeat, which the site never reads. It
 * is written FIRST, before anything that can throw, on every tick in and out
 * of the window: a tick that fails is already loud, but a trigger that never
 * runs makes no sound anywhere. check-notice.py reads it and fails on a stale
 * one.
 *
 * After every tick both cells also go to wvwrelink.com/api, signed - see
 * push(). The cells stay the one source: what is sent is read back from them.
 *
 * Cost. Outside the window it reads two small timers and returns; inside it
 * (about four days a month) it also reads the two tables, the expensive part.
 */

/**
 * The function the trigger calls. Every 15 minutes.
 *
 * Locked: triggers are not queued, so a tick that runs long is overlapped by
 * the next one, and a second run in the middle of the baseline being cleared
 * and rewritten would leave a half-written table, which reads as every guild
 * having moved. Gives up rather than waits.
 */
function relinkTick() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    RelinkNotice_.tick();
  } finally {
    RelinkNotice_.push();
    lock.releaseLock();
  }
}

/**
 * Run this once by hand, from the editor, before the first relink.
 *
 * Takes the first baseline and writes a dark state. Also the only way to get
 * the authorisation prompts out of the way before the night it matters.
 */
function relinkSetup() {
  RelinkNotice_.setup();
}

/**
 * Run once by hand. Creates the secret the messages to wvwrelink.com/api are
 * signed with and logs it this once, to be pasted into the Worker's
 * INGEST_RELINK secret and nowhere else. Until it exists nothing is sent.
 * To change it: delete the "ingest" script property, run this again, paste.
 */
function relinkSecret() {
  RelinkNotice_.secret();
}


var RelinkNotice_ = (function () {
  'use strict';

  // Must match the tab named in RELINK_SHEET_URL in js/config.js. If this tab
  // is missing, the CSV export quietly serves the *first* sheet instead of
  // failing; setup() renames the default sheet to this rather than leaving an
  // empty one in front of it.
  //
  // No spreadsheet id here: bound, the only spreadsheet this script can touch
  // is the one it lives in. The id exists only in js/config.js.
  //
  // The document must be shared as "anyone with the link, VIEWER", never
  // Editor: whoever can write the cell below can make the page say the new
  // teams are out when they are not.
  var TAB = 'relink';

  var API = 'https://api.guildwars2.com/v2';
  var REGIONS = ['na', 'eu'];

  // One percent of the table: about 45 guilds in NA, 55 in EU. The signal is
  // bimodal - outside a relink no guild changes team, a relink moves most
  // of the table - so this is not a tuning knob.
  var THRESHOLD_FRACTION = 0.01;

  // Rolling: whenever the table is seen to have moved, the table that moved
  // becomes the new baseline, in the same pass, so it is always "the last
  // thing that was true".
  //
  // In tabs of the same spreadsheet, not Drive files: Drive would cost an
  // OAuth scope over the owner's whole Drive.
  //
  // Layout of each tab: A1 'takenAt', B1 the epoch integer, then one row per
  // guild from row 2 - guid in A, team in B.
  var BASELINE_TAB = { na: 'baseline-na', eu: 'baseline-eu' };

  // One relink cycle is a month. A baseline older than this means a whole
  // window was missed and the table has come back two relinks behind, which
  // reads as a relink. Refuse, retake. Must agree with MAX_GAP_SECONDS in
  // scripts/check-notice.py.
  var BASELINE_MAX_AGE_SECONDS = 45 * 24 * 60 * 60;

  var GUID_RE = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
  var TEAM_RE = /^[0-9]{5}$/;
  var STATE_RE = /^(\d{1,12}):(\d{1,12})$/;

  // Quiet for a hiccup, loud for a real outage, never loud on every tick:
  // Apps Script emails on every uncaught exception, and a trigger that throws
  // for hours is one Google may disable, which would take the notice away
  // silently. At fifteen minutes a tick, the first email comes after about an
  // hour (4 ticks), then a reminder about every six hours (24).
  var ALARM_AFTER = 4;
  var ALARM_EVERY = 24;

  // Per request, against the 360 s default; see getAll().
  var TIMEOUT_SECONDS = 20;

  var INGEST = 'https://wvwrelink.com';
  var INGEST_PATH = '/api/ingest/relink';


  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }


  /**
   * Records a failure, and throws only at the thresholds above.
   * Throwing is the only way this script can reach anybody: nobody watches the
   * execution log.
   */
  function fail(message) {
    var props = PropertiesService.getScriptProperties();
    var n = num(props.getProperty('fails')) + 1;
    props.setProperty('fails', String(n));
    Logger.log('failure ' + n + ': ' + message);
    if (n === ALARM_AFTER
        || (n > ALARM_AFTER && (n - ALARM_AFTER) % ALARM_EVERY === 0)) {
      throw new Error('teams notice: ' + n + ' failed ticks (~'
        + (n * 15) + ' min): ' + message);
    }
  }


  /** A tick that got as far as it meant to. Clears the failure streak. */
  function healthy() {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('fails')) props.deleteProperty('fails');
  }


  /**
   * GETs in parallel, with retries, returning one body per url or null.
   *
   * Only the ones that failed are asked again. fetchAll throws when any request
   * in it fails below HTTP - a timeout, a dropped connection - so a throw
   * counts against all of them.
   *
   * The timeout bounds a tick: without it a hung request waits the 360 s
   * default, the whole execution. Worst case is 3 x 20 s + 2 x 5 s per call,
   * two calls a tick.
   */
  function getAll(urls) {
    var bodies = urls.map(function () { return null; });
    for (var attempt = 0; attempt < 3; attempt++) {
      var pending = [];
      for (var i = 0; i < urls.length; i++) if (bodies[i] === null) pending.push(i);
      if (!pending.length) break;
      if (attempt) Utilities.sleep(5000);
      try {
        var res = UrlFetchApp.fetchAll(pending.map(function (k) {
          return {
            url: urls[k],
            muteHttpExceptions: true,
            followRedirects: true,
            timeoutSeconds: TIMEOUT_SECONDS,
            headers: { 'User-Agent': 'wvwrelink-relink-notice' }
          };
        }));
        for (var j = 0; j < pending.length; j++) {
          if (res[j].getResponseCode() === 200) bodies[pending[j]] = res[j].getContentText();
        }
      } catch (e) {
        // fall through to the next attempt
      }
    }
    for (var n = 0; n < urls.length; n++) {
      if (bodies[n] === null) Logger.log('failed: ' + urls[n]);
    }
    return bodies;
  }


  /** A timer endpoint's timestamp for one region, epoch seconds, or null. */
  function timerAt(body, region) {
    if (body === null) return null;
    try {
      var data = JSON.parse(body);
      if (Object.prototype.toString.call(data) === '[object Array]') data = data[0];
      var at = Date.parse(data[region]);
      return isNaN(at) ? null : Math.floor(at / 1000);
    } catch (e) {
      return null;
    }
  }


  /** The NA lockout and teamAssignment timers, fetched together. */
  function timers() {
    var got = getAll([API + '/wvw/timers/lockout', API + '/wvw/timers/teamAssignment']);
    return { lockout: timerAt(got[0], 'na'), assignNa: timerAt(got[1], 'na') };
  }


  /**
   * One region's guild-to-team table, or null if the answer is not one.
   *
   * A truncated read, an error document or a changed shape must never be
   * mistaken for a table in which every guild moved - that reads as a relink
   * and would fire the notice on a bad afternoon.
   */
  function readTable(body) {
    if (body === null) return null;
    var table;
    try {
      table = JSON.parse(body);
    } catch (e) {
      return null;
    }
    if (!table || typeof table !== 'object'
        || Object.prototype.toString.call(table) === '[object Array]') {
      return null;
    }
    var n = 0;
    for (var guid in table) {
      if (!GUID_RE.test(guid)) return null;
      if (!TEAM_RE.test(String(table[guid]))) return null;
      n++;
    }
    return n >= 100 ? table : null;
  }


  /** Both regions' tables, fetched together, keyed by region; null entries failed. */
  function readTables() {
    var got = getAll(REGIONS.map(function (r) { return API + '/wvw/guilds/' + r; }));
    var tables = {};
    for (var i = 0; i < REGIONS.length; i++) tables[REGIONS[i]] = readTable(got[i]);
    return tables;
  }


  /**
   * How many guilds sit on a different team than they do in the baseline.
   *
   * Only this counts: a guild that appeared or vanished since the baseline
   * moves nobody, its members follow it at the next relink.
   */
  function countChanged(before, after) {
    var changed = 0;
    for (var guid in after) {
      var was = before[guid];
      if (was !== undefined && String(was) !== String(after[guid])) changed++;
    }
    return changed;
  }


  function size(obj) {
    var n = 0;
    for (var k in obj) n++;
    return n;
  }


  function book() {
    var doc = SpreadsheetApp.getActiveSpreadsheet();
    if (!doc) {
      throw new Error('No spreadsheet. This script has to be bound to the '
        + 'relink spreadsheet - created from it through Extensions > Apps '
        + 'Script - and not be a standalone project.');
    }
    return doc;
  }


  /**
   * The cell the site reads, creating the tab if it is not there. Created
   * rather than failed on; check-notice.py watches either way.
   *
   * A new spreadsheet's one empty sheet is named by the account's language,
   * and the CSV export serves the FIRST sheet when it cannot find the tab
   * name, so an empty sheet in front of this one would answer the site with
   * nothing. The default sheet is renamed instead; later tabs go at the end.
   */
  function stateTab() {
    var doc = book();
    var tab = doc.getSheetByName(TAB);
    if (!tab) {
      var sheets = doc.getSheets();
      if (sheets.length === 1 && sheets[0].getLastRow() === 0) {
        tab = sheets[0].setName(TAB);
      } else {
        tab = doc.insertSheet(TAB, doc.getNumSheets());
      }
    }
    return tab;
  }


  function cell() {
    return stateTab().getRange('A1');
  }


  /**
   * Stamps the heartbeat, and never lets its own failure end the tick.
   *
   * A failed write means the document is unreachable, which the work below
   * discovers and reports through fail(); throwing here would replace that
   * report. A missed stamp is also the right outcome: check-notice.py should
   * see a stale heartbeat when the sheet cannot be written.
   */
  function beat(now) {
    try {
      var target = stateTab().getRange('A2');
      target.setNumberFormat('@');
      target.setValue(String(Math.floor(now)));
    } catch (e) {
      Logger.log('heartbeat not stamped: ' + e);
    }
  }


  /** The cell the site reads, as { window: n, published: n }, or null. */
  function readState() {
    var found = STATE_RE.exec(String(cell().getValue() || ''));
    if (!found) return null;
    return { window: Number(found[1]), published: Number(found[2]) };
  }


  /**
   * Writes the cell the site reads, and nothing but two integers into it.
   * Nothing from the API has a path into this cell.
   */
  function writeState(window, published) {
    window = Math.floor(Number(window));
    published = Math.floor(Number(published));
    if (!(window >= 0) || !(published >= 0)) {
      throw new Error('relink state takes non-negative integers only');
    }
    var text = window + ':' + published;
    if (!STATE_RE.test(text)) {
      throw new Error('generated relink state did not read back as itself');
    }
    var target = cell();
    target.setNumberFormat('@');
    target.setValue(text);
  }


  /** One region's baseline tab, created at the end of the book if missing. */
  function baselineTab(region) {
    var doc = book();
    var tab = doc.getSheetByName(BASELINE_TAB[region]);
    if (!tab) tab = doc.insertSheet(BASELINE_TAB[region], doc.getNumSheets());
    return tab;
  }


  /** The rolling baseline for one region, as { takenAt, guilds }, or null. */
  function readBaseline(region) {
    var rows;
    try {
      rows = baselineTab(region).getDataRange().getValues();
    } catch (e) {
      return null;
    }
    // Row 1 is the timestamp, and at least a hundred guilds have to follow it
    // or this is not a baseline - the same floor as readTable.
    if (!rows || rows.length < 101 || String(rows[0][0]) !== 'takenAt') {
      return null;
    }
    var takenAt = Number(rows[0][1]);
    if (!(takenAt > 0)) return null;

    var guilds = {};
    for (var i = 1; i < rows.length; i++) {
      var guid = String(rows[i][0]);
      var team = String(rows[i][1]);
      if (!GUID_RE.test(guid) || !TEAM_RE.test(team)) return null;
      guilds[guid] = team;
    }
    return { takenAt: takenAt, guilds: guilds };
  }


  function writeBaseline(region, takenAt, table) {
    // Rebuilt key by key from values that already passed readTable, so what
    // lands in the sheet is this script's own data and not the API's.
    var rows = [['takenAt', takenAt]];
    for (var guid in table) rows.push([String(guid), String(table[guid])]);

    var tab = baselineTab(region);
    // Cleared first: last month's table is longer or shorter than this one, and
    // leftover rows below the new data would be read back as part of it.
    tab.clear();

    // getRange does not grow the sheet, and a new spreadsheet has a thousand
    // rows against the ten thousand this needs, so without this the first write
    // throws. The spare hundred saves a second call when the table gains guilds.
    var need = rows.length - tab.getMaxRows();
    if (need > 0) tab.insertRowsAfter(tab.getMaxRows(), need + 100);

    // One call, not ten thousand. Written as plain text so a five-digit team id
    // is never reinterpreted as a number and read back in some other shape.
    var range = tab.getRange(1, 1, rows.length, 2);
    range.setNumberFormat('@');
    range.setValues(rows);
  }


  function tick() {
    var now = Math.floor(Date.now() / 1000);

    // Before anything that can return or throw: the one line that proves the
    // trigger is alive on the days a working tick does nothing else.
    beat(now);

    var t = timers();
    var lockout = t.lockout;
    var assignNa = t.assignNa;
    if (lockout === null || assignNa === null) {
      fail('the wvw timers did not answer');
      return;
    }

    // Same window as `rebuilding` in js/relink.js: it opens when the lockout
    // closes and closes when NA - the later region - lands.
    if (lockout > now || assignNa <= now) {
      healthy();
      Logger.log('outside the window; nothing to do');
      return;
    }

    var tables = readTables();
    for (var i = 0; i < REGIONS.length; i++) {
      if (tables[REGIONS[i]] === null) {
        // A garbled read looks exactly like every guild having moved, so it is
        // never compared against.
        fail(REGIONS[i] + ': the guild table came back a shape this does not '
          + 'recognise');
        return;
      }
    }
    healthy();

    var state = readState();
    if (state && state.window === assignNa && state.published > 0) {
      Logger.log('already published at ' + state.published);
      return;
    }

    var moved = true;
    var oldest = now;
    for (var j = 0; j < REGIONS.length; j++) {
      var region = REGIONS[j];
      var baseline = readBaseline(region);
      if (baseline === null) {
        Logger.log(region + ': no baseline; taking one and staying dark');
        writeBaseline(region, now, tables[region]);
        moved = false;
        continue;
      }
      oldest = Math.min(oldest, baseline.takenAt);
      var changed = countChanged(baseline.guilds, tables[region]);
      var limit = Math.max(1, Math.floor(size(baseline.guilds) * THRESHOLD_FRACTION));
      Logger.log(region + ': changed ' + changed + ' of threshold ' + limit);
      if (changed < limit) moved = false;
    }

    if (now - oldest > BASELINE_MAX_AGE_SECONDS) {
      // Two relinks behind: this month's ordinary table would read as
      // thousands of guilds having moved and light the notice. Retake and stay
      // dark.
      var days = Math.floor((now - oldest) / 86400);
      for (var k = 0; k < REGIONS.length; k++) {
        writeBaseline(REGIONS[k], now, tables[REGIONS[k]]);
      }
      writeState(assignNa, 0);
      // Repaired first, then reported, so the throw cannot leave it broken.
      // Thrown rather than logged because this costs a month of the feature
      // and somebody has to know why.
      throw new Error('teams notice: the baseline was ' + days + ' days old, '
        + 'more than one relink cycle, so a whole window was missed. A fresh '
        + 'one has been taken: there will be no notice this month and the next '
        + 'window works normally. Check whether this trigger was disabled.');
    }

    if (!moved) {
      // Both regions or neither: somebody whose guild is in the region that
      // has not moved yet would follow the notice to the old answer.
      //
      // Written only when it would change something, to keep the document's
      // revision history free of noise.
      if (!state || state.window !== assignNa || state.published !== 0) {
        writeState(assignNa, 0);
      }
      return;
    }

    // The one write of the month that matters, and both halves belong together:
    // the notice goes on, and the table that turned it on becomes the baseline.
    writeState(assignNa, now);
    for (var m = 0; m < REGIONS.length; m++) {
      writeBaseline(REGIONS[m], now, tables[REGIONS[m]]);
    }
    Logger.log('both regions moved; notice on for window ' + assignNa);
  }


  function setup() {
    stateTab();
    var now = Math.floor(Date.now() / 1000);
    var assignNa = timers().assignNa;
    if (assignNa === null) throw new Error('teamAssignment unreadable');

    var tables = readTables();
    for (var i = 0; i < REGIONS.length; i++) {
      var table = tables[REGIONS[i]];
      if (table === null) throw new Error(REGIONS[i] + ': unusable read');
      writeBaseline(REGIONS[i], now, table);
      Logger.log(REGIONS[i] + ': baseline taken, ' + size(table) + ' guilds');
    }
    writeState(assignNa, 0);
    Logger.log('state written: ' + assignNa + ':0');
    Logger.log('The cell ' + TAB + '!A1 should now read "' + assignNa + ':0".');
  }


  function hex(bytes) {
    return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  }


  /**
   * Sends A1 and A2, as they stand after the tick, with the failure streak.
   *
   * Runs after every tick, including one that threw, and never throws itself:
   * the tick's exception is the one worth an email, and a failed push is sent
   * again fifteen minutes later with newer values. Whoever watches for pushes
   * stopping is outside this script: the Worker's health route.
   */
  function push() {
    try {
      var props = PropertiesService.getScriptProperties();
      var secret = props.getProperty('ingest');
      if (!secret) return;
      var v = stateTab().getRange('A1:A2').getDisplayValues();
      var found = STATE_RE.exec(String(v[0][0]));
      var body = JSON.stringify({
        beat: num(v[1][0]),
        window: found ? Number(found[1]) : null,
        published: found ? Number(found[2]) : null,
        fails: num(props.getProperty('fails'))
      });
      var t = Math.floor(Date.now() / 1000);
      var sig = hex(Utilities.computeHmacSha256Signature(
        Utilities.newBlob(t + '\n' + INGEST_PATH + '\n' + body).getBytes(),
        Utilities.newBlob(secret).getBytes()));
      var res = UrlFetchApp.fetch(INGEST + INGEST_PATH, {
        method: 'post',
        contentType: 'application/json',
        payload: body,
        headers: { 'x-wvw-time': String(t), 'x-wvw-sig': sig },
        muteHttpExceptions: true,
        followRedirects: false,
        timeoutSeconds: TIMEOUT_SECONDS
      });
      if (res.getResponseCode() !== 200) Logger.log('push: HTTP ' + res.getResponseCode());
    } catch (e) {
      Logger.log('push: ' + e);
    }
  }


  function secret() {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('ingest')) {
      Logger.log('A secret already exists. Delete the "ingest" script property '
        + 'first to replace it.');
      return;
    }
    // getUuid is java.util.UUID.randomUUID, a cryptographically strong
    // generator: four of them, hashed into 512 bits.
    var bytes = [];
    for (var i = 0; i < 2; i++) {
      bytes = bytes.concat(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
        Utilities.getUuid() + Utilities.getUuid() + Date.now()));
    }
    var value = hex(bytes);
    props.setProperty('ingest', value);
    Logger.log('Paste this into the Worker secret INGEST_RELINK, and nowhere else:');
    Logger.log(value);
  }


  return { tick: tick, setup: setup, push: push, secret: secret };
})();
