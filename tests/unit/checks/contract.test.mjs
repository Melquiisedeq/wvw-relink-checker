// scripts/check-contract.mjs with the game's answers made up: no network. The answers are the
// recording the page tests run on, so the check is green until a test plants a defect in one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { main, against, resolve, shapeOf, versus, tname, readRecording, ROOT, BASE } from '../../../scripts/check-contract.mjs';
import { fakeFetch, fakeSleep, lines, errors } from './fake-http.mjs';

// The recording the page tests run on, cut to a few items of each list and sixty keys of each map: the shapes are the same
// and both sides receive the same cut.
const cut = (v) => {
  if (Array.isArray(v)) return v.slice(0, 3).map(cut);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 60).map(([k, x]) => [k, cut(x)]));
  return v;
};
const entries = new Map([...readRecording(ROOT)].map(([route, data]) => [route, cut(data)]));
const clone = (v) => structuredClone(v);

// A checkout of the three files the check reads, with a recording of our own.
function rooted(recorded, contract) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'tests', 'e2e', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'gw2-contract.json'), JSON.stringify(contract));
  const entriesJson = {};
  for (const [route, data] of Object.entries(recorded)) entriesJson[`${BASE}${route}`] = [200, {}, JSON.stringify(data)];
  fs.writeFileSync(path.join(root, 'tests', 'e2e', 'data', 'recordings.json.gz'), zlib.gzipSync(JSON.stringify({ entries: entriesJson })));
  return root;
}
const CONTRACT = (routes, defs = {}) => ({ defs, routes: routes.map((r) => ({ read_in: 'site/js/x.js', ...r })) });


// The real contract with a recording cut to what it asks with: the checks read it once a run, and the whole one is heavy.
const REAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'gw2-contract.json'), 'utf8'));
const WANTED = new Set(REAL.routes.flatMap((r) => [r.route, r.recorded]).filter(Boolean));
const GUILD_IDS = [...entries.keys()].filter((p) => /^\/guild\/[0-9A-Fa-f-]{36}$/.test(p)).sort().slice(0, 5);
const SEARCHES = [...entries.keys()].filter((p) => p.startsWith('/guild/search?name='));
const SLIM = rooted(Object.fromEntries([...entries].filter(([p]) => WANTED.has(p) || GUILD_IDS.includes(p) || SEARCHES.includes(p))), REAL);

// The live route the recording knows under another map's name is answered with that recording.
const SECTORS = (id) => `/continents/2/floors/3/regions/7/maps/${id}/sectors?ids=all`;
const STAND_IN = { [SECTORS(1651)]: SECTORS(1099) };

// The game as the recording has it; `edit` changes what one route answers.
async function run({ edit = {}, down = {}, flaky = {}, root = SLIM, recorded = entries } = {}) {
  const fetchFn = fakeFetch((url) => {
    const route = url.slice(BASE.length);
    if (down[route]) return down[route];
    if (flaky[route] && fetchFn.asked.filter((a) => a.endsWith(route)).length <= flaky[route]) return { status: 502 };
    const known = recorded.has(route) ? route : STAND_IN[route];
    if (!known) return { status: 404 };
    const data = clone(recorded.get(known));
    return { body: edit[route] ? edit[route](data) ?? data : data };
  });
  const sleep = fakeSleep();
  const result = await main({ fetchFn, sleep, root });
  return { ...result, log: lines(result), asked: fetchFn.asked, slept: sleep.slept };
}
const red = async (plan, pattern, count = 1) => {
  const r = await run(plan);
  assert.equal(r.code, 1, r.log);
  assert.equal(errors(r).length, count, r.log);
  assert.match(errors(r)[0], pattern);
  assert.match(r.out.at(-1), new RegExp(`^${count} problem\\(s\\)\\.$`));
  return r;
};

const MATCHES = '/wvw/matches?ids=all';
const OBJECTIVES = '/wvw/objectives?ids=all';
const LOCKOUT = '/wvw/timers/lockout';

test('the game as recorded: green, a line for each route', async () => {
  const r = await run();
  assert.equal(r.code, 0, r.log);
  assert.equal(r.out.at(-1), 'The live API matches the contract and the recording.');
  assert.equal(r.out.at(-2), '');
  const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'gw2-contract.json'), 'utf8'));
  assert.equal(r.out.length, contract.routes.length + 2);
  assert.ok(r.out.includes(`${LOCKOUT.padEnd(62)} 1 request(s)`));
  assert.ok(r.out.some((l) => l.startsWith('/guild/$guildId'.padEnd(62)) && l.endsWith(' 5 request(s)')));
  assert.ok(r.out.some((l) => l.startsWith('/guild/search?name=$guild') && l.endsWith(' 2 request(s)')), r.log);
  assert.ok(r.out.some((l) => l.startsWith('/guild/upgrades?ids=583,147,483,513,590,306,168,298,562,178,41 ')), 'the name is cut at 62');
  assert.deepEqual(r.slept, []);
});

test('a route that never answers fails after three attempts, with the pauses between', async () => {
  const r = await red({ down: { [LOCKOUT]: { status: 500 } } }, /^::error::\/wvw\/timers\/lockout did not answer \(HTTP 500 after 3 attempts\)$/);
  assert.deepEqual(r.slept, [5, 5]);
  assert.equal(r.asked.filter((a) => a.endsWith(LOCKOUT)).length, 3);
  const bad = await red({ down: { [LOCKOUT]: { body: 'not json' } } }, /did not answer \(SyntaxError: .* after 3 attempts\)$/);
  assert.equal(bad.asked.filter((a) => a.endsWith(LOCKOUT)).length, 3);
});

test('a route that fails twice and then answers is read', async () => {
  const r = await run({ flaky: { [LOCKOUT]: 2 } });
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(r.slept, [5, 5]);
  assert.equal(r.asked.filter((a) => a.endsWith(LOCKOUT)).length, 3);
});

test('a key the page reads that is gone is named, with the file that reads it', async () => {
  const r = await red({ edit: { [LOCKOUT]: (d) => { delete d.na; } } }, /^::error::contract \(site\/js\/relink\.js\): \/wvw\/timers\/lockout lacks key na$/, 2);
  assert.equal(errors(r)[1], '::error::recording (/wvw/timers/lockout): field gone from the live answer: .na (recorded str)');
});

test('a key the page may lack can go, and one that is null passes while it is optional', async () => {
  const eu = await run({ edit: { [LOCKOUT]: (d) => { delete d.eu; } } });
  assert.deepEqual(errors(eu), ['::error::recording (/wvw/timers/lockout): field gone from the live answer: .eu (recorded str)']);
  const nul = await run({ edit: { [LOCKOUT]: (d) => { d.eu = null; } } });
  assert.equal(nul.code, 1, 'a null passes the contract, but the recording had a string');
  assert.ok(!errors(nul).some((l) => l.includes('contract (')), nul.log);
  assert.ok(errors(nul).some((l) => l.includes('type changed at .eu: recorded str, live null')), nul.log);
});

test('a type that changed is named, a required key that is null too', async () => {
  await red({ edit: { [LOCKOUT]: (d) => { d.na = 5; } } }, /^::error::contract \(.*\): \/wvw\/timers\/lockout\.na is num, the page reads str$/, 2);
  const r = await run({ edit: { [LOCKOUT]: (d) => { d.na = null; } } });
  assert.ok(errors(r).includes('::error::contract (site/js/relink.js): /wvw/timers/lockout.na is null, the page reads str'), r.log);
});

test('an answer that is not an object or not a list is named', async () => {
  const obj = await run({ edit: { [LOCKOUT]: () => ['x'] } });
  assert.ok(errors(obj).includes('::error::contract (site/js/relink.js): /wvw/timers/lockout is list, the page reads an object'), obj.log);
  const list = await run({ edit: { [OBJECTIVES]: () => ({ a: 1 }) } });
  assert.ok(errors(list).includes('::error::contract (site/js/maps.js): /wvw/objectives?ids=all is object, the page reads a list'.replace('?ids=all', '')), list.log);
});

test('an empty list is named as such', async () => {
  const r = await run({ edit: { [OBJECTIVES]: () => [] } });
  assert.ok(errors(r).includes('::error::/wvw/objectives?ids=all came back as an empty list'), r.log);
});

test('a key gone from every item names five of them, one gone from one item names one', async () => {
  const r = await run({ edit: { [OBJECTIVES]: (d) => { while (d.length < 8) d.push(clone(d[0])); for (const o of d) delete o.name; } } });
  const contractErrors = errors(r).filter((l) => l.includes('contract ('));
  assert.equal(contractErrors.length, 5);
  assert.ok(contractErrors.every((l) => l.endsWith('/wvw/objectives[] lacks key name')), r.log);
  const one = await run({ edit: { [OBJECTIVES]: (d) => { delete d[0].name; } } });
  assert.equal(errors(one).filter((l) => l.includes('contract (')).length, 1);
});

test('the keys of a map keyed by arbitrary ids are read, the first fifty only', async () => {
  const guilds = '/wvw/guilds/na';
  const r = await run({ edit: { [guilds]: (d) => { d[Object.keys(d)[0]] = 5; } } });
  assert.ok(errors(r).includes('::error::contract (site/js/api.js): /wvw/guilds/na.* is num, the page reads str'), r.log);
  const late = await run({ edit: { [guilds]: (d) => { const k = Object.keys(d); d[k[k.length - 1]] = 5; } } });
  assert.ok(!errors(late).some((l) => l.includes('contract (')), 'the fifty-first is not read');
});

test('the shape of the live answer against the recording: a field gone, new, or of another type', async () => {
  const r = await run({ edit: { [LOCKOUT]: (d) => { d.extra = 1; d.eu = 3; } } });
  assert.ok(errors(r).includes('::error::recording (/wvw/timers/lockout): new field in the live answer: .extra (num)'), r.log);
  assert.ok(errors(r).includes('::error::recording (/wvw/timers/lockout): type changed at .eu: recorded str, live num'), r.log);
  const gone = await run({ edit: { [MATCHES]: (d) => { for (const m of d) delete m.start_time; } } });
  assert.ok(errors(gone).some((l) => /recording \(\/wvw\/matches\?ids=all\): field gone from the live answer: \[\]\.start_time \(recorded str\)$/.test(l)), gone.log);
});

test('no more than eight differences are listed for a route', async () => {
  const r = await run({ edit: { [LOCKOUT]: (d) => { for (let i = 0; i < 12; i++) d[`k${String(i).padStart(2, '0')}`] = 1; } } });
  assert.equal(errors(r).filter((l) => l.includes('recording (/wvw/timers/lockout)')).length, 8);
});

test('a recorded route is compared under the name the recording knows it by', async () => {
  const r = await run({ edit: { '/wvw/matches?id=1-1': (d) => { d.extra = 1; } } });
  assert.ok(errors(r).includes('::error::recording (/wvw/matches?id=1-1): new field in the live answer: .extra (num)'), r.log);
});

test('the guild routes ask with what the recording holds: five ids, and every recorded search', async () => {
  const r = await run();
  const guild = r.asked.filter((a) => /GET .*\/guild\/[0-9A-F-]{36}$/i.test(a));
  assert.equal(guild.length, 5);
  assert.deepEqual(guild, [...guild].sort());
  const searches = [...entries.keys()].filter((p) => p.startsWith('/guild/search?name='));
  assert.equal(searches.length, 2);
  for (const s of searches) assert.ok(r.asked.includes(`GET ${BASE}${s}`));
  const broken = await run({ edit: { [guild[0].slice(`GET ${BASE}`.length)]: (d) => { delete d.name; } } });
  assert.ok(errors(broken).some((l) => /^::error::contract \(site\/js\/relink\.js\): \/guild\/[0-9A-F-]{36} lacks key name$/i.test(l) || l.includes('lacks key')), broken.log);
});

test('a recording with nothing to ask the guild routes with says so', async () => {
  const root = rooted({}, CONTRACT([{ route: '/guild/$guildId', shape: { id: 'str' } }, { route: '/guild/search?name=$guild', shape: ['str'] }]));
  const r = await run({ root, recorded: new Map() });
  assert.equal(r.code, 1);
  assert.deepEqual(errors(r), [
    '::error::/guild/$guildId: nothing in the recording to ask with',
    '::error::/guild/search?name=$guild: nothing in the recording to ask with',
  ]);
  assert.deepEqual(r.asked, []);
  assert.ok(!r.out.some((l) => l.includes('request(s)')), 'a route with nothing to ask is not counted as asked');
});

test('only a recorded 200 with a guild id in the path is asked with, in either case of letters', async () => {
  const id = '00000000-0000-0000-0000-00000000000';
  const upper = 'ABCDEF01-2345-6789-ABCD-EF0123456789';
  const lower = 'abcdef01-2345-6789-abcd-ef0123456789';
  const asked = { [`/guild/${id}1`]: { id: 'x' }, [`/guild/${upper}`]: { id: 'x' }, [`/guild/${lower}`]: { id: 'x' } };
  const noise = { '/guild/not-an-id': { id: 'x' }, [`/guild/${id}2/extra`]: {}, [`/guild/zz${id}3`]: {}, [`/guild/${id}4zz`]: {}, '/guild/': {} };
  const root = rooted({ ...asked, ...noise }, CONTRACT([{ route: '/guild/$guildId', shape: { id: 'str' } }]));
  const r = await run({ root, recorded: new Map(Object.entries(asked)) });
  assert.equal(r.code, 0, r.log);
  assert.deepEqual(r.asked, Object.keys(asked).sort().map((p) => `GET ${BASE}${p}`));
});

test('a recording of eight guilds is sampled by its first five in sorted order', async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `0000000${i}-0000-0000-0000-000000000000`);
  const rec = Object.fromEntries([...ids].reverse().map((i) => [`/guild/${i}`, { id: 'x' }]));
  const r = await run({ root: rooted(rec, CONTRACT([{ route: '/guild/$guildId', shape: { id: 'str' } }])), recorded: new Map(Object.entries(rec)) });
  assert.deepEqual(r.asked, ids.slice(0, 5).map((i) => `GET ${BASE}/guild/${i}`));
});

test('every request says who is asking', async () => {
  const agents = [];
  const fetchFn = fakeFetch((url, init) => { agents.push(init.headers['User-Agent']); return { body: entries.get(url.slice(BASE.length)) ?? entries.get(SECTORS(1099)) }; });
  await main({ fetchFn, sleep: fakeSleep(), root: ROOT });
  assert.ok(agents.length > 20);
  assert.deepEqual([...new Set(agents)], ['wvwrelink-health-check']);
});

test('a route the recording lacks is noted and not compared; the contract still is', async () => {
  const root = rooted({}, CONTRACT([{ route: '/x', shape: { a: 'str' } }]));
  const r = await run({ root, recorded: new Map([['/x', { a: 1 }]]) });
  assert.equal(r.code, 1);
  assert.ok(r.out.includes('/x is not in the recording'), r.log);
  assert.deepEqual(errors(r), ['::error::contract (site/js/x.js): /x.a is num, the page reads str']);
});

test('only a recording of status 200 under the API address counts', async () => {
  const root = rooted({ '/x': { a: 'x' } }, CONTRACT([{ route: '/x', shape: { a: 'str' } }]));
  const file = path.join(root, 'tests', 'e2e', 'data', 'recordings.json.gz');
  const rec = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  rec.entries[`${BASE}/y`] = [404, {}, '{"a":1}'];
  rec.entries['https://example.com/v2/z'] = [200, {}, '{"a":1}'];
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(rec)));
  assert.deepEqual([...readRecording(root).keys()], ['/x']);
});

test('a name from the game cannot start a workflow command in the log', async () => {
  const root = rooted({ '/x': { 'a\n::error::injected': 'x' } }, CONTRACT([{ route: '/x', shape: { 'a\n::error::injected': 'str' } }]));
  const r = await run({ root, recorded: new Map([['/x', { 'a\n::error::injected': 5 }]]) });
  assert.deepEqual(r.out.filter((l) => l.startsWith('::')).map((l) => l.slice(0, l.indexOf('(') + 1)), ['::error::contract (', '::error::recording (']);
  assert.ok(r.out.some((l) => l.includes('a%0A::error::injected is num')));
});

test('a definition the contract names but lacks stops the check', async () => {
  const root = rooted({}, CONTRACT([{ route: '/x', shape: '$nothing' }]));
  await assert.rejects(run({ root, recorded: new Map() }), /KeyError: 'nothing'/);
});

test('the types of a value, as the contract names them', () => {
  assert.deepEqual([null, true, 1, 1.5, 'a', [], {}].map(tname), ['null', 'bool', 'num', 'num', 'str', 'list', 'object']);
});

test('definitions resolve all the way down, and a list shape keeps its first item', () => {
  const defs = { a: { x: '$b', y: ['$b'] }, b: 'str|num' };
  assert.deepEqual(resolve('$a', defs), { x: 'str|num', y: ['str|num'] });
  assert.deepEqual(resolve([{ k: 'str' }, 'ignored'], defs), [{ k: 'str' }]);
  assert.equal(resolve('str', defs), 'str');
});

test('a type listed with | takes any of them; ? and * in a shape', () => {
  const out = [];
  against(5, 'str|num', 'w', out);
  against(null, 'str|null', 'w', out);
  against(true, 'str|num', 'w', out);
  against({ a: null, b: 1 }, { 'a?': 'str', 'b?': 'str' }, 'w', out);
  against({ a: 1 }, { '*': 'str' }, 'w', out);
  against([], ['str'], 'w', out);
  assert.deepEqual(out, ['w is bool, the page reads str|num', 'w.b is num, the page reads str', 'w.* is num, the page reads str']);
});

test('a list is read item by item until one item has more than three faults', () => {
  const item = { a: 'str', b: 'str', c: 'str', d: 'str' };
  const lacking = (n) => Object.fromEntries(Object.keys(item).slice(n).map((k) => [k, 'x']));
  const three = [];
  against([lacking(3), lacking(3), lacking(3)], [item], 'w', three);
  assert.equal(three.length, 9, 'three faults an item: no stop');
  const four = [];
  against([lacking(4), lacking(4), lacking(4)], [item], 'w', four);
  assert.equal(four.length, 4, 'four faults an item: it stops after the first');
});

test('an object keyed by arbitrary ids is read to its fiftieth value, and an optional object may be null only as a string shape', () => {
  const wide = (bad) => Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i === bad ? 1 : 'x']));
  const at50 = [];
  against(wide(49), { '*': 'str' }, 'w', at50);
  assert.deepEqual(at50, ['w.* is num, the page reads str']);
  const at51 = [];
  against(wide(50), { '*': 'str' }, 'w', at51);
  assert.deepEqual(at51, []);
  const nested = [];
  against({ o: null }, { 'o?': { a: 'str' } }, 'w', nested);
  assert.deepEqual(nested, ['w.o is null, the page reads an object']);
  const plain = [];
  against({ o: null, p: 1 }, { 'o?': 'str', 'p??': 'num' }, 'w', plain);
  assert.deepEqual(plain, []);
});

test('the paths and types of a value, an object of more than fifty keys by one path', () => {
  const into = shapeOf({ a: [1, 'x'], b: { c: null } }, new Map());
  assert.deepEqual([...into].map(([k, v]) => [k, [...v].sort().join('/')]).sort(),
    [['', 'object'], ['.a', 'list'], ['.a[]', 'num/str'], ['.b', 'object'], ['.b.c', 'null']].sort());
  const wide = shapeOf(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i])), new Map());
  assert.deepEqual([...wide.keys()].sort(), ['', '.*']);
  const narrow = shapeOf(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])), new Map());
  assert.equal(narrow.size, 51);
});

test('an empty list on one side carries no children to compare', () => {
  const sets = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
  const rec = sets({ '': ['object'], '.l': ['list'], '.l[]': ['object'], '.l[].a': ['num'] });
  assert.deepEqual(versus(sets({ '': ['object'], '.l': ['list'] }), rec), [], 'live empty: nothing to compare');
  assert.deepEqual(versus(sets({ '': ['object'], '.l': ['list'], '.l[]': ['object'], '.l[].a': ['num'], '.l[].b': ['str'] }), rec),
    ['new field in the live answer: .l[].b (str)']);
  assert.deepEqual(versus(sets({ '': ['object'], '.l': ['list'], '.l[]': ['object'] }), rec), ['field gone from the live answer: .l[].a (recorded num)']);
  assert.deepEqual(versus(sets({ '': ['object'], '.l': ['object'] }), rec).length, 3, 'live of another type: its children are gone');
  const empty = sets({ '': ['object'], '.l': ['list'] });
  assert.deepEqual(versus(rec, empty), [], 'recorded empty: nothing to compare against');
  assert.deepEqual(versus(sets({ '': ['object'], '.l': ['list'], '.l[]': ['num'] }), empty), [], 'children of a recorded empty list');
  assert.deepEqual(versus(sets({ '': ['list'] }), sets({ '': ['list'], '[]': ['object'] })).length, 1, 'a list at the root has no such leniency');
  assert.deepEqual(versus(sets({ '': ['object'], '.a': ['num'] }), sets({ '': ['object'], '.b': ['num'] })).length, 2);
  assert.deepEqual(versus(sets({ '': ['num'] }), sets({ '': ['str'] })), ['type changed at (root): recorded str, live num']);
  assert.deepEqual(versus(sets({ '.x': ['str', 'num'], '': ['object'] }), sets({ '.x': ['num'], '': ['object'] })), ['type changed at .x: recorded num, live num/str']);
  assert.deepEqual(versus(sets({ '.x': ['num'], '': ['object'] }), sets({ '.x': ['str', 'null', 'num'], '': ['object'] })), [], 'a subset is the same type');
  assert.deepEqual(versus(sets({ '.x': ['bool'], '': ['object'] }), sets({ '.x': ['str', 'null', 'num'], '': ['object'] })), ['type changed at .x: recorded null/num/str, live bool']);
  assert.deepEqual(versus(sets({ '.x': ['num'], '': ['object'] }), sets({ '.x': ['num', 'str'], '': ['object'] })), []);
});

// A loop that never ends cannot be stopped by the test runner's own timeout (the event loop is busy), so the
// call runs in a child process with a limit.
test('a key whose parent path never shrinks is reported as new, not looped on', () => {
  const script = `
    import { versus } from ${JSON.stringify(new URL('../../../scripts/check-contract.mjs', import.meta.url).href)};
    const sets = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
    const out = {};
    for (const odd of ['.a.', '.a[', '.a]x', '.', '.a[]\\n', '.a..b']) {
      out[odd] = versus(sets({ '': ['object'], [odd]: ['num'] }), sets({ '': ['object'] }));
    }
    console.log(JSON.stringify(out));`;
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8' });
  assert.equal(ran.error, undefined, `did not finish in 5 s: ${ran.error}`);
  assert.equal(ran.status, 0, ran.stderr);
  for (const [odd, found] of Object.entries(JSON.parse(ran.stdout))) {
    assert.deepEqual(found, [`new field in the live answer: ${odd} (num)`], JSON.stringify(odd));
  }
});
