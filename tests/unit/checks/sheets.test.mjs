// scripts/check-sheets.mjs with the two spreadsheets and the game's matches made up: no network, a fixed clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseCsv, sheetIds, csvUrl, fallbacksInCode, ROOT, GAME_MATCHES, KILLS_STALE_MINUTES } from '../../../scripts/check-sheets.mjs';
import { fakeFetch, fakeSleep, lines, errors } from './fake-http.mjs';

const NOW = 1763900000;
const MIN = 60000;
const [IDS] = [sheetIds(ROOT)[0]];
const URL_OF = { solo: csvUrl(IDS.community, 'SoloGuilds'), alli: csvUrl(IDS.community, 'Alliances'), kills: csvUrl(IDS.kills, 'kills') };
const head = (n, at) => { const h = Array.from({ length: n }, (_, i) => `c${i}`); for (const [i, v] of Object.entries(at)) h[i] = v; return h; };
const csv = (rows) => rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replaceAll('"', '""')}"` : c)).join(',')).join('\n');
const SOLO = [head(26, { 21: 'World', 19: 'API Mismatch' }), Array(26).fill('x')];
const ALLI = [head(26, { 22: 'World ID', 2: 'Guilds' }), Array(26).fill('y')];
const kills = (ageMs, extra = []) => [[NOW * 1000 - ageMs, 'm1', 1, 2, 3, 4], [NOW * 1000 - ageMs - 5 * MIN, 'm2', 1, 2, 3, 4], ...extra];

// The sheets as a healthy day has them; `over` changes what one answer says (text, rows or a { status }).
async function run(over = {}) {
  const w = { solo: SOLO, alli: ALLI, kills: kills(10 * MIN), game: [{ id: '1-1' }], root: ROOT, ...over };
  const fetchFn = fakeFetch((url) => {
    const key = Object.keys(URL_OF).find((k) => URL_OF[k] === url) ?? (url === GAME_MATCHES ? 'game' : null);
    if (!key) return { status: 404 };
    const v = w[key];
    if (key === 'game') return v && typeof v === 'object' && 'status' in v ? v : { body: v };
    if (v && typeof v === 'object' && 'status' in v) return v;
    return { body: typeof v === 'string' ? v : csv(v) };
  });
  const sleep = fakeSleep();
  const result = await main({ fetchFn, sleep, now: () => NOW * 1000, root: w.root });
  return { ...result, log: lines(result), asked: fetchFn.asked, slept: sleep.slept };
}
const red = async (over, re, count = 1) => {
  const r = await run(over);
  assert.equal(r.code, 1, r.log);
  assert.match(errors(r).join('\n'), re, r.log);
  assert.equal(errors(r).length, count, r.log);
  return r;
};
const rootWith = (file, edit) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheets-'));
  fs.mkdirSync(path.join(root, 'site', 'js'), { recursive: true });
  for (const f of ['config.js', 'sheet.js']) {
    const text = fs.readFileSync(path.join(ROOT, 'site', 'js', f), 'utf8');
    fs.writeFileSync(path.join(root, 'site', 'js', f), f === file ? edit(text) : text);
  }
  return root;
};

test('a healthy day: both sheets answer, the notes say what was read, green', async () => {
  const r = await run();
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(r.out, [
    `${'SoloGuilds'.padEnd(22)} 2 rows, 26 columns`,
    `  ${'World'.padEnd(30)} column 21, SOLO_WORLD_FALLBACK agrees`,
    `  ${'API Mismatch'.padEnd(30)} column 19, SOLO_MISMATCH_FALLBACK agrees`,
    `${'Alliances'.padEnd(22)} 2 rows, 26 columns`,
    `  ${'World ID'.padEnd(30)} column 22, ALLIANCE_WORLD_FALLBACK agrees`,
    `  ${'Guilds'.padEnd(30)} column 2, ALLIANCE_MEMBERS_FALLBACK agrees`,
    `${'kills'.padEnd(22)} 2 rows, 2 matches, newest 10.0 min old`,
    '',
    'Both sheets answer, and every column the page resolves by name is still there.',
  ]);
  assert.equal(r.asked.length, 3);
});

test('the ids and the fallbacks are read out of the page, never copied', () => {
  assert.match(IDS.community, /^[\w-]{20,}$/);
  assert.notEqual(IDS.community, IDS.kills);
  assert.deepEqual(fallbacksInCode(ROOT), { SOLO_WORLD_FALLBACK: 21, SOLO_MISMATCH_FALLBACK: 19, ALLIANCE_MEMBERS_FALLBACK: 2, ALLIANCE_WORLD_FALLBACK: 22 });
  assert.equal(csvUrl('ID', 'Solo Guilds'), 'https://docs.google.com/spreadsheets/d/ID/gviz/tq?tqx=out:csv&sheet=Solo%20Guilds');
});

test('a renamed id constant names itself and asks nothing', async () => {
  for (const [from, name] of [['const SHEET_ID', 'SHEET_ID'], ['const KILLS_SHEET_ID', 'KILLS_SHEET_ID']]) {
    const r = await run({ root: rootWith('config.js', (c) => c.replace(from, `${from}_X`)) });
    assert.equal(r.code, 1);
    assert.equal(r.asked.length, 0);
    assert.match(r.out.join('\n'), new RegExp(`^::error::${name} could not be read out of js/config\\.js`));
  }
});

test('a tab that does not answer: three tries, a pause between, and the tab is named', async () => {
  const r = await red({ solo: { status: 500 } }, /^::error::The SoloGuilds tab of the community sheet did not answer \(HTTP 500 after 3 attempts\)\. The shield icon reads that tab\./);
  assert.deepEqual(r.slept, [5, 5]);
  assert.equal(r.asked.length, 5);
  assert.ok(r.out.some((l) => l.startsWith('Alliances')), 'the other tab is still read');
  await red({ alli: { status: 403 } }, /The Alliances tab of the community sheet did not answer \(HTTP 403/);
  await red({ solo: { status: 500 }, alli: { status: 404 } }, /SoloGuilds[\s\S]*Alliances/, 2);
});

test('a tab with no rows, only blank lines, or a header and nothing under it', async () => {
  await red({ solo: '' }, /SoloGuilds tab of the community sheet came back with nothing at all - not even a header row/);
  await red({ alli: '\n\n' }, /Alliances tab no longer has a "World ID" or "World" column[\s\S]*"Guilds" column/, 2);
  await red({ solo: [SOLO[0]] }, /SoloGuilds tab of the community sheet has a header and no data under it/);
});

test('a missing header says where the page falls back to, per name asked', async () => {
  await red({ solo: [head(26, { 19: 'API Mismatch' }), ['x']] }, /SoloGuilds tab no longer has a "World" column\. js\/sheet\.js falls back to index 21, so nothing will error/);
  await red({ solo: [head(26, { 21: 'World' }), ['x']] }, /no longer has a "API Mismatch" column\. js\/sheet\.js falls back to index 19/);
  await red({ alli: [head(26, { 2: 'Guilds' }), ['x']] }, /Alliances tab no longer has a "World ID" or "World" column\. js\/sheet\.js falls back to index 22/);
  await red({ alli: [head(26, { 22: 'World ID' }), ['x']] }, /no longer has a "Guilds" column\. js\/sheet\.js falls back to index 2/);
  await red({ solo: [head(26, {}), ['x']] }, /"World" column[\s\S]*"API Mismatch" column/, 2);
  await red({ solo: [head(26, { 21: 'world', 19: 'API Mismatch' }), ['x']] }, /no longer has a "World" column/);
});

test('Alliances has World ID or World: either is enough, and the first name asked for wins', async () => {
  const world = await run({ alli: [head(26, { 22: 'World', 2: 'Guilds' }), ['x']] });
  assert.equal(world.code, 0, world.log);
  assert.ok(world.out.some((l) => l.startsWith('  World ID') && l.includes('column 22, ALLIANCE_WORLD_FALLBACK agrees')), world.log);
  const both = await run({ alli: [head(26, { 22: 'World ID', 1: 'World', 2: 'Guilds' }), ['x']] });
  assert.ok(both.out.some((l) => l.includes('column 22, ALLIANCE_WORLD_FALLBACK agrees')), both.log);
  const reverse = await run({ alli: [head(26, { 22: 'World ID', 8: 'World', 2: 'Guilds' }), ['x']] });
  assert.equal(reverse.code, 0);
});

test('a column moved is not a failure: the note says the fallback is stale; a fallback the code lost is said too', async () => {
  const moved = await run({ solo: [head(30, { 4: 'World', 19: 'API Mismatch' }), ['x']] });
  assert.equal(moved.code, 0, moved.log);
  assert.ok(moved.out.includes(`  ${'World'.padEnd(30)} column 4, but SOLO_WORLD_FALLBACK says 21 - the fallback is stale, harmless while the header is there`), moved.log);
  assert.ok(moved.out.includes('SoloGuilds'.padEnd(22) + ' 2 rows, 30 columns'));
  const lost = await run({ root: rootWith('sheet.js', (c) => c.replace(/SOLO_WORLD_FALLBACK/g, 'SOLO_WORLD_BACKUP')) });
  assert.equal(lost.code, 0, lost.log);
  assert.ok(lost.out.includes(`  ${'World'.padEnd(30)} column 21 (SOLO_WORLD_FALLBACK not found in js/sheet.js)`), lost.log);
  const lostAndGone = await run({ solo: [head(26, { 19: 'API Mismatch' }), ['x']], root: rootWith('sheet.js', (c) => c.replace('SOLO_WORLD_FALLBACK', 'SOLO_X_FALLBACK')) });
  assert.match(errors(lostAndGone).join('\n'), /falls back to index \?, so nothing will error/);
});

test('the header is read the way the csv module and str.strip read it', async () => {
  const padded = await run({ solo: [head(26, { 21: '  World ', 19: '\x85API Mismatch\x1f' }), ['x']] });
  assert.equal(padded.code, 0, padded.log);
  const nbsp = await run({ solo: [head(26, { 21: '\xa0World', 19: 'API Mismatch' }), ['x']] });
  assert.equal(nbsp.code, 0, nbsp.log);
  await red({ solo: [head(26, { 21: 'World', 19: 'API Mismatch\ufeff' }), ['x']] }, /no longer has a "API Mismatch" column/);
  const quoted = await run({ solo: `${head(26, { 21: 'World', 19: 'API Mismatch', 3: 'a,"b"' }).map((c) => (/[",]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(',')}\r\nx\r\n` });
  assert.equal(quoted.code, 0, quoted.log);
  assert.ok(quoted.out[0].includes('2 rows, 26 columns'), quoted.log);
  const blank = await run({ solo: `\n${head(26, { 21: 'World', 19: 'API Mismatch' }).join(',')}\nx\n` });
  assert.match(errors(blank).join('\n'), /no longer has a "World" column/);
  const stray = await run({ solo: `${head(26, { 21: 'World', 19: 'API Mismatch' }).join(',')}\na\rb\n` });
  assert.equal(stray.code, 1);
  assert.match(errors(stray).join('\n'), /SoloGuilds tab of the community sheet did not answer \(Error: new-line character seen in unquoted field/);
});

test('parseCsv reads what the csv module read', () => {
  const p = parseCsv;
  assert.deepEqual(p(''), []);
  assert.deepEqual(p('a,b\r\nc\n'), [['a', 'b'], ['c']]);
  assert.deepEqual(p('a,"b,""x""\nq",c\n\n,\n'), [['a', 'b,"x"\nq', 'c'], [], ['', '']]);
  assert.deepEqual(p('x,"unterminated'), [['x', 'unterminated']]);
  assert.deepEqual(p('"a"b,c'), [['ab', 'c']]);
  assert.deepEqual(p('a,b,'), [['a', 'b', '']]);
  assert.deepEqual(p('"",x'), [['', 'x']]);
  assert.deepEqual(p('a\n"b\n'), [['a'], ['b\n']]);
  assert.deepEqual(p('a"b'), [['a"b']]);
  assert.deepEqual(p('\r\n'), [[]]);
  assert.deepEqual(p('"a"'), [['a']]);
  assert.deepEqual(p('x\n"a"'), [['x'], ['a']]);
  assert.throws(() => p('\rx\n'), /new-line character seen/);
  assert.throws(() => p('a\rb\n'), /new-line character seen in unquoted field/);
  assert.throws(() => p('"a"\rb\n'), /new-line character seen/);
});

test('the kills sheet: down, empty, no stamped row, and a stamped row in another column', async () => {
  const down = await red({ kills: { status: 500 } }, /^::error::The kills sheet did not answer \(HTTP 500 after 3 attempts\)\. This is what puts the crossed swords on the busiest map\./);
  assert.deepEqual(down.slept, [5, 5]);
  await red({ kills: '' }, /kills sheet has no rows with a timestamp in them/);
  await red({ kills: 'abc,def\nx,y\n' }, /kills sheet has no rows with a timestamp in them/);
  await red({ kills: [['ts', 'id', 1, 2, 3, 4], ['-5', 'm', 1, 2, 3, 4], ['12.5', 'm', 1, 2, 3, 4], ['', 'm', 1, 2, 3, 4]] }, /no rows with a timestamp/);
});

test('narrow rows are counted among the stamped ones; a short row without a stamp is nobody\'s business', async () => {
  const r = await red({ kills: kills(MIN, [[NOW * 1000 - 9 * MIN, 'm3', 1, 2, 3], [NOW * 1000 - 9 * MIN]]) }, /^::error::2 row\(s\) in the kills sheet have fewer than 6 columns\. js\/maps-early\.js skips those/);
  assert.ok(r.out.some((l) => l.includes('4 rows, 3 matches')), r.log);
  const five = await red({ kills: [[NOW * 1000 - MIN, 'm', 1, 2, 3]] }, /^::error::1 row\(s\) in the kills sheet have fewer than 6 columns/);
  assert.ok(five.log);
  const six = await run({ kills: [[NOW * 1000 - MIN, 'm', 1, 2, 3, 4], ['not a stamp', 'm']] });
  assert.equal(six.code, 0, six.log);
  assert.ok(six.out.some((l) => l.includes('1 rows, 1 matches')), six.log);
});

test('the newest row decides, padded ids count once and empty ones not at all', async () => {
  const r = await run({ kills: [[` ${NOW * 1000 - 3 * 3600000} `, ' m1 ', 1, 2, 3, 4], [`\x85${NOW * 1000 - 20 * MIN}`, 'm1\x1f', 1, 2, 3, 4], [NOW * 1000 - 30 * MIN, '', 1, 2, 3, 4], [NOW * 1000 - 40 * MIN, '  ', 1, 2, 3, 4]] });
  assert.equal(r.code, 0, r.log);
  assert.ok(r.out.some((l) => l === `${'kills'.padEnd(22)} 4 rows, 1 matches, newest 20.0 min old`), r.log);
  const one = await run({ kills: [[NOW * 1000 - MIN, 'm1', 1, 2, 3, 4], [NOW * 1000 - 2 * MIN, 'm1', 1, 2, 3, 4], [NOW * 1000 - 3 * MIN]] });
  assert.ok(one.out.some((l) => l.endsWith('3 rows, 1 matches, newest 1.0 min old')) || one.out.some((l) => l.includes('1 matches')), one.log);
});

test('the age is written to one decimal, a half going to the even digit like %.1f, and a row from the future is negative', async () => {
  const at = async (ms) => (await run({ kills: kills(ms) })).out.find((l) => l.startsWith('kills'));
  assert.ok((await at(10.25 * MIN)).endsWith('newest 10.2 min old'));
  assert.ok((await at(10.75 * MIN)).endsWith('newest 10.8 min old'));
  assert.ok((await at(10.05 * MIN)).endsWith('newest 10.1 min old'));
  assert.ok((await at(0)).endsWith('newest 0.0 min old'));
  assert.ok((await at(-30 * MIN)).endsWith('newest -30.0 min old'));
});

test('stale means more than 90 minutes: 90 is fine, a millisecond more is a stopped trigger when the game answers', async () => {
  assert.equal(KILLS_STALE_MINUTES, 90);
  const fresh = await run({ kills: kills(90 * MIN) });
  assert.equal(fresh.code, 0, fresh.log);
  assert.ok(!fresh.asked.includes(`GET ${GAME_MATCHES}`), 'the game is asked only once the sheet is late');
  const late = await red({ kills: kills(90 * MIN + 1) }, /^::error::The newest row in the kills sheet is 90 minutes old\. The Apps Script trigger runs every five minutes and writes whenever a score rose, so it has stopped/);
  assert.ok(late.asked.includes(`GET ${GAME_MATCHES}`));
  await red({ kills: kills(91 * MIN) }, /is 91 minutes old/);
  await red({ kills: kills(3 * 1440 * MIN) }, /is 4320 minutes old/);
});

test('the minutes of a late row are written like %.0f: a half goes to the even number', async () => {
  await red({ kills: kills(90.5 * MIN) }, /is 90 minutes old/);
  await red({ kills: kills(91.5 * MIN) }, /is 92 minutes old/);
});

test('a late row with the game down is not the trigger\'s fault: the game answers nothing usable', async () => {
  const late = kills(120 * MIN);
  const msg = /^::error::The game API is not answering, so kills\.gs has nothing to write; the newest row in the kills sheet is 120 minutes old\. This clears when the game API is back\./;
  for (const game of [{ status: 500 }, [], {}, null, 'null', '"text"', '<html>', '', '[NaN]', '\ufeff[1]']) {
    const r = await red({ kills: late, game: typeof game === 'object' && game !== null && !Array.isArray(game) && !('status' in game) ? JSON.stringify(game) : game }, msg);
    assert.ok(r.asked.includes(`GET ${GAME_MATCHES}`));
  }
  await red({ kills: kills(90.5 * MIN), game: { status: 500 } }, /sheet is 90 minutes old\. This clears/);
  const slept = await red({ kills: late, game: { status: 500 } }, msg);
  assert.deepEqual(slept.slept, [5, 5]);
});

test('a late row with the game answering a list is the stopped trigger; a non-empty answer of any other shape is not a list', async () => {
  for (const game of [[0], [[]], [{ id: '1-1' }], ' \n[1]\n ']) {
    await red({ kills: kills(120 * MIN), game }, /so it has stopped - and the crossed swords stop with it, silently\./);
  }
  await red({ kills: kills(120 * MIN), game: JSON.stringify({ a: 1 }) }, /game API is not answering/);
});

test('the game flaking twice and then answering is an answer', async () => {
  let n = 0;
  const inner = fakeFetch(() => ({ body: JSON.stringify([1]) }));
  const w = { solo: csv(SOLO), alli: csv(ALLI), kills: csv(kills(120 * MIN)) };
  const fetchFn = async (url, init) => {
    const key = Object.keys(URL_OF).find((k) => URL_OF[k] === url);
    if (key) return new Response(w[key]);
    return ++n <= 2 ? new Response('', { status: 502 }) : inner(url, init);
  };
  const r = await main({ fetchFn, sleep: fakeSleep(), now: () => NOW * 1000, root: ROOT });
  assert.match(errors(r).join('\n'), /has stopped/);
});

test('every problem is one line of its own, ended by a count, and text from the sheet cannot start a command', async () => {
  const r = await run({ solo: { status: 500 }, alli: '', kills: '' });
  assert.equal(r.code, 1);
  assert.equal(errors(r).length, 3);
  assert.equal(r.out.at(-1), '3 problem(s).');
  assert.equal(r.out.at(-2), '');
  assert.ok(r.out.every((l) => !l.includes('\n')));
});

test('an Arabic-Indic digit is not a timestamp here', async () => {
  await red({ kills: [['١٧٦٣٨٩٩٩٠٠٠٠٠', 'm', 1, 2, 3, 4]] }, /no rows with a timestamp/);
});

test('what a failed request says is escaped: a network error cannot start a command', async () => {
  for (const [tab, re] of [['SoloGuilds', /SoloGuilds tab of the community sheet did not answer \(Error: x%0A::error::evil after 3 attempts\)/], ['kills', /kills sheet did not answer \(Error: x%0A::error::evil after 3 attempts\)/]]) {
    const inner = fakeFetch((url) => ({ body: csv(url === URL_OF.kills ? kills(MIN) : url === URL_OF.alli ? ALLI : SOLO) }));
    const target = tab === 'kills' ? URL_OF.kills : URL_OF.solo;
    const r = await main({ fetchFn: async (url, init) => { if (url === target) throw new Error('x\n::error::evil'); return inner(url, init); }, sleep: fakeSleep(), now: () => NOW * 1000, root: ROOT });
    assert.equal(r.code, 1);
    assert.match(errors(r).join('\n'), re);
    assert.ok(r.out.every((l) => !l.includes('\n')));
  }
});
