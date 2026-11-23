// The page's rules in js/panels.js, run in Node without a browser: the scripts load into a node:vm and the rules are fed
// bodies from the e2e recording, mutated by a fixed-seed PRNG where a test says so (page/harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, MIN, clone, fresh, naTiers, teamsOf, bodyAt } from './harness.mjs';

test('standingsBoard: a tier remembered and left out of the list comes back as its line-up (js/panels.js)', () => {
  const p = fresh();
  const [a, b, c, d] = naTiers();
  p.call('weekStoreOffer', bodyAt(d, p.clock.now - 10 * MIN));
  const board = p.call('standingsBoard', [a, b, c]);
  assert.deepEqual(clone(board.map((m) => m.id)), ['1-1', '1-2', '1-3', '1-4']);
  assert.equal(board[3].lineupOnly, true, 'the fourth is the remembered line-up, not a waiting card');
  assert.equal(board[3].waitingId, undefined);
  assert.deepEqual(teamsOf(p, board[3]), teamsOf(p, d));
});

// What the standings cards print as a tie or a lead (js/panels.js).
const withFigures = (field, figures) => ({ ...JSON.parse(JSON.stringify(matches[0])), [field]: figures });

test('isTiedOnVp: tied is another side on the same VP, whatever the third has, and never on a score alone (js/panels.js)', () => {
  const p = fresh();
  const tied = (vp, color) => {
    p.ctx.__m = withFigures('victory_points', vp);
    return p.run(`isTiedOnVp(__m, '${color}')`);
  };
  const scores = (red, blue) => ({ red, blue, green: 0 });
  const two = { red: 30, blue: 30, green: 10 };
  assert.equal(tied(two, 'red'), true, 'two sides on 30: the first is tied');
  assert.equal(tied(two, 'blue'), true, 'and the second');
  assert.equal(tied(two, 'green'), false, 'the third, alone on 10, is not');
  const apart = { red: 50, blue: 0, green: 30 };
  assert.equal(tied(apart, 'red'), false, 'a side on 0 does not tie one on 50');
  assert.equal(tied(apart, 'green'), false);
  assert.equal(tied({ red: 0, blue: 0, green: 0 }, 'blue'), true, 'the new week: all on 0 are tied');
  p.ctx.__m = { ...withFigures('victory_points', two), scores: scores(900, 100) };
  assert.equal(p.run("isTiedOnVp(__m, 'red')"), true, 'the same VP with far apart scores is still a tie');
  p.ctx.__m = { ...withFigures('victory_points', apart), scores: scores(500, 500) };
  assert.equal(p.run("isTiedOnVp(__m, 'red')"), false, 'the same score on different VP is not a tie');
});

test('getStatLeaders: a side with no deaths has no K/D and cannot lead it (js/panels.js)', () => {
  const p = fresh();
  p.ctx.__m = {
    ...withFigures('kills', { red: 100, blue: 50, green: 30 }),
    deaths: { red: 0, blue: 25, green: 30 },
  };
  assert.equal(p.run('getStatLeaders(__m)').kd, 'blue', 'the dash is not a ratio: 2.00 leads over 1.00');
  p.ctx.__m.deaths = { red: 0, blue: 0, green: 0 };
  assert.equal(p.run('getStatLeaders(__m)').kd, null, 'nobody has a ratio, nobody leads');
});
