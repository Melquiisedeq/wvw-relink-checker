// apps-script/kills/kills.gs in a node:vm, its requests handed to the real Worker (worker/index.mjs) over the
// fake D1: what the script signs the Worker accepts, and the rows reach /api/kills. The GW2 API is a function
// the test writes; the Worker's answer to a push is the real one unless the test forces a status.
// Run: node --test "tests/unit/**/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readScript, loadScript, fakeClock, fakeProps, fakeLogger, fakeUtilities, fakeLock, fakeSheet, fakeSpreadsheetApp, deliverer, httpResponse } from './harness.mjs';
import { KILLS_KEY, NA_WEEK, setup } from '../worker/harness.mjs';
import { signHeaders } from '../../worker-fakes/signed.mjs';

const src = readScript('kills/kills.gs');
const MAPS = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];
const MIN = 60e3;
const T0 = Date.parse('2026-09-30T12:00:00Z');
const PREV_WEEK = NA_WEEK - 7 * 86400e3;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const plain = (x) => JSON.parse(JSON.stringify(x));

// One match of the API: kills per map, [center, red, blue, green] (all of them on the red team), and the scores.
function match(id, { kills = [10, 20, 30, 40], scores = [1000, 2000, 3000], start = NA_WEEK, maps } = {}) {
  return {
    id, start_time: iso(start), scores: { red: scores[0], blue: scores[1], green: scores[2] },
    maps: maps || MAPS.map((type, i) => ({ type, kills: { red: kills[i], blue: 0, green: 0 }, deaths: { red: 0, blue: 0, green: 0 } }))
  };
}

// The script, its Google services, and a Worker behind its UrlFetchApp.fetch.
// serve(): what the API answers each read of the pair; force(): what a push gets instead of the Worker's answer (a status, or an Error to throw).
function rig({ props = { ingest: KILLS_KEY }, sheet = fakeSheet('kills'), lockFree = true } = {}) {
  const clock = fakeClock(T0);
  const w = setup();
  const p = fakeProps(props);
  const log = fakeLogger();
  const utils = fakeUtilities();
  const lock = fakeLock({ free: lockFree });
  const app = fakeSpreadsheetApp([sheet]);
  const r = {
    clock, w, props: p, log, utils, sheet, lock: lock.lock, reads: [], pushes: [], forced: [], bodies: [],
    // What the API serves, next tick on: one body per read of the pair, or one for both.
    serve(...bodies) { r.bodies = bodies; },
    // The status the next pushes get instead of the Worker's.
    force(...codes) { r.forced.push(...codes); }
  };
  r.ctx = loadScript(src, {
    Date: clock.Date, JSON, Math, Error, Number, String, Array, Object, isFinite,
    Logger: log, Utilities: utils, PropertiesService: { getScriptProperties: () => p },
    LockService: lock, SpreadsheetApp: app,
    UrlFetchApp: {
      fetchAll(reqs) {
        r.reads.push(reqs.length);
        return reqs.map((q, k) => {
          const b = r.bodies.length > 1 ? r.bodies[k] : r.bodies[0];
          if (b instanceof Error) throw b;
          if (b && b.code) return httpResponse(b.code, b.text ?? '');
          return httpResponse(200, b === undefined ? '[]' : b);
        });
      },
      fetch(url, opt) {
        const f = r.forced.length ? r.forced.shift() : null;
        r.pushes.push({ at: clock.now, url, opt: plain(opt), code: f instanceof Error ? 'threw' : f });
        if (f instanceof Error) throw f;
        return httpResponse(f ?? 200);
      }
    }
  }, '({ snapshot, killsSecret })');
  r.tick = (...bodies) => { if (bodies.length) r.serve(...bodies); r.ctx.out.snapshot(); };
  r.deliver = deliverer(w, r.pushes);
  r.sent = (i) => JSON.parse(r.pushes[i].opt.payload).rows;
  r.saved = () => JSON.parse(p.getProperty('scores') || '{}');
  return r;
}

test('a tick writes the sheet and sends the same rows, signed, to the ingest route', () => {
  const r = rig();
  r.tick([match('1-1'), match('1-2', { kills: [1, 2, 3, 4] })]);
  assert.equal(r.sheet.data.length, 2);
  assert.deepEqual(plain(r.sheet.data[0]), [T0, '1-1', 10, 20, 30, 40, NA_WEEK, 6000]);
  assert.equal(r.pushes.length, 1);
  assert.equal(r.pushes[0].url, 'https://wvwrelink.com/api/ingest/kills');
  assert.equal(r.pushes[0].opt.method, 'post');
  assert.equal(r.pushes[0].opt.followRedirects, false);
  assert.deepEqual(r.sent(0), plain(r.sheet.data));
  assert.equal(r.lock.held, false, 'the lock is released');
});

test('what the script signs the Worker accepts, and the rows are served by /api/kills', async () => {
  const r = rig();
  r.tick([match('1-1'), match('1-2', { kills: [1, 2, 3, 4] })]);
  assert.deepEqual(await r.deliver(), [200]);
  const got = JSON.parse((await r.w.get('/api/kills')).body).rows;
  assert.deepEqual(got.sort((a, b) => (a[1] < b[1] ? -1 : 1)), [[T0, '1-1', 10, 20, 30, 40], [T0, '1-2', 1, 2, 3, 4]]);
  assert.equal(r.props.getProperty('pending'), null);
  // Five minutes on, the scores risen: signed at a later second, accepted again.
  r.clock.advance(5 * MIN);
  r.tick([match('1-1', { scores: [1100, 2000, 3000], kills: [11, 20, 30, 40] })]);
  assert.deepEqual(await r.deliver(), [200]);
  assert.equal(r.sent(1).length, 1);
});

test('a message signed over another path, or with another key, is refused by the Worker', async () => {
  const r = rig({ props: { ingest: 'x'.repeat(128) } });
  r.tick([match('1-1')]);
  assert.deepEqual(await r.deliver(), [401]);
  // The same body, signed for another path.
  const ok = rig();
  ok.tick([match('1-1')]);
  const push = ok.pushes[0];
  ok.w.advance(push.at - ok.w.now);
  const headers = signHeaders(KILLS_KEY, push.opt.headers['x-wvw-time'], '/api/ingest/relink', push.opt.payload);
  const res = await ok.w.fetch(new Request(push.url, { method: 'POST', body: push.opt.payload, headers }));
  assert.equal(res.status, 401);
});

test('without the ingest secret the sheet is written and nothing is sent', () => {
  const r = rig({ props: {} });
  r.tick([match('1-1')]);
  assert.equal(r.sheet.data.length, 1);
  assert.equal(r.pushes.length, 0);
  assert.equal(r.props.getProperty('pending'), null);
});

test('killsSecret() makes a 128-hex secret once and logs it; a second run keeps the first', () => {
  const r = rig({ props: {} });
  r.ctx.out.killsSecret();
  const secret = r.props.getProperty('ingest');
  assert.match(secret, /^[0-9a-f]{128}$/);
  assert.ok(r.log.lines.includes(secret));
  r.ctx.out.killsSecret();
  assert.equal(r.props.getProperty('ingest'), secret);
  assert.match(r.log.lines.at(-1), /already exists/);
});

test('a score that did not rise writes nothing and sends nothing; one that rose does', () => {
  const r = rig();
  r.tick([match('1-1')]);
  r.clock.advance(5 * MIN);
  r.tick([match('1-1', { kills: [99, 99, 99, 99] })]);
  assert.equal(r.sheet.data.length, 1);
  assert.equal(r.pushes.length, 1);
  assert.deepEqual(r.saved(), { '1-1': [6000, NA_WEEK] });
  r.clock.advance(5 * MIN);
  r.tick([match('1-1', { scores: [1001, 2000, 3000] })]);
  assert.equal(r.sheet.data.length, 2);
  assert.deepEqual(r.saved(), { '1-1': [6001, NA_WEEK] });
});

test('a new start_time counts even when the score is lower, and its kills stand', () => {
  const r = rig();
  r.tick([match('1-1', { start: PREV_WEEK, scores: [5000, 5000, 5000], kills: [900, 900, 900, 900] })]);
  r.clock.advance(5 * MIN);
  r.tick([match('1-1', { scores: [10, 10, 10], kills: [5, 5, 5, 5] })]);
  assert.deepEqual(plain(r.sheet.data[1]).slice(2), [5, 5, 5, 5, NA_WEEK, 30]);
});

test('of the two bodies read the newer wins, in either order: start, then score sum, then kills and deaths', () => {
  const a = match('1-1', { start: PREV_WEEK, scores: [9000, 9000, 9000], kills: [500, 500, 500, 500] });
  const b = match('1-1', { kills: [1, 1, 1, 1], scores: [1, 1, 1] });
  for (const order of [[a, b], [b, a]]) {
    const r = rig();
    r.tick([order[0]], [order[1]]);
    assert.deepEqual(plain(r.sheet.data[0]).slice(2), [1, 1, 1, 1, NA_WEEK, 3], 'the newer week, whatever its score');
  }
  const low = match('1-1', { scores: [1, 1, 1] }), high = match('1-1', { scores: [2, 2, 2], kills: [3, 3, 3, 3] });
  for (const order of [[low, high], [high, low]]) {
    const r = rig();
    r.tick([order[0]], [order[1]]);
    assert.equal(r.sheet.data[0][7], 6, 'the higher score sum');
    assert.equal(r.sheet.data[0][2], 3);
  }
  // Same start and sum: the one with more kills and deaths; on a full tie the first read stays.
  const few = match('1-1'), many = match('1-1', { maps: match('1-1', { kills: [11, 20, 30, 40] }).maps });
  for (const order of [[few, many], [many, few]]) {
    const r = rig();
    r.tick([order[0]], [order[1]]);
    assert.equal(r.sheet.data[0][2], 11);
  }
});

test('one failed read of the pair is not a failed tick; both failing is', () => {
  const r = rig();
  r.tick({ code: 500 }, [match('1-1')]);
  assert.equal(r.sheet.data.length, 1);
  assert.equal(r.reads.length, 1);
  const f = rig();
  f.tick({ code: 503 });
  assert.equal(f.sheet.data.length, 0);
  assert.equal(f.reads.length, 2, 'two rounds');
  assert.deepEqual(f.utils.sleeps, [2000]);
  assert.equal(f.props.getProperty('fails'), '1');
  f.tick([match('1-1')]);
  assert.equal(f.props.getProperty('fails'), null, 'a good tick clears the count');
});

test('a body that is not JSON, or throws, counts as a failed read', () => {
  const r = rig();
  r.tick('not json', new Error('timeout'));
  assert.equal(r.sheet.data.length, 0);
  assert.equal(r.props.getProperty('fails'), '1');
});

test('matches the script cannot trust are left out: no start, no maps, odd scores, null entries', () => {
  const r = rig();
  const noStart = match('1-1'); delete noStart.start_time;
  const noMaps = match('1-2'); delete noMaps.maps;
  const oddScore = match('1-3'); oddScore.scores.red = 'x';
  const noScores = match('1-4'); delete noScores.scores;
  r.tick([null, 7, noStart, noMaps, oddScore, noScores, { ...match('1-5'), id: 15 }, match('1-5', { kills: [1, 2, 3, 4] })]);
  assert.deepEqual(plain(r.sheet.data).map((x) => x[1]), ['1-5']);
  const none = rig();
  none.tick([noStart], { not: 'an array' });
  assert.equal(none.props.getProperty('fails'), '1');
  assert.equal(none.sheet.data.length, 0);
  assert.equal(none.pushes.length, 0);
});

test('a match with maps missing or odd gets no row, and the others do', () => {
  const r = rig();
  const three = match('1-1'); three.maps = three.maps.slice(1);
  const unknown = match('1-2'); unknown.maps[0].type = 'EternalBattlegrounds';
  const empty = match('1-3', { maps: [] });
  const nulls = match('1-4', { maps: [null, ...match('1-4').maps] });
  r.tick([three, unknown, empty, nulls, match('1-5')]);
  assert.deepEqual(plain(r.sheet.data).map((x) => x[1]), ['1-4', '1-5']);
  assert.deepEqual(r.saved()['1-1'], undefined);
  // Kills that are not numbers count as none.
  const odd = match('1-6'); odd.maps[1].kills = { red: 'x', blue: null };
  const r2 = rig();
  r2.tick([odd]);
  assert.deepEqual(plain(r2.sheet.data[0]).slice(2, 6), [10, 0, 30, 40]);
});

test('a drop in kills: small is a lagging node and the old number stays, a big one is the reset', () => {
  const r = rig();
  r.tick([match('1-1', { kills: [1000, 1000, 1000, 1000] })]);
  r.clock.advance(5 * MIN);
  r.tick([match('1-1', { scores: [1100, 2000, 3000], kills: [600, 400, 1500, 500] })]);
  assert.deepEqual(plain(r.sheet.data[1]).slice(2, 6), [1000, 400, 1500, 1000]);
});

test('a body of a week before the last row of the sheet gives no row', () => {
  const r = rig();
  r.tick([match('1-1')]);
  r.props.deleteProperty('scores');
  r.clock.advance(5 * MIN);
  r.tick([match('1-1', { start: PREV_WEEK, scores: [9000, 9000, 9000] })]);
  assert.equal(r.sheet.data.length, 1);
  assert.equal(r.pushes.length, 1);
});

test('the sheet keeps two hours, never deletes what was just written, and grows when it is full', () => {
  const old = [T0 - 3 * 3600e3, T0 - 121 * MIN, T0 - 119 * MIN, T0 - MIN].map((at, i) => [at, 'x' + i, 1, 1, 1, 1, NA_WEEK, 1]);
  const r = rig({ sheet: fakeSheet('kills', { rows: old, maxRows: 4 }) });
  r.tick([match('1-1')]);
  assert.deepEqual(plain(r.sheet.data).map((x) => x[1]), ['x2', 'x3', '1-1']);
  const stale = rig({ sheet: fakeSheet('kills', { rows: old.slice(0, 2).map((x) => [x[0] - 4 * 3600e3, ...x.slice(1)]) }) });
  stale.tick([match('1-1')]);
  assert.deepEqual(plain(stale.sheet.data).map((x) => x[1]), ['1-1']);
});

test('a sheet that is missing is made, and one with too few columns is widened', () => {
  const r = rig({ sheet: fakeSheet('kills', { maxColumns: 6 }) });
  r.tick([match('1-1')]);
  assert.equal(r.sheet.maxColumns, 8);
  assert.equal(r.sheet.data.length, 1);
  const bare = rig();
  bare.ctx.SpreadsheetApp.getActive().sheets.length = 0;
  bare.tick([match('1-1')]);
  assert.equal(bare.ctx.SpreadsheetApp.getActive().sheets[0].name, 'kills');
});

test('a tick that cannot take the lock does nothing', () => {
  const r = rig({ lockFree: false });
  r.tick([match('1-1')]);
  assert.equal(r.reads.length, 0);
  assert.equal(r.sheet.data.length, 0);
});

test('the first alarm is on the sixth failed tick, the next 72 ticks later, and none between', () => {
  const r = rig();
  r.serve({ code: 500 });
  const thrown = [];
  for (let n = 1; n <= 6 + 72; n++) {
    try { r.ctx.out.snapshot(); } catch (e) { thrown.push(n); }
  }
  assert.deepEqual(thrown, [6, 78]);
  assert.equal(r.props.getProperty('fails'), '78');
});

test('a refused push keeps the rows, the next tick sends them again, and the Worker takes them', async () => {
  const r = rig();
  r.force(500);
  r.tick([match('1-1')]);
  assert.equal(r.pushes.length, 1);
  assert.match(r.log.lines.at(-1), /HTTP 500/);
  assert.deepEqual(JSON.parse(r.props.getProperty('pending')), r.sent(0));
  assert.equal(r.sheet.data.length, 1, 'the sheet is written anyway');
  // Nothing moved on the next tick, and the owed rows still go.
  r.clock.advance(5 * MIN);
  r.tick();
  assert.equal(r.pushes.length, 2);
  assert.deepEqual(r.sent(1), r.sent(0));
  assert.deepEqual(await r.deliver(), [200]);
  assert.equal(r.props.getProperty('pending'), null);
  assert.deepEqual(JSON.parse((await r.w.get('/api/kills')).body).rows, [[T0, '1-1', 10, 20, 30, 40]]);
});

test('a push that throws is logged, not thrown, and kept for the next tick', () => {
  const r = rig();
  r.force(new Error('timeout'));
  assert.doesNotThrow(() => r.tick([match('1-1')]));
  assert.match(r.log.lines.at(-1), /^push: Error: timeout/);
  assert.deepEqual(JSON.parse(r.props.getProperty('pending')), r.sent(0));
  r.clock.advance(5 * MIN);
  r.tick();
  assert.deepEqual(r.sent(1), r.sent(0));
  assert.equal(r.props.getProperty('pending'), null);
});

test('a push answered with any code but 200 is kept; a lost one is sent with the next ones', () => {
  const r = rig();
  r.force(302);
  r.tick([match('1-1')]);
  assert.ok(r.props.getProperty('pending'));
  r.clock.advance(5 * MIN);
  r.tick([match('1-1', { scores: [1100, 2000, 3000] })]);
  assert.equal(r.sent(1).length, 2, 'the old row and the new one');
  assert.equal(r.props.getProperty('pending'), null);
});

test('owed rows older than 30 minutes are dropped, younger ones sent', () => {
  const r = rig();
  r.force(500, 500);
  r.tick([match('1-1')]);
  r.clock.advance(25 * MIN);
  r.tick([match('1-1', { scores: [1100, 2000, 3000] })]);
  assert.equal(r.sent(1).length, 2, 'at 25 minutes the first is still owed');
  r.clock.advance(31 * MIN);
  r.tick([match('1-1', { scores: [1200, 2000, 3000] })]);
  assert.deepEqual(r.sent(2).map((x) => x[0]), [r.clock.now], 'both older rows are past 30 minutes');
});

test('owed rows are cut from the oldest to fit a script property, the new rows always going', () => {
  const owed = Array.from({ length: 300 }, (_, i) => [T0 - MIN, '1-1', i, 1, 1, 1, NA_WEEK, 1]);
  const r = rig({ props: { ingest: KILLS_KEY, pending: JSON.stringify(owed) } });
  r.tick([match('1-1')]);
  const sent = r.sent(0);
  assert.ok(JSON.stringify(sent).length <= 8000);
  assert.ok(sent.length > 1 && sent.length < 301);
  assert.equal(sent.at(-1)[1], '1-1');
  assert.equal(sent.at(-1)[2], 10, 'the new row is last');
  assert.equal(sent.at(-2)[2], 299, 'the youngest owed row stays');
});

test('a row owed for 30 minutes, the oldest the script still sends, is taken by the Worker', async () => {
  const r = rig();
  r.force(500);
  r.tick([match('1-1')]);
  r.clock.advance(30 * MIN);
  r.tick();
  assert.deepEqual(r.sent(1), r.sent(0));
  assert.deepEqual(await r.deliver(), [200]);
  assert.equal(JSON.parse((await r.w.get('/api/kills')).body).rows.length, 1);
});
