// The notes (worker/notes.mjs): the wiki's lines as apps-script/notes sends them, the forum's RSS
// read by the schedule, and what GET /api/notes publishes. The wiki pages and the RSS are recorded
// (fixtures/notes/, read with the script's User-Agent); the lines come from the script's own parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { workerHarness } from './harness.mjs';
import { signHeaders } from '../../worker-fakes/signed.mjs';
import { readScript, loadScript } from '../apps-script/harness.mjs';
import worker from '../../../worker/index.mjs';
import { notesDaily, cut, kindOf, labelOf, plainText, holds, matchForm, RSS_URL, USER_AGENT, STABLE_S } from '../../../worker/notes.mjs';

const KEY = 'n'.repeat(128);
const fixture = (name) => zlib.gunzipSync(fs.readFileSync(new URL('fixtures/notes/' + name + '.gz', import.meta.url))).toString('utf8');
export const PAGES = ['2026-04-14', '2026-07-15', '2026-08-11', '2026-08-17', '2026-09-29', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-16'];
const RSS = fixture('forum-rss-2026-11-24.xml');
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
    async daily(answer = () => new Response(RSS)) {
      const asked = [];
      const fetchFn = async (url, init) => { asked.push({ url, init }); return answer(url, init); };
      const real = Date.now;
      Date.now = () => h.now;
      try {
        await notesDaily(h.env, h.now, fetchFn);
      } finally {
        Date.now = real;
      }
      return asked;
    },
    async notes(search = '') {
      const r = await h.call(new Request('https://wvwrelink.com/api/notes' + search));
      return { status: r.status, headers: r.headers, data: r.status === 200 ? JSON.parse(await r.text()) : null };
    }
  });
}

const texts = (data) => data.notes.map((n) => n.text);
const lab = JSON.parse(fs.readFileSync(new URL('fixtures/notes/lab-lines-2026.json', import.meta.url)));

// The days the RSS has release notes for, and the lab's lines of those days the RSS also holds.
const RSS_DAYS = ['2026-04-14', '2026-07-14', '2026-08-11', '2026-09-29', '2026-11-10'];
const dayOf = (update) => new Date(Date.parse(update.replace(/^.* - /, '') + ' UTC')).toISOString().slice(0, 10);

test('the 2026 notes: a big update\'s lines only once the RSS has them, the hotfixes once a second reading 20 h on still has them', async () => {
  const w = setup();
  assert.equal(await w.push(wikiNotes()), 200);
  assert.deepEqual((await w.notes()).data.notes, [], 'nothing before the RSS is read');
  const asked = await w.daily();
  assert.equal(asked.length, 1);
  // A run reads the text of the newest two days with lines to confirm; the other three wait.
  assert.deepEqual([...new Set((await w.notes()).data.notes.map((n) => n.day))], ['2026-11-10', '2026-09-29']);
  await w.daily();
  await w.daily();
  assert.equal(asked[0].url, RSS_URL);
  assert.equal(asked[0].init.headers['user-agent'], USER_AGENT);
  const first = (await w.notes()).data;
  // The lab's lines of the RSS's days, but the one the wiki changed after the forum (not in the RSS),
  // and those of a later h2 of the same day (Late Notes, Update 2: not in that day's RSS item).
  const big = lab.filter((r) => RSS_DAYS.includes(dayOf(r.update)) && r.update.startsWith('Update - ') && !r.text.startsWith('Modified Ammunition'));
  assert.equal(big.length, 103);
  assert.deepEqual(new Set(texts(first)), new Set(big.map((r) => cut(r.text))));
  assert.ok(first.notes.every((n) => n.hotfix === false));
  assert.equal(first.wiki, Math.floor(START / 1000));
  assert.equal(first.rss, Math.floor(START / 1000));

  w.advance(STABLE_S * 1000 + HOUR);
  assert.equal(await w.push(wikiNotes()), 200);
  const second = (await w.notes('?v=' + (await w.notes()).data.v)).data;
  const hot = second.notes.filter((n) => n.hotfix);
  assert.deepEqual(hot.map((n) => n.day).sort(), ['2026-08-17', '2026-09-30', '2026-11-11', '2026-11-11', '2026-11-11', '2026-11-11',
    '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-16', '2026-11-16']);
  assert.equal(second.notes.length, 116);
  // The link: built here, the page from its name, the line's from a checked page name.
  const n = second.notes.find((x) => x.text.startsWith('Splinter Weapon'));
  assert.deepEqual([n.page, n.link, n.sub, n.type, n.day], ['https://wiki.guildwars2.com/wiki/Game_updates/2026-04-14',
    'https://wiki.guildwars2.com/wiki/Splinter_Weapon', 'Ritualist', 'nerf', '2026-04-14']);
});

test('the type of each line is the lab\'s, and a type the rules are not sure of is no label', () => {
  for (const r of lab) {
    const kind = kindOf(r.text, r.section.replace(/:$/, ''), r.sub, r.icon !== null);
    assert.equal(kind, r.type, r.text);
    assert.equal(labelOf(kind) !== null, r.sure, r.text);
  }
});

// A line of a day the RSS has, changed on the wiki: the forum's text is the one trusted.
test('a wiki line changed from the forum\'s is not published; a truncated one neither', async () => {
  const w = setup();
  const edit = (html, p) => (p === '2026-04-14' ? html.replace('from 0.35 to 0.25 in', 'from 0.35 to 0.95 in').replace('while any inner gates', 'while any outer gates') : html);
  await w.push(wikiNotes(edit));
  for (let i = 0; i < 3; i++) await w.daily();
  const all = texts((await w.notes()).data);
  assert.ok(!all.some((t) => t.startsWith('Splinter Weapon')));
  assert.ok(!all.some((t) => t.startsWith('Keep and castle objectives')));
  assert.ok(all.some((t) => t.startsWith('Waypoints were previously')));
  // Whole words: a line cut short inside a word of the forum's does not pass.
  const rss = matchForm('Reduced the power coefficient from 0.35 to 0.25 in WvW.');
  assert.equal(holds(rss, 'Reduced the power coefficient from 0.35 to 0.2'), false);
  assert.equal(holds(rss, 'educed the power coefficient from 0.35 to 0.25 in WvW.'), false);
  assert.equal(holds(rss, 'Reduced the power coefficient from 0.35 to 0.25 in WvW.'), true);
  assert.equal(holds(rss, 'Reduced the power coefficient from 0.35 to 0.25 in Wv…'), true);
});

test('a line is checked against its own day\'s RSS item, never another\'s', async () => {
  const w = setup();
  const own = 'The War Score now counts each objective held at the end of a skirmish.';
  // The text of a 29/09 line, under the 10/11 update.
  const borrowed = lab.find((r) => r.update === 'Update - September 29, 2026' && r.section === 'World vs. World').text;
  await w.push([{ page: '2026-11-10', update: 'Update - November 10, 2026', lines: [
    { section: 'World vs. World', sub: '', text: borrowed, link: null, icon: false },
    { section: 'World vs. World', sub: '', text: own, link: null, icon: false }] }]);
  await w.daily();
  w.advance(STABLE_S * 1000 * 2);
  await w.push([{ page: '2026-11-10', update: 'Update - November 10, 2026', lines: [
    { section: 'World vs. World', sub: '', text: borrowed, link: null, icon: false },
    { section: 'World vs. World', sub: '', text: own, link: null, icon: false }] }]);
  assert.deepEqual((await w.notes()).data.notes, [], 'a day the RSS has never takes the hotfix rule');
});

const hotfix = (text, update = 'Update - November 12, 2026', page = '2026-11-12') => [{ page, update, lines: [{ section: 'Bug Fixes', sub: '', text, link: null, icon: false }] }];
const LINE = 'Fixed an issue that let players into the WvW keep through its wall.';

test('a hotfix line: published only from a reading 20 h or more after its first, with the line unchanged since', async (t) => {
  await t.test('one reading, however old, is not two', async () => {
    const w = setup();
    await w.push(hotfix(LINE));
    w.advance(30 * HOUR);
    await w.daily();
    assert.deepEqual(texts((await w.notes()).data), []);
  });
  await t.test('a second reading under 20 h on is not enough; one at 20 h is', async () => {
    const w = setup();
    await w.push(hotfix(LINE));
    w.advance(STABLE_S * 1000 - 1000);
    await w.push(hotfix(LINE));
    assert.deepEqual(texts((await w.notes('?v=' + (await w.notes()).data.v)).data), []);
    w.advance(1000);
    await w.push(hotfix(LINE));
    const got = await w.notes('?v=' + (await w.notes()).data.v);
    assert.deepEqual(got.data.notes.map((n) => [n.text, n.hotfix, n.day]), [[LINE, true, '2026-11-12']]);
  });
  await t.test('a line changed between readings starts again', async () => {
    const w = setup();
    await w.push(hotfix(LINE));
    w.advance(10 * HOUR);
    await w.push(hotfix(LINE.replace('wall', 'gate')));
    w.advance(12 * HOUR);
    await w.push(hotfix(LINE.replace('wall', 'gate')));
    assert.deepEqual(texts((await w.notes('?v=' + (await w.notes()).data.v)).data), []);
  });
  await t.test('a note the reading no longer had keeps the time of the last reading that had it', async () => {
    const w = setup();
    await w.push(hotfix(LINE));
    w.advance(21 * HOUR);
    await w.push(hotfix('Fixed a WvW sentry that did not respawn.', 'Update - November 16, 2026', '2026-11-16'));
    w.advance(20 * HOUR);
    await w.push(hotfix('Fixed a WvW sentry that did not respawn.', 'Update - November 16, 2026', '2026-11-16'));
    assert.deepEqual(texts((await w.notes('?v=' + (await w.notes()).data.v)).data), ['Fixed a WvW sentry that did not respawn.']);
  });
});

test('the last good copy stays: a gutted note, a failed or empty RSS change nothing published', async (t) => {
  const w = setup();
  await w.push(wikiNotes());
  await w.daily();
  const before = (await w.notes()).data;
  await t.test('a reading with under half of a note\'s lines leaves the note as it was', async () => {
    w.advance(HOUR);
    const gutted = wikiNotes().map((n) => (n.update === 'Update - November 10, 2026' ? { ...n, lines: n.lines.slice(0, 24) } : n));
    assert.equal(await w.push(gutted), 200);
    assert.equal(w.sql.prepare("SELECT n FROM note_group WHERE note = 'Update - November 10, 2026'").get().n, 50);
    assert.deepEqual(texts((await w.notes()).data), texts(before));
  });
  await t.test('half of them is a reading like any other', async () => {
    const w2 = setup();
    await w2.push(wikiNotes());
    w2.advance(HOUR);
    await w2.push(wikiNotes().map((n) => (n.update === 'Update - November 10, 2026' ? { ...n, lines: n.lines.slice(0, 25) } : n)));
    assert.equal(w2.sql.prepare("SELECT n FROM note_group WHERE note = 'Update - November 10, 2026'").get().n, 25);
  });
  await t.test('a note blanked to no line at all leaves it too', async () => {
    w.advance(HOUR);
    await w.push(wikiNotes().map((n) => (n.update === 'Update - April 14, 2026' ? { ...n, lines: [] } : n)));
    assert.equal(w.sql.prepare("SELECT count(*) n FROM note_line WHERE note = 'Update - April 14, 2026'").get().n, 3);
  });
  for (const [name, answer] of [['403', () => new Response(RSS, { status: 403 })], ['no items', () => new Response('<rss><channel></channel></rss>')],
    ['broken XML', () => new Response(RSS.slice(0, 5000))], ['a failed fetch', () => { throw new TypeError('fetch failed'); }],
    ['over 2 MB', () => new Response(RSS + ' '.repeat(2 * 1024 * 1024))]]) {
    await t.test('an RSS answering ' + name + ' changes nothing, its time included', async () => {
      const at = (await w.notes()).data.rss;
      w.advance(HOUR);
      await w.daily(answer);
      const now = (await w.notes()).data;
      assert.equal(now.rss, at);
      assert.deepEqual(texts(now), texts(before));
    });
  }
});

test('the same reading again writes no line, and moves only the reading\'s time', async () => {
  const w = setup();
  await w.push(wikiNotes());
  const ran = w.ran.length;
  w.advance(6 * HOUR);
  assert.equal(await w.push(wikiNotes()), 200);
  const writes = w.ran.slice(ran).map((s) => s.q).filter((q) => /^(INSERT|UPDATE|DELETE)/.test(q));
  assert.deepEqual(writes.map((q) => q.split(' ').slice(0, 3).join(' ')), ['UPDATE source SET', 'UPDATE note_feed SET']);
  assert.equal((await w.notes()).data.wiki, Math.floor(w.now / 1000));
});

test('what a line may carry: plain text, cut, a link only to a wiki page by a checked name', async () => {
  const w = setup();
  const line = (text, extra = {}) => ({ section: 'World vs. World', sub: '', text, link: null, icon: false, ...extra });
  const long = 'WvW ' + 'a'.repeat(400);
  const many = Array.from({ length: 70 }, (_, i) => line('WvW line ' + i));
  await w.push([
    { page: '2026-11-12', update: 'Update - November 12, 2026', lines: [
      line('WvW keep‮ evil​ text\u0000.', { link: 'javascript:alert(1)' }),
      line('WvW <script>alert(1)</script>'),
      line('WvW <img src=x onerror=alert(1)>'),
      line(long, { link: 'Stonemist Castle' }),
      line('WvW link to another site', { link: '//evil.example/x' }),
      line('WvW link with a query', { link: 'Special:Random?x=1' }),
      line('WvW section never seen', { section: 'Totally New Section' }),
      line('A line about raids only.', { section: 'Raids' }),
      line('WvW', { icon: 'yes' })
    ] },
    { page: '2026-11-16', update: 'Update - November 16, 2026', lines: many }
  ]);
  const rows = w.sql.prepare('SELECT body, link FROM note_line ORDER BY note, pos').all().map((r) => ({ ...r }));
  const of12 = rows.filter((r) => !r.body.startsWith('WvW line'));
  assert.deepEqual(of12.map((r) => r.link), [null, 'Stonemist Castle', null, null]);
  assert.equal(of12[0].body, 'WvW keep evil text.');
  assert.equal([...of12[1].body].length, 300);
  assert.ok(of12[1].body.endsWith('a…'));
  assert.equal(rows.filter((r) => r.body.startsWith('WvW line')).length, 60);
  assert.equal(plainText('a⁦b⁩c\ud800'), 'abc');
  w.advance(STABLE_S * 1000);
  await w.push([{ page: '2026-11-12', update: 'Update - November 12, 2026', lines: [line('WvW keep‮ evil​ text\u0000.', { link: 'javascript:alert(1)' }), line(long, { link: 'Stonemist Castle' })] }]);
  const out = (await w.notes()).data.notes;
  assert.deepEqual(out.map((n) => n.link), [null, 'https://wiki.guildwars2.com/wiki/Stonemist_Castle']);
});

test('a note out of shape is left out; a message out of shape is refused whole', async (t) => {
  const note = (page, update) => [{ page, update, lines: [{ section: 'World vs. World', sub: '', text: 'WvW rule.', link: null, icon: false }] }];
  for (const [name, notes] of [
    ['a date not in the wiki\'s mold', note('2026-11-12', 'Update - Novembre 12, 2026')],
    ['a day that does not exist', note('2026-11-12', 'Update - February 30, 2026')],
    ['a heading of another kind', note('2026-11-12', 'Balance Update Preview - November 12, 2026')],
    ['a page far from its day', note('2026-11-20', 'Update - November 12, 2026')],
    ['a page in the future', note('2026-12-01', 'Update - December 1, 2026')],
    ['a page over a year old', note('2025-09-01', 'Update - September 1, 2025')],
    ['a page name out of shape', note('../2026-11-12', 'Update - November 12, 2026')]
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
  const notes = hotfix(LINE);
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
  await w.daily();
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

test('/api/latest names the notes\' version and times', async () => {
  const w = setup();
  await w.push(wikiNotes());
  await w.daily();
  w.sql.prepare("INSERT INTO latest (id, start, score, at, reader, gz, sha, raw) VALUES ('1-1', 1, 1, ?1, 'x', '{}', 's', 2)").run(Math.floor(w.now / 1000));
  const r = await w.call(new Request('https://wvwrelink.com/api/latest'));
  const data = JSON.parse(await r.text());
  assert.deepEqual(data.notes, { v: (await w.notes()).data.v, wiki: Math.floor(START / 1000), rss: Math.floor(START / 1000) });
  // Without the notes' table the copy answers as before.
  w.sql.exec('DROP TABLE note_feed');
  const without = JSON.parse(await (await w.call(new Request('https://wvwrelink.com/api/latest'))).text());
  assert.deepEqual(Object.keys(without), ['at', 'matches']);
});

test('the daily schedule: the kills cleanup runs as before, then the RSS; a notes failure does not touch the cleanup', async () => {
  const realFetch = globalThis.fetch;
  try {
    const w = setup();
    globalThis.fetch = async () => new Response(RSS);
    await worker.scheduled({}, w.env, {});
    assert.ok(w.sql.prepare("SELECT received FROM source WHERE name = 'cleanup'").get().received > 0);
    assert.ok(w.sql.prepare('SELECT rss FROM note_feed').get().rss > 0);
    const broken = setup();
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    broken.sql.exec('DROP TABLE note_feed');
    await worker.scheduled({}, broken.env, {});
    assert.ok(broken.sql.prepare("SELECT received FROM source WHERE name = 'cleanup'").get().received > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
