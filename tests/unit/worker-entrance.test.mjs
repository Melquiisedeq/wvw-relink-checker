// The entrance of wvwrelink.com/api (worker/index.mjs): what it takes from each
// source, what it refuses, and the shape and limits of a signed message.
// Run: node --test "tests/unit/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/index.mjs';
import { KILLS_KEY, RELINK_KEY, NA_WEEK, EU_WEEK, setup } from './worker-harness.mjs';
import { defineSignatureTests } from '../worker-fakes/signed.mjs';

test('the entrance takes a signed message from each source', async () => {
  const w = setup();
  assert.equal(await w.post('kills', { rows: w.rows(w.now) }), 200);
  assert.equal(await w.post('relink', w.relink()), 200);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 9);
  assert.deepEqual({ ...w.sql.prepare('SELECT window_at, published FROM relink').get() },
    { window_at: 1790992800, published: 0 });
});

defineSignatureTests(test, [
  {
    name: 'kills', source: 'kills', envName: 'INGEST_KILLS', make: (env) => setup({ env }),
    body: (w) => ({ rows: w.rows(w.now) }), otherKey: RELINK_KEY, otherPath: '/api/ingest/relink',
    untouched: (w) => assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 0)
  },
  {
    name: 'relink', source: 'relink', envName: 'INGEST_RELINK', make: (env) => setup({ env }),
    body: (w) => w.relink(), otherKey: KILLS_KEY, otherPath: '/api/ingest/kills',
    untouched: (w) => assert.equal(w.sql.prepare('SELECT count(*) n FROM relink').get().n, 0)
  }
]);

test('the entrance refuses what is not a well-formed message', async (t) => {
  const w = setup();
  const good = JSON.stringify({ rows: w.rows(w.now) });
  const cases = [
    ['over 64 KB', () => w.post('kills', JSON.stringify({ rows: [], pad: 'x'.repeat(65 * 1024) })), 413],
    ['not JSON', () => w.post('kills', '{rows:'), 400],
    ['a match id that cannot exist', () => w.post('kills', { rows: [[w.now, '9-9', 1, 2, 3, 4, NA_WEEK, 100]] }), 422],
    ['markup as a match id', () => w.post('kills', { rows: [[w.now, '<b>', 1, 2, 3, 4, NA_WEEK, 100]] }), 422],
    ['negative kills', () => w.post('kills', { rows: [[w.now, '1-1', -5, 2, 3, 4, NA_WEEK, 100]] }), 422],
    ['a row from two hours ago', () => w.post('kills', { rows: w.rows(w.now - 2 * 3600e3) }), 422],
    ['301 rows', () => w.post('kills', { rows: Array(301).fill(w.rows(w.now)[0]) }), 422],
    ['a relink beat from yesterday', () => w.post('relink', w.relink({ beat: Math.floor(w.now / 1000) - 86400 })), 422],
    ['a relink window only half there', () => w.post('relink', w.relink({ published: null })), 422]
  ];
  for (const [name, send, want] of cases) {
    await t.test(name, async () => assert.equal(await send(), want));
  }
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 0, 'nothing refused was written');
});

// killsInsert lets the row furthest along win, so a row ahead of the truth would keep every honest
// row of its match out: none gets in on a week that never began, a score its week cannot hold, or no score.
test('kills: a row no real week can hold is refused and says why, and the match goes on taking rows', async () => {
  const w = setup();
  const held = () => w.sql.prepare("SELECT count(*) n FROM kills WHERE match = '1-1'").get().n;
  const lines = [];
  const log = console.log;
  console.log = (x) => lines.push(JSON.parse(x));
  try {
    assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 100, 200, 300, 400, NA_WEEK, 100000]] }), 200);
    w.advance(60e3);
    const cap = 1000 * (w.now - NA_WEEK) / 60e3 + 2000;
    const ahead = [
      ['start', [w.now, '1-1', 1e7, 1e7, 1e7, 1e7, NA_WEEK + 7 * 86400e3, 0]],
      ['start not a reset', [w.now, '1-1', 1e7, 1e7, 1e7, 1e7, w.now, 0]],
      ['start not a reset', [w.now, '1-1', 1e7, 1e7, 1e7, 1e7, NA_WEEK + 3600e3, 0]],
      // Past the ceiling by the Worker's clock; the row's own time, 60 s ahead, would allow it.
      ['score for the week', [w.now + 60e3, '1-1', 1e7, 1e7, 1e7, 1e7, NA_WEEK, cap + 1]],
      ['row shape', [w.now, '1-1', 1e7, 1e7, 1e7, 1e7, NA_WEEK]]
    ];
    for (const [why, row] of ahead) {
      lines.length = 0;
      assert.equal(await w.post('kills', { rows: [row] }), 422, why);
      assert.deepEqual(lines, [{ source: 'kills', refused: 422, why }]);
    }
    assert.equal(held(), 1, 'nothing refused was written');
    for (let i = 1; i <= 3; i++) {
      w.advance(300e3);
      assert.equal(await w.post('kills', { rows: [[w.now, '1-1', 100 + i, 200, 300, 400, NA_WEEK, 100000 + 500 * i]] }), 200);
      assert.equal(held(), 1 + i, `honest row ${i} after them`);
    }
  } finally {
    console.log = log;
  }
  const served = JSON.parse((await w.get('/api/kills')).body).rows.filter((r) => r[1] === '1-1');
  assert.deepEqual(served.map((r) => r[2]), [100, 101, 102, 103]);
});

test('a chunked body with no length is cut off, not held', async () => {
  const w = setup();
  const big = new ReadableStream({
    start(c) { for (let i = 0; i < 80; i++) c.enqueue(new Uint8Array(65536)); c.close(); }
  });
  const req = new Request('https://wvwrelink.com/api/ingest/kills', {
    method: 'POST', body: big, duplex: 'half',
    headers: { 'x-wvw-time': String(Math.floor(w.now / 1000)), 'x-wvw-sig': 'a'.repeat(64) }
  });
  const real = Date.now;
  Date.now = () => w.now;
  try {
    assert.equal((await worker.fetch(req, w.env)).status, 413);
  } finally {
    Date.now = real;
  }
});

test('only the three entrance paths and three reads exist', async () => {
  const w = setup();
  assert.equal((await w.get('/api/ingest/kills')).status, 405);
  assert.equal((await w.get('/api/kills', 'POST')).status, 405);
  // An unknown source is refused before its signature is even read.
  for (const p of ['/api/ingest/admin', '/api/ingest/constructor']) {
    assert.equal((await w.get(p, 'POST')).status, 404, p);
  }
  for (const p of ['/api/constructor', '/api/__proto__', '/api/kills/', '/api/', '/api/health/x']) {
    assert.equal((await w.get(p)).status, 404, p);
  }
});

test('a backlog after an outage goes in as one statement', async () => {
  const w = setup();
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(...w.rows(w.now - i * 300e3));
  assert.equal(await w.post('kills', { rows }), 200);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 54);
  // Sent again with the next tick: INSERT OR IGNORE keeps one of each.
  w.advance(1000);
  assert.equal(await w.post('kills', { rows }), 200);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 54);
});

test('a signed message with a wrong shape is 422 and writes nothing, whatever the field', async (sub) => {
  const w = setup();
  const now = w.now;
  const t0 = { t: Math.floor(now / 1000) };
  // Valid as it stands: each case breaks one thing.
  const row = (over = {}) => {
    const r = [now, '1-1', 1, 2, 3, 4, NA_WEEK, 100];
    for (const [i, v] of Object.entries(over)) r[i] = v;
    return r;
  };
  const cases = [
    ['kills: JSON null', () => w.post('kills', 'null', t0), 422],
    ['kills: a list, not an object', () => w.post('kills', '[1]', t0), 422],
    ['kills: rows not a list', () => w.post('kills', { rows: 'x' }, t0), 422],
    ['kills: an empty list of rows', () => w.post('kills', { rows: [] }, t0), 422],
    ['kills: a null row', () => w.post('kills', { rows: [null] }, t0), 422],
    ['kills: a row of six', () => w.post('kills', { rows: [row().slice(0, 6)] }, t0), 422],
    ['kills: a row of seven, with no score', () => w.post('kills', { rows: [row().slice(0, 7)] }, t0), 422],
    ['kills: a row of nine', () => w.post('kills', { rows: [[...row(), 1]] }, t0), 422],
    ['kills: next week\'s start, after the row\'s own time', () => w.post('kills', { rows: [row({ 6: NA_WEEK + 7 * 86400e3 })] }, t0), 422],
    ['kills: the start of the week before, more than 8 days back', () => w.post('kills', { rows: [row({ 6: NA_WEEK - 7 * 86400e3 })] }, t0), 422],
    ['kills: start a minute off the reset hour', () => w.post('kills', { rows: [row({ 6: NA_WEEK + 60e3 })] }, t0), 422],
    ['kills: start at the reset hour of another day', () => w.post('kills', { rows: [row({ 6: NA_WEEK + 86400e3 })] }, t0), 422],
    ['kills: start a second off the reset hour', () => w.post('kills', { rows: [row({ 6: NA_WEEK + 1000 })] }, t0), 422],
    ['kills: start a millisecond off the reset hour', () => w.post('kills', { rows: [row({ 6: NA_WEEK + 1 })] }, t0), 422],
    ['kills: start on the other region\'s reset', () => w.post('kills', { rows: [row({ 6: EU_WEEK })] }, t0), 422],
    ['kills: a fractional count', () => w.post('kills', { rows: [row({ 3: 1.5 })] }, t0), 422],
    ['kills: a count past 1e7', () => w.post('kills', { rows: [row({ 4: 1e7 + 1 })] }, t0), 422],
    ['kills: a score past what its week can hold', () => w.post('kills', { rows: [row({ 7: 1000 * 106 * 60 + 2000 + 1 })] }, t0), 422],
    ['kills: a negative score', () => w.post('kills', { rows: [row({ 7: -1 })] }, t0), 422],
    ['kills: a fractional score', () => w.post('kills', { rows: [row({ 7: 1.5 })] }, t0), 422],
    ['kills: a row from the future', () => w.post('kills', { rows: [row({ 0: now + 61e3 })] }, t0), 422],
    ['relink: JSON null', () => w.post('relink', 'null', t0), 422],
    ['relink: a list', () => w.post('relink', '[]', t0), 422],
    ['relink: negative fails', () => w.post('relink', w.relink({ fails: -1 }), t0), 422],
    ['relink: fails past 1e6', () => w.post('relink', w.relink({ fails: 1e6 + 1 }), t0), 422],
    ['relink: fails as text', () => w.post('relink', w.relink({ fails: '0' }), t0), 422],
    ['relink: window below 1.7e9', () => w.post('relink', w.relink({ window: 1.7e9 - 1 }), t0), 422],
    ['relink: window above 4.1e9', () => w.post('relink', w.relink({ window: 4.1e9 + 1 }), t0), 422],
    ['relink: window with a fraction', () => w.post('relink', w.relink({ window: 1790992800.5 }), t0), 422],
    ['relink: published in the future', () => w.post('relink', w.relink({ published: Math.floor(now / 1000) + 61 }), t0), 422],
    ['relink: negative published', () => w.post('relink', w.relink({ published: -1 }), t0), 422],
    ['relink: window null, published not', () => w.post('relink', w.relink({ window: null, published: 5 }), t0), 422],
    ['relink: beat an hour and a second old', () => w.post('relink', w.relink({ beat: Math.floor(now / 1000) - 3601 }), t0), 422],
    ['relink: beat a minute and a second ahead', () => w.post('relink', w.relink({ beat: Math.floor(now / 1000) + 61 }), t0), 422]
  ];
  for (const [name, send, want] of cases) await sub.test(name, async () => assert.equal(await send(), want));
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 0);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM relink').get().n, 0);
});

test('the limits of a signed message are inclusive on the side they say, and a relink with no window is kept as none', async () => {
  const w = setup();
  const now = w.now;
  const sec = Math.floor(now / 1000);
  let k = 0;
  const at = () => ({ t: sec + ++k });
  for (const [window, fails] of [[1.7e9, 0], [4.1e9, 1e6]]) {
    assert.equal(await w.post('relink', w.relink({ window, fails }), at()), 200, `window ${window}`);
    assert.deepEqual({ ...w.sql.prepare('SELECT window_at, fails FROM relink').get() }, { window_at: window, fails });
  }
  const t1 = at();
  assert.equal(await w.post('relink', w.relink({ published: t1.t + 60, beat: t1.t - 3600 }), t1), 200, 'the oldest beat and the furthest published');
  assert.equal(await w.post('relink', w.relink({ window: null, published: null }), at()), 200);
  assert.deepEqual({ ...w.sql.prepare('SELECT window_at, published FROM relink').get() }, { window_at: null, published: null });
  assert.equal((await w.get('/api/relink')).status, 503, 'a sheet that did not parse is no answer');
  // The clock that puts the NA week's start exactly 8 days before a row dated 60 s ahead.
  w.advance(NA_WEEK + 8 * 86400e3 - 60e3 - w.now);
  const t2 = { t: w.now / 1000 };
  const cap = 1000 * (w.now - NA_WEEK) / 60e3 + 2000;
  assert.equal(await w.post('kills', { rows: [[w.now + 60e3, '1-1', 0, 0, 0, 0, NA_WEEK, cap]] }, t2), 200,
    'the farthest ahead row, the oldest start, the highest score its week can hold');
  const t3 = { t: t2.t + 1 };
  const old = t3.t * 1000 - 45 * 60e3;
  assert.equal(await w.post('kills', { rows: [[old, '1-2', 1e7, 0, 0, 0, NA_WEEK + 7 * 86400e3, 0]] }, t3), 200, 'the oldest row, the biggest count, the lowest score');
});

test('a signed POST with no body at all is refused: 401 unsigned, 400 when the empty body is what was signed', async () => {
  const w = setup();
  const send = async (path, headers) => {
    const real = Date.now;
    Date.now = () => w.now;
    try { return (await worker.fetch(new Request('https://wvwrelink.com' + path, { method: 'POST', headers }), w.env)).status; }
    finally { Date.now = real; }
  };
  const t = String(Math.floor(w.now / 1000));
  assert.equal(await send('/api/ingest/kills', { 'x-wvw-time': t, 'x-wvw-sig': 'a'.repeat(64) }), 401);
  assert.equal(await send('/api/ingest/kills', {}), 401);
  assert.equal(await send('/api/ingest/relink', { 'x-wvw-time': t, 'x-wvw-sig': 'a'.repeat(64) }), 401);
  assert.equal(await send('/api/ingest/kills', w.signed('/api/ingest/kills', '', { t: Number(t) })), 400);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM kills').get().n, 0);
});
