// The Apps Script apps-script/notes/notes.gs in a node:vm: its parser over the recorded wiki pages
// (tests/unit/worker/fixtures/notes/), and notesTick() and notesSeed() whole, its push handed to the real Worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readScript, loadScript, fakeProps, fakeLogger, fakeUtilities, httpResponse, fakeClock } from './harness.mjs';
import { workerHarness } from '../worker/harness.mjs';

const src = readScript('notes/notes.gs');
const fixture = (name) => zlib.gunzipSync(fs.readFileSync(new URL('../worker/fixtures/notes/' + name + '.gz', import.meta.url))).toString('utf8');
const PAGES = ['2026-04-14', '2026-07-15', '2026-08-11', '2026-08-17', '2026-09-29', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-16'];
const lab = JSON.parse(fs.readFileSync(new URL('../worker/fixtures/notes/lab-lines-2026.json', import.meta.url)));
const KEY = 'n'.repeat(128);
const NOW = Date.parse('2026-11-24T12:00:00Z');

function load({ props = { ingest: KEY }, answer } = {}) {
  const calls = [];
  const sleeps = [];
  const clock = fakeClock(NOW);
  const logger = fakeLogger();
  const ctx = loadScript(src, {
    UrlFetchApp: { fetch: (url, opt) => { calls.push({ url, opt }); return answer(url, opt, calls.length); } },
    Utilities: fakeUtilities({ sleeps }), Logger: logger, Date: clock.Date,
    PropertiesService: { getScriptProperties: () => fakeProps(props) }
  }, 'Notes_');
  return { ctx, calls, sleeps, logger, clock, run: () => ctx.notesTick() };
}

test('the parser gives the lab\'s WvW lines of the 2026 pages, the wiki\'s later moves of one update apart', () => {
  const { ctx } = load({ answer: () => null });
  const got = PAGES.flatMap((p) => ctx.out.notes(fixture(p + '.html'), [p]).flatMap((n) => n.lines.map((l) => ({ ...l, update: n.update, page: n.page }))));
  const key = (r) => [r.section, r.sub, r.text].join('|');
  assert.deepEqual(got.map(key).sort(), lab.map(key).sort());
  // Edited on the wiki after the lab read it: four lines now sit under another update of 10-11/11.
  const moved = ['Augury of Death: Fixed', 'Players can no longer glide', 'Players can no longer stand', 'The northern keep walls'];
  const where = (rows) => new Map(rows.filter((r) => !moved.some((m) => r.text.startsWith(m))).map((r) => [key(r), r.update]));
  assert.deepEqual(where(got), where(lab));
  assert.equal(got.find((r) => r.text.startsWith('Splinter Weapon')).link, 'Splinter Weapon');
  assert.equal(got.find((r) => r.text.startsWith('Splinter Weapon')).icon, true);
});

test('the index page: each update of the five pages it shows, on its page, an update with no WvW line included', () => {
  const { ctx } = load({ answer: () => null });
  const notes = ctx.out.notes(fixture('index-2026-11-24.html'));
  assert.deepEqual(JSON.parse(JSON.stringify(notes.map((n) => [n.page, n.update, n.lines.length]))), [
    ['2026-11-17', 'Update - November 17, 2026', 0], ['2026-11-16', 'Update - November 16, 2026', 2],
    ['2026-11-12', 'Update - November 12, 2026', 5], ['2026-11-11', 'Update 2 - November 11, 2026', 3],
    ['2026-11-11', 'Update - November 11, 2026', 1], ['2026-11-10', 'Update - November 10, 2026', 50]]);
});

test('each update\'s lead: the text under its heading before its first section, without the edit link, the first with text when the heading repeats', () => {
  const { ctx } = load({ answer: () => null });
  const lead = (notes, update) => notes.find((n) => n.update === update).lead;
  const index = ctx.out.notes(fixture('index-2026-11-24.html'));
  assert.match(lead(index, 'Update - November 10, 2026'), /^Note to users of third-party programs: The game may not launch/);
  assert.equal([...lead(index, 'Update - November 10, 2026')].length, 200);
  assert.equal(lead(index, 'Update - November 11, 2026'), '');
  // Its list sits right under the heading, with no section: not its lead.
  assert.equal(lead(ctx.out.notes(fixture('2026-04-14.html'), ['2026-04-14']), 'Late Notes - April 14, 2026'), 'Bug Fix:');
  const h2 = (t) => '<div class="mw-heading mw-heading2"><h2>' + t + '</h2><span class="mw-editsection"><span class="mw-editsection-bracket">[</span>' +
    '<a href="/w/index.php?title=Game_updates&amp;action=edit&amp;section=1">edit</a><span class="mw-editsection-bracket">]</span></span></div>';
  const li = '<h3>World vs. World</h3><ul><li>A WvW line.</li></ul>';
  const page = '<div class="mw-parser-output"><a href="/wiki/Game_updates/2026-11-10">x</a>' +
    h2('Update - November 12, 2026') + li + '<p>Note to users of third-party programs: under a section.</p>' +
    h2('Update - November 10, 2026') + li + h2('Update - November 10, 2026') + '<p><b>Note to users of third-party programs:</b> a release.</p>' + li +
    h2('Update - November 10, 2026') + '<p>Later text.</p>' + li + '<!-- NewPP limit report --></div>';
  const notes = ctx.out.notes(page);
  assert.deepEqual(JSON.parse(JSON.stringify(notes.map((n) => [n.update, n.lead, n.lines.length]))), [
    ['Update - November 12, 2026', '', 1], ['Update - November 10, 2026', 'Note to users of third-party programs: a release.', 3]]);
});

test('notesTick: one GET of the wiki\'s index with our User-Agent, then one signed push the Worker takes', async () => {
  const html = fixture('index-2026-11-24.html');
  const s = load({ answer: (url) => (url.endsWith('/api/ingest/notes') ? httpResponse(200, 'ok') : httpResponse(200, html)) });
  s.run();
  assert.deepEqual(s.calls.map((c) => c.url), ['https://wiki.guildwars2.com/wiki/Game_updates', 'https://wvwrelink.com/api/ingest/notes']);
  assert.equal(s.calls[0].opt.headers['User-Agent'], 'wvwrelink-notes (+https://wvwrelink.com)');
  assert.equal(s.calls[0].opt.followRedirects, false);
  const w = workerHarness({ start: NOW, secrets: { INGEST_NOTES: KEY } });
  const push = s.calls[1];
  const r = await w.call(new Request(push.url, { method: 'POST', body: push.opt.payload, headers: push.opt.headers }));
  assert.equal(r.status, 200);
  assert.equal(w.sql.prepare('SELECT count(*) n FROM note_group').get().n, 6);
});

test('a message over 60 KB loses its oldest pages, each whole', () => {
  const { ctx } = load({ answer: () => null });
  const line = (i) => ({ section: 'World vs. World', sub: '', text: 'WvW ' + 'x'.repeat(290) + i, link: null, icon: false });
  const note = (page, update) => ({ page, update, lines: Array.from({ length: 60 }, (_, i) => line(i)) });
  const list = [note('2026-11-12', 'Update - November 12, 2026'), note('2026-11-11', 'Update 2 - November 11, 2026'),
    note('2026-11-11', 'Update - November 11, 2026'), note('2026-11-10', 'Update - November 10, 2026')];
  const got = ctx.out.fit(list);
  // About 22 KB a note: 2026-11-10 leaves, then the whole of 2026-11-11, never one of its two.
  assert.deepEqual(got.list.map((n) => n.update), ['Update - November 12, 2026']);
  assert.equal(got.body, JSON.stringify({ v: 1, notes: got.list }));
  const small = ctx.out.fit(list.slice(0, 1));
  assert.equal(small.list.length, 1);
});

test('notesTick: a wiki answering 5xx is tried three times, waiting longer each time; a 403 throws and sends nothing', () => {
  const html = fixture('index-2026-11-24.html');
  const s = load({ answer: (url, opt, n) => (url.endsWith('/api/ingest/notes') ? httpResponse(200, 'ok') : httpResponse(n < 3 ? 503 : 200, html)) });
  s.run();
  assert.equal(s.calls.length, 4);
  assert.deepEqual(s.sleeps, [3000, 6000]);
  const refused = load({ answer: () => httpResponse(403, 'no') });
  assert.throws(() => refused.run(), /wiki: HTTP 403/);
  assert.equal(refused.calls.length, 1);
  const down = load({ answer: () => httpResponse(502, 'no') });
  assert.throws(() => down.run(), /wiki: HTTP 502/);
  assert.equal(down.calls.length, 3);
});

test('notesTick: a push the Worker refuses throws, so the trigger\'s e-mail says so; with no secret nothing is read', () => {
  const html = fixture('index-2026-11-24.html');
  const s = load({ answer: (url) => (url.endsWith('/api/ingest/notes') ? httpResponse(422, 'refused') : httpResponse(200, html)) });
  assert.throws(() => s.run(), /push: 422/);
  assert.equal(s.calls.length, 2);
  const none = load({ props: {}, answer: () => httpResponse(200, html) });
  none.run();
  assert.equal(none.calls.length, 0);
});

test('notesSecret: 128 hex characters in the ingest property, made once', () => {
  const props = {};
  const fake = fakeProps(props);
  const ctx = loadScript(src, { Utilities: fakeUtilities(), Logger: fakeLogger(), PropertiesService: { getScriptProperties: () => fake } }, 'Notes_');
  ctx.notesSecret();
  const v = fake.getProperty('ingest');
  assert.match(v, /^[0-9a-f]{128}$/);
  ctx.notesSecret();
  assert.equal(fake.getProperty('ingest'), v);
});

// ---- notesSeed: the pages the wiki's index no longer lists --------------------------------

const NOW_SEED = Date.parse('2026-11-28T12:00:00Z');
const MONTHS_URL = 'https://wiki.guildwars2.com/wiki/Game_updates/';
// The wiki as recorded: its index shows five pages, 2026-11-10 not among them; each month
// page shows every update of its month.
function wiki({ index = fixture('index-2026-11-28.html'), months = {} } = {}) {
  const pages = { [MONTHS_URL.slice(0, -1)]: index, [MONTHS_URL + 'November_2026']: fixture('month-2026-11.html'),
    [MONTHS_URL + 'October_2026']: fixture('month-2026-10.html'), [MONTHS_URL + 'September_2026']: fixture('month-2026-09.html'), ...months };
  return (url) => {
    if (url.endsWith('/api/ingest/notes')) return httpResponse(200, 'ok');
    return typeof pages[url] === 'string' ? httpResponse(200, pages[url]) : httpResponse(typeof pages[url] === 'number' ? pages[url] : 404, 'no');
  };
}
function seeded(opt) {
  const s = load({ answer: wiki(opt) });
  s.clock.now = NOW_SEED;
  s.ctx.notesSeed();
  return s;
}
const sentNotes = (s) => JSON.parse(s.calls.at(-1).opt.payload).notes;
const plain = (x) => JSON.parse(JSON.stringify(x));

test('notesSeed: one signed push of the index\'s pages and the month pages\' updates of the last 60 days, the newest page first', () => {
  const s = seeded();
  assert.deepEqual(s.calls.map((c) => c.url), [MONTHS_URL.slice(0, -1), MONTHS_URL + 'November_2026', MONTHS_URL + 'October_2026',
    MONTHS_URL + 'September_2026', 'https://wvwrelink.com/api/ingest/notes']);
  assert.ok(s.calls.slice(0, 4).every((c) => c.opt.headers['User-Agent'] === 'wvwrelink-notes (+https://wvwrelink.com)' && c.opt.followRedirects === false));
  const notes = sentNotes(s);
  assert.deepEqual(notes.map((n) => n.page), notes.map((n) => n.page).sort().reverse());
  assert.equal(new Set(notes.map((n) => n.update)).size, notes.length);
  assert.deepEqual(notes.map((n) => [n.page, n.update.replace(/, 2026$/, '')]), [
    ['2026-11-24', 'Update - November 24'], ['2026-11-17', 'Update - November 17'], ['2026-11-16', 'Update - November 16'],
    ['2026-11-12', 'Update - November 12'], ['2026-11-11', 'Update - November 11'], ['2026-11-10', 'Update 2 - November 10'],
    ['2026-11-10', 'Update - November 10'], ['2026-10-20', 'Update - October 20'], ['2026-10-15', 'Update - October 15'],
    ['2026-10-14', 'Update - October 14'], ['2026-10-13', 'Late Notes - October 13'], ['2026-10-13', 'Update - October 13'],
    ['2026-10-01', 'Update - October 1'], ['2026-09-30', 'Update - September 30'], ['2026-09-30', 'Late Notes - September 30'],
    ['2026-09-29', 'Update 2 - September 29'], ['2026-09-29', 'Update - September 29']]);
  assert.equal(notes.find((n) => n.update === 'Update - November 10, 2026').lines.length, 50);
  assert.deepEqual(s.logger.lines, ['seeded 17 updates, the index\'s and those since 2026-09-29']);
});

test('notesSeed: a month that ended before the window is not read, nor a name that is no month; a wiki that fails, or an index with no update, sends nothing', () => {
  const index = fixture('index-2026-11-28.html').replace('<a href="/wiki/Game_updates/September_2026"', '<a href="/wiki/Game_updates/November_2026">n</a><a href="/wiki/Game_updates/August_2026">a</a><a href="/wiki/Game_updates/Smarch_2026">b</a>$&');
  const s = seeded({ index });
  assert.ok(s.calls.every((c) => !/August|Smarch/.test(c.url)));
  assert.equal(s.calls.length, 5);
  const down = load({ answer: wiki({ months: { [MONTHS_URL + 'October_2026']: 503 } }) });
  down.clock.now = NOW_SEED;
  assert.throws(() => down.ctx.notesSeed(), /wiki: HTTP 503/);
  assert.ok(down.calls.every((c) => !c.url.endsWith('/api/ingest/notes')));
  const empty = load({ answer: wiki({ index: '<html></html>' }) });
  assert.throws(() => empty.ctx.notesSeed(), /no update found/);
  assert.equal(empty.calls.length, 1);
  const none = load({ props: {}, answer: wiki() });
  none.ctx.notesSeed();
  assert.equal(none.calls.length, 0);
});

test('notesSeed: a page the month page has newer than the index\'s newest still comes first, an update both show once, from the index', () => {
  const s = seeded({ index: fixture('index-2026-11-24.html') });
  const notes = sentNotes(s);
  assert.equal(notes[0].page, '2026-11-24');
  assert.deepEqual(notes.map((n) => n.page), notes.map((n) => n.page).sort().reverse());
  assert.equal(new Set(notes.map((n) => n.update)).size, notes.length);
  // The index's own copy of the update, with its lead, not a second one.
  assert.equal(notes.filter((n) => n.update === 'Update - November 10, 2026').length, 1);
  assert.equal(notes.find((n) => n.update === 'Update - November 11, 2026').lines.length, 1);
});

test('a message of more than 20 notes loses its oldest page, whole', () => {
  const { ctx } = load({ answer: () => null });
  const day = (i) => '2026-11-' + String(30 - i).padStart(2, '0');
  const list = Array.from({ length: 19 }, (_, i) => ({ page: day(i), update: 'Update - November ' + (30 - i) + ', 2026', lead: '', lines: [] }));
  // The oldest page has two notes: both leave, not one.
  list.push({ page: '2026-11-10', update: 'Update 2 - November 10, 2026', lead: '', lines: [] }, { page: '2026-11-10', update: 'Update - November 10, 2026', lead: '', lines: [] });
  const got = ctx.out.fit(list);
  assert.equal(got.list.length, 19);
  assert.deepEqual(plain(got.list.map((n) => n.page)), list.slice(0, 19).map((n) => n.page));
  assert.equal(ctx.out.fit(list.slice(0, 20)).list.length, 20);
});

test('notesSeed, then notesTick: the Worker serves 2026-11-10, the release\'s lines at once, the beta of the new map an event; without the seed it never sees it', async () => {
  const w = workerHarness({ start: NOW_SEED, secrets: { INGEST_NOTES: KEY } });
  const deliver = async (call) => {
    const r = await w.call(new Request(call.url, { method: 'POST', body: call.opt.payload, headers: call.opt.headers }));
    return r.status;
  };
  const served = async () => JSON.parse(await (await w.call(new Request('https://wvwrelink.com/api/notes'))).text());
  // A tick alone: the index has lost the update.
  const plainTick = load({ answer: wiki() });
  plainTick.clock.now = NOW_SEED;
  plainTick.run();
  assert.equal(await deliver(plainTick.calls.at(-1)), 200);
  assert.ok(!(await served()).notes.some((n) => n.update === 'Update - November 10, 2026'));
  w.advance(6 * 3600e3);
  const seed = load({ answer: wiki() });
  seed.clock.now = w.now;
  seed.ctx.notesSeed();
  assert.equal(await deliver(seed.calls.at(-1)), 200);
  const own = (data) => data.notes.filter((n) => n.update === 'Update - November 10, 2026');
  const first = own(await served());
  assert.ok(first.length > 0 && first.every((n) => n.hotfix === false));
  const beta = first.find((n) => /beta/i.test(n.text) && n.type === 'event');
  assert.ok(beta, 'the beta line is an event');
  // The next ordinary reading, six hours on, the same index as before.
  w.advance(6 * 3600e3);
  const tick = load({ answer: wiki() });
  tick.clock.now = w.now;
  tick.run();
  assert.equal(await deliver(tick.calls.at(-1)), 200);
  assert.deepEqual(own(await served()), first);
  assert.ok((await served()).notes.some((n) => n.update === 'Update - September 29, 2026'));
});
