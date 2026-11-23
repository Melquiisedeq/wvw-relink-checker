// scripts/check-d1-writes.mjs with the API made up: how it reads the rows of each day and what it
// fails on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, judge, buildQuery, databaseId, rowsByDate, ask, ENDPOINT, ROOT } from '../../../scripts/check-d1-writes.mjs';
import { fakeFetch, lines, errors } from './fake-http.mjs';

const answer = (rows) => ({
  data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups:
    Object.entries(rows).map(([date, n]) => ({ sum: { rowsWritten: n }, dimensions: { date } })) }] } },
});
const judged = (a) => judge(a, '2026-11-16', '2026-11-17');

test('two days under 80,000 pass, and the line says both numbers', () => {
  const [line, problems] = judged(answer({ '2026-11-16': 52000, '2026-11-17': 31000 }));
  assert.equal(line, 'D1 rows written (limit 80000): 2026-11-16 52000, 2026-11-17 31000');
  assert.deepEqual(problems, []);
});

test('80,000 passes, 80,001 on either day fails naming the day', () => {
  assert.deepEqual(judged(answer({ '2026-11-16': 80000, '2026-11-17': 1 }))[1], []);
  const [, y] = judged(answer({ '2026-11-16': 80001, '2026-11-17': 1 }));
  assert.equal(y.length, 1);
  assert.match(y[0], /passed 80000 on 2026-11-16\./);
  const [, t] = judged(answer({ '2026-11-16': 5, '2026-11-17': 90000 }));
  assert.match(t[0], /on 2026-11-17\./);
  const [, both] = judged(answer({ '2026-11-16': 90000, '2026-11-17': 90000 }));
  assert.match(both[0], /on 2026-11-16 and 2026-11-17\./);
});

test('rows of one day in two groups are added', () => {
  const a = answer({ '2026-11-16': 50000 });
  a.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups.push({ sum: { rowsWritten: 31000 }, dimensions: { date: '2026-11-16' } });
  assert.equal(judged(a)[1].length, 1);
});

test('an answer with errors fails and prints the codes, not the message', () => {
  const [line, problems] = judged({ data: null, errors: [
    { message: 'echo of the query secret-xyz', extensions: { code: 'authz' } }] });
  assert.equal(line, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /1 error\(s\) \(authz\)/);
  assert.ok(!problems[0].includes('secret-xyz'));
});

test('error codes are listed once, sorted, and only when they look like a code', () => {
  const e = (code) => ({ extensions: { code } });
  assert.equal(rowsByDate({ errors: [e('b'), e('a'), e('b'), e('bad code'), e(7), e('x'.repeat(41)), { message: 'm' }, 'text'] })[1],
    'the API answered with 8 error(s) (a, b)');
  assert.equal(rowsByDate({ errors: [{ message: 'only a message' }] })[1], 'the API answered with 1 error(s)');
  assert.equal(rowsByDate({ errors: 'boom' })[1], 'the API answered with some error(s)');
  assert.equal(rowsByDate({ errors: { a: 1 } })[1], 'the API answered with some error(s)');
  assert.equal(rowsByDate({ errors: [e('a\n')] })[1], 'the API answered with 1 error(s)');
  assert.equal(rowsByDate({ errors: [e(''), e('a1'), e('b-c'), e('c_d'), e('ñé')] })[1], 'the API answered with 5 error(s) (a1, b-c, c_d, ñé)');
});

test('errors that are empty, null or zero are no error', () => {
  for (const empty of [[], {}, null, 0, '']) {
    assert.deepEqual([...rowsByDate({ ...answer({ '2026-11-16': 1 }), errors: empty })[0]], [['2026-11-16', 1]], JSON.stringify(empty));
  }
});

test('groups that are an empty string or an empty object are no days at all', () => {
  for (const none of ['', {}]) {
    const a = answer({});
    a.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups = none;
    assert.deepEqual([...rowsByDate(a)[0]], []);
  }
});

test('an empty list fails on yesterday; today with no rows yet passes', () => {
  const [, none] = judged(answer({}));
  assert.equal(none.length, 1);
  assert.match(none[0], /none on 2026-11-16/);
  const [, ok] = judged(answer({ '2026-11-16': 50000 }));
  assert.deepEqual(ok, []);
});

test('an answer of another shape fails', () => {
  const shape = 'D1 rows written: the answer is not data.viewer.accounts[0].d1AnalyticsAdaptiveGroups of {sum.rowsWritten, dimensions.date}';
  const group = (g) => ({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [g] }] } } });
  const bad = [
    { data: { viewer: { accounts: [] } } },
    { data: null },
    { data: { viewer: { accounts: {} } } },
    { data: { viewer: { accounts: [{}] } } },
    { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: 5 }] } } },
    { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: { a: 1 } }] } } },
    group({ dimensions: { date: '2026-11-16' } }),
    group({ sum: { rowsWritten: 1 } }),
    group({ sum: {}, dimensions: { date: 'x' } }),
    group({ sum: { rowsWritten: true }, dimensions: { date: 'x' } }),
    group({ sum: { rowsWritten: '5' }, dimensions: { date: 'x' } }),
    group({ sum: { rowsWritten: 1.5 }, dimensions: { date: 'x' } }),
    group({ sum: { rowsWritten: 1 }, dimensions: { date: ['x'] } }),
    group('text'),
    group({ sum: { rowsWritten: 1 }, dimensions: {} }),
  ];
  for (const a of bad) {
    const [line, problems] = judged(a);
    assert.equal(line, null, JSON.stringify(a));
    assert.deepEqual(problems, [shape], JSON.stringify(a));
  }
  assert.deepEqual(judged([1]), [null, ['D1 rows written: the answer is not an object']]);
  assert.deepEqual(judged(null), [null, ['D1 rows written: the answer is not an object']]);
});

test('the query is built from checked values only', () => {
  const database = databaseId();
  const built = (account, day) => { try { buildQuery(account, database, day, '2026-11-17'); return 'built'; } catch { return 'refused'; } };
  assert.deepEqual([
    built('a'.repeat(32), '2026-11-16'),
    built(`${'a'.repeat(32)}\n`, '2026-11-16'),
    built('a'.repeat(32), '2026-11-16"'),
    built('A'.repeat(32), '2026-11-16'),
    built('a'.repeat(31), '2026-11-16'),
    built('a'.repeat(32), '2026-11-16\n'),
  ], ['built', 'refused', 'refused', 'refused', 'refused', 'refused']);
  assert.throws(() => buildQuery('a'.repeat(32), database, '2026-11-16"', '2026-11-17'), /Not a date: '2026-11-16"'/);
  assert.throws(() => buildQuery('a'.repeat(32), database, '2026-11-16', '2026-11-17\n'), /Not a date: '2026-11-17\\n'/);
  assert.throws(() => buildQuery('z'.repeat(1) + 'a'.repeat(32), database, '2026-11-16', '2026-11-17'), /not 32 hex/);
  assert.throws(() => buildQuery('a'.repeat(32), database, 'x2026-11-16', '2026-11-17'), /Not a date/);
  assert.throws(() => buildQuery('a'.repeat(32), database, '2026-11-16', '2026-11-17x'), /Not a date/);
  assert.throws(() => buildQuery('x', database, '2026-11-16', '2026-11-17'), /CLOUDFLARE_ACCOUNT_ID is not 32 hex characters\./);
  const q = buildQuery('a'.repeat(32), database, '2026-11-16', '2026-11-17');
  assert.ok(q.includes(`accountTag: "${'a'.repeat(32)}"`) && q.includes(`databaseId: "${database}", date_geq: "2026-11-16", date_leq: "2026-11-17"`));
});

test('the database id is read from the Worker configuration, and refused when it is not a UUID', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  assert.match(databaseId(), /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  const root = mkdtempSync(join(tmpdir(), 'd1-'));
  mkdirSync(join(root, 'worker'));
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  for (const text of ['{}', '"database_id": "not-a-uuid"', '"database_id": ""', `"database_id": "x${uuid}"`, `"database_id": "${uuid}x"`, `"database_id": "${uuid}\n"`]) {
    writeFileSync(join(root, 'worker', 'wrangler.jsonc'), text);
    assert.throws(() => databaseId(root), /no longer has a "database_id" that is a UUID: update databaseId in check-d1-writes\.mjs\./);
  }
  writeFileSync(join(root, 'worker', 'wrangler.jsonc'), `{ "database_id"  :  "${uuid}" }`);
  assert.equal(databaseId(root), uuid);
});

// The run, with the clock fixed just after midnight UTC and Cloudflare answering `plan`.
const NOW = Date.parse('2026-11-17T00:30:00Z');
const ENV = { CLOUDFLARE_ANALYTICS_TOKEN: 'tok-123', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) };
async function run(plan, env = ENV) {
  const fetchFn = fakeFetch((url, init) => (typeof plan === 'function' ? plan(url, init) : plan));
  const result = await main({ fetchFn, now: () => NOW, root: ROOT, env });
  return { ...result, log: lines(result), asked: fetchFn.asked, fetchFn };
}

test('the run asks for yesterday and today, with the token, and prints the line', async () => {
  let sent;
  const r = await run((url, init) => { sent = { url, init }; return { body: answer({ '2026-11-16': 52000, '2026-11-17': 3 }) }; });
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(r.out, ['D1 rows written (limit 80000): 2026-11-16 52000, 2026-11-17 3']);
  assert.equal(sent.url, ENDPOINT);
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers.Authorization, 'Bearer tok-123');
  const { query } = JSON.parse(sent.init.body);
  assert.ok(query.includes('date_geq: "2026-11-16", date_leq: "2026-11-17"'));
});

test('without the secrets it asks nothing and says which are missing', async () => {
  const both = await run({ body: {} }, {});
  assert.equal(both.code, 1);
  assert.deepEqual(both.out, ['::error::CLOUDFLARE_ANALYTICS_TOKEN and CLOUDFLARE_ACCOUNT_ID not set: the job needs the repository secret(s).']);
  assert.deepEqual(both.asked, []);
  const one = await run({ body: {} }, { CLOUDFLARE_ANALYTICS_TOKEN: 'x' });
  assert.deepEqual(one.out, ['::error::CLOUDFLARE_ACCOUNT_ID not set: the job needs the repository secret(s).']);
  const other = await run({ body: {} }, { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) });
  assert.deepEqual(other.out, ['::error::CLOUDFLARE_ANALYTICS_TOKEN not set: the job needs the repository secret(s).']);
});

test('an account id of the wrong shape asks nothing', async () => {
  const r = await run({ body: {} }, { ...ENV, CLOUDFLARE_ACCOUNT_ID: 'nope' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, ['::error::CLOUDFLARE_ACCOUNT_ID is not 32 hex characters.']);
  assert.deepEqual(r.asked, []);
});

test('a failed ask names the status or the kind of failure and never the body or the token', async () => {
  const http = await run({ status: 403, body: 'secret-body tok-123' });
  assert.equal(http.code, 1);
  assert.deepEqual(http.out, ['::error::D1 rows written: HTTP 403']);
  const notJson = await run({ body: 'secret-body <html>' });
  assert.deepEqual(notJson.out, ['::error::D1 rows written: the answer is not JSON']);
  const down = await run(() => { throw new TypeError('fetch failed tok-123'); });
  assert.deepEqual(down.out, ['::error::D1 rows written: TypeError']);
  const named = await run(() => { throw Object.assign(new Error('x'), { name: 'Bad\n::error::injected' }); });
  assert.deepEqual(named.out, ['::error::D1 rows written: Bad%0A::error::injected']);
  const timeout = await ask(async () => { throw new DOMException('slow', 'TimeoutError'); }, 't', 'q');
  assert.deepEqual(timeout, [null, 'TimeoutError']);
});

test('over the limit, empty yesterday and an answer with errors are red, once each', async () => {
  const over = await run({ body: answer({ '2026-11-16': 81000, '2026-11-17': 1 }) });
  assert.equal(over.code, 1);
  assert.equal(errors(over).length, 1);
  assert.match(over.out[0], /^D1 rows written/);
  const none = await run({ body: answer({ '2026-11-17': 5 }) });
  assert.equal(none.code, 1);
  assert.equal(errors(none).length, 1);
  const err = await run({ body: { errors: [{ extensions: { code: 'authz' } }] } });
  assert.deepEqual(err.out, ['::error::D1 rows written: the API answered with 1 error(s) (authz)']);
});
