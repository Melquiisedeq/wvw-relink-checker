// The Apps Script apps-script/relink-notice/relink-notice.gs in a node:vm. setup() against a fake spreadsheet:
// the state tab must come first, because the CSV export serves the first sheet when the named one is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readScript, loadScript, fakeProps, fakeLogger, fakeUtilities, httpResponse, fakeClock, fakeLock, fakeSheet, fakeSpreadsheetApp, deliverer } from './apps-script-harness.mjs';

import { RELINK_KEY, setup } from './worker-harness.mjs';
import { signHeaders } from '../worker-fakes/signed.mjs';

const src = readScript('relink-notice/relink-notice.gs');

const range = () => ({ setNumberFormat() { return this; }, setValues() { return this; }, setValue() { return this; }, getDisplayValues: () => [['', ''], ['', '']] });
const sheet = (name, rows = 0) => ({ name, rows, setName(n) { this.name = n; return this; }, getLastRow() { return this.rows; }, getMaxRows: () => 1000,
  insertRowsAfter() {}, clear() {}, getRange() { this.rows = Math.max(this.rows, 1); return range(); } });

const table = JSON.stringify(Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`${String(i).padStart(8, '0')}-AAAA-BBBB-CCCC-DDDDDDDDDDDD`, '11005'])));
const res = body => httpResponse(200, body);

function tabsAfterSetup(sheets) {
  const doc = { getSheetByName: n => sheets.find(s => s.name === n) || null, getSheets: () => sheets.slice(), getNumSheets: () => sheets.length,
    insertSheet(n, i) { const s = sheet(n); sheets.splice(i, 0, s); return s; } };
  const ctx = loadScript(src, {
    SpreadsheetApp: { getActiveSpreadsheet: () => doc },
    UrlFetchApp: { fetchAll: reqs => reqs.map(r => res(/timers/.test(r.url) ? JSON.stringify({ na: '2026-11-03T07:59:00Z', eu: '2026-11-03T07:59:00Z' }) : table)) },
    Utilities: fakeUtilities(), Logger: fakeLogger(),
    PropertiesService: { getScriptProperties: () => fakeProps() },
  }, 'RelinkNotice_');
  ctx.out.setup();
  return sheets.map(s => s.name);
}

test('setup() on a new spreadsheet renames the empty default tab to relink, in front of the baselines', () => {
  assert.deepEqual(tabsAfterSetup([sheet('Sheet1')]), ['relink', 'baseline-na', 'baseline-eu']);
});

test('setup() on a spreadsheet that already has relink leaves it where it is', () => {
  assert.deepEqual(tabsAfterSetup([sheet('notes', 3), sheet('relink', 1)]), ['notes', 'relink', 'baseline-na', 'baseline-eu']);
});

// relinkTick() whole: the lock, tick() and the push() in the finally, against a fake spreadsheet and a fake GW2 API,
// each push handed to the real Worker. The clock of each case comes from the notice's rules: the window opens when the
// lockout closes and closes when NA, the later region, lands (the lockout and the NA assignment are 48 hours apart here).

const ASSIGN = Date.parse('2026-11-03T02:00:00Z') / 1000;
const LOCKOUT = ASSIGN - 48 * 3600;
const INSIDE = LOCKOUT + 3600;
const DAY = 86400;
const iso = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const guid = (i) => `${String(i).padStart(8, '0')}-AAAA-BBBB-CCCC-DDDDDDDDDDDD`;
// n guilds on team 11005, the first `moved` of them on 11006.
const guilds = (n = 300, moved = 0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [guid(i), i < moved ? '11006' : '11005']));
const rowsOf = (table, takenAt) => [['takenAt', takenAt], ...Object.entries(table)];

// The script, its Google, and a GW2 API the test writes: api.<key> is the body, api.down the keys answering 500,
// api.raw a body as text. Baselines and the state cell are seeded straight into the tabs.
function rig({ now = INSIDE, props = { ingest: RELINK_KEY }, lockFree = true, base = guilds(), live = guilds(), state } = {}) {
  const clock = fakeClock(now * 1000);
  const w = setup();
  const p = fakeProps(props);
  const log = fakeLogger();
  const utils = fakeUtilities();
  const lock = fakeLock({ free: lockFree });
  const tabs = { relink: fakeSheet('relink', { rows: state === undefined ? [] : [[state]] }), na: fakeSheet('baseline-na'), eu: fakeSheet('baseline-eu') };
  const app = fakeSpreadsheetApp([tabs.relink]);
  const r = { clock, w, props: p, log, utils, lock: lock.lock, tabs, reads: [], pushes: [], throwOnPush: null,
    api: { lockout: LOCKOUT, assign: ASSIGN, na: live, eu: live, down: new Set(), raw: {} } };
  r.seed = (region, takenAt, table = base) => { tabs[region].data = rowsOf(table, takenAt); app.doc.sheets.push(tabs[region]); tabs[region].name = 'baseline-' + region; };
  if (base) for (const region of ['na', 'eu']) r.seed(region, now - 6 * 3600);
  r.ctx = loadScript(src, {
    Date: clock.Date, Logger: log, Utilities: utils, PropertiesService: { getScriptProperties: () => p },
    LockService: lock, SpreadsheetApp: app,
    UrlFetchApp: {
      fetchAll: (reqs) => reqs.map(({ url }) => {
        r.reads.push(url);
        const key = /lockout$/.test(url) ? 'lockout' : /teamAssignment$/.test(url) ? 'assign' : url.slice(-2);
        if (r.api.down.has(key)) return httpResponse(500, 'down');
        if (key in r.api.raw) return httpResponse(200, r.api.raw[key]);
        const v = r.api[key];
        return res(typeof v === 'number' ? JSON.stringify({ na: iso(v), eu: iso(v - 8 * 3600) }) : JSON.stringify(v));
      }),
      fetch(url, opt) {
        r.pushes.push({ at: clock.now, url, opt, code: null });
        if (r.throwOnPush) throw r.throwOnPush;
        return httpResponse(r.pushStatus ?? 200);
      }
    }
  }, '({ relinkTick, relinkSetup, relinkSecret })');
  r.tick = () => r.ctx.out.relinkTick();
  r.deliver = deliverer(w, r.pushes);
  r.a1 = () => tabs.relink.data[0]?.[0] ?? '';
  r.a2 = () => tabs.relink.data[1]?.[0] ?? '';
  r.a1Writes = () => tabs.relink.writes.filter((x) => x.r === 1).length;
  r.baseline = (region) => app.doc.getSheetByName('baseline-' + region).data;
  r.sent = (i = -1) => JSON.parse(r.pushes.at(i).opt.payload);
  return r;
}
const guildReads = (r) => r.reads.filter((u) => /guilds/.test(u)).length;

test('the window opens when the lockout closes and shuts when NA lands: outside, only the two timers are read', () => {
  for (const [at, inside] of [[LOCKOUT - 1, false], [LOCKOUT, true], [ASSIGN - 1, true], [ASSIGN, false], [ASSIGN + 1, false]]) {
    const r = rig({ now: at, props: { ingest: RELINK_KEY, fails: '3' } });
    r.tick();
    assert.equal(guildReads(r), inside ? 2 : 0, `at ${at - LOCKOUT} s after the lockout`);
    assert.equal(r.reads.filter((u) => /timers/.test(u)).length, 2);
    assert.equal(r.a2(), String(at), 'the heartbeat is stamped on every tick');
    assert.equal(r.props.getProperty('fails'), null, 'a tick that got where it meant to clears the streak');
    if (!inside) {
      assert.ok(r.log.lines.includes('outside the window; nothing to do'));
      assert.equal(r.a1(), '', 'nothing written to the state cell');
    }
  }
});

test('in the window with nothing moved the cell goes dark once, and is not rewritten on the next tick', () => {
  const r = rig();
  r.tick();
  assert.equal(r.a1(), `${ASSIGN}:0`);
  assert.equal(r.tabs.na.writes.length + r.tabs.eu.writes.length, 0, 'the baselines are left alone');
  assert.equal(r.a1Writes(), 1);
  r.clock.advance(5 * 60e3);
  r.tick();
  assert.equal(r.a1Writes(), 1, 'already dark: written only when it would change something');
  assert.equal(r.a2(), String(INSIDE + 300));
  // Last month's cell is replaced, and a cell that is not two integers too.
  for (const old of [`${ASSIGN - 30 * DAY}:${ASSIGN - 29 * DAY}`, 'not a state']) {
    const o = rig({ state: old });
    o.tick();
    assert.equal(o.a1(), `${ASSIGN}:0`, old);
  }
});

test('both regions moved: the notice goes on, the new tables become the baselines, the Worker serves it', async () => {
  const live = guilds(300, 300);
  const r = rig({ live });
  r.tick();
  assert.equal(r.a1(), `${ASSIGN}:${INSIDE}`);
  for (const region of ['na', 'eu']) {
    assert.deepEqual(r.baseline(region), rowsOf(live, INSIDE), region);
    assert.equal(r.tabs[region].data[0][1], INSIDE);
  }
  assert.ok(r.log.lines.includes(`both regions moved; notice on for window ${ASSIGN}`));
  assert.deepEqual(r.sent(), { beat: INSIDE, window: ASSIGN, published: INSIDE, fails: 0 });
  assert.deepEqual(await r.deliver(), [200]);
  assert.equal((await r.w.get('/api/relink')).body, JSON.stringify({ window: ASSIGN, published: INSIDE }));
  // Five minutes on: already published, the baselines are not compared, nothing rewritten, still served.
  r.clock.advance(5 * 60e3);
  r.api.na = guilds(300, 0);
  r.tick();
  assert.equal(r.a1(), `${ASSIGN}:${INSIDE}`);
  assert.equal(r.a1Writes(), 1);
  assert.ok(r.log.lines.includes(`already published at ${INSIDE}`));
  assert.equal(r.tabs.na.writes.length, 1, 'the baseline is not retaken');
  assert.deepEqual(await r.deliver(), [200]);
  assert.equal((await r.w.get('/api/relink')).body, JSON.stringify({ window: ASSIGN, published: INSIDE }));
});

test('published for another window is compared again', () => {
  const r = rig({ live: guilds(300, 300), state: `${ASSIGN - 30 * DAY}:${ASSIGN - 29 * DAY}` });
  r.tick();
  assert.equal(r.a1(), `${ASSIGN}:${INSIDE}`);
});

test('the limit is 1 % of the baseline, and reaching it counts', () => {
  for (const [moved, published] of [[2, false], [3, true]]) {
    const r = rig({ live: guilds(300, moved) });
    r.tick();
    assert.equal(r.a1(), published ? `${ASSIGN}:${INSIDE}` : `${ASSIGN}:0`, `${moved} of 300`);
  }
  // 120 guilds: 1.2 rounds down to one guild.
  const one = rig({ base: guilds(120), live: guilds(120, 1) });
  one.tick();
  assert.equal(one.a1(), `${ASSIGN}:${INSIDE}`);
  const none = rig({ base: guilds(120), live: guilds(120, 0) });
  none.tick();
  assert.equal(none.a1(), `${ASSIGN}:0`);
});

test('a region that moved alone, either one, does not light the notice', () => {
  for (const moved of ['na', 'eu']) {
    const r = rig();
    r.api[moved] = guilds(300, 300);
    r.tick();
    assert.equal(r.a1(), `${ASSIGN}:0`, moved + ' only');
    assert.equal(r.tabs.na.writes.length + r.tabs.eu.writes.length, 0);
  }
});

test('guilds that appeared or vanished since the baseline move nobody', () => {
  const live = { ...guilds(250, 2), ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [guid(1000 + i), '11009'])) };
  const r = rig({ live });
  r.tick();
  assert.equal(r.a1(), `${ASSIGN}:0`);
  assert.ok(r.log.lines.includes('na: changed 2 of threshold 3'));
});

test('a table that is not a table is never compared: the failure is counted and nothing is written', () => {
  const garbled = {
    array: [], 'an error document': { text: 'too many requests' }, 'under 100 guilds': guilds(99),
    'a guild id that is not one': { ...guilds(120), 'not-a-guid': '11005' }, 'a team that is not a team': { ...guilds(120), [guid(500)]: 'x' }
  };
  for (const region of ['na', 'eu']) {
    for (const [what, body] of Object.entries(garbled)) {
      const r = rig({ live: guilds(300, 300), state: `${ASSIGN - 30 * DAY}:0` });
      r.api[region] = body;
      r.tick();
      assert.equal(r.a1(), `${ASSIGN - 30 * DAY}:0`, `${region}: ${what}`);
      assert.equal(r.props.getProperty('fails'), '1');
      assert.equal(r.tabs.na.writes.length + r.tabs.eu.writes.length, 0);
      assert.match(r.log.lines.join('\n'), new RegExp(`failure 1: ${region}: the guild table came back a shape`));
    }
  }
  // Not JSON, and an answer that is an HTTP error (asked three times, the retries a pause apart).
  const text = rig({ live: guilds(300, 300), state: 'x' });
  text.api.raw.eu = '{"na": ';
  text.tick();
  assert.equal(text.props.getProperty('fails'), '1');
  const down = rig({ live: guilds(300, 300), state: 'x' });
  down.api.down.add('na');
  down.tick();
  assert.equal(down.props.getProperty('fails'), '1');
  assert.deepEqual(down.utils.sleeps, [5000, 5000]);
  assert.equal(down.a1(), 'x');
});

test('timers that do not answer count a failure, read no table, and the twelfth tick throws and still pushes', async () => {
  for (const [how, set] of [['down', (r) => r.api.down.add('assign')], ['not a date', (r) => { r.api.raw.lockout = '{"na":"soon"}'; }]]) {
    const r = rig({ props: { ingest: RELINK_KEY, fails: '4' } });
    set(r);
    r.tick();
    assert.equal(guildReads(r), 0, how);
    assert.equal(r.props.getProperty('fails'), '5');
    assert.equal(r.a2(), String(INSIDE), 'the heartbeat is stamped even so');
    assert.equal(r.sent().fails, 5);
    assert.equal(r.lock.held, false);
  }
  const r = rig({ props: { ingest: RELINK_KEY, fails: '11' } });
  r.api.down.add('lockout');
  assert.throws(() => r.tick(), /teams notice: 12 failed ticks \(~60 min\)/);
  assert.equal(r.lock.held, false, 'the lock is released');
  assert.equal(r.sent().fails, 12, 'the push ran in the finally, after the throw');
  assert.deepEqual(await r.deliver(), [200]);
  assert.equal(JSON.parse((await r.w.get('/api/health')).body).relink, INSIDE);
  // The next reminder comes 72 failures after the first.
  const again = rig({ props: { ingest: RELINK_KEY, fails: '83' } });
  again.api.down.add('lockout');
  assert.throws(() => again.tick(), /84 failed ticks/);
  const quiet = rig({ props: { ingest: RELINK_KEY, fails: '12' } });
  quiet.api.down.add('lockout');
  quiet.tick();
  assert.equal(quiet.props.getProperty('fails'), '13');
});

test('without a baseline one is taken and the cell stays dark', () => {
  for (const missing of [['na', 'eu'], ['na']]) {
    const r = rig({ base: null, live: guilds(300, 300) });
    if (missing.length === 1) r.seed('eu', INSIDE - 3600, guilds());
    r.tick();
    assert.equal(r.a1(), `${ASSIGN}:0`, missing.join());
    assert.deepEqual(r.baseline('na'), rowsOf(guilds(300, 300), INSIDE));
    assert.ok(r.log.lines.includes('na: no baseline; taking one and staying dark'));
    assert.equal(r.log.lines.includes('eu: no baseline; taking one and staying dark'), missing.length === 2);
    if (missing.length === 1) assert.equal(r.baseline('eu')[0][1], INSIDE - 3600, 'the one that was there is left');
  }
});

test('a baseline older than 45 days is retaken, the month stays dark, the tick throws after repairing, and the push still goes', async () => {
  const live = guilds(300, 300);
  for (const old of ['na', 'eu']) {
    const r = rig({ live });
    r.seed(old, INSIDE - 46 * DAY);
    assert.throws(() => r.tick(), /the baseline was 46 days old/);
    assert.equal(r.a1(), `${ASSIGN}:0`, 'dark although both moved');
    for (const region of ['na', 'eu']) assert.deepEqual(r.baseline(region), rowsOf(live, INSIDE), region);
    assert.equal(r.a2(), String(INSIDE));
    assert.equal(r.lock.held, false);
    assert.equal(r.pushes.length, 1);
    assert.deepEqual(r.sent(), { beat: INSIDE, window: ASSIGN, published: 0, fails: 0 });
    assert.deepEqual(await r.deliver(), [200]);
  }
  // 45 days to the second is still a baseline.
  const edge = rig({ live });
  edge.seed('na', INSIDE - 45 * DAY);
  edge.tick();
  assert.equal(edge.a1(), `${ASSIGN}:${INSIDE}`);
});

test('the push is signed over time, path and body: the Worker accepts it, refuses another key, and serves the cell', async () => {
  const r = rig();
  r.tick();
  const push = r.pushes[0];
  assert.equal(push.url, 'https://wvwrelink.com/api/ingest/relink');
  assert.equal(push.opt.method, 'post');
  assert.equal(push.opt.followRedirects, false);
  assert.deepEqual(r.sent(), { beat: INSIDE, window: ASSIGN, published: 0, fails: 0 });
  r.w.advance(push.at - r.w.now);
  const wrong = signHeaders('x'.repeat(128), push.opt.headers['x-wvw-time'], '/api/ingest/relink', push.opt.payload);
  assert.equal((await r.w.fetch(new Request(push.url, { method: 'POST', body: push.opt.payload, headers: wrong }))).status, 401);
  const other = signHeaders(RELINK_KEY, push.opt.headers['x-wvw-time'], '/api/ingest/kills', push.opt.payload);
  assert.equal((await r.w.fetch(new Request(push.url, { method: 'POST', body: push.opt.payload, headers: other }))).status, 401);
  assert.deepEqual(await r.deliver(), [200]);
  assert.equal((await r.w.get('/api/relink')).body, JSON.stringify({ window: ASSIGN, published: 0 }));
  assert.equal(r.w.sql.prepare('SELECT beat, fails FROM relink').get().beat, INSIDE);
});

test('the failure streak reaches the Worker, and a cell that does not parse goes as nulls', async () => {
  const r = rig({ props: { ingest: RELINK_KEY, fails: '2' }, state: 'garbage' });
  r.api.down.add('assign');
  r.tick();
  assert.deepEqual(r.sent(), { beat: INSIDE, window: null, published: null, fails: 3 });
  assert.deepEqual(await r.deliver(), [200]);
  assert.equal(r.w.sql.prepare('SELECT fails FROM relink').get().fails, 3);
  assert.equal((await r.w.get('/api/relink')).status, 503);
});

test('a push that fails is logged and never throws, the tick is not made to fail by it', () => {
  const r = rig();
  r.throwOnPush = new Error('dns');
  r.tick();
  assert.ok(r.log.lines.includes('push: Error: dns'));
  assert.equal(r.lock.held, false);
  const s = rig();
  s.pushStatus = 500;
  s.tick();
  assert.ok(s.log.lines.includes('push: HTTP 500'));
});

test('without the ingest secret nothing is sent; with the lock taken by another run, nothing is done', () => {
  const r = rig({ props: {} });
  r.tick();
  assert.equal(r.pushes.length, 0);
  assert.equal(r.a1(), `${ASSIGN}:0`);
  const busy = rig({ lockFree: false });
  busy.tick();
  assert.equal(busy.reads.length, 0);
  assert.equal(busy.pushes.length, 0);
  assert.equal(busy.a2(), '');
});
