// The scheduler's pg_net timeout must outlast the reader's serial waits, or the
// Worker push (the last step) can be cut off. Reads both files as text.
// Run: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../supabase/${name}`, import.meta.url), 'utf8');

test('call_reader timeout is longer than the reader\'s serial deadlines', () => {
  const reader = read('reader.mjs');
  const waits = [...reader.matchAll(/AbortSignal\.timeout\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.equal(waits.length, (reader.match(/\bfetch\(/g) || []).length, 'every fetch in the reader has a literal AbortSignal.timeout');
  const timeouts = [...read('scheduler.sql').matchAll(/timeout_milliseconds\s*:=\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(timeouts.length, 1, 'one timeout_milliseconds in the scheduler');
  const sum = waits.reduce((a, b) => a + b, 0);
  assert.ok(timeouts[0] > sum, `timeout ${timeouts[0]} ms must exceed the reader's ${sum} ms`);
});
