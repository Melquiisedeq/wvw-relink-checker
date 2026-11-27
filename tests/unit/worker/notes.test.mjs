// The notes (worker/notes.mjs): the wiki's lines as apps-script/notes sends them, and what
// GET /api/notes publishes. The wiki pages are recorded (fixtures/notes/, read with the script's
// User-Agent); the lines come from the script's own parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { workerHarness } from './harness.mjs';
import { signHeaders } from '../../worker-fakes/signed.mjs';
import { readScript, loadScript } from '../apps-script/harness.mjs';
import { checkNotes, cut, kindOf, labelOf, plainText, HOTFIX_WAIT_S, KEEP_NOTE_DAYS, MAX_SERVED } from '../../../worker/notes.mjs';

const KEY = 'n'.repeat(128);
const fixture = (name) => zlib.gunzipSync(fs.readFileSync(new URL('fixtures/notes/' + name + '.gz', import.meta.url))).toString('utf8');
export const PAGES = ['2026-04-14', '2026-07-15', '2026-08-11', '2026-08-17', '2026-09-29', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-16'];
const script = loadScript(readScript('notes/notes.gs'), {}, 'Notes_').out;
// The script's notes of every recorded page, each page read alone.
const wikiNotes = (edit = (h) => h) => PAGES.flatMap((p) => script.notes(edit(fixture(p + '.html'), p), [p]));
const START = Date.parse('2026-11-24T12:00:00Z');
const HOUR = 3600e3;

function setup() {
  const h = workerHarness({ start: START, secrets: { INGEST_NOTES: KEY } });
  let last = 0;
  return Object.assign(h, {
    async push(notes, { key = KEY, t } = {}) {
      const body = typeof notes === 'string' ? notes : JSON.stringify({ v: 1, notes });
      t = t ?? Math.max(Math.floor(h.now / 1000), last + 1);
      last = t;
      const headers = signHeaders(key, t, '/api/ingest/notes', body);
      return (await h.call(new Request('https://wvwrelink.com/api/ingest/notes', { method: 'POST', body, headers }))).status;
    },
    async notes(search = '') {
      const r = await h.call(new Request('https://wvwrelink.com/api/notes' + search));
      return { status: r.status, headers: r.headers, data: r.status === 200 ? JSON.parse(await r.text()) : null };
    }
  });
}

const texts = (data) => data.notes.map((n) => n.text);
const lab = JSON.parse(fs.readFileSync(new URL('fixtures/notes/lab-lines-2026.json', import.meta.url)));
// The lead the wiki writes under a release's heading.
const NOTICE = 'Note to users of third-party programs: The game may not launch or work properly after we release a new build if you use a third-party program.';
const one = (text, update = 'Update - November 12, 2026', page = '2026-11-12') => [{ page, update, lead: NOTICE, lines: [{ section: 'Bug Fixes', sub: '', text, link: null, icon: false }] }];
// The recorded pages' releases: the forum's notes of those days hold their lines, and of no other update.
const RELEASES = ['Update - April 14, 2026', 'Update - July 14, 2026', 'Update - August 11, 2026', 'Update - September 29, 2026', 'Update - November 10, 2026'];
const hotfixTexts = () => checkNotes({ v: 1, notes: wikiNotes() }, START).notes.filter((n) => n.hotfix).flatMap((n) => n.lines.map((l) => l.text));
const LINE = 'Fixed an issue that let players into the WvW keep through its wall.';

test('the 2026 notes: the lab\'s lines as the wiki has them, a release\'s by the first reading, a hotfix\'s a day on', async () => {
  const w = setup();
  assert.deepEqual((await w.notes()).data, { v: '', wiki: 0, notes: [] }, 'nothing before a reading');
  assert.equal(await w.push(wikiNotes()), 200);
  const hot = hotfixTexts();
  assert.equal(hot.length, 14);
  const first = (await w.notes()).data;
  assert.equal(first.wiki, Math.floor(START / 1000));
  assert.deepEqual(texts(first).sort(), lab.map((r) => cut(r.text)).filter((t) => !hot.includes(t)).sort());
  assert.ok(first.notes.every((n) => n.hotfix === false));
  for (let i = 0; i < 4; i++) { w.advance(6 * HOUR); await w.push(wikiNotes()); }
  const got = (await w.notes()).data;
  assert.equal(got.notes.length, lab.length);
  assert.deepEqual(texts(got).sort(), lab.map((r) => cut(r.text)).sort());
  assert.deepEqual(got.notes.filter((n) => n.hotfix === true).map((n) => n.text).sort(), [...hot].sort());
  assert.deepEqual(Object.keys(got.notes[0]), ['day', 'update', 'section', 'sub', 'text', 'type', 'hotfix', 'page', 'link']);
  // Newest day first.
  assert.deepEqual(got.notes.map((n) => n.day), got.notes.map((n) => n.day).sort().reverse());
  // The link: built here, the page from its name, the line's from a checked page name.
  const n = got.notes.find((x) => x.text.startsWith('Splinter Weapon'));
  assert.deepEqual([n.page, n.link, n.sub, n.type, n.day], ['https://wiki.guildwars2.com/wiki/Game_updates/2026-04-14',
    'https://wiki.guildwars2.com/wiki/Splinter_Weapon', 'Ritualist', 'nerf', '2026-04-14']);
});

test('a line changed on the wiki is published changed by the next reading, the old one gone', async () => {
  const w = setup();
  await w.push(wikiNotes());
  w.advance(6 * HOUR);
  const edit = (html, p) => (p === '2026-04-14' ? html.replace('from 0.35 to 0.25 in', 'from 0.35 to 0.95 in') : html);
  await w.push(wikiNotes(edit));
  const all = texts((await w.notes()).data);
  assert.equal(all.length, lab.length - hotfixTexts().length);
  assert.equal(all.filter((t) => t.startsWith('Splinter Weapon')).length, 1);
  assert.ok(all.some((t) => t.startsWith('Splinter Weapon') && t.includes('from 0.35 to 0.95 in')));
});

// The lab's lines whose label the event and reward rules give; every other keeps the lab's.
const RELABELLED = new Map([
  ['Added placement-based skirmish rewards', 'reward'], ['Match rewards and skirmish rewards', 'reward'],
  ['Added the Tenebral Armor set as a reward choice', 'reward'], ['New WvW Borderlands map beta event begins.', 'event'],
  ['The new Seared Borderlands map has replaced', 'event']]);
const relabel = (text) => [...RELABELLED].find(([start]) => text.startsWith(start))?.[1];

test('the type of each line is the lab\'s but for an event or a reward of WvW, and a type the rules are not sure of is no label', () => {
  let changed = 0;
  for (const r of lab) {
    const kind = kindOf(r.text, r.section.replace(/:$/, ''), r.sub, r.icon !== null);
    const now = relabel(r.text);
    if (now) { changed++; assert.equal(labelOf(kind), now, r.text); continue; }
    assert.equal(kind, r.type, r.text);
    assert.equal(labelOf(kind) !== null, r.sure, r.text);
  }
  assert.equal(changed, RELABELLED.size);
  // Lines of the 2026 notes the recorded pages lack.
  for (const [text, section, want] of [
    ['A new legendary accessory, Strife Unending, is now available for purchase from Dugan in WvW after players have completed the Mists Research: Strife Unending achievement.', 'Rewards', 'reward'],
    ['Added the Forge Guard\'s armor set and Glimmering Resin weapon set to the Visions of Eternity Reward Track in PvP and WvW.', 'Items', 'reward'],
    ['Added the Deal 50,000 Damage Using Siege Equipment objective to the WvW pool.', 'Wizard\'s Vault', null],
    ['Several reward boxes obtained from the WvW and PvP reward tracks now use the new vendor UI, allowing several of these boxes to be opened at once.', 'Items', null],
    ['Reward track boost items have been spread across the PvP Rush and WvW Rush Champion achievement tiers to reduce the amount gained in one tier.', 'Rewards', null],
    ['Fixed an issue that prevented skirmish rewards from being enabled in WvW.', 'World vs. World', 'bug'],
    ['Guards no longer give War Score during a War Score beta.', 'World vs. World', 'wvw_rule'],
    ['Siege golems wear pumpkin heads in WvW until November 3.', 'Halloween', null]
  ]) assert.equal(labelOf(kindOf(text, section, '', false)), want, text);
});

// Two readings of the recorded pages, 6 h apart: the same counts twice, as a page that has settled.
async function read() {
  const w = setup();
  await w.push(wikiNotes());
  w.advance(6 * HOUR);
  await w.push(wikiNotes());
  return w;
}
const withNote = (update, lines) => wikiNotes().map((n) => (n.update === update ? { ...n, lines } : n));
const WVW = (i) => ({ section: 'World vs. World', sub: '', text: 'WvW invented line ' + i + '.', link: null, icon: false });
const NOV10 = 'Update - November 10, 2026';
const APRIL = 'Update - April 14, 2026';
const linesOf = (w, note) => w.sql.prepare('SELECT count(*) n FROM note_line WHERE note = ?1').get(note).n;

test('a note is what the wiki\'s last reading of its page had: gutted, blanked, inflated, reverted', async () => {
  const w = await read();
  const nov10 = wikiNotes().find((n) => n.update === NOV10).lines;
  assert.equal(linesOf(w, NOV10), 50);
  w.advance(6 * HOUR);
  assert.equal(await w.push(withNote(NOV10, nov10.slice(0, 3))), 200);
  assert.equal(linesOf(w, NOV10), 3, 'gutted: taken by the next reading');
  w.advance(6 * HOUR);
  await w.push(withNote(NOV10, []));
  assert.equal(linesOf(w, NOV10), 0, 'blanked: no line left');
  w.advance(6 * HOUR);
  await w.push(wikiNotes());
  assert.equal(linesOf(w, NOV10), 50, 'undone on the wiki: back by the next reading');
  const own = async () => (await w.notes()).data.notes.filter((n) => n.update === APRIL).map((n) => n.text);
  const original = await own();
  assert.equal(original.length, 3);
  w.advance(6 * HOUR);
  await w.push(withNote(APRIL, [...wikiNotes().find((n) => n.update === APRIL).lines, ...Array.from({ length: 57 }, (_, i) => WVW(i))]));
  assert.equal((await own()).length, 60);
  w.advance(6 * HOUR);
  await w.push(wikiNotes());
  assert.deepEqual(await own(), original);
});

test('an update the wiki deletes leaves with the next reading; one on a page the push lacks stays', async (t) => {
  const FAKE = 'Update - November 13, 2026';
  const fake = { page: '2026-11-12', update: FAKE, lead: NOTICE, lines: Array.from({ length: 60 }, (_, i) => WVW(i)) };
  const updates = async (w) => new Set((await w.notes()).data.notes.map((n) => n.update));
  await t.test('an invented update, published once, is gone the reading after the wiki deletes it', async () => {
    const w = await read();
    w.advance(6 * HOUR);
    await w.push([...wikiNotes(), fake]);
    assert.ok((await updates(w)).has(FAKE));
    w.advance(6 * HOUR);
    await w.push(wikiNotes());
    assert.ok(!(await updates(w)).has(FAKE));
    assert.equal(linesOf(w, FAKE), 0);
    assert.equal(w.sql.prepare('SELECT count(*) n FROM note_group WHERE note = ?1').get(FAKE).n, 0);
  });
  await t.test('a real update its page, still read, lacks once leaves at once', async () => {
    const w = await read();
    const JULY = 'Update - July 14, 2026';
    const without = wikiNotes().filter((n) => n.update !== JULY);
    assert.ok((await updates(w)).has(JULY));
    assert.ok(without.some((n) => n.page === '2026-07-15'), 'its page is still read');
    w.advance(6 * HOUR);
    await w.push(without);
    assert.ok(!(await updates(w)).has(JULY));
  });
  await t.test('the notes of a page the push lacks (it failed, or left the index) stay', async () => {
    const w = await read();
    const before = (await w.notes()).data.notes;
    for (let i = 0; i < 2; i++) { w.advance(6 * HOUR); await w.push(wikiNotes().filter((n) => n.page !== '2026-04-14')); }
    assert.deepEqual((await w.notes()).data.notes, before);
  });
});

test('the same reading again writes no line, and moves only the reading\'s time', async () => {
  const w = await read();
  const v = (await w.notes()).data.v;
  const ran = w.ran.length;
  w.advance(6 * HOUR);
  assert.equal(await w.push(wikiNotes()), 200);
  const writes = w.ran.slice(ran).map((s) => s.q).filter((q) => /^(INSERT|UPDATE|DELETE)/.test(q));
  assert.deepEqual(writes.map((q) => q.split(' ').slice(0, 3).join(' ')), ['UPDATE source SET', 'UPDATE note_served SET']);
  const got = (await w.notes()).data;
  assert.deepEqual([got.wiki, got.v], [Math.floor(w.now / 1000), v]);
});

test('what a line may carry: plain text, cut, a link only to a wiki page by a checked name', async () => {
  const w = setup();
  const line = (text, extra = {}) => ({ section: 'World vs. World', sub: '', text, link: null, icon: false, ...extra });
  const long = 'WvW ' + 'a'.repeat(400);
  const many = Array.from({ length: 70 }, (_, i) => line('WvW line ' + i));
  await w.push([
    { page: '2026-11-12', update: 'Update - November 12, 2026', lead: NOTICE, lines: [
      line('WvW keep‮ evil​ text\u0000.', { link: 'javascript:alert(1)' }),
      line('WvW <script>alert(1)</script>'),
      line('WvW <img src=x onerror=alert(1)>'),
      line(long, { link: 'Stonemist Castle' }),
      line('WvW link to another site', { link: '//evil.example/x' }),
      line('WvW link with a query', { link: 'Special:Random?x=1' }),
      line('WvW section never seen', { section: 'Totally New Section' }),
      line('WvW event section with markup', { section: '<b>x</b> Bonus Event: Ascent' }),
      line('A line about raids only.', { section: 'Raids' }),
      line('WvW', { icon: 'yes' })
    ] },
    { page: '2026-11-16', update: 'Update - November 16, 2026', lead: NOTICE, lines: many }
  ]);
  const rows = w.sql.prepare('SELECT body, link FROM note_line ORDER BY note, pos').all().map((r) => ({ ...r }));
  const of12 = rows.filter((r) => !r.body.startsWith('WvW line'));
  assert.deepEqual(of12.map((r) => r.link), [null, 'Stonemist Castle', null, null]);
  assert.equal(of12[0].body, 'WvW keep evil text.');
  assert.equal([...of12[1].body].length, 300);
  assert.ok(of12[1].body.endsWith('a…'));
  assert.equal(rows.filter((r) => r.body.startsWith('WvW line')).length, 60);
  assert.equal(plainText('a⁦b⁩c\ud800'), 'abc');
  const out = (await w.notes()).data.notes.filter((n) => n.day === '2026-11-12');
  assert.deepEqual(out.map((n) => n.link), [null, 'https://wiki.guildwars2.com/wiki/Stonemist_Castle', null, null]);
  // Over 2000 characters before the cut, it is not a note line.
  const w2 = setup();
  await w2.push([{ page: '2026-11-12', update: 'Update - November 12, 2026', lead: NOTICE, lines: [line('WvW ' + 'b'.repeat(1996)), line('WvW ' + 'c'.repeat(1997)),
    line('WvW ' + 'd'.repeat(296)), line('WvW ' + 'e'.repeat(297))] }]);
  assert.deepEqual(texts((await w2.notes()).data).map((t) => [t[4], [...t].length, t.at(-1)]), [['b', 300, '…'], ['d', 300, 'd'], ['e', 300, '…']]);
  // A link that is not a string is none, whatever it reads as.
  const w3 = setup();
  await w3.push([{ page: '2026-11-12', update: 'Update - November 12, 2026', lines: [line('WvW numeric link', { link: 12345 }), line('WvW listed link', { link: ['Stonemist Castle'] })] }]);
  assert.deepEqual(w3.sql.prepare('SELECT link FROM note_line ORDER BY pos').all().map((r) => r.link), [null, null]);
});

test('a line\'s sub-heading: plain text in the wiki\'s mold, or the line is left out', async () => {
  const w = setup();
  const subs = ['Ritu\u200balist', 'Ritualist\u202e', '\u2066Ritualist\u2069', 'Spear (Ranger)', '<b>Ritualist</b>', 'Ritualist<', 'R'.repeat(61), 'R'.repeat(60),
    'Necromancer: Reaper', 'Herald/Revenant', 'Ritualist "x"', '\u200b'];
  await w.push([{ page: '2026-11-12', update: 'Update - November 12, 2026',
    lines: subs.map((sub, i) => ({ section: 'Profession Skills', sub, text: 'WvW line ' + i, link: null, icon: false })) }]);
  const rows = w.sql.prepare('SELECT sub, body FROM note_line ORDER BY pos').all().map((r) => [r.sub, r.body]);
  assert.deepEqual(rows, [['Ritualist', 'WvW line 0'], ['Ritualist', 'WvW line 1'], ['Ritualist', 'WvW line 2'], ['Spear (Ranger)', 'WvW line 3'],
    ['R'.repeat(60), 'WvW line 7']]);
});

test('a note out of shape is left out; a message out of shape is refused whole', async (t) => {
  const note = (page, update) => [{ page, update, lines: [{ section: 'World vs. World', sub: '', text: 'WvW rule.', link: null, icon: false }] }];
  for (const [name, notes] of [
    ['a date not in the wiki\'s mold', note('2026-11-12', 'Update - Novembre 12, 2026')],
    ['a day that does not exist', note('2026-11-12', 'Update - February 30, 2026')],
    ['a heading of another kind', note('2026-11-12', 'Balance Update Preview - November 12, 2026')],
    ['a heading that only ends like one', note('2026-11-12', 'Not an Update - November 12, 2026')],
    ['a page far from its day', note('2026-11-20', 'Update - November 12, 2026')],
    ['a page in the future', note('2026-12-01', 'Update - December 1, 2026')],
    ['a page over a year old', note('2025-09-01', 'Update - September 1, 2025')],
    ['a page name out of shape', note('../2026-11-12', 'Update - November 12, 2026')],
    ['a page day that does not exist', note('2026-09-31', 'Update - October 1, 2026')]
  ]) {
    await t.test(name, async () => {
      const w = setup();
      assert.equal(await w.push(notes), 200);
      assert.equal(w.sql.prepare('SELECT count(*) n FROM note_group').get().n, 0);
    });
  }
  for (const [name, body, want] of [['not JSON', '{', 400], ['another version', JSON.stringify({ v: 2, notes: note('2026-11-12', 'Update - November 12, 2026') }), 422],
    ['no note', JSON.stringify({ v: 1, notes: [] }), 422], ['21 notes', JSON.stringify({ v: 1, notes: Array(21).fill(note('2026-11-12', 'Update - November 12, 2026')[0]) }), 422]]) {
    await t.test(name + ' is ' + want, async () => {
      const w = setup();
      assert.equal(await w.push(body), want);
      assert.equal(w.sql.prepare("SELECT t FROM source WHERE name = 'notes'").get().t, 0);
    });
  }
});

test('the notes door: the signature, its own secret, the clock, the replay', async () => {
  const w = setup();
  const notes = one(LINE);
  const t0 = Math.floor(w.now / 1000);
  assert.equal(await w.push(notes, { key: 'k'.repeat(128) }), 401);
  assert.equal(await w.push(notes, { t: t0 - 360 }), 401);
  assert.equal(await w.push(notes, { t: t0 }), 200);
  assert.equal(await w.push(notes, { t: t0 }), 409);
  const none = workerHarness({ start: START, secrets: {} });
  const body = JSON.stringify({ v: 1, notes });
  const r = await none.call(new Request('https://wvwrelink.com/api/ingest/notes', { method: 'POST', body, headers: signHeaders(KEY, t0, '/api/ingest/notes', body) }));
  assert.equal(r.status, 404);
});

test('GET /api/notes: short-lived; by version, kept for good, and only the version held', async () => {
  const w = setup();
  await w.push(wikiNotes());
  const plain = await w.notes();
  assert.equal(plain.headers.get('cache-control'), 'public, max-age=300');
  assert.match(plain.data.v, /^[0-9a-f]{16}$/);
  const byV = await w.notes('?v=' + plain.data.v);
  assert.equal(byV.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(byV.data, { v: plain.data.v, notes: plain.data.notes });
  assert.equal((await w.notes('?v=0123456789abcdef')).status, 404);
  let prepared = 0;
  const prepare = w.env.DB.prepare;
  w.env.DB.prepare = (q) => { prepared++; return prepare(q); };
  for (const q of ['?v=XYZ', '?v=0123456789abcdef0', '?x=1', '?v=0123456789abcdef&x=1']) assert.equal((await w.notes(q)).status, 404, q);
  assert.equal(prepared, 0, 'a query out of shape reads nothing');
  const post = await w.call(new Request('https://wvwrelink.com/api/notes', { method: 'POST' }));
  assert.equal(post.status, 405);
});

test('at most MAX_SERVED lines are published, the newest days\' first', async () => {
  const w = setup();
  const note = (d) => ({ page: '2026-11-' + d, update: 'Update - November ' + d + ', 2026', lead: NOTICE,
    lines: Array.from({ length: 60 }, (_, i) => ({ section: 'World vs. World', sub: '', text: 'WvW line ' + d + '-' + i, link: null, icon: false })) });
  await w.push(['10', '11', '12', '13'].map(note));
  const got = (await w.notes()).data.notes;
  assert.equal(MAX_SERVED, 200);
  assert.equal(got.length, 200);
  assert.deepEqual([got[0].text, got.at(-1).text], ['WvW line 13-0', 'WvW line 10-19']);
});

test('a note past KEEP_NOTE_DAYS is deleted by the next reading that changes something', async () => {
  const w = setup();
  await w.push(one(LINE));
  w.advance((KEEP_NOTE_DAYS - 20) * 86400e3);
  const later = new Date(w.now).toISOString().slice(0, 10);
  const update = 'Update - ' + new Date(w.now).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  await w.push(one('Fixed a WvW sentry that did not respawn.', update, later));
  w.advance(HOUR);
  await w.push(one('Fixed a WvW sentry that did not respawn.', update, later));
  assert.equal(w.sql.prepare('SELECT count(*) n FROM note_group').get().n, 2, 'within the days kept');
  w.advance(11 * 86400e3);
  await w.push(one('Fixed a WvW sentry that did not respawn.', update, later));
  assert.equal(w.sql.prepare('SELECT count(*) n FROM note_group').get().n, 2, 'the same reading again writes nothing');
  await w.push(one('Fixed a WvW sentry that respawned twice.', update, later));
  assert.deepEqual(w.sql.prepare('SELECT note FROM note_group').all().map((r) => r.note), [update]);
  assert.deepEqual(w.sql.prepare('SELECT DISTINCT note FROM note_line').all().map((r) => r.note), [update]);
  assert.deepEqual(texts((await w.notes()).data), ['Fixed a WvW sentry that respawned twice.']);
});

test('/api/latest names the notes\' version and time, and without a version or the table is as before, byte for byte', async () => {
  const w = setup();
  const at = Math.floor(w.now / 1000);
  w.sql.prepare("INSERT INTO latest (id, start, score, at, reader, gz, sha, raw) VALUES ('1-1', 1, 1, ?1, 'x', '{}', 's', 2)").run(at);
  const latest = async () => (await w.call(new Request('https://wvwrelink.com/api/latest'))).text();
  const before = '{"at":' + at + ',"matches":[{"id":"1-1","start":1,"score":1,"at":' + at + ',"by":"x","v":2,"body":{}}]}';
  assert.equal(await latest(), before, 'no version yet');
  await w.push(wikiNotes());
  w.advance(HOUR);
  w.sql.prepare('UPDATE latest SET at = ?1').run(Math.floor(w.now / 1000));
  const now = Math.floor(w.now / 1000);
  const v = (await w.notes()).data.v;
  assert.equal(await latest(), '{"at":' + now + ',"matches":[{"id":"1-1","start":1,"score":1,"at":' + now + ',"by":"x","v":2,"body":{}}],' +
    '"notes":{"v":"' + v + '","wiki":' + at + '}}');
  w.sql.exec('DROP TABLE note_served');
  assert.equal(await latest(), before.replaceAll(String(at), String(now)), 'no table');
});

test('a release is an "Update - " heading whose lead is the wiki\'s notice; every other update is a hotfix', async (t) => {
  await t.test('the recorded pages and the index page', () => {
    const releases = (notes) => checkNotes({ v: 1, notes }, START).notes.filter((n) => !n.hotfix).map((n) => n.update);
    assert.deepEqual(releases(wikiNotes()), RELEASES);
    assert.deepEqual(releases(script.notes(fixture('index-2026-11-24.html'))), ['Update - November 10, 2026']);
  });
  const hotfix = (n) => checkNotes({ v: 1, notes: [{ page: '2026-11-10', update: 'Update - November 10, 2026', lines: [], ...n }] }, START).notes[0].hotfix;
  for (const [name, note, want] of [
    ['the notice as the lead', { lead: NOTICE }, false],
    ['the notice in spaces and a line break the wiki may write', { lead: '  Note to users of\nthird-party  programs: The game may not launch.' }, false],
    ['the notice under an "Update 2" heading', { update: 'Update 2 - November 10, 2026', lead: NOTICE }, true],
    ['the notice under a "Late Notes" heading', { update: 'Late Notes - November 10, 2026', lead: NOTICE }, true],
    ['the notice after other text', { lead: 'Release Highlights: ' + NOTICE }, true],
    ['no lead', {}, true],
    ['a lead that is not text', { lead: [NOTICE] }, true],
    ['a lead with markup', { lead: '<b>' + NOTICE }, true],
    ['the message\'s own say, no notice', { hotfix: false }, true],
    ['the message\'s own say, the notice', { hotfix: true, lead: NOTICE }, false]
  ]) await t.test(name, () => assert.equal(hotfix(note), want));
});

// The index page as the script reads it: the release of 10/11 and five hotfixes.
const indexNotes = (edit = (n) => n) => edit(script.notes(fixture('index-2026-11-24.html')));
const NOV12 = 'Update - November 12, 2026';
const published = async (w) => (await w.notes()).data.notes;
const hotOf = async (w, update = NOV12) => (await published(w)).filter((n) => n.update === update);
const ripe = (w) => w.sql.prepare('SELECT ripe FROM note_served').get().ripe;

test('a hotfix\'s line is published once every reading of its page has held it for a day', async (t) => {
  await t.test('held by same readings: out before the day is up, in at its end, by a reading that changes nothing', async () => {
    const only = setup();
    await only.push(one(LINE));
    assert.equal(ripe(only), 0, 'a release\'s lines: nothing waits');
    const w = setup();
    await w.push(indexNotes());
    const t0 = Math.floor(START / 1000);
    assert.equal((await hotOf(w)).length, 0);
    assert.equal((await hotOf(w, 'Update - November 10, 2026')).length, 50, 'a release\'s lines at once');
    assert.equal(ripe(w), t0 + HOTFIX_WAIT_S);
    const v = (await w.notes()).data.v;
    for (const step of [6, 6, 6, 6 - 1 / 3600]) { w.advance(step * HOUR); await w.push(indexNotes()); }
    assert.equal((await hotOf(w)).length, 0, 'a second short of the day');
    assert.equal((await w.notes()).data.v, v);
    w.advance(1000);
    await w.push(indexNotes());
    const hot = await hotOf(w);
    assert.equal(hot.length, 5);
    assert.ok(hot.every((n) => n.hotfix === true));
    assert.notEqual((await w.notes()).data.v, v);
    assert.equal(ripe(w), 0);
    assert.equal((await published(w)).length, 61);
  });
  await t.test('held by readings that change other notes: in at the day\'s end all the same', async () => {
    const w = setup();
    const edited = (i) => indexNotes((ns) => ns.map((n) => (n.update === 'Update - November 10, 2026' ? { ...n, lines: [...n.lines, WVW(i)] } : n)));
    await w.push(edited(0));
    for (let i = 1; i <= 3; i++) { w.advance(6 * HOUR); await w.push(edited(i)); }
    assert.equal((await hotOf(w)).length, 0);
    w.advance(6 * HOUR);
    await w.push(edited(4));
    assert.equal((await hotOf(w)).length, 5);
  });
  await t.test('a line that leaves a reading, or changes, starts its day again when it is back', async () => {
    const w = setup();
    const lines = [...indexNotes().find((n) => n.update === NOV12).lines];
    const without = indexNotes((ns) => ns.map((n) => (n.update === NOV12 ? { ...n, lines: lines.slice(1) } : n)));
    const changed = indexNotes((ns) => ns.map((n) => (n.update === NOV12 ? { ...n, lines: [{ ...lines[0], text: lines[0].text + ' Again.' }, ...lines.slice(1)] } : n)));
    await w.push(indexNotes());
    w.advance(12 * HOUR); await w.push(without);
    w.advance(6 * HOUR); await w.push(indexNotes());
    w.advance(6 * HOUR); await w.push(indexNotes());
    assert.deepEqual((await hotOf(w)).map((n) => n.text), lines.slice(1).map((l) => l.text), 'the four held all day; the one back 6 h ago waits');
    w.advance(6 * HOUR); await w.push(changed);
    w.advance(12 * HOUR); await w.push(changed);
    assert.deepEqual((await hotOf(w)).map((n) => n.text), lines.slice(1).map((l) => l.text), 'the changed one is a new line');
    w.advance(12 * HOUR); await w.push(changed);
    assert.equal((await hotOf(w)).length, 5, 'a day after the change');
  });
  await t.test('a note gone from its page, still read, starts again; a page the push lacks keeps the count', async () => {
    const w = setup();
    const NOV11B = 'Update 2 - November 11, 2026';
    const unread = (ns) => ns.filter((n) => n.page !== '2026-11-16');
    await w.push(indexNotes());
    w.advance(6 * HOUR); await w.push(indexNotes((ns) => unread(ns).filter((n) => n.update !== NOV11B)));
    w.advance(6 * HOUR); await w.push(indexNotes(unread));
    w.advance(12 * HOUR); await w.push(indexNotes(unread));
    assert.equal((await hotOf(w, NOV11B)).length, 0, 'back 18 h ago');
    assert.equal((await hotOf(w)).length, 5, 'its page read all day');
    assert.equal((await hotOf(w, 'Update - November 16, 2026')).length, 2, 'its page unread, still a day held');
  });
  await t.test('a hotfix whose notice the wiki adds later is a release from that reading, at once', async () => {
    const w = setup();
    await w.push(indexNotes());
    w.advance(6 * HOUR);
    await w.push(indexNotes((ns) => ns.map((n) => (n.update === NOV12 ? { ...n, lead: NOTICE } : n))));
    const now = await hotOf(w);
    assert.equal(now.length, 5);
    assert.ok(now.every((n) => n.hotfix === false));
  });
});
