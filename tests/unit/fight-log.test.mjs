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

// A visitor clock minutes ahead: samples written before the first accepted reading sit on the device's clock and must follow it.
function skewedPage() {
  const page = loadPage(NOW);
  const body = (k) => JSON.stringify({ id: '1-1', start_time: new Date(NOW - 86400000).toISOString(),
    end_time: new Date(NOW + 86400000).toISOString(),
    maps: [{ type: 'Center', kills: { red: k, blue: 0, green: 0 } }], scores: { red: k, blue: 0, green: 0 } });
  const offer = (k) => page.run(`(() => { const b = ${body(k)}; newestMatches.set('1-1', { match: b, at: steadyNow(), rose: true }); recordFightSamples([b], Date.now()); })()`);
  const log = () => JSON.parse(page.run(`localStorage.getItem('wvw-fight-v1')`))['1-1'];
  const served = () => page.run('steadyNow()');
  return { ...page, offer, log, served };
}

test('an unmeasured sample follows the clock when the first reading finds it 10 min ahead', () => {
  const p = skewedPage();
  p.offer(100);
  p.run('moveClock(600000, true); clockMeasured = true;');
  p.clock.now = NOW + 120000;
  p.offer(140);
  const samples = p.log();
  assert.equal(samples.length, 2, 'the new sample is kept next to the moved one');
  assert.ok(samples.every((s) => s.at <= p.served()), 'no sample sits in the server clock\'s future');
  assert.equal(samples[0].at, NOW - 600000);
  assert.deepEqual(samples.map((s) => s.n.Center), [100, 140]);
});

test('a floored clock moves the page\'s unmeasured samples and a later reading moves them once', () => {
  const p = skewedPage();
  p.offer(100);
  p.run('moveClock(300000, false)');
  assert.equal(p.log()[0].at, NOW - 300000);
  p.run('moveClock(600000, true); clockMeasured = true;');
  assert.equal(p.log()[0].at, NOW - 600000);
  p.run('moveClock(0, true)');
  assert.equal(p.log()[0].at, NOW - 600000, 'after the reading the sample is on the server\'s time and stays');
});

test('samples this page did not write stay where they are when the clock moves', () => {
  const p = skewedPage();
  const other = { at: NOW - 120000, n: { Center: 5 } };
  p.run(`localStorage.setItem('wvw-fight-v1', ${JSON.stringify(JSON.stringify({ '1-1': [other] }))})`);
  p.offer(100);
  p.run('moveClock(600000, true); clockMeasured = true;');
  assert.deepEqual(p.log().map((s) => s.at), [other.at, NOW - 600000]);
});

test('a reading that leaves the margin alone still ends the wait; a sample written after it is never moved', () => {
  const p = skewedPage();
  p.offer(100);
  p.run('moveClock(0, true); clockMeasured = true;');
  p.clock.now = NOW + 120000;
  p.offer(140);
  p.run('moveClock(300000, true)');
  assert.deepEqual(p.log().map((s) => s.at), [NOW, NOW + 120000], 'neither the settled sample nor the later one moves');
});
