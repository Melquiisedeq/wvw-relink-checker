// What the standings cards print as a tie or a lead (js/panels.js), run in Node on the page's scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, loadRecording } from './page-harness.mjs';

const { recordedAt, matches } = loadRecording();
const withFigures = (field, figures) => ({ ...JSON.parse(JSON.stringify(matches[0])), [field]: figures });

test('isTiedOnVp: tied is another side on the same VP, whatever the third has, and never on a score alone (js/panels.js)', () => {
  const p = loadPage(recordedAt);
  const tied = (vp, color) => {
    p.ctx.__m = withFigures('victory_points', vp);
    return p.run(`isTiedOnVp(__m, '${color}')`);
  };
  const two = { red: 30, blue: 30, green: 10 };
  assert.equal(tied(two, 'red'), true, 'two sides on 30: the first is tied');
  assert.equal(tied(two, 'blue'), true, 'and the second');
  assert.equal(tied(two, 'green'), false, 'the third, alone on 10, is not');
  const apart = { red: 50, blue: 0, green: 30 };
  assert.equal(tied(apart, 'red'), false, 'a side on 0 does not tie one on 50');
  assert.equal(tied(apart, 'green'), false);
  assert.equal(tied({ red: 0, blue: 0, green: 0 }, 'blue'), true, 'the new week: all on 0 are tied');
});

test('getStatLeaders: a side with no deaths has no K/D and cannot lead it (js/panels.js)', () => {
  const p = loadPage(recordedAt);
  p.ctx.__m = {
    ...withFigures('kills', { red: 100, blue: 50, green: 30 }),
    deaths: { red: 0, blue: 25, green: 30 },
  };
  assert.equal(p.run('getStatLeaders(__m)').kd, 'blue', 'the dash is not a ratio: 2.00 leads over 1.00');
  p.ctx.__m.deaths = { red: 0, blue: 0, green: 0 };
  assert.equal(p.run('getStatLeaders(__m)').kd, null, 'nobody has a ratio, nobody leads');
});
