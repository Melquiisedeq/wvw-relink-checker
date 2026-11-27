// The Apps Script apps-script/notes/notes.gs in a node:vm: its parser over the recorded wiki pages
// (tests/unit/worker/fixtures/notes/), and notesTick() whole, its push handed to the real Worker.
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
  return { ctx, calls, sleeps, logger, run: () => ctx.notesTick() };
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

test('the index page: each update since the last big one, on its page, an update with no WvW line included', () => {
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
