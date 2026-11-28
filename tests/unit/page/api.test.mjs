// The page's rules in js/api.js and the sweeps of the clock lead that cross scripts, run in Node without a browser: the scripts load into a node:vm and the rules are fed
// bodies from the e2e recording, mutated by a fixed-seed PRNG where a test says so (page/harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedAt, matches, prng, loadPage, MIN, clone, fresh, state, weekBody, naTiers, teamsOf, bodyAt, openMatch, OPEN_ID, stepOf, happened } from './harness.mjs';

// The next week: a later start, every counter at zero.
function nextWeek(base) {
  const m = clone(base);
  const week = 7 * 24 * 60 * MIN;
  m.start_time = new Date(Date.parse(base.start_time) + week).toISOString();
  m.end_time = new Date(Date.parse(base.end_time) + week).toISOString();
  for (const f of ['kills', 'deaths', 'scores']) for (const c of Object.keys(m[f])) m[f][c] = 0;
  return m;
}

// A body with fields lost on the way: only ever drops information.
function damage(body, rnd) {
  const m = clone(body);
  switch (rnd.int(5)) {
    case 0: delete m.scores; break;
    case 1: m.scores = null; break;
    case 2: delete m.scores[rnd.pick(Object.keys(m.scores))]; break;
    case 3: m.kills = null; break;
    default: delete m.deaths; break;
  }
  return m;
}

test('matchIsBehind: a later start is never behind, an earlier one always is (js/api.js)', () => {
  const p = fresh();
  const rnd = prng(1);
  for (const base of matches) {
    const week = nextWeek(base);
    assert.equal(p.call('matchIsBehind', base, week), true);
    assert.equal(p.call('matchIsBehind', week, base), false);
    // Last week's counters, however high, lose to a new week at zero.
    assert.equal(p.call('matchIsBehind', state(base, 50), week), true);
    assert.equal(p.call('matchIsBehind', base, base), false);
    for (let i = 0; i < 20; i++) {
      const a = rnd.int(6);
      const b = rnd.int(6);
      const x = rnd() < 0.5 ? state(base, a) : damage(state(base, a), rnd);
      const y = state(base, b);
      assert.ok(!(p.call('matchIsBehind', x, y) && p.call('matchIsBehind', y, x)), 'both ways behind');
    }
  }
});

test('matchIsBehind: inside one week, fewer kills or lower scores are behind (js/api.js)', () => {
  const p = fresh();
  for (const base of matches) {
    for (let i = 0; i < 5; i++) {
      assert.equal(p.call('matchIsBehind', state(base, i), state(base, i + 1)), true);
      assert.equal(p.call('matchIsBehind', state(base, i + 1), state(base, i)), false);
    }
    const lower = clone(base);
    lower.scores.blue -= 1;
    assert.equal(p.call('matchIsBehind', lower, base), true, 'same kills, lower score');
    assert.equal(p.call('matchIsBehind', base, lower), false);
  }
});

test('matchIsBehind: an unreadable start_time is taken, never judged (js/api.js)', () => {
  const p = fresh();
  const base = matches[0];
  for (const bad of [undefined, null, 'garbage', '', NaN]) {
    const broken = clone(base);
    if (bad === undefined) delete broken.start_time; else broken.start_time = bad;
    assert.equal(p.call('matchIsBehind', broken, base), false);
    assert.equal(p.call('matchIsBehind', base, broken), false);
  }
});

test('keepNewestMatch: the kept body never walks backwards (js/api.js)', () => {
  const rnd = prng(2);
  for (const base of matches.slice(0, 4)) {
    const p = fresh();
    const bodies = [0, 1, 2, 3, 4, 5].map((k) => state(base, k));
    bodies.push(nextWeek(base));
    let top = -1;
    for (let step = 0; step < 40; step++) {
      p.clock.now += 20000;
      // The first offer is a real body; after that stale and damaged ones are interleaved.
      let idx = step === 0 ? 0 : rnd.int(bodies.length);
      if (idx === bodies.length - 1 && rnd() < 0.8) idx = rnd.int(bodies.length - 1);
      let offered = bodies[idx];
      if (idx < top && rnd() < 0.4) offered = damage(offered, rnd);
      top = Math.max(top, idx);
      assert.equal(p.call('keepNewestMatch', offered), bodies[top], `step ${step}: offered ${idx}, top ${top}`);
    }
  }
});

test('keepNewestMatch: what is not a match passes through; a frozen body keeps its time (js/api.js)', () => {
  const p = fresh();
  for (const junk of [null, undefined, 5, {}, { id: 7 }]) {
    assert.equal(p.call('keepNewestMatch', junk), junk);
  }
  const m = matches[0];
  p.call('keepNewestMatch', m);
  assert.equal(p.call('matchScoreRoseAt', m.id), recordedAt);
  p.clock.now += 10 * MIN;
  p.call('keepNewestMatch', m);
  assert.equal(p.call('matchScoreRoseAt', m.id), recordedAt, 'the same body again is not news');
  p.call('keepNewestMatch', state(m, 1));
  assert.equal(p.call('matchScoreRoseAt', m.id), p.clock.now, 'a higher score is');
});

test('keepNewestMatch: a rise after a gap is not watched, and its burst shares the gap (js/api.js)', () => {
  const p = fresh();
  const m = matches[0];
  const entry = () => p.run(`newestMatches.get(${JSON.stringify(m.id)})`);
  p.call('keepNewestMatch', m);
  p.clock.now += 30000;
  p.call('keepNewestMatch', state(m, 1));
  assert.equal(entry().rose, true, 'a rise after a normal poll is watched');
  const before = p.clock.now;
  p.clock.now += 30 * MIN;
  p.call('keepNewestMatch', state(m, 2));
  assert.equal(entry().rose, false, 'a rise after a gap is a first sight again, though one was watched before');
  assert.equal(entry().gapFrom, before);
  p.clock.now += 200;
  p.call('keepNewestMatch', state(m, 3));
  assert.equal(entry().rose, false, 'the next body of the same burst');
  assert.equal(entry().gapFrom, before, 'keeps the gap');
  p.clock.now += 30000;
  p.call('keepNewestMatch', state(m, 4));
  assert.equal(entry().rose, true, 'a rise after a normal poll is watched again');
  assert.equal(entry().gapFrom, undefined);
});

test('keepNewestMatch: an answer that does not move the data still ends the gap for the rise after it (js/api.js)', () => {
  // A read asked before a sleep can land after it, ahead of the game's new
  // answer (/api/latest, mergeLatest's late offer): seen under load in freshness-time.spec.mjs.
  for (const [what, late] of [['the same body', 1], ['an older body', 0]]) {
    const p = fresh();
    const m = matches[0];
    const entry = () => p.run(`newestMatches.get(${JSON.stringify(m.id)})`);
    p.call('keepNewestMatch', m);
    p.clock.now += 30000;
    p.call('keepNewestMatch', state(m, 1));
    const before = p.clock.now;
    p.clock.now += 30 * MIN;
    p.call('keepNewestMatch', state(m, late));
    p.clock.now += 117;
    p.call('keepNewestMatch', state(m, 2));
    assert.equal(entry().rose, false, `${what} first: the rise is still a first sight`);
    assert.equal(entry().gapFrom, before, `${what} first: the gap runs from the last answer before it`);
  }
});

test('ageBehindHistory: a body behind the history is dated by the oldest line ahead of it, not the newest (js/api.js)', () => {
  const p = loadPage(recordedAt);
  const m = matches[0];
  p.ctx.__m = m; p.run('keepNewestMatch(__m)');
  const now = p.clock.now;
  const t = p.run('fightTotals(__m)');
  const shift = (d) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v + d]));
  const datedBy = (lines) => {
    p.ctx.__by = new Map([[m.id, lines]]);
    p.run(`newestMatches.get(${JSON.stringify(m.id)}).at = ${now}`);
    p.run('ageBehindHistory(__by, fightTotals)');
    return (now - p.run(`newestMatches.get(${JSON.stringify(m.id)}).at`)) / MIN;
  };
  assert.equal(datedBy([{ at: now - 40 * MIN, n: shift(5) }, { at: now - 2 * MIN, n: shift(5) }]), 40);
  // A line equal to the body, or behind it, is no proof of anything.
  assert.equal(datedBy([{ at: now - 60 * MIN, n: shift(0) }, { at: now - 50 * MIN, n: shift(-3) },
    { at: now - 40 * MIN, n: shift(5) }, { at: now - 2 * MIN, n: shift(5) }]), 40);
  // A line of the week before, ahead of the body, is not of this week.
  assert.equal(datedBy([{ at: Date.parse(m.start_time) - 10 * MIN, n: shift(9) },
    { at: now - 40 * MIN, n: shift(5) }, { at: now - 2 * MIN, n: shift(5) }]), 40);
});

test('ageBehindHistory: a rise after a gap, with no copy to date it, takes the line written inside the gap (js/api.js)', () => {
  const p = loadPage(recordedAt);
  const m = matches[0];
  const id = JSON.stringify(m.id);
  p.ctx.__m = m; p.run('keepNewestMatch(__m)');
  p.clock.now += 30000;
  p.ctx.__m = state(m, 1); p.run('keepNewestMatch(__m)');
  const before = p.clock.now;
  p.clock.now += 30 * MIN;
  p.ctx.__m = state(m, 2); p.run('keepNewestMatch(__m)');
  const woke = p.clock.now;
  assert.equal(p.run(`newestMatches.get(${id}).gapFrom`), before);
  const t = p.run(`fightTotals(newestMatches.get(${id}).match)`);
  const datedBy = (line) => {
    p.ctx.__by = new Map([[m.id, [line]]]);
    p.run(`newestMatches.get(${id}).at = ${woke}`);
    p.run('ageBehindHistory(__by, fightTotals)');
    return (woke - p.run(`newestMatches.get(${id}).at`)) / MIN;
  };
  assert.equal(datedBy({ at: woke - 20 * MIN, n: t }), 20);
  // A line from before the gap, or one a map is ahead of, is not the rise's.
  assert.equal(datedBy({ at: before - MIN, n: t }), 0);
  const [first] = Object.keys(t);
  assert.equal(datedBy({ at: woke - 20 * MIN, n: { ...t, [first]: t[first] - 1 } }), 0);
});

test('ageFirstSightFromHistory: a first sight ahead of the newest line is not dated by it; one equal to it is (js/api.js)', () => {
  const p = loadPage(recordedAt);
  const m = matches[0];
  p.ctx.__m = m; p.run('keepNewestMatch(__m)');
  const now = p.clock.now;
  const t = p.run('fightTotals(__m)');
  const shift = (d) => Object.fromEntries(Object.entries(t).map(([k, v], i) => [k, i === 0 ? v + d : v]));
  const datedBy = (lines) => {
    p.ctx.__by = new Map([[m.id, lines]]);
    p.run(`newestMatches.get(${JSON.stringify(m.id)}).at = ${now}`);
    p.run('ageFirstSightFromHistory(__by, HUD_STALE_MS, fightTotals)');
    return (now - p.run(`newestMatches.get(${JSON.stringify(m.id)}).at`)) / MIN;
  };
  // Opening during a freeze: the body is the line's, and is as old as it.
  assert.equal(datedBy([{ at: now - 30 * MIN, n: shift(0) }]), 30);
  // A map ahead of the line: the score rose after it, where no reader of ours saw it.
  assert.equal(datedBy([{ at: now - 30 * MIN, n: shift(-4) }]), 0);
});

test('keepNewestMatch: a first sight with the score of our copy takes the copy\'s time (js/api.js)', () => {
  const p = loadPage(recordedAt);
  const m = matches[0];
  const now = p.clock.now;
  p.ctx.__m = m; p.run('keepNewestMatch(__m)');
  const copy = clone(m);
  p.ctx.__c = copy;
  p.run(`latestBodyAt.set(__c, ${now - 4 * MIN})`);
  p.clock.now += 2000;
  p.run('keepNewestMatch(__c)');
  const id = JSON.stringify(m.id);
  assert.equal((now - p.run(`matchScoreRoseAt(${id})`)) / MIN, 4);
  // A rise this page watched keeps its own time.
  const q = loadPage(recordedAt);
  q.ctx.__m = m; q.run('keepNewestMatch(__m)');
  q.clock.now += 30000;
  const up = clone(m); up.scores.red += 1;
  q.ctx.__u = up; q.run('keepNewestMatch(__u)');
  const watched = q.clock.now;
  const same = clone(up);
  q.ctx.__c = same;
  q.run(`latestBodyAt.set(__c, ${watched - 4 * MIN})`);
  q.clock.now += 2000;
  q.run('keepNewestMatch(__c)');
  assert.equal(q.run(`matchScoreRoseAt(${id})`), watched);
});

const stored = (p, id) => {
  const v = p.run(`weekStoreRead().get(${JSON.stringify(id)})`);
  return v ? { s: v.s, e: v.e } : null;
};

test('weekStoreOffer: a body of an earlier week does not erase a later one for two hours from its start (js/api.js)', () => {
  const HOLD = 2 * 60 * MIN;
  const day = 24 * 60 * MIN;
  for (const [after, kept] of [[-30 * MIN, true], [0, true], [HOLD - 1, true], [HOLD, false], [HOLD + MIN, false]]) {
    const p = fresh();
    const newStart = p.clock.now - after;   // `after` past the later week's start (negative: not begun yet)
    const fresher = weekBody(matches[0], '1-1', newStart, newStart + 7 * day);
    const older = weekBody(matches[0], '1-1', newStart - 7 * day, newStart + 12 * 60 * MIN);
    p.call('weekStoreOffer', fresher);
    assert.equal(stored(p, '1-1').s, newStart, `the later week is written (${after} ms in)`);
    p.call('weekStoreOffer', older);
    const had = stored(p, '1-1');
    assert.equal(had.s, kept ? newStart : newStart - 7 * day,
      `${after} ms after the later week began: the older body ${kept ? 'must not overwrite' : 'is allowed to overwrite'} it`);
  }
});

test('weekStoreOffer: a later week always replaces an earlier one; an earlier body wins once the later week is old (js/api.js)', () => {
  const day = 24 * 60 * MIN;
  const p = fresh();
  const t = p.clock.now;
  const a = weekBody(matches[0], '1-2', t - 3 * day, t + 4 * day);
  const b = weekBody(matches[0], '1-2', t - day, t + 6 * day);
  p.call('weekStoreOffer', a);
  assert.equal(stored(p, '1-2').s, t - 3 * day);
  p.call('weekStoreOffer', b);
  assert.equal(stored(p, '1-2').s, t - day, 'a later start replaces, however long ago the earlier began');
  p.call('weekStoreOffer', a);
  assert.equal(stored(p, '1-2').s, t - 3 * day, 'the memory of a week begun a day ago no longer holds against an earlier body');
});

test('weekStoreRead: every tier remembered survives a reload, not only the last one (js/api.js)', () => {
  const p = fresh();
  const start = p.clock.now - 10 * MIN;
  for (const m of naTiers()) p.call('weekStoreOffer', bodyAt(m, start));
  p.run('weekStore = null');   // the page loaded again: only localStorage is left
  assert.deepEqual(clone([...p.run('weekStoreRead()').keys()].sort()), ['1-1', '1-2', '1-3', '1-4']);
});

// An entry written 1 min ago by the server's time, read by a page whose clock is 10 min behind; `measured`: whether the page has measured it.
const weekAfterSkew = (measured) => {
  const p = fresh();
  const server = p.clock.now;
  const [t1, t2] = naTiers();
  p.clock.now = server - MIN;
  p.call('weekStoreOffer', bodyAt(t1, server - 30 * MIN));
  p.run('weekStore = null');
  p.clock.now = server - 10 * MIN;
  p.set('clockMeasured', measured);
  return { p, t2, server };
};

const inStorage = (p) => Object.keys(JSON.parse(p.ctx.localStorage.getItem('wvw-weeks-v1'))).sort();

test('weekStoreRead: a clock 10 min behind, not yet measured, keeps an entry written a minute ago and does not save it away (js/api.js)', () => {
  const { p, t2, server } = weekAfterSkew(false);
  assert.deepEqual(clone([...p.run('weekStoreRead()').keys()]), ['1-1']);
  p.call('weekStoreOffer', bodyAt(t2, server - 30 * MIN));
  assert.deepEqual(inStorage(p), ['1-1', '1-2']);
});

test('weekStoreRead: once the clock is measured, an entry written more than 5 min ahead of it is still refused (js/api.js)', () => {
  const { p } = weekAfterSkew(true);
  assert.deepEqual(clone([...p.run('weekStoreRead()').keys()]), []);
});

test('weekLineup: the remembered line-up has the three teams and no score at all (js/api.js)', () => {
  const p = fresh();
  const [t1] = naTiers();
  p.call('weekStoreOffer', bodyAt(t1, p.clock.now - 10 * MIN));
  const line = p.call('weekLineup', '1-1');
  assert.equal(line.lineupOnly, true);
  assert.deepEqual(teamsOf(p, line), teamsOf(p, t1));
  assert.equal(line.scores, undefined, 'a remembered line-up has no score to show');
  assert.equal(JSON.stringify(line).includes('scores'), false);
});

test('matchesToReread: a tier remembered this week and missing from the list is read again by id (js/api.js)', () => {
  const p = fresh();
  const [a, b, c, d] = naTiers();
  p.call('weekStoreOffer', bodyAt(d, p.clock.now - 10 * MIN));
  const r = p.call('matchesToReread', [a, b, c], ['1']);
  assert.deepEqual(clone(r.need), ['1-4']);
  assert.deepEqual(clone(r.holes), ['1-4']);
});

test('matchReplaces and keptMatchWithTeam: the same week\'s live body stands in for the team over an ended one (js/api.js)', () => {
  const p = fresh();
  const live = clone(matches.find((m) => m.id === '1-1'));
  const ended = { ...clone(live), id: '1-2', end_time: new Date(p.clock.now - MIN).toISOString() };
  assert.equal(p.call('matchReplaces', ended, live), false, 'an ended body does not take the live one\'s place');
  assert.equal(p.call('matchReplaces', live, ended), true, 'the live body takes the ended one\'s');
  p.run('matchDataCache').set(live.id, live);
  p.run('matchDataCache').set(ended.id, ended);
  const team = p.call('matchTeamId', live, 'red');
  assert.equal(p.call('keptMatchWithTeam', team).id, '1-1');
});

test('getMatchForTeam: a first answer without the team is read again, and the answer that has it counts (js/api.js)', async () => {
  const p = fresh();
  const [other, mine] = naTiers();
  const team = p.call('matchTeamId', mine, 'red');
  let reads = 0;
  p.ctx.URL = URL;
  p.ctx.fetch = () => Promise.reject(new TypeError('offline'));
  p.ctx.__answer = () => (++reads === 1 ? other : mine);
  p.run('fetchJson = async () => __answer()');
  const got = await p.call('getMatchForTeam', team);
  assert.equal(got.id, '1-2');
  assert.ok(reads > 1, 'read again');
});

test('fetchMatches: a whole region on one week is written to the memory even where it holds a later week (js/api.js)', async () => {
  const p = fresh();
  const list = naTiers();
  const later = p.clock.now - 30 * MIN;
  p.call('weekStoreOffer', bodyAt(list[1], later));
  assert.equal(stored(p, '1-2').s, later);
  p.ctx.URL = URL;
  p.ctx.fetch = () => Promise.reject(new TypeError('offline'));
  p.ctx.__list = list;
  p.run('fetchJson = async (url) => (/ids=all/.test(url) ? __list : __list.filter((m) => url.includes(m.id)))');
  await p.call('fetchMatches', 'https://api.guildwars2.com/v2/wvw/matches?ids=all', 4000, ['1']);
  p.run('weekStore = null');
  assert.equal(stored(p, '1-2').s, Date.parse(list[1].start_time), 'the list is the line-up, the older memory is replaced');
});

test('retryAfterMs: seconds, an HTTP date, the cap, and anything unusable (js/api.js)', () => {
  const page = fresh();
  const ms = (header) => page.call('retryAfterMs', header);
  const FALLBACK = 1500, CAP = 30000;
  assert.equal(ms('7'), 7000, 'seconds');
  assert.equal(ms('2.5'), 2500, 'fractions of a second');
  assert.equal(ms('30'), CAP, 'exactly the cap');
  assert.equal(ms('3600'), CAP, 'a delay nobody sits through');
  // An HTTP date has whole seconds: the delay is the date minus the page's clock.
  const whole = Math.floor(recordedAt / 1000) * 1000;
  const at = (offset) => new Date(whole + offset).toUTCString();
  assert.equal(ms(at(12000)), whole + 12000 - recordedAt, 'an HTTP date, against the page clock');
  assert.equal(ms(at(10 * 60000)), CAP, 'a date far ahead');
  assert.equal(ms(at(-5000)), FALLBACK, 'a date in the past');
  for (const bad of [null, undefined, '', ' ', '0', '-3', 'soon', 'Infinity', 'NaN', '1e999', 'Thu, 99 Foo 2026']) {
    assert.equal(ms(bad), FALLBACK, `${JSON.stringify(bad)} is no delay`);
  }
});

test('our copy and its summary are read past the browser cache, the kills and the relink window revalidated (js/api.js, js/standings.js)', async () => {
  const page = fresh();
  const seen = new Map();
  page.ctx.AbortController = AbortController;
  page.ctx.fetch = (url, init) => { seen.set(String(url), init && init.cache); return Promise.reject(new TypeError('offline')); };
  await page.run('latestRead()');
  await page.run('peekLatest()');
  await page.run('readOwnKills()').catch(() => {});
  await page.run('readOwnRelink()').catch(() => {});
  assert.equal(seen.get('/api/latest'), 'no-store', '/api/latest');
  assert.equal(seen.get('/api/latest/summary'), 'no-store', '/api/latest/summary');
  // Not 'no-store': only the copy and the summary set the server clock.
  assert.equal(seen.get(page.run('OWN_KILLS_URL')), 'no-cache', '/api/kills');
  assert.equal(seen.get(page.run('OWN_RELINK_URL')), 'no-cache', '/api/relink');
});

test('latestSummaryLearn: keeps a number start and score under a match id, nothing else (js/api.js)', () => {
  const page = fresh();
  page.ctx.__s = {
    '1-1': { start: 5, score: 9, at: 1, by: 'a' }, '2-1': { start: 5, score: 9, at: '7' }, '2-2': { start: 5, score: 9, at: -3 },
    '2-3': { start: 5, score: 9, at: NaN },
    '1-2': { start: '5', score: 9 }, '1-3': { start: 5, score: NaN }, '1-4': null, '1-5': 'x',
    '3-1': { start: 5, score: 9 }, '__proto__x': { start: 5, score: 9 }, '2-9': { start: 7, score: 0 },
  };
  const kept = page.run('[...latestSummaryLearn(__s)]');
  assert.deepEqual(JSON.parse(JSON.stringify(kept)), [['1-1', { start: 5, score: 9, at: 1000 }], ['2-1', { start: 5, score: 9 }],
    ['2-2', { start: 5, score: 9 }], ['2-3', { start: 5, score: 9 }], ['2-9', { start: 7, score: 0 }]]);
});

test('the summary dates a body of the same week and score, never later than now, and only a first sight (js/api.js)', () => {
  const page = fresh();
  const live = matches.find((m) => Date.parse(m.end_time) > recordedAt);
  const start = Date.parse(live.start_time);
  const score = (m) => page.run(`colorSum(newestMatches.get('${m}').match.scores)`);
  const kept = () => page.run(`({ at: newestMatches.get('${live.id}').at, rose: newestMatches.get('${live.id}').rose })`);
  const tell = (e) => page.call('latestSummaryLearn', { [live.id]: e });
  // Kept first, the summary read after: the first sight is redated.
  page.clock.now += 5 * 60000;
  page.call('keepNewestMatch', clone(live));
  const sec = Math.floor(page.run('Date.now()') / 1000);
  const s = score(live.id);
  tell({ start, score: s, at: sec - 240 });
  assert.equal(kept().at, (sec - 240) * 1000, 'a body kept before the summary is redated');
  assert.equal(kept().rose, false, 'older than KILLS_ALIVE_MS: not a recent rise');
  tell({ start, score: s, at: sec - 300 });
  assert.equal(kept().at, (sec - 300) * 1000, 'an earlier time moves it back');
  tell({ start, score: s, at: sec - 100 });
  assert.equal(kept().at, (sec - 300) * 1000, 'a later time does not move it forward');
  tell({ start, score: s + 1, at: 1 });
  tell({ start: start + 1, score: s, at: 1 });
  assert.equal(kept().at, (sec - 300) * 1000, 'another score or week dates nothing');
  // A rise this page watched is not a first sight: the summary does not redate it.
  const watched = fresh();
  watched.call('keepNewestMatch', clone(live));
  watched.clock.now += 2000;
  watched.call('keepNewestMatch', state(live, 1));
  assert.equal(watched.run(`newestMatches.get('${live.id}').rose`), true, 'the page saw the rise');
  const roseAt = watched.run(`newestMatches.get('${live.id}').at`);
  const wsec = Math.floor(watched.run('Date.now()') / 1000);
  watched.call('latestSummaryLearn', { [live.id]: { start, score: watched.run(`colorSum(newestMatches.get('${live.id}').match.scores)`), at: wsec - 300 } });
  assert.equal(watched.run(`newestMatches.get('${live.id}').at`), roseAt, 'a watched rise keeps its time');
  // Offered after the summary: a new body of the same score is dated by it, never after now.
  const other = fresh();
  other.call('latestSummaryLearn', { [live.id]: { start, score: s, at: (other.run('Date.now()') + 999999000) / 1000 } });
  other.call('keepNewestMatch', clone(live));
  assert.equal(other.run(`newestMatches.get('${live.id}').at`), other.run('Date.now()'), 'a time ahead of now is now');
  const again = fresh();
  again.call('latestSummaryLearn', { [live.id]: { start, score: s, at: Math.floor(again.run('Date.now()') / 1000) - 90 } });
  again.call('keepNewestMatch', clone(live));
  assert.equal(again.run(`newestMatches.get('${live.id}').at`), (Math.floor(again.run('Date.now()') / 1000) - 90) * 1000, 'a body offered after the summary');
});

test('latestWanted: a fresh summary decides; without one, a body behind or a quiet match (js/api.js)', () => {
  const page = fresh();
  const live = matches.find((m) => Date.parse(m.end_time) > recordedAt);
  page.call('keepNewestMatch', clone(live));
  const score = page.run(`colorSum(newestMatches.get('${live.id}').match.scores)`);
  const want = (behind = false) => page.call('latestWanted', [live.id], behind);
  page.clock.now += 40000;
  assert.equal(want(), false, 'no summary, risen 40 s ago');
  assert.equal(want(true), true, 'no summary, the game gave a body behind');
  page.call('latestSummaryLearn', { [live.id]: { start: Date.parse(live.start_time), score } });
  assert.equal(want(true), false, 'the summary holds the same score: the copy has nothing newer');
  page.call('latestSummaryLearn', { [live.id]: { start: Date.parse(live.start_time), score: score + 1 } });
  assert.equal(want(), true, 'the summary is ahead');
  page.call('latestSummaryLearn', { [live.id]: { start: Date.parse(live.start_time) + 1, score: score + 1 } });
  assert.equal(want(), false, 'another week in the summary');
  page.clock.now += 91000;
  assert.equal(want(), true, 'the summary is old: quiet 131 s');
});

test('offerLate: a late copy that moves a match makes the open map read once; that read asks no copy (js/api.js)', () => {
  const page = fresh();
  const live = matches.find((m) => Date.parse(m.end_time) > recordedAt);
  page.call('keepNewestMatch', clone(live));
  const pushed = [];
  page.ctx.__push = (ids) => pushed.push([...ids]);
  page.run('mapAhead = __push');
  page.run('latestAskedAt = Date.now()');   // startLatest, as the map's read asked it
  page.clock.now += 2000;
  const ahead = state(live, 1);
  page.call('offerLate', [ahead]);
  assert.deepEqual(pushed, [[live.id]], 'the body that won is pushed to the map');
  page.call('offerLate', [clone(ahead)]);
  page.call('offerLate', [clone(live)]);
  assert.equal(pushed.length, 1, 'the same body again, or one behind, pushes nothing');
  // The read mapAhead starts gets the game's body, behind the copy's.
  assert.equal(page.call('latestWanted', [live.id], true), false, 'no summary: the last ask is under LATEST_GAP_MS old');
  page.call('latestSummaryLearn', { [live.id]: { start: Date.parse(live.start_time), score: page.run(`colorSum(newestMatches.get('${live.id}').match.scores)`) } });
  page.clock.now += 60000;
  assert.equal(page.call('latestWanted', [live.id], true), false, 'a summary no further than the copy: no ask');
});

const shownOf = (m) => [m.kills.red, m.deaths.red, m.scores.red];

// The game answers `game` (or fails), our copy answers `copy`; counts how often the copy was asked.
function serveFrom(p, { game, copy }) {
  p.ctx.URL = URL;
  p.ctx.__copy = copy;
  p.ctx.__game = game;
  p.ctx.__asked = 0;
  p.run('fetchJson = async () => { if (__game.message === "offline") throw __game; return __game; }');
  p.run('latestRead = () => { __asked++; return Promise.resolve(__copy); }');
  return () => p.ctx.__asked;
}

const ONE_URL = `https://api.guildwars2.com/v2/wvw/matches?id=${OPEN_ID}`;

const LIST_URL = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';

test('matchIsBehind: more kills and deaths decide before the score, so older activity with a higher score is behind (js/api.js)', () => {
  const p = fresh();
  const kept = stepOf(2);
  const stale = clone(kept);
  stale.deaths.red -= 10;
  stale.scores.red += 10;
  assert.equal(p.call('matchIsBehind', stale, kept), true, 'fewer deaths is a body from before, whatever its score says');
  assert.equal(p.call('matchIsBehind', kept, stale), false, 'and the other way round it is not');
});

test('keepNewestMatch: a new week with a low score still moves the data, so its time restarts (js/api.js)', () => {
  const p = fresh();
  p.call('keepNewestMatch', stepOf(2));
  const first = p.run(`newestMatches.get('${OPEN_ID}').at`);
  p.clock.now += 20 * MIN;
  const week = 7 * 24 * 60 * MIN;
  const next = clone(openMatch);
  next.start_time = new Date(Date.parse(openMatch.start_time) + week).toISOString();
  next.end_time = new Date(Date.parse(openMatch.end_time) + week).toISOString();
  for (const f of ['kills', 'deaths', 'scores']) for (const c of Object.keys(next[f])) next[f][c] = 0;
  p.call('keepNewestMatch', next);
  assert.equal(p.run(`newestMatches.get('${OPEN_ID}').match.start_time`), next.start_time);
  assert.equal(p.run(`newestMatches.get('${OPEN_ID}').at`), first + 20 * MIN, 'the new week is first seen now, not 20 minutes ago');
});

test('matchesToReread: a body from an earlier week is read again; one behind in its own week is not (js/api.js)', () => {
  const p = fresh();
  p.call('keepNewestMatch', stepOf(2));
  const old = stepOf(1);
  old.start_time = new Date(Date.parse(openMatch.start_time) - 7 * 24 * 60 * MIN).toISOString();
  const earlier = p.call('matchesToReread', [old], []);
  assert.deepEqual(JSON.parse(JSON.stringify(earlier.need)), [OPEN_ID]);
  assert.deepEqual(JSON.parse(JSON.stringify(earlier.behind)), []);
  const sameWeek = p.call('matchesToReread', [stepOf(1)], []);
  assert.deepEqual(JSON.parse(JSON.stringify(sameWeek.need)), [], 'its own week is a question for our copy');
  assert.deepEqual(JSON.parse(JSON.stringify(sameWeek.behind)), [OPEN_ID]);
});

test('fetchMatches: a list with a body behind asks our copy, and the copy\'s newer body is the one shown (js/api.js)', async () => {
  const p = fresh();
  p.call('keepNewestMatch', stepOf(1));
  const asked = serveFrom(p, { game: [stepOf(0)], copy: [stepOf(2)] });
  const list = await p.call('fetchMatches', LIST_URL, 4000, []);
  assert.equal(asked(), 1);
  assert.deepEqual(shownOf(list.find((m) => m.id === OPEN_ID)), shownOf(stepOf(2)));
});

test('fetchMatches: one open match answered behind asks our copy, and shows its newer body (js/api.js)', async () => {
  const p = fresh();
  p.call('keepNewestMatch', stepOf(1));
  const asked = serveFrom(p, { game: stepOf(0), copy: [stepOf(2)] });
  const got = await p.call('fetchMatches', ONE_URL, 4000, []);
  assert.equal(asked(), 1);
  assert.deepEqual(shownOf(got), shownOf(stepOf(2)));
});

test('fetchMatches: the game failing for an open match, our copy that is further along stands in; a copy that is not, the error stays (js/api.js)', async () => {
  const p = fresh();
  p.call('keepNewestMatch', stepOf(1));
  serveFrom(p, { game: new TypeError('offline'), copy: [stepOf(3)] });
  assert.deepEqual(shownOf(await p.call('fetchMatches', ONE_URL, 4000, [])), shownOf(stepOf(3)));
  const q = fresh();
  q.call('keepNewestMatch', stepOf(1));
  serveFrom(q, { game: new TypeError('offline'), copy: [stepOf(0)] });
  await assert.rejects(() => q.call('fetchMatches', ONE_URL, 4000, []), /offline/);
});

test('latestWanted: a map reading every 30 s asks the copy though the clock is a second short; 2 s short does not (js/api.js)', () => {
  const p = fresh();
  p.call('keepNewestMatch', stepOf(1));
  p.run('latestAskedAt = Date.now()');
  p.clock.now += 29 * 1000 + 500;
  assert.equal(p.call('latestWanted', [OPEN_ID], true), true);
  p.run('latestAskedAt = Date.now()');
  p.clock.now += 28 * 1000;
  assert.equal(p.call('latestWanted', [OPEN_ID], true), false);
});

test('resolveGuildId: a pasted GUID comes back in capitals, the case of the keys of wvw/guilds (js/api.js)', async () => {
  const p = loadPage(recordedAt);
  const id = '4BBB52AA-D768-4FC6-8EDE-C299F2822F0F';
  assert.equal(await p.run(`resolveGuildId('  ${id.toLowerCase()} ')`), id);
  assert.equal(await p.run(`resolveGuildId('${id}')`), id);
  const link = await p.run(`resolveGuildId('${id.toLowerCase()}').then((g) => findLink(g, { na: { '${id}': 1001 }, eu: {} }))`);
  assert.equal(link.teamId, 1001);
});

test('copyHolds: the copy holds the matches with a new read, not the one standing still; none when the copy cannot answer (js/api.js)', () => {
  const p = loadPage(Date.UTC(2026, 10, 12, 12, 0, 0));
  const ids = ['1-1', '1-2', '1-3', '1-4', '2-1', '2-2', '2-3', '2-4', '2-5'];
  const others = ids.filter((id) => id !== '1-3');
  p.ctx.__ids = ids;
  const held = (oldAge, lead = 0) => p.run(`(() => {
    ownClockLead = ${lead};
    const shown = __ids.map((id) => ({ id, start_time: '2026-11-07T02:00:00Z', end_time: '2026-11-14T02:00:00Z',
      scores: { red: 5, blue: 1, green: 1 } }));
    const at = (age) => (Date.now() - ownClockLead - age) / 1000;
    latestSummaryLearn(Object.fromEntries(shown.map((m) => [m.id,
      { start: Date.parse(m.start_time), score: 7, at: at(m.id === '1-3' ? ${oldAge} : 10e3) }])));
    return JSON.stringify(copyHolds(shown));
  })()`);
  assert.deepEqual(held(9 * MIN), JSON.stringify(others), 'one of nine 9 minutes old: the other eight are held');
  assert.deepEqual(held(60e3), JSON.stringify(ids), 'all within the 90 s: all held');
  assert.deepEqual(held(9 * MIN, 3 * MIN), JSON.stringify(others), 'a device clock 3 minutes ahead: the new eight are still held');
  assert.equal(p.run(`copyHolds(__ids.map((id) => ({ id, start_time: '2026-11-14T02:00:00Z' })))`), null, 'a week the copy does not know');
  assert.equal(p.run(`(() => { latestSummaryLearn(Object.fromEntries(__ids.map((id) =>
    [id, { start: Date.parse('2026-11-07T02:00:00Z'), score: 7, at: (Date.now() - ownClockLead - 5 * 60e3) / 1000 }])));
    return copyHolds(__ids.map((id) => ({ id, start_time: '2026-11-07T02:00:00Z' }))); })()`), null, 'every at old: the copy cannot answer');
});

// The five places that read a game instant on the server's time, Date.now() - steadyClockLead (js/config.js,
// js/maps.js, js/relink.js), with the visitor's clock off by minutes.
const SEC = 1000;

for (const lead of [5 * MIN, -5 * MIN]) {
  const ahead = lead > 0;
  // The banner on server time `server` with the visitor's clock off by `lead`; every stat and banner built is kept.
  function banner(server, setup) {
    const p = fresh();
    p.set('steadyClockLead', lead);
    p.clock.now = server + lead;
    const seen = { value: [], stat: [], rebuild: [] };
    p.set('buildRelinkValue', (...a) => { seen.value.push(a); return p.ctx.document; });
    p.set('buildRelinkStat', (...a) => { seen.stat.push(a); return p.ctx.document; });
    p.set('buildRebuildBanner', (...a) => { seen.rebuild.push(a); });
    setup(p);
    p.call('updateRelinkBanner');
    return seen;
  }

  test(`clock ${ahead ? 'ahead' : 'behind'} by 5 min: matchIsLive, flippedAgo, riLeft, tickRi read the server's time`, () => {
    const p = fresh();
    const server = p.clock.now;
    p.set('steadyClockLead', lead);
    p.clock.now = server + lead;
    const at = (ms) => new Date(server + ms).toISOString();

    assert.equal(p.call('matchIsLive', { end_time: at(MIN) }), true);
    assert.equal(p.call('matchIsLive', { end_time: at(-MIN) }), false);

    assert.equal(p.call('flippedAgo', at(-3 * MIN)), '3m');
    assert.equal(p.call('flippedAgo', at(MIN)), null);

    assert.equal(p.call('riLeft', at(-4 * MIN)), MIN);
    assert.equal(p.call('riLeft', at(-6 * MIN)), 0);

    const clocks = [];
    const badge = (until) => ({
      dataset: { until: String(server + until) },
      remove() { this.gone = true; },
      querySelector: () => ({ set textContent(v) { clocks.push(v); } }),
    });
    const live = badge(MIN), over = badge(-MIN);
    p.call('tickRi', { querySelectorAll: () => [live, over] });
    assert.equal(over.gone, true);
    assert.equal(live.gone, undefined);
    assert.deepEqual(clocks, [p.call('riClock', MIN)]);
  });

  test(`clock ${ahead ? 'ahead' : 'behind'} by 5 min: the banner's countdown and urgency read the server's time`, () => {
    const server = Date.UTC(2026, 10, 11, 12);
    // Two hours is the urgent line: 118 min is urgent, 122 min is not; each wrong clock lands on the other side.
    const away = (ahead ? 122 : 118) * MIN;
    const seen = banner(server, (p) => {
      p.set('relinkNA', server + away);
      p.set('relinkEU', server + away);
    });
    const [naLeft, euLeft, naUrgent, euUrgent] = seen.value[0];
    assert.equal(naLeft, away);
    assert.equal(euLeft, away);
    assert.equal(naUrgent, !ahead);
    assert.equal(euUrgent, !ahead);
  });

  for (const [region, day, hour, resetAt] of [['NA', 14, 2], ['EU', 13, 18]]) {
    test(`clock ${ahead ? 'ahead' : 'behind'} by 5 min: ${region} counts as resetting by the server's time`, () => {
      // 10 min after the reset the region is resetting; 17 min after it is not (the arrival window is 15).
      const server = Date.UTC(2026, 10, day, hour) + (ahead ? 10 : 17) * MIN;
      const seen = banner(server, (p) => {
        p.set('relinkNA', server + 6 * 60 * MIN);
        p.set('relinkEU', server + 6 * 60 * MIN);
      });
      assert.equal(seen.value[0][region === 'NA' ? 4 : 5], ahead);
    });
  }

  test(`clock ${ahead ? 'ahead' : 'behind'} by 5 min: the lockout reads the server's time`, () => {
    const server = Date.UTC(2026, 10, 11, 12);
    const seen = banner(server, (p) => {
      p.set('timersLoaded', true);
      p.set('lockoutTime', server + 2 * MIN);
    });
    const lockout = seen.stat.find((a) => a[0] === 'Season Lockout');
    assert.equal(lockout[1], '2m');
  });

  test(`clock ${ahead ? 'ahead' : 'behind'} by 5 min: the rebuild window opens and counts by the server's time`, () => {
    const server = Date.UTC(2026, 10, 11, 12);
    const seen = banner(server, (p) => {
      p.set('timersLoaded', true);
      p.set('lockoutTime', server - 2 * MIN);
      p.set('assignNA', server + 2 * MIN);
      p.set('assignEU', server + 4 * MIN);
    });
    assert.deepEqual(seen.rebuild, [[2 * MIN, 4 * MIN]]);
  });
}

// What fetchOwnApi keeps in steadyClockLead, by the real path: a fake fetch answers with a Date header
// (whole seconds, as a server sends it) from a server `trueLead` behind the visitor's clock.
function metering(trueLead) {
  const p = fresh();
  p.ctx.AbortController = AbortController;
  const T0 = Date.UTC(2026, 10, 11, 12);
  // One own-API answer, generated `frac` ms into the second `second` s after T0, arriving `trip` ms later.
  p.answer = async (second, frac, { trip = 0, date = true } = {}) => {
    const server = T0 + second * SEC + frac;
    p.clock.now = server + trueLead;
    p.set('fetch', async () => {
      const header = new Date(T0 + second * SEC).toUTCString();
      p.clock.now += trip;
      return { ok: true, headers: { get: () => (date ? header : null) }, json: async () => ({}) };
    });
    await p.call('fetchOwnApi', 'https://wvwrelink.com/api/x', 'no-store');
  };
  p.steady = () => p.run('steadyClockLead');
  p.T0 = T0;
  return p;
}

test('steadyClockLead: a right clock stays 0 whatever fraction of a second each answer carries', async () => {
  const p = metering(0);
  for (const [i, frac] of [300, 900, 100, 950, 0, 999].entries()) {
    await p.answer(i, frac);
    assert.equal(p.steady(), 0);
    assert.equal(p.run('ownClockLead'), frac, 'ownClockLead still takes every reading as it comes');
  }
});

test('steadyClockLead: the RI badge clock on a right clock counts down one second per tick', async () => {
  const p = metering(0);
  const clocks = [];
  const badge = { dataset: { until: String(p.T0 + 130 * SEC) }, remove() {},
    querySelector: () => ({ set textContent(v) { clocks.push(v); } }) };
  const fractions = [300, 900, 100, 950, 400];
  for (const [i, frac] of fractions.entries()) {
    p.clock.now = p.T0 + i * SEC;
    p.call('tickRi', { querySelectorAll: () => [badge] });
    await p.answer(i, frac);
  }
  assert.deepEqual(clocks, fractions.map((_, i) => p.call('riClock', (130 - i) * SEC)));
});

test('steadyClockLead: a clock minutes off is corrected and does not move with the fraction of the second', async () => {
  const p = metering(5 * MIN);
  await p.answer(0, 300);
  const first = p.steady();
  assert.ok(Math.abs(first - 5 * MIN) <= SEC, `first reading ${first}`);
  for (const [i, frac] of [900, 100, 950, 0].entries()) {
    await p.answer(i + 1, frac);
    assert.equal(p.steady(), first, `moved on fraction ${frac}`);
  }
});

test('steadyClockLead: a clock fixed mid-session returns to exactly 0', async () => {
  const p = metering(10 * MIN);
  await p.answer(0, 300);
  assert.ok(p.steady() > 9 * MIN);
  const fixed = metering(400);
  fixed.set('steadyClockLead', p.steady());
  await fixed.answer(1, 0);
  assert.equal(fixed.steady(), 0);
});

test('steadyClockLead: a clock 4.5 s ahead stays 0 until a reading leaves the band, then moves once', async () => {
  const p = metering(4500);
  await p.answer(0, 300);
  assert.equal(p.steady(), 0);
  await p.answer(1, 900);
  const moved = p.steady();
  assert.ok(moved > 5 * SEC && moved < 6 * SEC, `moved to ${moved}`);
  await p.answer(2, 100);
  assert.equal(p.steady(), moved, 'and stops there');
});

test('steadyClockLead: the page clock is never before the newest `at` the server gave, refused readings included', async () => {
  const p = metering(0);
  const DAY = 24 * 60 * MIN;
  p.set('steadyClockLead', 2 * DAY);
  const at = Math.floor(p.T0 / 1000) - 5;
  p.clock.now = p.T0;
  p.set('fetch', async () => {
    p.clock.now += 1500;   // past CLOCK_TRIP_MAX_MS: the reading is refused
    return { ok: true, headers: { get: () => new Date(p.T0).toUTCString() }, text: async () => JSON.stringify({ at, matches: [] }) };
  });
  await p.call('latestRead');
  assert.ok(p.run('steadyNow()') >= at * 1000, `steadyNow ${p.run('steadyNow()')} before ${at * 1000}`);
  assert.ok(p.steady() < MIN, `lead ${p.steady()}`);
  const before = p.run('steadyNow()');
  p.clock.now += 10 * SEC;
  assert.equal(p.run('steadyNow()'), before + 10 * SEC, 'and it keeps walking');
});

// One /api/latest answer for `at` s, generated at the server instant `server`; `trip` ms of travel (over CLOCK_TRIP_MAX_MS: refused).
async function latestAnswer(p, trueLead, server, at, trip) {
  p.clock.now = server + trueLead;
  p.set('fetch', async () => {
    p.clock.now += trip;
    return { ok: true, headers: { get: () => new Date(server).toUTCString() }, text: async () => JSON.stringify({ at, matches: [] }) };
  });
  await p.call('latestRead');
}

test('steadyClockLead: the floor leaves a lead the server time agrees with, and one within the band', async () => {
  const measured = metering(-5 * MIN);
  measured.set('steadyClockLead', -5 * MIN);
  await latestAnswer(measured, -5 * MIN, measured.T0, measured.T0 / 1000 - 30, 1500);
  assert.equal(measured.steady(), -5 * MIN, 'a measured lead with an `at` 30 s old');
  const near = metering(0);
  await latestAnswer(near, 0, near.T0, near.T0 / 1000 + 3, 1500);
  assert.equal(near.steady(), 0, 'an `at` 3 s ahead is inside the band');
});

test('steadyClockLead: a body stamped on the page clock keeps its age when the floor moves the lead and a reading then lands', async () => {
  const p = metering(-5 * MIN);
  const S = p.T0;
  const stamped = S - 5 * MIN;   // the page clock, 5 min behind, took the body's time
  p.ctx.__k = { at: stamped, clockAt: stamped };
  p.run("newestMatches.set('m', __k)");
  await latestAnswer(p, -5 * MIN, S, S / 1000 - 1, 1500);   // refused: the floor moves the lead
  assert.ok(p.steady() < -4 * MIN, `lead ${p.steady()}`);
  await latestAnswer(p, -5 * MIN, S, S / 1000 - 1, 0);   // accepted
  const at = p.run("newestMatches.get('m').at");
  assert.ok(Math.abs(at - S) <= 5 * SEC, `at ${at - S} from the server's time`);
});

test('steadyClockLead: a body stamped on the page clock still moves when the reading after the floor lands outside the band', async () => {
  const p = metering(-10 * MIN);
  const S = p.T0;
  const stamped = S - 10 * MIN;
  p.ctx.__k = { at: stamped, clockAt: stamped };
  p.run("newestMatches.set('m', __k)");
  await latestAnswer(p, -10 * MIN, S, S / 1000 - 20, 1500);   // refused: the floor moves the lead 21.5 s from the truth
  assert.ok(p.steady() < -9 * MIN, `lead ${p.steady()}`);
  await latestAnswer(p, -10 * MIN, S, S / 1000 - 20, 0);   // accepted: 21.5 s is past the band
  const at = p.run("newestMatches.get('m').at");
  assert.ok(Math.abs(at - S) <= 5 * SEC, `at ${at - S} from the server's time`);
});

test('steadyClockLead: an answer without a Date header changes nothing', async () => {
  const p = metering(5 * MIN);
  await p.answer(0, 300);
  const kept = p.steady();
  await p.answer(1, 300, { date: false });
  assert.equal(p.steady(), kept);
  assert.equal(p.run('ownClockLead'), 0, 'ownClockLead still falls to 0 with no Date');
  const q = metering(0);
  await q.answer(0, 300, { date: false });
  assert.equal(q.steady(), 0);
});

test('steadyClockLead: an answer slower than a second changes nothing', async () => {
  const p = metering(5 * MIN);
  await p.answer(0, 300, { trip: 1500 });
  assert.equal(p.steady(), 0);
  await p.answer(1, 300, { trip: 1000 });
  assert.ok(p.steady() > 4 * MIN, 'a second exactly still counts');
  const kept = p.steady();
  await p.answer(2, 300, { trip: 2000 });
  assert.equal(p.steady(), kept);
});

test('steadyClockLead: a body first seen before the lead is known is moved to the server\'s time when it is, and one dated by a copy stays', async () => {
  for (const lead of [5 * MIN, -5 * MIN]) {
    for (const trip of [0, 1500]) {
      const p = metering(lead);
      await p.answer(0, 300);
      p.set('steadyClockLead', 0);
      p.set('clockMeasured', false);
      p.set('ownClockLead', 0);
      const server = p.T0 + 10 * SEC;
      p.clock.now = server + lead;
      p.call('keepNewestMatch', stepOf(1));
      p.clock.now += 3 * SEC;
      p.call('keepNewestMatch', stepOf(1));   // the same body again keeps the stamp
      const dated = { ...stepOf(1), id: '1-2' };
      p.ctx.__latest = dated;
      p.run('latestBodyAt.set(__latest, Date.now() - steadyClockLead - 90000)');
      p.call('keepNewestMatch', dated);
      const at = () => p.run(`[newestMatches.get('${OPEN_ID}').at, newestMatches.get('1-2').at]`);
      assert.equal(at()[0], server + lead, 'control: stamped on the page clock, a repeat keeping it');
      const copyAt = at()[1];
      await p.answer(11, 300, { trip });
      // The Date header is whole seconds: the lead is right to within one.
      assert.ok(Math.abs(at()[0] - (trip > 1000 ? server + lead : server)) < SEC, `lead ${lead}, trip ${trip}: ${at()[0] - server}`);
      assert.equal(at()[1], copyAt, 'a body the copy dated keeps its time');
      if (trip > 1000) {
        await p.answer(12, 300);
        assert.ok(Math.abs(at()[0] - server) < SEC, 'the next reading moves it');
      }
      // A stamp made after the first reading is on the server's time already: a later change of the lead moves nothing.
      const fixed = at()[0];
      p.clock.now = p.T0 + 20 * SEC + lead;
      p.call('keepNewestMatch', stepOf(2));
      const second = p.run(`newestMatches.get('${OPEN_ID}').at`);
      p.set('fetch', async () => ({ ok: true, headers: { get: () => new Date(p.T0 + 20 * SEC).toUTCString() }, json: async () => ({}) }));
      p.clock.now += 3 * MIN;
      await p.call('fetchOwnApi', 'https://wvwrelink.com/api/x', 'no-store');
      assert.equal(p.run(`newestMatches.get('${OPEN_ID}').at`), second, 'a later change of the lead moves no stamp');
      assert.equal(p.run(`newestMatches.get('${OPEN_ID}').clockAt`), undefined, 'after the first reading no stamp is marked as the page clock');
      assert.ok(fixed !== undefined);
    }
  }
});

// Every place that compares a game or server instant with the clock (js/standings.js, js/api.js, js/maps-early.js,
// js/maps.js, js/stat-popovers.js), with the visitor's clock off by minutes: each reads the server's time. A threshold `limit`
// is probed 30 s to the young side on a clock ahead and 30 s to the old side on one behind, so either wrong clock lands across it.
for (const lead of [5 * MIN, -5 * MIN]) {
  const ahead = lead > 0;
  const side = ahead ? 'ahead' : 'behind';
  const probe = (limit) => limit + (ahead ? -30 * SEC : 30 * SEC);
  const skewed = () => {
    const p = fresh();
    const server = p.clock.now;
    p.set('steadyClockLead', lead);
    p.clock.now = server + lead;
    return { p, server };
  };
  const iso = (ms) => new Date(ms).toISOString();
  const teams = { red: 11001, blue: 11002, green: 11003 };
  const body = (server, over = {}) => ({
    id: '1-1', start_time: iso(server - 600 * MIN), end_time: iso(server + 24 * 60 * MIN),
    scores: { red: 1, blue: 1, green: 1 }, kills: { red: 1, blue: 1, green: 1 }, deaths: { red: 1, blue: 1, green: 1 },
    maps: [], all_worlds: { red: [11001], blue: [11002], green: [11003] }, ...over });
  const keep = (p, m, at, rose = false) => {
    p.ctx.__m = { match: m, at, rose };
    p.run("newestMatches.set(__m.match.id, __m)");
  };
  const entry = (s, e, server) => ({ s, e, t: teams, v: server });
  const weeks = (p, obj) => p.ctx.localStorage.setItem('wvw-weeks-v1', JSON.stringify(obj));
  // regionResetting's `now` argument, from every call a function makes.
  const resettingNows = (p) => {
    const nows = [];
    p.set('regionResetting', (region, now) => { nows.push(now); return false; });
    return nows;
  };
  const quiet = (promise) => { if (promise && promise.catch) promise.catch(() => {}); };

  test(`clock ${side} by 5 min: showRegion asks regionResetting for the server's time (js/standings.js)`, () => {
    const { p, server } = skewed();
    const nows = resettingNows(p);
    p.call('showRegion', p.ctx.document, p.ctx.document, [], 'NA', 0, false);
    assert.deepEqual(nows.slice(0, 1), [server]);
  });

  test(`clock ${side} by 5 min: the retry notices ask regionResetting for the server's time (js/standings.js)`, () => {
    const { p, server } = skewed();
    const nows = resettingNows(p);
    p.set('paintRetryStatus', () => {});
    p.set('standingsFailed', [{ el: {}, region: 'NA', label: 'NA' }]);
    p.set('standingsExtraUsed', 99);
    p.call('planStandingsRetry');
    assert.deepEqual(nows, [server]);
    p.set('standingsExtraUsed', 0);
    p.call('planStandingsRetry');
    assert.deepEqual(nows, [server, server]);
  });

  test(`clock ${side} by 5 min: loadStandings asks regionResetting for the server's time (js/standings.js)`, () => {
    const { p, server } = skewed();
    const nows = resettingNows(p);
    p.set('paintRetryStatus', () => {});
    p.set('standingsFailed', [{ el: {}, region: 'NA', label: 'NA' }]);
    quiet(p.call('loadStandings', 'retry'));
    assert.deepEqual(nows, [server]);

    const q = skewed();
    const cycle = resettingNows(q.p);
    q.p.set('standingsEverLoaded', true);
    q.p.run("matchDataCache.set('1-1', {})");
    quiet(q.p.call('loadStandings', 'cycle'));
    assert.deepEqual(cycle.slice(0, 2), [q.server, q.server]);
  });

  test(`clock ${side} by 5 min: the week memory drops an ended entry by the server's time when read and when saved (js/api.js)`, () => {
    // An entry that ends 1 min after the server's now, on a clock ahead; 1 min before it, on a clock behind.
    const { p, server } = skewed();
    const e = ahead ? server + MIN : server - MIN;
    weeks(p, { '1-1': entry(server - 60 * MIN, e, server) });
    assert.deepEqual(clone(p.run('[...weekStoreRead().keys()]')), ahead ? ['1-1'] : []);
    p.run(`weekStore.set('1-2', ${JSON.stringify(entry(server - 60 * MIN, e, server))})`);
    p.call('weekStoreSave');
    assert.deepEqual(clone(p.run("[...weekStore.keys()].filter((id) => id === '1-2')")), ahead ? ['1-2'] : []);
  });

  test(`clock ${side} by 5 min: the week memory holds an entry for two hours by the server's time (js/api.js)`, () => {
    const { p, server } = skewed();
    const s = server - probe(120 * MIN);
    weeks(p, { '1-1': entry(s, server + 7 * 24 * 60 * MIN, server) });
    assert.equal(!!p.call('weekHeld', '1-1'), ahead);
  });

  test(`clock ${side} by 5 min: an offered body is kept or refused by the server's time (js/api.js)`, () => {
    // The memory holds a later week for 2 h by the server's time: an earlier body is refused inside it, kept after.
    const { p, server } = skewed();
    const had = server - probe(120 * MIN);
    weeks(p, { '1-1': entry(had, server + 7 * 24 * 60 * MIN, server) });
    p.call('weekStoreOffer', body(server, { start_time: iso(had - 60 * MIN) }));
    assert.equal(p.run("weekStoreRead().get('1-1').s") === had, ahead);
    // A week that starts 60 min after the server's now is the most that is kept: 62 min is refused, 58 min kept.
    const q = skewed();
    const s = q.server + (ahead ? 62 : 58) * MIN;
    q.p.call('weekStoreOffer', body(q.server, { id: '1-2', start_time: iso(s), end_time: iso(s + 7 * 24 * 60 * MIN) }));
    assert.equal(q.p.run("weekStoreRead().has('1-2')"), !ahead);
  });

  test(`clock ${side} by 5 min: a region's line-up is written by the server's time (js/api.js)`, () => {
    const { p, server } = skewed();
    const s = server + (ahead ? 62 : 58) * MIN;
    p.call('weekStoreRegion', '1', [body(server, { start_time: iso(s), end_time: iso(s + 7 * 24 * 60 * MIN) })]);
    assert.equal(p.run("weekStoreRead().has('1-1')"), !ahead);
  });

  test(`clock ${side} by 5 min: the history redates a first sight when it is stale by the server's time (js/api.js)`, () => {
    const { p, server } = skewed();
    keep(p, body(server), server);
    p.ctx.__by = new Map([['1-1', [{ at: server - probe(5 * MIN), n: {} }]]]);
    assert.equal(p.run('ageFirstSightFromHistory(__by, 5 * 60000, () => ({}))'), ahead ? 0 : 1);
  });

  test(`clock ${side} by 5 min: a summary redates a kept body and says if it rose lately by the server's time (js/api.js)`, () => {
    const { p, server } = skewed();
    const m = body(server);
    keep(p, m, server);
    const alive = p.run('KILLS_ALIVE_MS');
    p.call('latestSummaryLearn', { '1-1': { start: Date.parse(m.start_time), score: 3, at: (server - probe(alive)) / 1000 } });
    assert.equal(p.run("newestMatches.get('1-1').rose"), ahead);
  });

  test(`clock ${side} by 5 min: a body first seen is dated by the server's time, and a quiet one is asked after by it (js/api.js)`, () => {
    const { p, server } = skewed();
    const m = body(server);
    p.call('keepNewestMatch', m);
    assert.equal(p.call('matchScoreRoseAt', '1-1'), server);
    // A copy's date, 1 min old, is the body's time.
    p.run('newestMatches.clear()');
    p.ctx.__m = m;
    p.run('latestBodyAt.set(__m, Date.now() - steadyClockLead - 60000)');
    p.call('keepNewestMatch', m);
    assert.equal(p.call('matchScoreRoseAt', '1-1'), server - MIN);
    // `rose`: a copy's date within KILLS_ALIVE_MS of the server's now.
    p.run('newestMatches.clear()');
    p.run(`latestBodyAt.set(__m, Date.now() - steadyClockLead - ${probe(p.run('KILLS_ALIVE_MS'))})`);
    p.call('keepNewestMatch', m);
    assert.equal(p.run("newestMatches.get('1-1').rose"), ahead);
    // latestWanted: a body quiet for LATEST_QUIET_MS is asked after.
    p.run('latestAskedAt = 0; latestSummaryAt = 0');
    keep(p, m, server - probe(p.run('LATEST_QUIET_MS')));
    assert.equal(p.call('latestWanted', ['1-1']), !ahead);
  });

  test(`clock ${side} by 5 min: a sample is stamped with the server's time of the ask, and kept while it ages by it (js/maps-early.js)`, () => {
    const { p, server } = skewed();
    const m = body(server, { maps: [{ type: 'Center', kills: { red: 5, blue: 0, green: 0 } }] });
    keep(p, m, server - 5000, true);
    p.call('recordFightSamples', [m], server + lead - 10000);
    const log = () => JSON.parse(p.ctx.localStorage.getItem(p.run('FIGHT_KEY')));
    assert.deepEqual(log()['1-1'].map((s) => s.at), [server - 10000]);
    // Ageing out at FIGHT_KEEP_MS, on the match the call names and on the ones it does not.
    const old = server - probe(p.run('FIGHT_KEEP_MS'));
    p.ctx.localStorage.setItem(p.run('FIGHT_KEY'), JSON.stringify({ '1-1': [{ at: old, n: { Center: 1 } }], '1-2': [{ at: old, n: { Center: 1 } }] }));
    p.call('recordFightSamples', [{ ...m, maps: [] }], server + lead);
    assert.equal(Object.values(log()).flat().length, ahead ? 2 : 0);
  });

  test(`clock ${side} by 5 min: fightLogAheadAt reads a sample's age by the server's time (js/maps-early.js)`, () => {
    const { p, server } = skewed();
    const m = body(server, { maps: [{ type: 'Center', kills: { red: 1, blue: 0, green: 0 } }] });
    const at = server - probe(p.run('FIGHT_KEEP_MS'));
    p.ctx.localStorage.setItem(p.run('FIGHT_KEY'), JSON.stringify({ '1-1': [{ at, n: { Center: 99 } }] }));
    assert.equal(p.call('fightLogAheadAt', m), ahead ? at : 0);
  });

  test(`clock ${side} by 5 min: fightSamples drops what is past its floor by the server's time (js/maps-early.js)`, () => {
    const { p, server } = skewed();
    const at = server - probe(p.run('FIGHT_STALE_MS'));
    p.ctx.localStorage.setItem(p.run('FIGHT_KEY'), JSON.stringify({ '1-1': [{ at, n: {} }] }));
    assert.deepEqual(clone(p.call('fightSamples', body(server)).map((s) => s.at)), ahead ? [at] : []);
  });

  test(`clock ${side} by 5 min: killView counts a body frozen and alive by the server's time (js/maps-early.js)`, () => {
    const { p, server } = skewed();
    const m = body(server);
    keep(p, m, server - probe(p.run('HUD_STALE_MS')), true);
    assert.equal(p.call('killView', m, []).frozen, !ahead);
    keep(p, m, server - probe(p.run('KILLS_ALIVE_MS')), true);
    assert.equal(p.call('killView', m, []).alive, ahead);
  });

  test(`clock ${side} by 5 min: the history counts as alive by the server's time (js/maps-early.js)`, () => {
    const { p, server } = skewed();
    const m = body(server);
    keep(p, m, server);
    const line = server - probe(p.run('HISTORY_LIVE_MS'));
    p.ctx.__by = new Map([['1-1', [{ at: line, n: {} }]]]);
    p.run('ageFromHistory(__by)');
    assert.equal(p.run("newestMatches.get('1-1').at"), ahead ? line : server);
  });

  test(`clock ${side} by 5 min: the peek compares a kept body's time with the server's (js/standings.js)`, () => {
    // handAhead() is the peek's other way to load; with it false, only the "behind" test loads.
    const { p, server } = skewed();
    const m = body(server);
    keep(p, m, server - probe(p.run('PEEK_BEHIND_MS')));
    p.set('handAhead', () => false);
    p.set('peekLearn', () => {});
    p.set('pushMissed', () => {});
    p.set('summaryAt', () => 0);
    p.set('summaryAhead', () => true);
    p.set('mapAhead', null);
    let loads = 0;
    p.set('loadStandings', () => { loads++; });
    p.set('fetchOwnApi', async () => ({ '1-1': {} }));
    p.set('latestSummaryLearn', () => {});
    p.set('peekLoadedAt', 0);
    return p.call('peekLatest').then(() => assert.equal(loads, ahead ? 0 : 1));
  });
  test(`clock ${side} by 5 min: the "while you were away" summary measures a kept body's age by the server's time (js/maps-early.js)`, () => {
    const { p, server } = skewed();
    const before = body(server, { maps: [{ type: 'Center', kills: { red: 1, blue: 0, green: 0 } }] });
    const after = body(server, { maps: [{ type: 'Center', kills: { red: 50, blue: 0, green: 0 } }], kills: { red: 50, blue: 1, green: 1 } });
    keep(p, before, server - probe(p.run('MISSED_AWAY_MS')));
    p.run(`missedLastOffer.set('1-1', steadyNow() - 60000)`);
    const calls = [];
    p.set('missedMakeNote', (...a) => { calls.push(a.slice(2, 5)); });
    p.set('missedRefreshNote', () => true);
    p.call('missedMatchOffered', after, p.run("newestMatches.get('1-1')"));
    assert.deepEqual(clone(calls.map((c) => c[2])), ahead ? [] : ['pause']);
  });
  // A body offered 20 min after the one kept, with more kills on a map: the summary's period is the server's.
  const gapOf = (p, server) => {
    const kills = (n) => ({ maps: [{ type: 'Center', kills: { red: n, blue: 0, green: 0 } }], kills: { red: n, blue: 1, green: 1 } });
    p.call('keepNewestMatch', body(server, kills(1)));
    return { after: body(server, kills(50)), server };
  };

  test(`clock ${side} by 5 min: the summary after a gap spans the server's time, not the page's (js/maps-early.js)`, () => {
    const { p, server } = skewed();
    const { after } = gapOf(p, server);
    p.clock.now += 19 * MIN;
    p.call('keepNewestMatch', body(server, { maps: [{ type: 'Center', kills: { red: 1, blue: 0, green: 0 } }], kills: { red: 1, blue: 1, green: 1 } }));
    p.clock.now += 1 * MIN;
    p.call('keepNewestMatch', after);
    const note = p.run("missedNotes.get('1-1')");
    assert.ok(note, 'a summary was made');
    assert.equal(note.rawSince, server);
    assert.equal(note.back, server + 20 * MIN);
    assert.equal(note.until, server + 20 * MIN + p.run('MISSED_SHOW_MS'));
    assert.ok(p.run("missedNoteFor('1-1')"), 'still up before its time');
    p.clock.now += p.run('MISSED_SHOW_MS') - 1000;
    assert.ok(p.run("missedNoteFor('1-1')"), 'still up a second before its time');
    p.clock.now += 2000;
    assert.equal(p.run("missedNoteFor('1-1')"), null, 'gone after its time');
  });

  test(`clock ${side} by 5 min: the summary on a return spans the server's time, not the page's (js/maps-early.js)`, () => {
    const { p, server } = skewed();
    const { after } = gapOf(p, server);
    p.ctx.document = { visibilityState: 'hidden' };
    p.run('missedOnVisibility()');
    const away = p.run('MISSED_AWAY_MS') + 2 * MIN;
    p.clock.now += away;
    p.ctx.document = { visibilityState: 'visible' };
    p.run('missedOnVisibility()');
    p.call('keepNewestMatch', after);
    const note = p.run("missedNotes.get('1-1')");
    assert.ok(note, 'a summary was made');
    assert.equal(note.kind, 'return');
    assert.equal(note.rawSince, server);
    assert.equal(note.back, server + away);
  });

  test(`clock ${side} by 5 min: the skirmish chart calls a body stalled by the server's time (js/stat-popovers.js)`, () => {
    const { p, server } = skewed();
    p.set('ownClockLead', lead);
    // The block clock is 2 min past the last published block; the body rose just under or over HUD_STALE_MS ago.
    const start = server - 2 * 2 * 60 * MIN - 2 * MIN;
    const m = body(server, { start_time: iso(start), skirmishes: [{ scores: { red: 10, blue: 1, green: 1 } }, { scores: { red: 20, blue: 1, green: 1 } }] });
    keep(p, m, server - probe(p.run('HUD_STALE_MS')), true);
    const shown = [];
    p.set('popFigure', (label, value) => { shown.push([label, value]); return p.ctx.document; });
    p.call('renderSkirmishTrendPopoverContent', p.ctx.document, 'Server', m, 'red');
    // Stalled: the running block is cut off, so the last block shown is the first.
    assert.deepEqual(clone(shown.find(([label]) => label === 'Last block')), ['Last block', ahead ? '20' : '10']);
  });
  test(`clock ${side} by 5 min: the map's score time is called stale by the server's time (js/maps.js)`, () => {
    const { p, server } = skewed();
    const m = body(server);
    const at = server - probe(p.run('HUD_STALE_MS'));
    keep(p, m, at, true);
    // Nodes that take anything and remember the classes toggled on them.
    const toggled = [];
    const node = () => new Proxy({}, {
      get: (o, k) => (k === 'classList' ? { toggle: (c, on) => toggled.push([c, on]), add() {}, remove() {} }
        : k in o ? o[k] : () => node()),
      set: (o, k, v) => { o[k] = v; return true; },
    });
    p.ctx.document = { createElement: () => node(), createTextNode: () => node() };
    const corners = p.call('buildMapCorners', node(), '1-1');
    corners.paint(p.call('killView', m, []), 'Center', at);
    assert.deepEqual(toggled.find(([c]) => c === 'is-stale'), ['is-stale', !ahead]);
  });
  test(`clock ${side} by 5 min: a history line inside a gap redates by the server's time (js/api.js)`, () => {
    const { p, server } = skewed();
    const m = body(server);
    const gapServer = server - 2 * MIN;
    p.ctx.__m = { match: m, at: server, rose: false, gapFrom: gapServer + lead };
    p.run("newestMatches.set('1-1', __m)");
    p.ctx.__by = new Map([['1-1', [{ at: gapServer + (ahead ? 30 : -30) * SEC, n: {} }]]]);
    p.run('ageBehindHistory(__by, () => ({}))');
    assert.equal(p.run("newestMatches.get('1-1').at") !== server, ahead);
  });

  test(`clock ${side} by 5 min: scoreFresh and the "counting since" tip read the server's time (js/maps.js)`, () => {
    const { p, server } = skewed();
    assert.equal(p.call('scoreFresh', server - probe(p.run('HOT_NOW_MS')), p.run('HOT_NOW_MS')), ahead);
    const m = body(server);
    keep(p, m, server, true);
    const titles = [];
    const node = () => new Proxy({}, {
      get: (o, k) => (k === 'classList' ? { toggle() {}, add() {}, remove() {} } : k in o ? o[k] : () => node()),
      set: (o, k, v) => { if (k === 'title') titles.push(v); o[k] = v; return true; },
    });
    p.ctx.document = { createElement: () => node(), createTextNode: () => node() };
    p.ctx.matchMedia = () => ({ matches: true, addEventListener() {} });
    const corners = p.call('buildMapCorners', node(), '1-1');
    const view = { ...p.call('killView', m, []), counting: { since: server - 9 * MIN, ready: server + (ahead ? MIN : -MIN) } };
    corners.paint(view, 'Center', server - MIN);
    assert.equal(titles.some((t) => String(t).startsWith('Counting since')), ahead);
  });

  test(`clock ${side} by 5 min: recentCaptures sets its ceiling by the server's time (js/maps.js)`, () => {
    const { p, server } = skewed();
    const flip = (id, at) => ({ id, type: 'Camp', owner: 'Red', last_flipped: iso(at) });
    const early = flip('1-1-a', server - 10 * MIN);
    const edge = flip('1-1-b', ahead ? server + 90 * SEC : server - 210 * SEC);
    const m = body(server, { maps: [{ type: 'Center', objectives: [early, edge] }] });
    p.ctx.__m = m;
    const ids = clone(p.run('recentCaptures(__m)')).map((c) => c.id);
    assert.deepEqual(ids, ahead ? ['1-1-a'] : ['1-1-b', '1-1-a']);
  });
}

test('fetchJson: a retry that fails on the network is not retried again by the attempt before it (js/api.js)', async () => {
  const answers = {
    '503, then the network twice': [{ status: 503 }, 'net', 'net'],
    '429 with Retry-After, then the network twice': [{ status: 429, retryAfter: '2' }, 'net', 'net'],
  };
  const waits = {
    '503, then the network twice': [500, 1000],
    '429 with Retry-After, then the network twice': [2000, 1000],
  };
  for (const [name, script] of Object.entries(answers)) {
    const page = fresh();
    const slept = [];
    let fetches = 0;
    page.ctx.AbortController = AbortController;
    // The 10 s deadline never fires; a wait between tries returns at once and is noted.
    page.ctx.setTimeout = (fn, ms) => { if (ms >= 10000) return 0; slept.push(ms); fn(); return 0; };
    page.ctx.fetch = async () => {
      const a = script[fetches++];
      if (a === 'net') throw new (page.run('TypeError'))('offline');
      return { status: a.status, ok: false, headers: { get: () => a.retryAfter ?? null } };
    };
    const err = await page.run("fetchJson('/x').catch((e) => e)");
    assert.equal(fetches, 3, `${name}: fetches`);
    assert.deepEqual(slept, waits[name], `${name}: waits`);
    assert.equal(err.network, true, `${name}: the last error is the network's`);
  }
});

test('keepNewestMatch: a fault in the summary hook never costs it its body (js/api.js)', () => {
  const { p, id, now } = happened();
  p.run(`missedMatchOffered = () => { throw new Error('on purpose'); }`);
  const up = clone(openMatch); up.scores.red += 100;
  let got;
  assert.doesNotThrow(() => { got = p.call('keepNewestMatch', up); });
  assert.equal(p.run(`newestMatches.get('${id}').match.scores.red`), up.scores.red);
  assert.equal(got.scores.red, up.scores.red);
});

// ---- The bodies /api/latest offers (js/api.js) ---------------------------------
const liveTwo = matches.filter((m) => Date.parse(m.end_time) > recordedAt).slice(0, 2);

const scoreSum = (m) => m.scores.red + m.scores.blue + m.scores.green;

const bumped = (m, n) => ({ ...clone(m), scores: { ...m.scores, red: m.scores.red + n } });

const latestEntry = (m, over = {}) => ({ id: m.id, start: Date.parse(m.start_time), score: scoreSum(m), at: 0, by: 'check-page', v: 2, body: m, ...over });

function readLatest(p, answer) {
  p.ctx.__text = JSON.stringify(answer);
  p.run('fetchOwnApi = async () => __text');
  return p.run('latestRead()');
}

test('latestRead: only the newer body of a known id passes; another match\'s body, or an id the game never gave, does not (js/api.js)', async () => {
  const [a, b] = liveTwo;
  const p = fresh();
  for (const m of liveTwo) p.call('keepNewestMatch', clone(m));
  const got = await readLatest(p, { at: 0, matches: [
    latestEntry(bumped(a, 5000)),
    latestEntry(bumped(a, 99999), { id: b.id }),
    latestEntry(bumped(a, 99999), { id: '1-9' }),
  ] });
  assert.deepEqual(Array.from(got, (x) => x.id), [a.id], 'only the body whose own id is the entry\'s');
  p.ctx.__got = got;
  p.run('offerLatest(__got)');
  assert.equal(p.run(`colorSum(newestMatches.get('${a.id}').match.scores)`), scoreSum(a) + 5000);
  assert.equal(p.run(`colorSum(newestMatches.get('${b.id}').match.scores)`), scoreSum(b), 'the other match is untouched');
  assert.equal(p.run(`newestMatches.has('1-9')`), false);
});

test('latestRead: garbage in any field the page checks passes nothing (js/api.js)', async () => {
  const a = liveTwo[0];
  const at = Date.parse(a.start_time);
  const p = fresh();
  const garbage = [
    { id: a.id, start: at, v: 2, body: 'not a body' },
    { id: a.id, start: at, v: 2, body: { ...bumped(a, 5000), maps: null } },
    { id: a.id, start: at, v: 2 },
  ];
  assert.deepEqual(Array.from(await readLatest(p, { at: 0, matches: garbage })), []);
  assert.equal((await readLatest(p, { at: 0, matches: [latestEntry(bumped(a, 5000), { start: at + 1 })] })).length, 0, 'a start that is not the body\'s');
  assert.equal((await readLatest(p, { at: 0, matches: [latestEntry(bumped(a, 5000))] })).length, 1, 'control: the same body, well formed');
});

test('latestRead: a newer body over the size cap does not pass (js/api.js)', async () => {
  const a = liveTwo[0];
  const pad = 300 * 1024;
  const p = fresh();
  assert.equal((await readLatest(p, { at: 0, matches: [latestEntry({ ...bumped(a, 5000), pad: ' '.repeat(pad) })] })).length, 0);
  assert.equal((await readLatest(p, { at: 0, matches: [latestEntry({ ...bumped(a, 5000), pad: ' '.repeat(1000) })] })).length, 1, 'control: the body under the cap');
});
