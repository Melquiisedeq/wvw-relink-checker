// A body behind the data the page already holds, and what the page shows then: the kept body,
// our copy from /api/latest, the fight log and the summary of what happened (js/api.js, js/maps-early.js).
// The scripts load into the vm of page-harness.mjs; the game's answer and the copy are stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, loadRecording } from './page-harness.mjs';

const { recordedAt, matches } = loadRecording();
const MIN = 60000;
const clone = (x) => JSON.parse(JSON.stringify(x));
const live = matches.find((m) => Date.parse(m.end_time) > recordedAt && m.maps.some((x) => x.kills));
const ID = live.id;

function fresh() {
  const page = loadPage(recordedAt);
  const call = (name, ...args) => { page.ctx.__args = args; return page.run(`${name}(...__args)`); };
  return { ...page, call };
}
// The recorded live match, `k` steps into its week: only ever more kills, deaths and score.
function step(k) {
  const m = clone(live);
  m.kills.red += 100 * k;
  m.deaths.red += 100 * k;
  m.scores.red += 50 * k;
  for (const map of m.maps) map.kills.red = Number(map.kills.red || 0) + 40 * k;
  return m;
}
const shown = (m) => [m.kills.red, m.deaths.red, m.scores.red];

// The game answers `game` (or fails), our copy answers `copy`; counts how often the copy was asked.
function serve(p, { game, copy }) {
  p.ctx.URL = URL;
  p.ctx.__copy = copy;
  p.ctx.__game = game;
  p.ctx.__asked = 0;
  p.run('fetchJson = async () => { if (__game.message === "offline") throw __game; return __game; }');
  p.run('latestRead = () => { __asked++; return Promise.resolve(__copy); }');
  return () => p.ctx.__asked;
}
const ONE = `https://api.guildwars2.com/v2/wvw/matches?id=${ID}`;
const LIST = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';

test('matchIsBehind: more kills and deaths decide before the score, so older activity with a higher score is behind (js/api.js)', () => {
  const p = fresh();
  const kept = step(2);
  const stale = clone(kept);
  stale.deaths.red -= 10;
  stale.scores.red += 10;
  assert.equal(p.call('matchIsBehind', stale, kept), true, 'fewer deaths is a body from before, whatever its score says');
  assert.equal(p.call('matchIsBehind', kept, stale), false, 'and the other way round it is not');
});

test('keepNewestMatch: a new week with a low score still moves the data, so its time restarts (js/api.js)', () => {
  const p = fresh();
  p.call('keepNewestMatch', step(2));
  const first = p.run(`newestMatches.get('${ID}').at`);
  p.clock.now += 20 * MIN;
  const week = 7 * 24 * 60 * MIN;
  const next = clone(live);
  next.start_time = new Date(Date.parse(live.start_time) + week).toISOString();
  next.end_time = new Date(Date.parse(live.end_time) + week).toISOString();
  for (const f of ['kills', 'deaths', 'scores']) for (const c of Object.keys(next[f])) next[f][c] = 0;
  p.call('keepNewestMatch', next);
  assert.equal(p.run(`newestMatches.get('${ID}').match.start_time`), next.start_time);
  assert.equal(p.run(`newestMatches.get('${ID}').at`), first + 20 * MIN, 'the new week is first seen now, not 20 minutes ago');
});

test('matchesToReread: a body from an earlier week is read again; one behind in its own week is not (js/api.js)', () => {
  const p = fresh();
  p.call('keepNewestMatch', step(2));
  const old = step(1);
  old.start_time = new Date(Date.parse(live.start_time) - 7 * 24 * 60 * MIN).toISOString();
  const earlier = p.call('matchesToReread', [old], []);
  assert.deepEqual(JSON.parse(JSON.stringify(earlier.need)), [ID]);
  assert.deepEqual(JSON.parse(JSON.stringify(earlier.behind)), []);
  const sameWeek = p.call('matchesToReread', [step(1)], []);
  assert.deepEqual(JSON.parse(JSON.stringify(sameWeek.need)), [], 'its own week is a question for our copy');
  assert.deepEqual(JSON.parse(JSON.stringify(sameWeek.behind)), [ID]);
});

test('fetchMatches: a list with a body behind asks our copy, and the copy\'s newer body is what is shown (js/api.js)', async () => {
  const p = fresh();
  p.call('keepNewestMatch', step(1));
  const asked = serve(p, { game: [step(0)], copy: [step(2)] });
  const list = await p.call('fetchMatches', LIST, 4000, []);
  assert.equal(asked(), 1);
  assert.deepEqual(shown(list.find((m) => m.id === ID)), shown(step(2)));
});

test('fetchMatches: one open match answered behind asks our copy, and shows its newer body (js/api.js)', async () => {
  const p = fresh();
  p.call('keepNewestMatch', step(1));
  const asked = serve(p, { game: step(0), copy: [step(2)] });
  const got = await p.call('fetchMatches', ONE, 4000, []);
  assert.equal(asked(), 1);
  assert.deepEqual(shown(got), shown(step(2)));
});

test('fetchMatches: the game failing for an open match, our copy that is further along stands in; a copy that is not, the error stays (js/api.js)', async () => {
  const p = fresh();
  p.call('keepNewestMatch', step(1));
  serve(p, { game: new TypeError('offline'), copy: [step(3)] });
  assert.deepEqual(shown(await p.call('fetchMatches', ONE, 4000, [])), shown(step(3)));
  const q = fresh();
  q.call('keepNewestMatch', step(1));
  serve(q, { game: new TypeError('offline'), copy: [step(0)] });
  await assert.rejects(() => q.call('fetchMatches', ONE, 4000, []), /offline/);
});

test('latestWanted: a map reading every 30 s asks the copy though the clock is a second short; 2 s short does not (js/api.js)', () => {
  const p = fresh();
  p.call('keepNewestMatch', step(1));
  p.run('latestAskedAt = Date.now()');
  p.clock.now += 29 * 1000 + 500;
  assert.equal(p.call('latestWanted', [ID], true), true);
  p.run('latestAskedAt = Date.now()');
  p.clock.now += 28 * 1000;
  assert.equal(p.call('latestWanted', [ID], true), false);
});

test('recordFightSamples: only a score this page watched rise is written to the fight log (js/maps-early.js)', () => {
  const p = fresh();
  const asked = p.clock.now;
  const log = () => p.call('readFightLog')[ID] || [];
  p.call('keepNewestMatch', step(1));
  p.call('recordFightSamples', [step(1)], asked);
  assert.equal(log().length, 0, 'a first sight may be the lagging group\'s: no line');
  p.call('keepNewestMatch', step(2));
  p.call('recordFightSamples', [step(2)], asked);
  assert.equal(log().length, 1, 'the rise watched is written');
});

// A match note: the body before the gap, the body after it, one map's kills at a time.
function note(p, before, after) {
  p.call('missedMakeNote', before, after, p.clock.now - 20 * MIN, p.clock.now, 'pause');
  return p.run(`missedNotes.get('${ID}')`);
}
const withKills = (m, perType) => {
  const x = clone(m);
  for (const map of x.maps) map.kills = { red: perType[map.type] || 0, blue: 0, green: 0 };
  return x;
};

test('missedView: a map the body says has fewer kills than before is not a negative count (js/maps-early.js)', () => {
  const p = fresh();
  const before = withKills(live, { Center: 100, RedHome: 100 });
  const after = withKills(live, { Center: 90, RedHome: 150 });
  const view = note(p, before, after);
  assert.deepEqual(JSON.parse(JSON.stringify(view.perMap.map((m) => [m.type, m.n]))), [['RedHome', 50]]);
  assert.equal(view.kills, 50);
});

test('missedView: the kills count from the newest body kept, not from a lagging one the summary was made on (js/maps-early.js)', () => {
  const p = fresh();
  p.call('keepNewestMatch', withKills(live, { Center: 100, RedHome: 300 }));
  const view = note(p, withKills(live, { Center: 100, RedHome: 100 }), withKills(live, { Center: 100, RedHome: 150 }));
  assert.equal(view.kills, 200, 'what the page now holds, 300 less the 100 before');
});

test('ageByScoreSum: a first sight takes the time of the oldest line of its week with its score, never an earlier week\'s (js/maps-early.js)', () => {
  const p = fresh();
  const body = step(1);
  p.call('keepNewestMatch', body);
  const sum = p.call('colorSum', body.scores);
  const week = Date.parse(body.start_time);
  const line = (at) => ({ at, n: {}, score: sum });
  p.call('ageByScoreSum', new Map([[ID, [line(week - 60 * MIN), line(p.clock.now - 30 * MIN)]]]));
  assert.equal(p.run(`newestMatches.get('${ID}').at`), p.clock.now - 30 * MIN);
});

test('ageByScoreSum: a score this page watched rise keeps its time (js/maps-early.js)', () => {
  const p = fresh();
  p.call('keepNewestMatch', step(1));
  p.call('keepNewestMatch', step(2));
  assert.equal(p.run(`newestMatches.get('${ID}').rose`), true, 'control: the rise was watched');
  const sum = p.call('colorSum', step(2).scores);
  p.call('ageByScoreSum', new Map([[ID, [{ at: p.clock.now - 30 * MIN, n: {}, score: sum }]]]));
  assert.equal(p.run(`newestMatches.get('${ID}').at`), p.clock.now);
});
