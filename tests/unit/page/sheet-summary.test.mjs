// The community sheet's reading (js/sheet.js): what a visitor sees of a sheet that
// arrives in a shape nobody promised. Run in node:vm, through page/harness.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage } from './harness.mjs';

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
