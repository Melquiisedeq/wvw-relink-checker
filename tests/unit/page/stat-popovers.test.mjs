// The page's rules in js/stat-popovers.js, run in Node without a browser: the scripts load into a node:vm and the rules are fed
// bodies from the e2e recording, mutated by a fixed-seed PRNG where a test says so (page/harness.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, prng, clone, fresh } from './harness.mjs';

test('skirmishProgress: block and fraction follow the clock, and stop at end_time (js/stat-popovers.js)', () => {
  const p = fresh();
  const rnd = prng(7);
  const base = matches[0];
  const start = Date.parse(base.start_time);
  const end = Date.parse(base.end_time);
  const at = (t, m = base) => { p.clock.now = t; return p.call('skirmishProgress', m); };
  assert.equal(at(start - 1), null, 'before the start');
  assert.deepEqual({ ...at(start) }, { index: 1, fraction: 0 });
  assert.deepEqual({ ...at(start + 3 * 3600000) }, { index: 2, fraction: 0.5 });
  let prev = -1;
  for (let i = 0; i < 300; i++) {
    const t = start + rnd.int(end - start);
    const r = at(t);
    const hours = (t - start) / 3600000;
    assert.ok(r.index >= 1 && r.fraction >= 0 && r.fraction < 1);
    assert.ok(Math.abs((r.index - 1) * 2 + r.fraction * 2 - hours) < 1e-9);
    const here = (r.index - 1) + r.fraction;
    const later = at(t + 1000);
    assert.ok((later.index - 1) + later.fraction >= here, 'the clock never runs backwards');
    prev = here;
  }
  assert.ok(prev >= 0);
  // A week over: the clock stops at end_time.
  const last = at(end);
  assert.deepEqual({ ...at(end + 5 * 24 * 3600000) }, { ...last });
  // The server's clock, not the device's: 5 minutes slow, a block's first minutes are not its end.
  const begin = Date.parse(base.start_time) + 4 * 3600000 + 2 * 60000;
  p.clock.now = begin - 5 * 60000;
  p.run('ownClockLead = -5 * 60000');
  const slow = p.call('skirmishProgress', base);
  assert.equal(slow.index, 3, 'a slow clock');
  assert.ok(Math.abs(slow.fraction - 1 / 60) < 1e-9, 'a slow clock');
  p.run('ownClockLead = 0');
  // An end that is not a date is ignored; a start that is not a date is no answer.
  const noEnd = clone(base);
  noEnd.end_time = 'garbage';
  assert.equal(at(start + 3600000, noEnd).index, 1);
  for (const bad of [undefined, null, 'garbage']) {
    const broken = clone(base);
    if (bad === undefined) delete broken.start_time; else broken.start_time = bad;
    assert.equal(at(start + 3600000, broken), null);
  }
});
