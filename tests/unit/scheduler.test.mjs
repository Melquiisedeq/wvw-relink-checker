// The scheduler's pg_net timeout must outlast the reader's serial waits, or the
// Worker push (the last step) can be cut off. Reads both files as text.
// Run: node --test "tests/unit/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../../supabase/${name}`, import.meta.url), 'utf8');

test('call_reader timeout is longer than the reader\'s serial deadlines', () => {
  const reader = read('reader.mjs');
  const waits = [...reader.matchAll(/AbortSignal\.timeout\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.equal(waits.length, (reader.match(/\bfetch\(/g) || []).length, 'every fetch in the reader has a literal AbortSignal.timeout');
  const timeouts = [...read('scheduler.sql').matchAll(/timeout_milliseconds\s*:=\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(timeouts.length, 1, 'one timeout_milliseconds in the scheduler');
  const sum = waits.reduce((a, b) => a + b, 0);
  assert.ok(timeouts[0] > sum, `timeout ${timeouts[0]} ms must exceed the reader's ${sum} ms`);
});

test('both readers are scheduled every 30 seconds and the peek follows', () => {
  const sql = read('scheduler.sql');
  const jobs = [...sql.matchAll(/cron\.schedule\('(reader-[a-z]+)',\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(jobs, [['reader-us', '30 seconds'], ['reader-eu', '30 seconds']]);
  const page = readFileSync(new URL('../../site/js/standings.js', import.meta.url), 'utf8');
  assert.match(page, /const PEEK_EVERY_MS = 30 \* 1000;/, 'the peek follows the beat');
});

test('the serial waits fit in one beat', () => {
  const waits = [...read('reader.mjs').matchAll(/AbortSignal\.timeout\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(waits.reduce((a, b) => a + b, 0) < 30000, 'the serial waits fit in one beat');
});
