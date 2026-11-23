// scripts/check-notice.mjs with the game's timer and the relink cell made up: no network, a fixed clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, sheetUrl, heartbeatUrl, parseTimestamp, iso, ROOT, API, MAX_GAP_SECONDS, MAX_SILENCE_SECONDS } from '../../../scripts/check-notice.mjs';
import { fakeFetch, fakeSleep, lines, errors } from './fake-http.mjs';

const NOW = 1763900000;
const DAY = 86400;
const WINDOW = NOW - 10 * DAY;
const stamp = (t) => new Date(t * 1000).toISOString().replace('.000', '');
const A1 = sheetUrl(ROOT);
const A2 = heartbeatUrl(A1);

// The world as a healthy month has it; `over` changes what one answer says.
async function run(over = {}) {
  const w = {
    na: JSON.stringify({ na: stamp(WINDOW + 30 * DAY) }), cell: `${WINDOW}:${WINDOW - 3 * DAY}`, beat: String(NOW - 120), root: ROOT, ...over,
  };
  const fetchFn = fakeFetch((url) => {
    const mine = url === `${API}/wvw/timers/teamAssignment` ? 'na' : url === A1 ? 'cell' : url === A2 ? 'beat' : null;
    if (!mine) return { status: 404 };
    const v = w[mine];
    return typeof v === 'object' && v ? v : { body: v };
  });
  const sleep = fakeSleep();
  const result = await main({ fetchFn, sleep, now: () => NOW * 1000, root: w.root });
  return { ...result, log: lines(result), asked: fetchFn.asked, slept: sleep.slept };
}
const red = async (over, re) => {
  const r = await run(over);
  assert.equal(r.code, 1, r.log);
  assert.match(errors(r).join('\n'), re, r.log);
  return r;
};
const rootWith = (edit) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-'));
  fs.mkdirSync(path.join(root, 'site', 'js'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site', 'js', 'config.js'), edit(fs.readFileSync(path.join(ROOT, 'site', 'js', 'config.js'), 'utf8')));
  return root;
};

test('a healthy month is green and reads three things', async () => {
  const r = await run();
  assert.equal(r.code, 0, r.log);
  assert.equal(errors(r).length, 0);
  assert.deepEqual(r.out.slice(0, 4), ['read at        2025-11-23T12:13:20Z', `next relink    ${stamp(WINDOW + 30 * DAY)}`, `last notice    ${stamp(WINDOW - 3 * DAY)}, for the relink of ${stamp(WINDOW)}`, 'last tick      2025-11-23T12:11:20Z, 2 min ago']);
  assert.equal(r.out.at(-1), 'The notice fired for the most recent relink.');
  assert.equal(r.asked.length, 3);
  assert.ok(r.out.includes('30 days between the relink the notice last fired for and the next one.'), r.log);
});

test('the sheet url is read out of config.js, id included', () => {
  assert.match(A1, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[^/]+\/gviz\/tq\?tqx=out:csv&sheet=relink&range=A1:A1$/);
  assert.equal(A2, A1.replace('range=A1:A1', 'range=A2:A2'));
  assert.equal(heartbeatUrl('https://x/?range=A1:B2'), null);
});

test('config.js unreadable: a placeholder id, a renamed url constant, a renamed id constant', async () => {
  const paste = await run({ root: rootWith((c) => c.replace(/(const RELINK_SHEET_ID\s*=\s*')[^']+/, '$1PASTE')) });
  assert.equal(paste.code, 1);
  assert.match(paste.out.at(-1), /still holds PASTE/);
  assert.equal(paste.asked.length, 0);
  for (const edit of [(c) => c.replace('const RELINK_SHEET_URL', 'const RELINK_SHEET_LINK'), (c) => c.replace('const RELINK_SHEET_ID', 'const RELINK_SHEET_KEY')]) {
    const r = await run({ root: rootWith(edit) });
    assert.equal(r.code, 1);
    assert.match(r.out.at(-1), /could not be read out of js\/config\.js/);
    assert.equal(r.asked.length, 0);
  }
});

test('the timer: down, three tries with a pause between, then an error about the API', async () => {
  const r = await red({ na: { status: 500 } }, /did not answer \(HTTP 500 after 3 attempts\), so there is nothing to measure the notice against/);
  assert.deepEqual(r.slept, [5, 5]);
  assert.equal(r.asked.length, 3);
});

test('the timer: no na field, and a na that is not a date', async () => {
  await red({ na: '{"eu":"2025-12-01T00:00:00Z"}' }, /no readable na field/);
  await red({ na: '{"na":"2025-13-01T00:00:00Z"}' }, /does not match format/);
  await red({ na: '{"na":"2027-02-29T00:00:00Z"}' }, /does not match format/);
  await red({ na: '{"na":"2025-12-01T24:00:00Z"}' }, /does not match format/);
});

test('parseTimestamp reads a UTC instant, one-digit fields and all', () => {
  const t = (s) => parseTimestamp(s);
  assert.equal(t('1970-01-01T00:00:00Z'), 0);
  assert.equal(t('2025-11-23T12:13:20Z'), NOW);
  assert.equal(t('2028-02-29T00:00:00Z'), Date.UTC(2028, 1, 29) / 1000);
  assert.equal(t('2025-1-5T1:2:3Z'), Date.UTC(2025, 0, 5, 1, 2, 3) / 1000);
  assert.equal(t('0001-01-01T00:00:00Z'), -62135596800);
  assert.equal(t('2025-12-01T23:59:60Z'), t('2025-12-02T00:00:00Z'));
  for (const bad of ['0000-01-01T00:00:00Z', '2025-00-01T00:00:00Z', '2025-02-30T00:00:00Z', '2025-12-00T00:00:00Z', '2025-04-31T00:00:00Z', '2025-13-01T00:00:00Z', '2025-12-01T23:60:00Z', '2025-12-01T23:59:62Z', '202-12-01T00:00:00Z', '2025-12-01T00:00:00', '']) {
    assert.equal(t(bad), null, bad);
  }
});

test('iso writes the second as UTC, even for twelve digits', () => {
  assert.equal(iso(0), '1970-01-01T00:00:00Z');
  assert.equal(iso(NOW), '2025-11-23T12:13:20Z');
  assert.equal(iso(999999999999), '33658-09-27T01:46:39Z');
});

test('the relink cell: not shared names the sharing and stops; down for any other reason does not', async () => {
  for (const status of [401, 403]) {
    const r = await red({ cell: { status } }, /not shared/);
    assert.match(r.log, new RegExp(`did not answer \\(HTTP ${status} after 3 attempts\\)`));
    assert.match(r.log, /VIEWER - never Editor/);
    assert.equal(r.asked.length, 1 + 3);
  }
  const r = await red({ cell: { status: 500 } }, /relink tab of the sheet did not answer \(HTTP 500/);
  assert.ok(!/not shared/.test(r.log));
});

test('the relink cell: only two integers and a colon, quotes allowed, anything else says what it holds', async () => {
  for (const cell of [`"${WINDOW}:${WINDOW - DAY}"`, `\n ${WINDOW}:${WINDOW - DAY}\r\n`, `${WINDOW}:999999999999`, `"${WINDOW}:5`]) {
    const r = await run({ cell });
    assert.equal(r.code, 0, `${cell}\n${r.log}`);
  }
  for (const cell of ['', 'hello', `${WINDOW}:${WINDOW}:${WINDOW}`, '1234567890123:5', `${WINDOW}:1234567890123`, '١٢٣:٤٥٦', `\ufeff${WINDOW}:5`, `${WINDOW}\n:5`]) {
    const r = await red({ cell }, /does not hold two integers separated by a colon/);
    assert.match(r.log, /does not exist under that name/);
    assert.equal(r.asked.length, 2, cell);
  }
});

test('what the cell holds is quoted on one line, cut at 80 characters and never starts a command', async () => {
  const r = await red({ cell: 'x%\n::error::evil\r::warning::y' }, /It holds: x%25%0A::error::evil%0D::warning::y\./);
  assert.equal(errors(r).length, 2);
  assert.ok(r.out.every((l) => !l.startsWith('::warning::') && !l.includes('\n')));
  const cut = await red({ cell: `${'a'.repeat(79)}😀tail` }, /It holds: a{79}😀\./);
  assert.ok(!cut.log.includes('tail'));
  const empty = await red({ cell: ' \n ' }, /It holds: \(empty\)\./);
  assert.ok(empty.log);
  const long = await red({ cell: 'b'.repeat(81) }, /It holds: b{80}\./);
  assert.ok(!/b{81}/.test(long.log));
  const beat = await red({ beat: 'c'.repeat(81) }, /It holds: c{80}\./);
  assert.ok(!/c{81}/.test(beat.log));
});

test('the cell is read with Python\'s whitespace: FS and NEL go, a BOM stays', async () => {
  assert.equal((await run({ cell: `\x1c${WINDOW}:${WINDOW - DAY}\x1f`, beat: `\x85${NOW - 60}\x85` })).code, 0);
  await red({ cell: `\ufeff${WINDOW}:5` }, /does not hold two integers/);
});

test('nothing published: a window not yet reached, no window, and a window gone by', async () => {
  const quiet = await run({ cell: `${NOW + 3 * DAY}:0` });
  assert.equal(quiet.code, 0, quiet.log);
  assert.match(quiet.out.at(-1), /^Nothing published for the relink of 2025-11-26T12:13:20Z yet/);
  assert.ok(quiet.out.includes('last notice    nothing for this window yet'));
  const none = await run({ cell: '0:0' });
  assert.equal(none.code, 0);
  assert.equal(none.out.at(-1), 'No window is being watched yet - run relinkSetup() once.');
  const equal = await run({ cell: `${NOW}:0` });
  assert.equal(equal.code, 0);
  assert.match(equal.out.at(-1), /^Nothing published/);
});

test('a window gone by with no notice fails for 36 hours and then goes quiet', async () => {
  const at = (age) => run({ cell: `${NOW - age}:0` });
  for (const age of [1, 3600, 36 * 3600]) {
    const r = await at(age);
    assert.equal(r.code, 1, `${age}\n${r.log}`);
    assert.match(errors(r).join('\n'), /has gone by and the notice never fired for it/);
  }
  for (const age of [36 * 3600 + 1, 40 * DAY]) {
    const r = await at(age);
    assert.equal(r.code, 0, `${age}\n${r.log}`);
    assert.equal(errors(r).length, 0);
    assert.match(r.out.at(-1), /^The relink of .* went by with no notice, \d+ days ago/);
  }
  assert.match((await at(40 * DAY)).out.at(-1), /, 40 days ago /);
});

test('the gap between the last notice and the next relink: 45 days is a month, one more second is a missed one', async () => {
  const gap = (s) => run({ na: JSON.stringify({ na: stamp(WINDOW + s) }) });
  assert.equal(MAX_GAP_SECONDS, 45 * DAY);
  const ok = await gap(MAX_GAP_SECONDS);
  assert.equal(ok.code, 0, ok.log);
  const r = await gap(MAX_GAP_SECONDS + 1);
  assert.equal(r.code, 1);
  assert.match(errors(r).join('\n'), /that is 45 days, so at least one whole window was missed/);
  assert.equal((await gap(60 * DAY)).code, 1);
});

test('a next relink before the window is a negative number of days, floored', async () => {
  const r = await run({ na: JSON.stringify({ na: stamp(WINDOW - 3 * DAY - 7) }) });
  assert.equal(r.code, 0, r.log);
  assert.ok(r.out.includes('-4 days between the relink the notice last fired for and the next one.'), r.log);
});

test('the heartbeat: three hours old is alive, one second more is a dead trigger and the minutes are floored', async () => {
  const ok = await run({ beat: String(NOW - MAX_SILENCE_SECONDS) });
  assert.equal(ok.code, 0, ok.log);
  const r = await red({ beat: String(NOW - MAX_SILENCE_SECONDS - 59) }, /has not run for 180 minutes and is supposed to run every 5/);
  assert.ok(r.out.some((l) => l.startsWith('last tick') && l.endsWith('180 min ago')));
  assert.ok(r.out.some((l) => l.startsWith('::error::The Apps Script trigger')));
  assert.equal(r.out.at(-1), 'The notice fired for the most recent relink.');
});

test('the heartbeat from the future is a negative number of minutes and not an alarm', async () => {
  const r = await run({ beat: String(NOW + 125) });
  assert.equal(r.code, 0, r.log);
  assert.ok(r.out.some((l) => l.endsWith(', -3 min ago')), r.log);
});

test('the heartbeat cell: down, garbage and a wrong shape are each their own error, and the rest of the check goes on', async () => {
  const down = await red({ beat: { status: 404 } }, /heartbeat cell did not answer \(HTTP 404 after 3 attempts\)/);
  assert.equal(down.out.at(-1), 'The notice fired for the most recent relink.');
  for (const beat of ['hello', '', '1763900000000', `${WINDOW}:5`, `\ufeff${NOW}`]) {
    const r = await red({ beat }, /heartbeat cell holds no timestamp/);
    assert.equal(r.out.at(-1), 'The notice fired for the most recent relink.');
  }
  const quoted = await run({ beat: `"${NOW - 60}"` });
  assert.equal(quoted.code, 0, quoted.log);
  const inject = await red({ beat: '%\n::error::x' }, /It holds: %25%0A::error::x\./);
  assert.equal(errors(inject).length, 1);
});

test('the heartbeat is judged after the state cell and decides the exit when nothing else fails', async () => {
  const stale = String(NOW - DAY);
  for (const cell of [`${NOW + DAY}:0`, '0:0', `${NOW - 40 * DAY}:0`]) {
    const r = await run({ beat: stale, cell });
    assert.equal(r.code, 1, `${cell}\n${r.log}`);
    assert.equal(errors(r).length, 1);
  }
  const both = await run({ beat: stale, cell: `${NOW - 3600}:0` });
  assert.equal(both.code, 1);
  assert.equal(errors(both).length, 2);
  const gone = await run({ beat: { status: 404 }, cell: `${NOW - 3600}:0` });
  assert.equal(gone.code, 1);
  assert.equal(errors(gone).length, 2);
});

test('a state cell that is not shared never reaches the heartbeat', async () => {
  const r = await run({ cell: { status: 403 }, beat: 'junk' });
  assert.ok(!r.asked.some((a) => a.endsWith('range=A2:A2')));
});

test('the page url without the single-cell range is the heartbeat error', async () => {
  const root = rootWith((c) => c.replace('&range=A1:A1', ''));
  const url = sheetUrl(root);
  assert.equal(heartbeatUrl(url), null);
  const fetchFn = fakeFetch((u) => (u === `${API}/wvw/timers/teamAssignment` ? { body: JSON.stringify({ na: stamp(WINDOW + 30 * DAY) }) } : { body: `${WINDOW}:${WINDOW - DAY}` }));
  const r = await main({ fetchFn, sleep: fakeSleep(), now: () => NOW * 1000, root });
  assert.equal(r.code, 1);
  assert.match(errors(r).join('\n'), /no longer asks for range=A1:A1/);
});

test('a dropped connection is retried, worded with its cause, and two drops still end well', async () => {
  const healthy = fakeFetch((url) => {
    if (url === `${API}/wvw/timers/teamAssignment`) return { body: JSON.stringify({ na: stamp(WINDOW + 30 * DAY) }) };
    return { body: url === A1 ? `${WINDOW}:${WINDOW - DAY}` : String(NOW - 60) };
  });
  let drops = 0;
  const sleep = fakeSleep();
  const twice = await main({
    fetchFn: async (url, init) => { if (url === A1 && ++drops <= 2) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); return healthy(url, init); },
    sleep, now: () => NOW * 1000, root: ROOT,
  });
  assert.equal(twice.code, 0, lines(twice));
  assert.deepEqual(sleep.slept, [5, 5]);
  const dead = await main({ fetchFn: async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); }, sleep: fakeSleep(), now: () => NOW * 1000, root: ROOT });
  assert.match(errors(dead).join('\n'), /TypeError: fetch failed \(ENOTFOUND\) after 3 attempts/);
});

test('what a failed request says is escaped too: nothing a network error carries starts a command', async () => {
  const healthy = fakeFetch((url) => {
    if (url === `${API}/wvw/timers/teamAssignment`) return { body: JSON.stringify({ na: stamp(WINDOW + 30 * DAY) }) };
    return { body: url === A1 ? `${WINDOW}:${WINDOW - DAY}` : String(NOW - 60) };
  });
  for (const [target, re] of [[`${API}/wvw/timers/teamAssignment`, /timer did not answer \(Error: x%0A::error::evil after 3 attempts\)/], [A1, /tab of the sheet did not answer \(Error: x%0A::error::evil/], [A2, /heartbeat cell did not answer \(Error: x%0A::error::evil/]]) {
    const r = await main({ fetchFn: async (url, init) => { if (url === target) throw new Error('x\n::error::evil'); return healthy(url, init); }, sleep: fakeSleep(), now: () => NOW * 1000, root: ROOT });
    assert.equal(r.code, 1);
    assert.match(errors(r).join('\n'), re);
    assert.ok(r.out.every((l) => !l.includes('\n')));
  }
});
