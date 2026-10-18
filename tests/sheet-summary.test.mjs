// The community sheet's reading (js/sheet.js) and the copyable summary (js/summary.js):
// what a visitor sees of a sheet that arrives in a shape nobody promised, and of
// a pasted list or a chat line that does not fit. Run in node:vm like page-rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './page-harness.mjs';

function fresh() {
  const page = loadPage(Date.parse('2026-10-03T12:00:00Z'));
  const call = (name, ...args) => {
    page.ctx.__args = args;
    return page.run(`${name}(...__args)`);
  };
  // The sheet fetch needs an AbortController, which the harness does not give the page.
  page.ctx.AbortController = AbortController;
  return { ...page, call };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test('parseCsv: doubled quotes, commas and line breaks inside quotes, CRLF and a missing last newline (js/sheet.js)', () => {
  const p = fresh();
  const csv = (t) => plain(p.call('parseCsv', t));
  assert.deepEqual(csv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(csv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']], 'CRLF leaves no \\r in a field');
  assert.deepEqual(csv('a,b\r\n1,2'), [['a', 'b'], ['1', '2']], 'the last row needs no newline');
  assert.deepEqual(csv('"say ""hi""",x\n'), [['say "hi"', 'x']]);
  assert.deepEqual(csv('"a,b","[X] one\n[Y] two"\n'), [['a,b', '[X] one\n[Y] two']]);
  assert.deepEqual(csv('a,,c\n,\n'), [['a', '', 'c'], ['', '']], 'empty cells stay, so columns keep their place');
  assert.deepEqual(csv('a,\n'), [['a', '']]);
  assert.deepEqual(csv(''), []);
  assert.deepEqual(csv('\n'), [['']]);
});

test('findColumn: exact name before a loose one, any case and spacing, the old place when the header changed (js/sheet.js)', () => {
  const p = fresh();
  const find = (header, names, fb) => p.call('findColumn', header, names, fb);
  assert.equal(find(['Name', 'Guilds', 'World ID'], ['World ID', 'World'], 22), 2);
  assert.equal(find(['Name', 'World Mismatch', 'World'], ['World'], 21), 2, 'the exact "World" wins over one that merely contains it');
  assert.equal(find(['Name', ' API MISMATCH '], ['api mismatch'], 19), 1, 'case and spaces do not matter');
  assert.equal(find(['Name', 'Server world'], ['World'], 21), 1, 'a loose match when there is no exact one');
  assert.equal(find(['Name', 'Guilds'], ['World'], 21), 21, 'a renamed header falls back to the layout last verified');
  assert.equal(find(['Name', 'World'], ['World ID', 'World'], 22), 1, 'names are tried in order, each exactly');
  for (const header of [undefined, ['']]) assert.equal(find(header, ['World'], 21), 21, 'no header: ' + JSON.stringify(header));
  assert.equal(find([null, 5, 'World'], ['World'], 9), 2, 'a header cell that is not text does not throw');
});

const wide = (cells) => { const r = new Array(24).fill(''); for (const [i, v] of Object.entries(cells)) r[i] = v; return r; };
const toCsv = (rows) => rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n') + '\r\n';

async function community(solo, alliances, o = {}) {
  const p = fresh();
  p.ctx.fetch = async (url) => {
    const tab = decodeURIComponent(String(url).split('sheet=')[1]);
    if (o.status) return { ok: false, status: o.status, text: async () => '' };
    return { ok: true, status: 200, text: async () => (tab === 'SoloGuilds' ? solo : alliances) };
  };
  const result = await p.run('loadCommunityGuilds()');
  return plain([...result.entries()]);
}

test('loadCommunityGuilds: solo guilds and alliances by team, flagged rows left out, header renamed or gone (js/sheet.js)', async () => {
  const soloHeader = (world, mismatch) => { const h = new Array(24).fill('x'); h[0] = 'Guild'; h[world] = 'World'; h[mismatch] = 'API Mismatch'; return h; };
  const allianceHeader = (members, world) => { const h = new Array(24).fill('x'); h[0] = 'Alliance'; h[members] = 'Guilds'; h[world] = 'World ID'; return h; };
  // Columns moved from where they were: found by their names.
  let solo = toCsv([soloHeader(5, 6),
    wide({ 0: '[AAA] Alpha (NA)', 5: 'Team One' }),
    wide({ 0: 'No Tag Guild', 5: 'Team One' }),
    wide({ 0: '[FLG] Flagged', 5: 'Team One', 6: ' true ' }),
    wide({ 0: '[NOW] No world', 5: '' }),
    wide({ 0: '', 5: 'Team One' })]);
  let alli = toCsv([allianceHeader(3, 4),
    wide({ 0: '[ALL] The Alliance', 3: '[M1] Member One (NA)\n\n  Member Two \n', 4: 'Team One' })]);
  let [[name, data]] = await community(solo, alli);
  assert.equal(name, 'Team One');
  assert.deepEqual(data.solo, [{ tag: 'AAA', name: 'Alpha', region: 'NA' }, { tag: null, name: 'No Tag Guild', region: null }]);
  assert.deepEqual(data.alliances, [{
    tag: 'ALL', name: 'The Alliance', region: null,
    members: [{ tag: 'M1', name: 'Member One', region: 'NA' }, { tag: null, name: 'Member Two', region: null }]
  }]);
  // Headers renamed: the layout last verified (world at 21 and 22, mismatch at 19, members at 2).
  solo = toCsv([['Guild', 'Renamed'], wide({ 0: '[BBB] Beta', 21: 'Team Two' }), wide({ 0: '[CCC] Flagged', 21: 'Team Two', 19: 'TRUE' })]);
  alli = toCsv([['Alliance'], wide({ 0: '[DDD] Delta', 2: '[E] Echo', 22: 'Team Two' })]);
  [[name, data]] = await community(solo, alli);
  assert.equal(name, 'Team Two');
  assert.deepEqual(data.solo.map((g) => g.tag), ['BBB']);
  assert.deepEqual(data.alliances[0].members.map((g) => g.tag), ['E']);
  // An empty sheet is no teams, not an error.
  assert.deepEqual(await community('', ''), []);
  await assert.rejects(community('', '', { status: 500 }), /HTTP 500/);
});

test('parseGuildNames: blank lines, repeats in any case, the length and the count limits (js/summary.js)', () => {
  const p = fresh();
  const parse = (t) => plain(p.call('parseGuildNames', t));
  assert.deepEqual(parse('Alpha\n\n  \nbeta \r\nALPHA\nAlpha Two\nBeta'), { names: ['Alpha', 'beta', 'Alpha Two'], cut: false },
    'the first spelling stays; CRLF and blank lines leave nothing');
  assert.deepEqual(parse(''), { names: [], cut: false });
  const long = 'x'.repeat(64) + 'tail';
  assert.deepEqual(parse(long + '\n' + 'X'.repeat(64)), { names: ['x'.repeat(64)], cut: false }, 'cut to 64 first, then compared');
  const n = (k) => Array.from({ length: k }, (_, i) => 'Guild ' + i).join('\n');
  assert.deepEqual([parse(n(20)).names.length, parse(n(20)).cut], [20, false]);
  assert.deepEqual([parse(n(21)).names.length, parse(n(21)).cut], [20, true]);
  assert.equal(parse(n(21)).names[19], 'Guild 19');
  assert.equal(parse(n(20) + '\nguild 3\nGUILD 4').cut, false, 'repeats past the limit are not "more"');
});

test('wrapChatLine: 199 characters fit, more break on spaces, and nothing is lost (js/summary.js)', () => {
  const p = fresh();
  const wrap = (l) => plain(p.call('wrapChatLine', l));
  const tag = (i) => '[T' + String(i).padStart(2, '0') + ']';
  const line199 = Array.from({ length: 32 }, (_, i) => tag(i)).join(' ') + ' LASTONE';
  assert.equal(line199.length, 199);
  assert.deepEqual(wrap(line199), [line199], '199 is not wrapped');
  assert.deepEqual(wrap(''), ['']);
  const line200 = line199 + 'C';
  assert.equal(line200.length, 200);
  const two = wrap(line200);
  assert.equal(two.length, 2);
  assert.equal(two[0], line199.slice(0, line199.lastIndexOf(' ')), 'the break is at a space, a tag stays whole');
  assert.equal(two[1], 'LASTONEC');
  assert.equal(two.join(' '), line200);
  // A word that makes the line exactly 199 still fits; one more character does not.
  const a = 'a'.repeat(100);
  assert.deepEqual(wrap(a + ' ' + 'b'.repeat(98) + ' c'), [a + ' ' + 'b'.repeat(98), 'c']);
  assert.deepEqual(wrap(a + ' ' + 'b'.repeat(98) + ' ' + 'c'.repeat(60)).map((s) => s.length), [199, 60]);
  assert.deepEqual(wrap(a + ' ' + 'b'.repeat(99)), [a, 'b'.repeat(99)]);
  // A single word past the limit goes out alone, with its neighbours on their own lines.
  const giant = 'g'.repeat(250);
  assert.deepEqual(wrap('first ' + giant + ' last'), ['first', giant, 'last']);
  assert.deepEqual(wrap(giant + ' ' + giant), [giant, giant]);
  // Many tags: every line fits, every tag is whole, in order.
  const many = Array.from({ length: 120 }, (_, i) => tag(i % 100)).join(' ');
  const out = wrap(many);
  assert.ok(out.length > 1 && out.every((l) => l.length <= 199));
  assert.equal(out.join(' '), many);
  assert.equal(p.call('wrapChatBlock', 'short\n' + many + '\n\nend'), ['short', ...out, '', 'end'].join('\n'));
});

test('the community blocks: nothing without data, only the lists that exist, tags only in the chat version (js/summary.js)', () => {
  const p = fresh();
  const compact = (d) => p.call('buildCompactCommunityBlock', 'Team Allies', d && plain(d));
  const detailed = (d) => p.call('buildDetailedCommunityBlock', 'Team Allies', d && plain(d));
  const g = (tag, name) => ({ tag, name, region: null });
  const al = { ...g('ALL', 'The Alliance'), members: [g('M1', 'One'), g(null, 'Tagless')] };
  for (const d of [undefined, null]) {
    assert.equal(compact(d), null);
    assert.equal(detailed(d), null);
  }
  assert.equal(compact({ alliances: [al], solo: [] }), 'Team Allies\nAlliances: [ALL]');
  assert.equal(compact({ alliances: [], solo: [g('S1', 'Solo'), g(null, 'Bare'), g('S2', 'Two')] }), 'Team Allies\nSolo: [S1] [S2]');
  assert.equal(compact({ alliances: [al], solo: [g('S1', 'Solo')] }), 'Team Allies\nAlliances: [ALL]\nSolo: [S1]');
  assert.equal(detailed({ alliances: [al], solo: [g('S1', 'Solo'), g(null, 'Bare')] }),
    'Team Allies\nAlliances:\n  [ALL] The Alliance\n    [M1] One\n    Tagless\nSolo guilds:\n  [S1] Solo\n  Bare');
  assert.equal(detailed({ alliances: [g(null, 'No Tag Alliance')].map((a) => ({ ...a, members: [] })), solo: [] }),
    'Team Allies\nAlliances:\n  No Tag Alliance');
});

// A match body (tiers 1-3 on NA, 2-2 on EU in the test below), built from a body shape the page reads.
function matchBody(id, endMs, ids) {
  const trio = (a, b, c) => ({ red: a, blue: b, green: c });
  return {
    id, start_time: '2026-10-03T02:00:00Z', end_time: new Date(endMs).toISOString(),
    worlds: trio(ids[0] - 10000, ids[1] - 10000, ids[2] - 10000),
    all_worlds: trio([ids[0] - 10000, ids[0]], [ids[1]], [ids[2]])
  };
}

test('buildSummaryText: a live tier names the enemies, a finished week and a team without a match say only where it landed (js/summary.js)', async () => {
  const p = fresh();
  const NOW = p.clock.now;
  const na = ['11001', '11002', '11003'];
  const eu = ['12001', '12002', '12003'];
  const name = (id) => p.call('getTeamName', id);
  const put = (body) => {
    p.ctx.__m = body;
    p.run('matchDataCache.set(__m.id, __m)');
    for (const c of ['red', 'blue', 'green']) { p.ctx.__id = String(body.all_worlds[c].at(-1)); p.run('teamToMatchId.set(__id, __m.id)'); }
  };
  const community = new Map([[name(na[0]), { alliances: [], solo: [{ tag: 'AAA', name: 'Alpha', region: null }] }],
    [name(na[1]), { alliances: [{ tag: 'BBB', name: 'Bravo', region: null, members: [] }], solo: [] }]]);
  p.ctx.loadCommunityGuilds = async () => community;
  put(matchBody('1-3', NOW + 86400e3, na.map(Number)));
  put(matchBody('2-2', NOW + 86400e3, eu.map(Number)));
  const live = await p.run(`buildSummaryText([{ name: 'Alpha', teamId: '${na[0]}' }, { name: 'Zed', teamId: '${eu[1]}' }, { name: 'Lost', teamId: '99999' }, { name: 'Beta', teamId: '${na[0]}' }])`);
  const blocks = live.detailed.split('\n\n');
  assert.equal(blocks[0], `Alpha, Beta landed on ${name(na[0])} (NA Tier 3)`);
  assert.equal(blocks[1], `${name(na[0])} Allies\nSolo guilds:\n  [AAA] Alpha`);
  assert.equal(blocks[2], `${name(na[1])} Enemies\nAlliances:\n  [BBB] Bravo`);
  assert.ok(!live.detailed.includes(name(na[2]) + ' Enemies'), 'an enemy the sheet does not know adds no block');
  assert.ok(live.detailed.includes(`Zed landed on ${name(eu[1])} (EU Tier 2)\nFighting: ${name(eu[0])}, ${name(eu[2])}`));
  assert.ok(live.compact.includes(`Zed landed on ${name(eu[1])} (EU Tier 2)\nFighting: ${name(eu[0])}, ${name(eu[2])}`));
  assert.ok(live.detailed.includes(`Lost landed on ${name('99999')}`) && !live.detailed.includes(`Lost landed on ${name('99999')} (`));
  assert.ok(live.compact.includes(`${name(na[0])} Allies\nSolo: [AAA]`));
  // The week is over: no tier, no enemies, no "Fighting:", but the sheet still speaks for the team.
  p.clock.now = NOW + 2 * 86400e3;
  const over = await p.run(`buildSummaryText([{ name: 'Alpha', teamId: '${na[0]}' }, { name: 'Zed', teamId: '${eu[1]}' }])`);
  assert.ok(over.detailed.startsWith(`Alpha landed on ${name(na[0])}\n\n${name(na[0])} Allies\nSolo guilds:\n  [AAA] Alpha`));
  assert.ok(!over.detailed.includes('Tier') && !over.detailed.includes('Enemies') && !over.detailed.includes('Fighting'));
  assert.ok(over.detailed.endsWith(`Zed landed on ${name(eu[1])}`));
  // The sheet failing costs the community lines only.
  p.ctx.loadCommunityGuilds = async () => { throw new Error('sheet down'); };
  const down = await p.run(`buildSummaryText([{ name: 'Alpha', teamId: '${na[0]}' }])`);
  assert.equal(down.detailed, `Alpha landed on ${name(na[0])}`);
  // A long tag row: the chat version wraps, the Discord one lists a guild per line and is left as it is.
  const tags = Array.from({ length: 60 }, (_, i) => ({ tag: 'T' + i, name: 'n' + i, region: null }));
  p.clock.now = NOW;
  p.ctx.loadCommunityGuilds = async () => new Map([[name(na[0]), { alliances: [], solo: tags }]]);
  const wrapped = await p.run(`buildSummaryText([{ name: 'Alpha', teamId: '${na[0]}' }])`);
  assert.ok(wrapped.compact.split('\n').every((l) => l.length <= 199));
  assert.ok(wrapped.compact.split('\n').length > 4, 'the 60 tags did not fit one line');
  assert.equal(wrapped.detailed.split('\n').filter((l) => /^  \[T\d+\] n\d+$/.test(l)).length, 60);
  assert.ok(wrapped.compact.replace(/\n/g, ' ').includes('[T59]'));
});
