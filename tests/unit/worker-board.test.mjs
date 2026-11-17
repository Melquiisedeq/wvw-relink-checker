// The board (worker/index.mjs): each match's skirmishes, from the readers' summaries.
// Run: node --test "tests/unit/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, SUPA_ENV, pushV2 } from './worker-harness.mjs';

const latestScore = (w) => w.sql.prepare("SELECT score FROM latest WHERE id = '1-1'").get();

const boardRows = (w) => w.sql.prepare('SELECT match, skirmish, red, blue, green, vp_red, vp_blue, vp_green, at FROM board ORDER BY match, skirmish').all()
  .map((r) => ({ ...r }));

test('board: a skirmish is written once it has finished, once, whichever reader and however often', async () => {
  const w = setup({ env: SUPA_ENV });
  const board = (running, vp) => ({ vp, skirmishes: [[running - 1, 100, 200, 300], [running, 1, 2, 3]] });
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', scores: [1000, 2000, 3000], board: board(54, [500, 400, 300]) }]), 200);
  const first = boardRows(w);
  assert.deepEqual(first.map((r) => [r.match, r.skirmish, r.red, r.blue, r.green, r.vp_red]), [['1-1', 53, 100, 200, 300, 500]]);
  // The other reader, the same score, a minute later; then a higher score: no new row, nothing rewritten.
  w.advance(60e3);
  assert.equal(await pushV2(w, 'latest-supa-eu', [{ id: '1-1', scores: [1000, 2000, 3000], board: board(54, [500, 400, 300]) }]), 200);
  w.advance(60e3);
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-1', scores: [1001, 2000, 3000], board: board(54, [500, 400, 300]) }]), 200);
  assert.deepEqual(boardRows(w), first);
  // The turn: 54 has finished, 55 runs.
  w.advance(2 * 3600e3);
  assert.equal(await pushV2(w, 'latest-supa-eu', [{ id: '1-1', scores: [9000, 9000, 9000], board: board(55, [543, 432, 321]) }]), 200);
  assert.deepEqual(boardRows(w).map((r) => [r.skirmish, r.vp_red]), [[53, 500], [54, 543]]);
});

test('board: a VP that rises a read after the skirmish list is kept, a lower one never', async () => {
  const w = setup({ env: SUPA_ENV });
  const send = (score, vp) => pushV2(w, 'latest-supa-us', [{ id: '1-2', scores: [score, 0, 0], board: { vp, skirmishes: [[53, 7, 8, 9], [54, 1, 1, 1]] } }]);
  assert.equal(await send(1000, [400, 300, 200]), 200);
  w.advance(60e3);
  assert.equal(await send(1100, [443, 332, 221]), 200);
  const risen = boardRows(w)[0];
  assert.deepEqual([risen.vp_red, risen.vp_blue, risen.vp_green, risen.at], [443, 332, 221, w.now]);
  w.advance(60e3);
  assert.equal(await send(1200, [400, 300, 200]), 200, 'a stale VP is no reason to refuse the message');
  assert.deepEqual(boardRows(w)[0], risen);
  // The other reader at the same score, which the latest table does not take, with the VP risen.
  w.advance(60e3);
  assert.equal(await pushV2(w, 'latest-supa-eu', [{ id: '1-2', scores: [1100, 0, 0], board: { vp: [444, 332, 221], skirmishes: [[53, 7, 8, 9], [54, 1, 1, 1]] } }]), 200);
  assert.equal(boardRows(w)[0].vp_red, 444);
});

test('board: the week\'s last skirmish is kept while it runs, its score only rising', async () => {
  const w = setup({ env: SUPA_ENV });
  // Saturday 01:00Z: skirmish 84 of the NA week runs until the reset at 02:00.
  w.advance(Date.parse('2026-10-03T01:00:00Z') - w.now);
  const send = (score, last, vp = [900, 800, 700]) => pushV2(w, 'latest-supa-us', [{
    id: '1-3', scores: [score, 0, 0], board: { vp, skirmishes: [[83, 5, 5, 5], [84, ...last]] }
  }]);
  assert.equal(await send(500000, [10, 20, 30]), 200);
  assert.deepEqual(boardRows(w).map((r) => [r.skirmish, r.red, r.blue, r.green]), [[83, 5, 5, 5], [84, 10, 20, 30]]);
  w.advance(60e3);
  assert.equal(await send(500100, [50, 20, 30]), 200);
  w.advance(60e3);
  assert.equal(await send(500200, [40, 20, 30]), 200);
  w.advance(60e3);
  assert.equal(await send(500300, [40, 20, 30], [999, 800, 700]), 200, 'a higher VP does not carry a lower score in');
  w.advance(60e3);
  assert.equal(await send(500400, [60, 20, 30], [900, 800, 600]), 200, 'nor a higher score a lower VP');
  assert.deepEqual(boardRows(w).map((r) => [r.skirmish, r.red, r.vp_red]), [[83, 5, 999], [84, 50, 900]]);
});

test('board: readers with and without the fields are taken at once; without, only board is left out', async () => {
  const w = setup({ env: SUPA_ENV });
  const vp = [3, 2, 1];
  assert.equal(await pushV2(w, 'latest-supa-us', [
    { id: '1-1' }, { id: '1-2', board: { vp, skirmishes: [[53, 1, 2, 3], [54, 0, 0, 0]] } }
  ]), 200);
  assert.equal(await pushV2(w, 'latest-supa-eu', [{ id: '1-3' }]), 200);
  assert.deepEqual(w.sql.prepare('SELECT id FROM latest ORDER BY id').all().map((r) => r.id), ['1-1', '1-2', '1-3']);
  assert.deepEqual(boardRows(w).map((r) => [r.match, r.skirmish]), [['1-2', 53]]);
  // Skirmish 1 running: nothing has finished yet.
  w.advance(Date.parse('2026-10-03T03:00:00Z') - w.now);
  const start = Date.parse('2026-10-03T02:00:00Z');
  assert.equal(await pushV2(w, 'latest-supa-us', [{ id: '1-4', start, board: { vp: [0, 0, 0], skirmishes: [[1, 9, 9, 9]] } }]), 200);
  assert.equal(boardRows(w).length, 1);
});

test('board: fields out of shape leave the board out, the rest goes in', async (sub) => {
  const w = setup({ env: SUPA_ENV });
  const s = (a, b) => [[53, ...a], [54, ...b]];
  const cases = {
    'vp without skirmishes': { vp: [1, 2, 3] },
    'skirmishes without vp': { skirmishes: s([1, 1, 1], [1, 1, 1]) },
    'a negative vp': { vp: [-1, 2, 3], skirmishes: s([1, 1, 1], [1, 1, 1]) },
    'vp of two': { vp: [1, 2], skirmishes: s([1, 1, 1], [1, 1, 1]) },
    'a vp past 60 a skirmish': { vp: [60 * 54 + 1, 0, 0], skirmishes: s([1, 1, 1], [1, 1, 1]) },
    'a fractional score': { vp: [1, 2, 3], skirmishes: s([1.5, 1, 1], [1, 1, 1]) },
    'three skirmishes': { vp: [1, 2, 3], skirmishes: [[52, 1, 1, 1], ...s([1, 1, 1], [1, 1, 1])] },
    'no skirmish': { vp: [1, 2, 3], skirmishes: [] },
    'only the running one past the first': { vp: [1, 2, 3], skirmishes: [[54, 1, 1, 1]] },
    'a gap between the two': { vp: [1, 2, 3], skirmishes: [[52, 1, 1, 1], [54, 1, 1, 1]] },
    'skirmish 0': { vp: [1, 2, 3], skirmishes: [[0, 1, 1, 1]] },
    'skirmish 85': { vp: [1, 2, 3], skirmishes: [[84, 1, 1, 1], [85, 1, 1, 1]] },
    'a skirmish that has not begun': { vp: [1, 2, 3], skirmishes: [[54, 1, 1, 1], [55, 1, 1, 1]] },
    'a skirmish past 1000 a minute': { vp: [1, 2, 3], skirmishes: s([122001, 0, 0], [1, 1, 1]) }
  };
  let score = 1000;
  const log = console.log;
  const send = async (board) => {
    const lines = [];
    console.log = (x) => lines.push(String(x));
    try {
      const status = await pushV2(w, 'latest-supa-us', [{ id: '1-1', scores: [++score, 2000, 3000], board }]);
      return { status, lines: lines.map((l) => JSON.parse(l)) };
    } finally {
      console.log = log;
    }
  };
  for (const [name, board] of Object.entries(cases)) {
    await sub.test(name, async () => {
      const r = await send(board);
      assert.equal(r.status, 200);
      assert.equal(latestScore(w).score, score + 5000, 'the latest body went in');
      assert.ok(r.lines.some((l) => l.board === 'left out' && /^1-1 /.test(l.why[0])), JSON.stringify(r.lines));
    });
  }
  assert.equal(boardRows(w).length, 0);
  // The edges the other way: the largest counts, and a skirmish 5 minutes before it begins (a reader's clock ahead).
  assert.equal((await send({ vp: [60 * 54, 0, 0], skirmishes: s([122000, 0, 0], [1, 1, 1]) })).status, 200);
  assert.deepEqual(boardRows(w).map((r) => [r.skirmish, r.red, r.vp_red]), [[53, 122000, 3240]]);
  const early = () => send({ vp: [60 * 55, 0, 0], skirmishes: [[54, 1, 1, 1], [55, 0, 0, 0]] });
  w.advance(2 * 3600e3 - 5 * 60e3 - 1000);
  await early();
  assert.equal(boardRows(w).length, 1);
  w.advance(1000);
  await early();
  assert.deepEqual(boardRows(w).map((r) => [r.skirmish, r.vp_red]), [[53, 3240], [54, 3300]]);
});

test('board: 18 matches are one statement, and without the table the message still goes in', async () => {
  const w = setup({ env: SUPA_ENV });
  const all = [];
  for (let i = 1; i <= 9; i++) all.push({ id: '1-' + i, board: { vp: [1, 1, 1], skirmishes: [[53, 1, 1, 1], [54, 1, 1, 1]] } });
  // The EU week began Friday 18:00Z, 114 hours before: skirmish 58 runs.
  const eu = Date.parse('2026-09-25T18:00:00Z');
  for (let i = 1; i <= 9; i++) all.push({ id: '2-' + i, start: eu, board: { vp: [1, 1, 1], skirmishes: [[57, 1, 1, 1], [58, 1, 1, 1]] } });
  assert.equal(await pushV2(w, 'latest-supa-us', all), 200);
  assert.equal(w.ran.filter((x) => /^INSERT INTO board/.test(x.q)).length, 1);
  assert.equal(boardRows(w).length, 18);

  const bare = setup({ env: SUPA_ENV, skip: ['schema-005-board.sql'] });
  const log = console.log;
  const lines = [];
  console.log = (x) => lines.push(String(x));
  try {
    assert.equal(await pushV2(bare, 'latest-supa-us', [all[0]]), 200);
  } finally {
    console.log = log;
  }
  assert.equal(bare.sql.prepare('SELECT count(*) n FROM latest').get().n, 1);
  assert.ok(lines.some((l) => JSON.parse(l).board === 'failed'), lines.join('\n'));
});
