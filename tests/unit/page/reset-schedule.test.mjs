// The weekly reset exists in four files (page, Worker, Supabase reader, the week the map-corners spec stamps on its fake rows). If they
// disagree, each counts the week from a different instant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

const page = (text) => {
  const m = /const RESET_SCHEDULE = \{\s*NA: \[(\d+), (\d+)\],\s*EU: \[(\d+), (\d+)\],?\s*\}/.exec(text);
  return m && { NA: [+m[1], +m[2]], EU: [+m[3], +m[4]] };
};
const byId = (text) => {
  const m = /const RESET = \{\s*1: \{ day: (\d+), hour: (\d+) \},\s*2: \{ day: (\d+), hour: (\d+) \},?\s*\}/.exec(text);
  return m && { NA: [+m[1], +m[2]], EU: [+m[3], +m[4]] };
};
const specTernary = (text) => {
  const m = /const \[day, hour\] = id\[0\] === '1' \? \[(\d+), (\d+)\] : \[(\d+), (\d+)\];/.exec(text);
  return m && { NA: [+m[1], +m[2]], EU: [+m[3], +m[4]] };
};

const COPIES = [
  ['site/js/relink.js', 'const RESET_SCHEDULE = { NA: [day, hour], EU: [day, hour] }', page],
  ['worker/index.mjs', 'const RESET = { 1: { day, hour }, 2: { day, hour } }', byId],
  ['supabase/reader.mjs', 'const RESET = { 1: { day, hour }, 2: { day, hour } }', byId],
  ['tests/e2e/map-corners.spec.mjs', "const [day, hour] = id[0] === '1' ? [day, hour] : [day, hour];", specTernary]
];

test('page, Worker, reader and the map-corners spec agree on each region\'s reset', () => {
  const [first, ...rest] = COPIES.map(([file, shape, parse]) => {
    const table = parse(read(file));
    assert.ok(table, `${file}: could not find "${shape}"`);
    return [file, table];
  });
  for (const [file, table] of rest) {
    assert.deepEqual(table, first[1], `${file} differs from ${first[0]}`);
  }
});
