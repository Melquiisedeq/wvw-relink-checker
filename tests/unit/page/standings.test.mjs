// The page's rules in js/standings.js, run in Node without a browser: the scripts load into a node:vm and the rules are fed
// bodies from the e2e recording, mutated by a fixed-seed PRNG where a test says so (page/harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN, fresh, naTiers, teamsOf, bodyAt } from './harness.mjs';

test('deduceLineup: a tier that ended in the week of the others is the late one, and its line-up is deduced (js/standings.js)', () => {
  const p = fresh();
  const list = naTiers();
  const all = new Set(list.flatMap((m) => teamsOf(p, m)));
  list[1].end_time = new Date(p.clock.now - MIN).toISOString();   // same start, already over
  const line = p.call('deduceLineup', list, all, 4);
  assert.equal(line && line.id, '1-2');
  assert.deepEqual(teamsOf(p, line).sort(), teamsOf(p, naTiers()[1]).sort());
});

test('deduceLineup: more than three teams left over is no line-up, and nothing is guessed (js/standings.js)', () => {
  const p = fresh();
  const list = naTiers();
  const all = new Set(list.flatMap((m) => teamsOf(p, m)));
  list[1] = bodyAt(list[1], Date.parse(list[1].start_time) - 7 * 24 * 60 * MIN);
  assert.ok(p.call('deduceLineup', list, all, 4), 'control: three left over closes');
  // A live tier names a team the table has not got: its own team is left over too, 4 in all.
  list[2].all_worlds.red = [99999];
  assert.equal(p.call('deduceLineup', list, all, 4), null);
});

test('runPeek: a show during the peek leaves one pending timer, not two (js/standings.js)', async () => {
  const page = fresh();
  const pending = new Set();
  let nextId = 1;
  page.ctx.setTimeout = () => { const id = nextId++; pending.add(id); return id; };
  page.ctx.clearTimeout = (id) => { pending.delete(id); };
  page.ctx.document = { visibilityState: 'visible' };
  let release;
  const gate = new Promise((r) => { release = r; });
  page.ctx.__gate = gate;
  page.run('peekLatest = () => __gate');
  const running = page.run('runPeek()');
  page.run('peekSoon()');   // what the visibilitychange to visible does
  release();
  await running;
  assert.equal(pending.size, 1);
});

test('runPeek: the next peek lands PEEK_AFTER_MS after a 20 s mark on the server\'s clock, whatever this device\'s (js/standings.js)', async () => {
  const page = fresh();
  const MIN = 60000, anchor = 1000 * MIN + 3000, lead = 20000;
  const device = anchor + 5 * MIN + 40000 + lead;   // the server's clock reads 40 s past the mark: this device's, 20 s more
  const delays = [];
  page.ctx.setTimeout = (fn, ms) => { delays.push(ms); return delays.length; };
  page.ctx.clearTimeout = () => {};
  page.ctx.document = { visibilityState: 'visible' };
  page.ctx.Date = { now: () => device };
  page.run(`peekLatest = async () => {}; peekAnchor = ${anchor}; ownClockLead = ${lead}`);
  await page.run('runPeek()');
  assert.equal(delays.length, 1);
  assert.equal((device - lead + delays[0] - anchor - page.run('PEEK_AFTER_MS')) % page.run('PEEK_EVERY_MS'), 0, 'on the server\'s mark, not this device\'s');
});

test('runPeek: a read of 6 s is followed by the next mark, counted from where it began (js/standings.js)', async () => {
  const page = fresh();
  const MIN = 60000, anchor = 1000 * MIN + 3000, mark = anchor + 11000 + 9 * MIN;
  let clock = mark - 5000;   // begun 5 s before a mark; the one after it, 25 s from the start, clears the floor
  const delays = [];
  page.ctx.setTimeout = (fn, ms) => { delays.push(ms); return delays.length; };
  page.ctx.clearTimeout = () => {};
  page.ctx.document = { visibilityState: 'visible' };
  page.ctx.Date = { now: () => clock };
  page.ctx.__slow = async () => { clock += 6000; };
  page.run('peekLatest = __slow; peekAnchor = ' + anchor + '; ownClockLead = 0; peekDelay = 30000');
  await page.run('runPeek()');
  assert.deepEqual(delays, [19000]);
});

test('the aligned peek: lands PEEK_AFTER_MS after a 20 s mark of the summary, never under the floor (js/standings.js)', () => {
  const page = fresh();
  const nav = { connection: { saveData: false } };
  page.ctx.navigator = nav;
  const MIN = 60000, HALF = 20000, mark = 1000 * MIN + 3000, aligned = (k) => mark + 11000 + k * MIN;
  const wait = (anchor, delay, now) => { page.ctx.__a = anchor; return page.run(`peekAnchor = __a; peekWait(${delay}, ${now})`); };
  assert.equal(page.run('PEEK_BEHIND_MS'), 30000);
  assert.equal(page.run('PEEK_AFTER_MS'), 11000);
  assert.equal(page.run('PEEK_EVERY_MS'), HALF);
  assert.equal(wait(0, 30000, 5), 30000, 'no summary read yet: the delay as it was');
  assert.equal(wait(mark, 30000, mark + 11000), 40000, 'asked at its own peek: the second mark on, 40 s (the first is under the floor)');
  assert.equal(wait(mark, 30000, mark), 31000, 'asked on the mark: the mark at +11 s is under the floor less its slack, so the next, +31 s');
  for (const delay of [30000, 120000]) {
    for (const from of [0, 4000, 12000, 59000, 61000, 90000]) {
      const now = 1000 * MIN + 9 * MIN + from;
      const at = now + wait(mark, delay, now);
      assert.equal((at - aligned(0)) % HALF, 0, `delay ${delay} from ${from}: on the mark`);
      assert.ok(at - now >= 25000 && at - now <= Math.max(delay, 30000) + HALF, 'about the delay');
    }
  }
  // Whenever it is asked, never sooner than the floor less the slack (a skipped peek must not spin).
  for (let from = 0; from < 3 * MIN; from += 1000) assert.ok(wait(mark, 30000, aligned(0) + from) >= 25000);
  // Save-Data (floor 60 s): the peek that ran on the mark is followed by the next minute, not two on.
  nav.connection.saveData = true;
  for (const late of [0, 300, 4000]) {
    const now = aligned(8) + late + 700;
    assert.equal(wait(mark, 60000, now), aligned(9) - now, `Save-Data, ${late} ms late: 60 s on`);
  }
  for (let from = 0; from < 3 * MIN; from += 1000) assert.ok(wait(mark, 60000, aligned(0) + from) >= 55000);
  nav.connection.saveData = false;
  // A mark that moved 10 s later is followed.
  const moved = mark + 10000, now = 1000 * MIN + 5 * MIN + 25000;
  assert.equal((now + wait(moved, 30000, now) - moved - 11000) % HALF, 0);
});

test('the aligned peek: a summary that did not move gets one more ask, and reads stay at four a minute (js/standings.js)', () => {
  const page = fresh();
  const nav = { connection: { saveData: false } };
  page.ctx.navigator = nav;
  const learn = (sum) => { page.ctx.__s = sum; return page.run('peekStill = false; peekLearn(__s); [peekAnchor, peekStill]'); };
  page.run('peekAnchor = 0');
  assert.deepEqual([...learn({ a: { at: 100 }, b: { at: 160 } })], [160000, false], 'first summary: learned, not still');
  assert.deepEqual([...learn({ a: { at: 100 }, b: { at: 160 } })], [160000, true], 'same newest at: still');
  assert.deepEqual([...learn({ a: { at: 220 } })], [220000, false], 'a newer at: moved');
  assert.deepEqual([...learn({ a: { at: 'x' } })], [220000, false], 'no number: kept');
  const next = (still, aligned) => page.run(`peekStill = ${still}; peekAligned = ${aligned}; [peekNext(30000, 1e6), peekAligned]`);
  assert.deepEqual([...next(true, true)].slice(0, 2), [10000, false], 'aligned and still: ask again in 10 s');
  assert.equal(next(true, false)[0] > 10000, true, 'that ask, or a show or an input, is not followed by another');
  assert.equal(next(false, true)[0] > 10000, true, 'moved: the rhythm');
  // The retry sits 10 s short of the next mark: the peek after it takes the last mark within its delay.
  page.run('peekAnchor = 1000 * 60000 + 3000; peekAligned = true; peekStill = true');
  const mark = 1000 * 60000 + 3000 + 11000 + 9 * 60000;
  assert.equal(page.run(`peekNext(30000, ${mark})`), 10000);
  assert.equal(page.run(`peekStill = false; peekNext(30000, ${mark + 10500})`), 29500, 'after the retry: the last mark within its 30 s, 40 s past the aligned one');
  // A read that took 6 s (the aligned one, or the retry) is followed by the next mark, counted from where it began.
  page.run('peekAnchor = 1000 * 60000 + 3000; peekAligned = false; peekStill = false; peekRetried = false');
  assert.equal(page.run(`peekNext(30000, ${mark + 6000}, ${mark})`), 34000, 'aligned read of 6 s: the last mark within the delay, counted from where it began');
  assert.equal(page.run(`peekNext(30000, ${mark + 1000}, ${mark - 5000})`), 19000, 'a read of 6 s begun 5 s before a mark: the next mark, 25 s from its start, not the one after');
  page.run('peekRetried = true');
  assert.equal(page.run(`peekNext(30000, ${mark + 16000}, ${mark + 10000})`), 24000, 'retry of 6 s: the last mark within the delay');
  assert.equal(page.run(`peekNext(30000, ${mark + 50000}, ${mark})`), 30000, 'a read longer than the floor: the last mark within the delay still ahead');
  // The same 6 s on an aligned read that did not move: the retry still lands 10 s after its start, then the next mark.
  page.run('peekAligned = true; peekStill = true; peekRetried = false');
  assert.equal(page.run(`peekNext(30000, ${mark + 6000}, ${mark})`), 4000, 'still aligned read of 6 s: retry 10 s after it began');
  assert.equal(page.run(`peekStill = false; peekNext(30000, ${mark + 16000}, ${mark + 10000})`), 24000, 'retry of 6 s: the mark 40 s after the aligned one');
  nav.connection.saveData = true;
  assert.equal(next(true, true)[0] > 10000, true, 'Save-Data never asks under its floor');
  nav.connection.saveData = false;
  // Ten minutes of a clock that never sees the summary move, a show (the real peekSoon) every `every` ms:
  // never more than four reads in a minute (an aligned read and its retry, and the shows, which replace the aligned peek), whatever the phase.
  for (const every of [40000, 50000, 75000, 100000, Infinity]) {
    page.run('peekAnchor = 1000 * 60000 + 3000; peekAligned = true');
    let now = 1000 * 60000 + 9 * 60000, lastSoon = now;
    const end = now + 10 * 60000, times = [];
    while (now < end) {
      times.push(now);
      page.run(`peekAt = ${now}; peekStill = true`);
      const wait = page.run(`peekNext(30000, ${now})`);
      if (now + wait > lastSoon + every) {   // a popover closes before that peek
        lastSoon += every; page.run('peekSoon()');
        now = Math.max(lastSoon, now + 30000);   // peekSoon: not before the floor after the last peek
      } else now += wait;
    }
    const reads = times.length;
    assert.ok(times.every((t) => times.filter((u) => u >= t && u < t + 60000).length <= 4), `a show every ${every / 1000} s: more than four reads in a minute`);
    if (every === Infinity) assert.equal(reads, 31, 'no show: an aligned read and its retry at every second mark, three a minute, the first one counted');
    assert.ok(reads <= 40, `a show every ${every / 1000} s: ${reads} reads in 10 min`);
  }
});

test('summaryAt: the newest `at` of a summary, in ms, ignoring what is not a number (js/standings.js)', () => {
  const page = fresh();
  const at = (o) => { page.ctx.__s = o; return page.run('summaryAt(__s)'); };
  assert.equal(at({ '1-1': { at: 100 }, '1-2': { at: 160 }, '1-3': { at: 130 } }), 160000);
  assert.equal(at({ '1-1': { at: 'x' }, '1-2': {}, '1-3': null, '1-4': { at: NaN }, '1-5': { at: 90 } }), 90000);
  assert.equal(at({ '1-1': {}, '1-2': 'x' }), 0);
  assert.equal(at({}), 0);
});

test('sideFigures: a figure of another week or another skirmish never floats a rise (js/standings.js)', () => {
  const p = fresh();
  const body = (start, vp, skirmishId, sk) => ({
    id: '1-1', start_time: start, end_time: '2026-11-21T02:00:00Z',
    victory_points: { red: vp, blue: 1, green: 1 }, kills: {}, deaths: {},
    skirmishes: Array.from({ length: skirmishId }, (_, i) => ({
      id: i + 1, scores: { red: i + 1 === skirmishId ? sk : 7, blue: 1, green: 1 } })),
    all_worlds: { red: [11001], blue: [11002], green: [11003] },
  });
  const deltas = (m) => {
    p.ctx.__m = m;
    return JSON.parse(p.run(`JSON.stringify((() => { const f = sideFigures(__m, 'red', 1); const el = {}; const n = pendingFlashes.length;
      queueSideFlashes(f, el, el); return pendingFlashes.slice(n).map((x) => x[1]); })())`));
  };
  const wk = '2026-11-14T02:00:00Z';
  deltas(body('2026-11-07T02:00:00Z', 152, 5, 310));
  assert.deepEqual(deltas(body(wk, 9, 1, 40)), [], 'last week\'s closing figures are not compared');
  assert.deepEqual(deltas(body(wk, 9, 1, 55)), [15], 'inside one skirmish the rise shows');
  assert.deepEqual(deltas(body(wk, 12, 2, 3)), [3], 'a new skirmish zeroes: the week total rises, the skirmish figure does not');
});

// ---- The copy that draws the list when the game's reads fail (js/standings.js) --
test('copyBoard: a body of the copy is drawn up to 6 min after its `at` by the servers\' clock, and not 1 s more (js/standings.js)', async () => {
  const p = fresh();
  const lead = 7 * MIN;
  const at = p.clock.now;
  p.ctx.__body = { id: '1-1' };
  p.run(`latestBodyAt.set(__body, ${at}); readCopyBodies = async () => [__body]`);
  p.run(`ownClockLead = ${lead}`);
  const tryAt = async (ms) => {
    p.clock.now = at + lead + ms;
    try { await p.run("copyBoard(new Error('refused'))"); return 'drawn'; } catch (e) { return e.message; }
  };
  assert.equal(await tryAt(6 * MIN - 1000), 'drawn');
  assert.equal(await tryAt(6 * MIN), 'drawn', 'at 6 min');
  assert.equal(await tryAt(6 * MIN + 1000), 'refused', 'at 6 min and 1 s');
  p.run('ownClockLead = 0');
  p.clock.now = at + 7 * MIN;
  await assert.rejects(p.run("copyBoard(new Error('refused'))"), /refused/, 'the device\'s clock is not the servers\'');
  p.run(`ownClockLead = ${lead}`);
  p.clock.now = at + lead + MIN;
  await p.run("copyBoard(new Error('refused'))");
});
