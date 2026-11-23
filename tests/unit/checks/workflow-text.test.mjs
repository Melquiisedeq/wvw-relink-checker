// The helpers every check writes its log with: scripts/workflow-text.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strip, fixed, decode, makeFetchText } from '../../../scripts/workflow-text.mjs';
import { fakeFetch, fakeSleep } from './fake-http.mjs';

test('strip takes Python\'s whitespace: FS, GS, RS, US and NEL go, the BOM stays', () => {
  assert.equal(strip(' \t\n\v\f\r\x1c\x1d\x1e\x1f\x85\xa0 　x '), 'x');
  assert.equal(strip('\ufeffx'), '\ufeffx');
  for (const c of ['\u1680', '\u2000', '\u200a', '\u2029', '\u202f', '\u205f']) assert.equal(strip(`${c}x${c}`), 'x', c.charCodeAt(0).toString(16));
  assert.equal(strip('\u200bx\u200b'), '\u200bx\u200b');
  assert.equal(strip('a b'), 'a b');
  assert.equal(strip(''), '');
  assert.equal(strip(' \n '), '');
});

test('strip is linear: a long run of spaces inside the text costs no more than its length', () => {
  const inside = `x${' '.repeat(200000)}y`;
  const t = Date.now();
  assert.equal(strip(inside), inside);
  assert.equal(strip(` ${inside} `), inside);
  assert.ok(Date.now() - t < 2000);
});

test('fixed rounds like %.Nf: a value exactly halfway goes to the even digit', () => {
  const table = [[0.25, 1, '0.2'], [0.75, 1, '0.8'], [90.5, 0, '90'], [91.5, 0, '92'], [-0.25, 1, '-0.2'], [2.675, 1, '2.7'], [0.05, 1, '0.1'], [100, 1, '100.0'], [-0.04, 1, '-0.0'], [1.25, 1, '1.2'], [1.35, 1, '1.4']];
  for (const [x, d, want] of table) assert.equal(fixed(x, d), want, `${x}`);
  assert.equal(fixed(Infinity, 1), 'Infinity');
});

test('decode keeps a leading BOM and replaces bad bytes', () => {
  assert.equal(decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), '\ufeffA');
  assert.equal(decode(new Uint8Array([0x41, 0xff])), 'A�');
});

test('fetchText tries three times with a pause of five seconds between, and words what went wrong', async () => {
  const sleep = fakeSleep();
  const down = makeFetchText({ fetchFn: fakeFetch(() => ({ status: 503 })), sleep, userAgent: 'ua' });
  assert.deepEqual(await down('https://x/'), [null, 'HTTP 503 after 3 attempts']);
  assert.deepEqual(sleep.slept, [5, 5]);
  const fetchFn = fakeFetch(() => ({ body: 'ok' }));
  const seen = [];
  const up = makeFetchText({ fetchFn: (u, i) => { seen.push(i.headers['User-Agent']); return fetchFn(u, i); }, sleep: fakeSleep(), userAgent: 'wvwrelink-test' });
  assert.deepEqual(await up('https://x/'), ['ok', null]);
  assert.deepEqual(seen, ['wvwrelink-test']);
  const dead = makeFetchText({ fetchFn: async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); }, sleep: fakeSleep(), userAgent: 'ua' });
  assert.deepEqual(await dead('https://x/'), [null, 'TypeError: fetch failed (ENOTFOUND) after 3 attempts']);
});
