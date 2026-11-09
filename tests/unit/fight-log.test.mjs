// The fight log (js/maps-early.js) is writable by anything on this origin: a value that is not a
// list of {at, n} per match must not make recordFightSamples throw (js/standings.js reads
// the match list inside a try, and a throw there marks the whole list failed on every cycle).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './page-harness.mjs';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const { run } = loadPage(NOW);
const KEY = 'wvw-fight-v1';
const put = (raw) => run(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(raw)})`);
const stored = () => JSON.parse(run(`localStorage.getItem(${JSON.stringify(KEY)})`));
const record = () => run('recordFightSamples([], 0)');
const good = [{ at: NOW - 60000, n: { Center: 5 } }];

for (const raw of ['{"x":1}', '{"1-1":{}}', '[1,2]', '"texto"', 'not json', 'null']) {
  test(`recordFightSamples survives ${raw} and writes a clean log`, () => {
    put(raw);
    assert.doesNotThrow(record);
    assert.deepEqual(stored(), {});
  });
}

test('a good entry survives next to bad ones and still feeds fightLogAheadAt; bad samples in a list are dropped', () => {
  put(JSON.stringify({
    '1-1': good, '1-2': {}, '1-3': 'x', '1-4': null,
    '1-5': [null, 7, { at: 'x', n: {} }, { at: NOW - 1000 }, ...good],
  }));
  assert.doesNotThrow(record);
  assert.deepEqual(stored(), { '1-1': good, '1-5': good });
  const live = { id: '1-1', start_time: new Date(NOW - 3600000).toISOString(),
    end_time: new Date(NOW + 3600000).toISOString(), maps: [{ type: 'Center', kills: { red: 1 } }] };
  assert.equal(run(`fightLogAheadAt(${JSON.stringify(live)})`), good[0].at);
});
