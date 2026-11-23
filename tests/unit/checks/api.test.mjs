// scripts/check-api.mjs with the game's answers made up: no network. main() runs with the fetch and the
// sleep replaced, and the exit code and the CI log are what is asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, BASE, ROOT, contractKeys, loadContract, makeFetch, positionless } from '../../../scripts/check-api.mjs';
import { fakeFetch, fakeSleep, lines, errors } from './fake-http.mjs';

const GUID = '00000000-0000-0000-0000-000000000001';
const COLORS = { red: 1, blue: 1, green: 1 };
const goodMap = { id: 7, kills: COLORS, deaths: COLORS, objectives: [], scores: COLORS, type: 'Center' };
const goodRound = { id: 1, map_scores: [], scores: COLORS };
const ITEM = Object.fromEntries(['id', 'name', 'description', 'icon', 'tiers', 'layers', 'bounds', 'coord', 'type'].map((k) => [k, 1]));
const obj = (id, extra) => ({ id, name: id, type: 'Camp', map_type: 'Center', map_id: 7, ...extra });
const placed = obj('7-2', { coord: [1, 2, 3] });
const without = (o, k) => { const { [k]: _, ...rest } = o; return rest; };

// The world as the game answers it today; `plan` changes it.
function world(plan = {}) {
  const match = {
    id: '1-1', scores: COLORS, start_time: 'x', end_time: 'x', worlds: {}, kills: COLORS, deaths: COLORS, victory_points: COLORS,
    maps: [goodMap], all_worlds: { red: [11001], blue: [11002], green: [11003] }, skirmishes: [goodRound], ...plan.match,
  };
  const guild = { id: GUID, name: 'A', tag: 'T', ...plan.guild };
  const routes = {
    '/wvw/timers/lockout': { na: 'x', eu: 'x' },
    '/wvw/timers/teamAssignment': { na: 'x', eu: 'x' },
    '/wvw/matches': ['1-1'],
    '/wvw/matches?ids=all': [match],
    '/wvw/objectives?ids=all': plan.objectives ?? [placed],
    '/wvw/guilds/na': { [GUID]: '11001' },
    '/wvw/guilds/eu': { x: '11001' },
    [`/guild/${GUID}`]: guild,
    [`/guild/search?name=${encodeURIComponent(guild.name)}`]: [GUID],
    ...plan.routes,
  };
  return (url) => {
    const route = url.slice(BASE.length);
    if (plan.status?.[route]) return { status: plan.status[route], body: '' };
    if (route.startsWith('/wvw/matches?world=')) return { body: plan.one ?? match };
    return { body: route in routes ? routes[route] : [ITEM] };
  };
}

async function run(plan) {
  const fetchFn = fakeFetch(world(plan));
  const sleep = fakeSleep();
  const result = await main({ fetchFn, sleep, root: ROOT });
  return { ...result, log: lines(result), asked: fetchFn.asked, slept: sleep.slept };
}
const red = async (plan, pattern, count = 1) => {
  const r = await run(plan);
  assert.equal(r.code, 1, r.log);
  assert.equal(errors(r).length, count, r.log);
  assert.match(r.log, pattern);
  return r;
};

test('every route answering in its shape: green, with a note for each route and the summary line', async () => {
  const r = await run({});
  assert.equal(r.code, 0, r.log);
  assert.equal(errors(r).length, 0);
  assert.ok(r.out.includes(`${'/wvw/matches'.padEnd(58)} 1 items`), r.log);
  assert.match(r.log, /^\/wvw\/timers\/lockout +na=x$/m);
  assert.match(r.log, /^\/wvw\/matches +1 items$/m);
  assert.match(r.log, /^guild pipeline +T -> "A" -> found again$/m);
  assert.ok(r.out.at(-1).startsWith('Every route the page reads still answers'));
});

test('a Spawn first in the list, every objective in play placed: green', async () => {
  const r = await run({ objectives: [{ ...obj('7-1'), type: 'Spawn' }, placed, obj('7-3', { label_coord: [1, 2, 3] })] });
  assert.equal(r.code, 0, r.log);
});

test('an objective in play with no coord, behind a placed first one: red', async () => {
  await red({ objectives: [placed, obj('7-3')] }, /carry no coord \(7-3\)/);
});

test('the ids of objectives without a coord are five at most, counted in full', async () => {
  const r = await red({ objectives: [1, 2, 3, 4, 5, 6, 7].map((n) => obj(`7-${n}`)) }, /7 objective\(s\)/);
  assert.match(r.log, /\(7-1, 7-2, 7-3, 7-4, 7-5\)\./);
});

test('an empty coord and no label_coord is no position; a Mercenary camp needs none', async () => {
  await red({ objectives: [obj('7-2', { coord: [] })] }, /7-2/);
  const r = await run({ objectives: [placed, { ...obj('7-9'), type: 'Mercenary' }] });
  assert.equal(r.code, 0, r.log);
});

test('an objective with no coord on a map not in play is not the check\'s business', async () => {
  const r = await run({ objectives: [placed, { ...obj('9-1'), map_id: 9 }] });
  assert.equal(r.code, 0, r.log);
});

test('the positions are not judged when a route they need did not answer', async () => {
  const r = await red({ objectives: [obj('7-3')], status: { '/wvw/objectives?ids=all': 500 } }, /::error::\/wvw\/objectives\?ids=all did not answer \(HTTP 500 after 3 attempts\)/);
  assert.ok(!/carry no coord/.test(r.log));
});

test('positionless leaves out what is not an object and matches without maps', () => {
  assert.deepEqual(positionless([5, null, obj('7-1'), obj('8-1', { map_id: '8' })], ['x', null, { maps: null }, { maps: [null, { id: 7 }, 'y', { id: '8' }] }]), ['7-1']);
});

test('a later objective missing a key the contract requires: red', async () => {
  await red({ objectives: [placed, { ...obj('7-3', { coord: [1, 2, 3] }), map_type: undefined }] }, /map_type \(1 of 2\)/);
});

test('items that are not objects are named "objects"', async () => {
  await red({ routes: { '/wvw/upgrades?ids=all': ['a', 'b'] } }, /^::error::\/wvw\/upgrades\?ids=all items no longer carry objects\./m);
});

test('a route that came back empty, or as something else than a list, is told apart', async () => {
  await red({ routes: { '/wvw/matches': [] } }, /\/wvw\/matches came back empty rather than a list/);
  await red({ routes: { '/wvw/matches': { a: 1 } } }, /\/wvw\/matches came back dict rather than/);
  await red({ routes: { '/wvw/matches': null } }, /\/wvw\/matches came back NoneType rather than/);
  await red({ routes: { '/wvw/matches': '"x"' } }, /\/wvw\/matches came back str rather than/);
});

test('a timer without the region the banner reads: red, and the route is named', async () => {
  await red({ routes: { '/wvw/timers/lockout': { eu: 'x' } } }, /\/wvw\/timers\/lockout no longer carries na\. On the page this is the lockout countdown/);
});

test('a route that answers an error is tried three times with a pause between, then reported', async () => {
  const r = await red({ status: { '/wvw/upgrades?ids=all': 500 } }, /\/wvw\/upgrades\?ids=all did not answer \(HTTP 500 after 3 attempts\)\. On the page this is objective upgrade tiers\./);
  assert.equal(r.asked.filter((a) => a.endsWith('/wvw/upgrades?ids=all')).length, 3);
  assert.deepEqual(r.slept, [5, 5]);
});

test('a route that fails twice and then answers is green', async () => {
  const answer = world({});
  let tries = 0;
  const fetchFn = fakeFetch((url, init) => (url.endsWith('/wvw/upgrades?ids=all') && ++tries < 3 ? { status: 503 } : answer(url, init)));
  const r = await main({ fetchFn, sleep: fakeSleep(), root: ROOT });
  assert.equal(r.code, 0, lines(r));
});

test('an answer that is not JSON, or a connection that breaks, is told with what it was', async () => {
  const answer = world({});
  const r = await main({
    fetchFn: fakeFetch((url, init) => {
      if (url.endsWith('/wvw/upgrades?ids=all')) return { body: 'not json' };
      if (url.endsWith('/wvw/matches')) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return answer(url, init);
    }),
    sleep: fakeSleep(), root: ROOT,
  });
  assert.match(lines(r), /\/wvw\/upgrades\?ids=all did not answer \(SyntaxError: .* after 3 attempts\)/);
  assert.match(lines(r), /\/wvw\/matches did not answer \(TypeError: fetch failed \(ECONNRESET\) after 3 attempts\)/);
});

test('the request carries the check\'s name and a time limit', async () => {
  let seen;
  await makeFetch({ fetchFn: async (url, init) => { seen = init; return new Response('[]'); }, sleep: fakeSleep() })('/x');
  assert.equal(seen.headers['User-Agent'], 'wvwrelink-health-check');
  assert.ok(seen.signal instanceof AbortSignal);
});

test('keys missing from a route\'s items are listed in order, each with its count', async () => {
  await red({ objectives: [placed, { ...obj('7-3', { coord: [1, 2, 3] }), map_type: undefined, id: undefined }] }, /items no longer carry id \(1 of 2\), map_type \(1 of 2\)\. On the page/);
  await red({ objectives: [{ ...placed, map_type: undefined, map_id: undefined }] }, /items no longer carry map_id \(1 of 1\), map_type \(1 of 1\)\./);
});

test('the match list that does not answer is one problem, and the detail is not judged', async () => {
  const r = await red({ status: { '/wvw/matches?ids=all': 500 } }, /Could not read match detail \(HTTP 500 after 3 attempts\)\./, 2);
  assert.ok(!r.log.includes('team ids'));
});

test('the second map of a match lacking a key: red', async () => {
  const bad = without(goodMap, 'deaths');
  await red({ match: { maps: [goodMap, bad] } }, /maps no longer carry deaths \(1 of 2, from maps\[1\]\)/);
});

test('the second skirmish of a match lacking a key: red', async () => {
  await red({ match: { skirmishes: [goodRound, without(goodRound, 'scores')] } }, /skirmishes no longer carry scores \(1 of 2, from skirmishes\[1\]\)/);
});

test('a key missing from every skirmish is one line, not one per skirmish', async () => {
  await red({ match: { skirmishes: Array(50).fill(without(goodRound, 'scores')) } }, /\(50 of 50, from skirmishes\[0\]\)/);
});

test('a match with several whole maps and skirmishes: green', async () => {
  const r = await run({ match: { maps: [goodMap, goodMap], skirmishes: [goodRound, goodRound] } });
  assert.equal(r.code, 0, r.log);
});

test('a match with no maps or skirmishes at all is judged by what it should carry', async () => {
  const r = await run({ match: { maps: [], skirmishes: [] } });
  assert.equal(r.code, 1);
  for (const key of ['id', 'kills', 'deaths', 'objectives', 'scores', 'type']) assert.ok(r.log.includes(`maps no longer carry ${key} (1 of 1, from maps[0]).`), key);
  for (const key of ['id', 'map_scores', 'scores']) assert.ok(r.log.includes(`skirmishes no longer carry ${key} (1 of 1, from skirmishes[0]).`), key);
});

test('scores or all_worlds without a colour: red, naming the colours', async () => {
  await red({ match: { scores: { red: 1, blue: 1 } } }, /match 1-1 scores no longer carries green\./);
  await red({ match: { all_worlds: { green: [11003] } } }, /match 1-1 all_worlds no longer carries blue, red\./);
});

test('a match with no 5-digit team id in all_worlds: red; strings of digits and numbers both count', async () => {
  await red({ match: { all_worlds: { red: [1001], blue: [1002], green: [1003] } } }, /match 1-1 has no 5-digit team ids in all_worlds/);
  await red({ match: { all_worlds: { red: [9999], blue: ['9999'], green: ['1e5'] } } }, /has no 5-digit team ids/);
  const edge = await run({ match: { all_worlds: { red: [10000], blue: [], green: [] } } });
  assert.equal(edge.code, 0, edge.log);
  const r = await run({ match: { all_worlds: { red: ['11001'], blue: [], green: [] } } });
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /1 matches, 1 team ids/);
});

test('a match without an id is called "?"', async () => {
  await red({ match: { id: undefined, scores: { red: 1 } } }, /match \? scores no longer carries blue, green/, 3);
});

test('the team lookup of the page: a team that answers no match, or one without an id, is red', async () => {
  await red({ status: { '/wvw/matches?world=11001': 500 } }, /\/wvw\/matches\?world=11001 did not answer \(HTTP 500 after 3 attempts\)\. This is how a team finds its own match\./);
  await red({ one: { x: 1 } }, /\/wvw\/matches\?world=11001 no longer returns a match with an id\./);
  await red({ one: [1] }, /no longer returns a match with an id\./);
});

test('the guild pipeline: the first guild of the table, its name searched back, both regions read', async () => {
  const r = await run({ routes: { '/wvw/guilds/na': { zzz: '11001', [GUID]: '11001' } } });
  assert.equal(r.code, 0, r.log);
  assert.ok(r.asked.includes(`GET ${BASE}/guild/${GUID}`));
  assert.ok(r.asked.includes(`GET ${BASE}/guild/search?name=A`));
  assert.match(r.log, /^\/wvw\/guilds\/na +2 guilds$/m);
  assert.match(r.log, /^\/wvw\/guilds\/eu +1 guilds$/m);
});

test('the guild table: a failure, an empty table and a list are each red', async () => {
  await red({ status: { '/wvw/guilds/na': 500 } }, /\/wvw\/guilds\/na did not answer \(HTTP 500 after 3 attempts\)\. This is the table that says which team/);
  await red({ routes: { '/wvw/guilds/na': {} } }, /\/wvw\/guilds\/na came back dict rather than an object of guilds/);
  await red({ routes: { '/wvw/guilds/na': [1] } }, /came back list rather than an object of guilds/);
});

test('a guild mapped to something that is not a 5-digit team id: red, with the value as Python wrote it', async () => {
  await red({ routes: { '/wvw/guilds/na': { [GUID]: 'abc' } } }, /maps 00000000-0000-0000-0000-000000000001 to 'abc', which is not a 5-digit team id/);
  await red({ routes: { '/wvw/guilds/na': { [GUID]: 9999 } } }, /to 9999, which is not/);
  await red({ routes: { '/wvw/guilds/na': { [GUID]: null } } }, /to None, which is not/);
  await red({ routes: { '/wvw/guilds/na': { [GUID]: '1e5' } } }, /to '1e5', which is not/);
  const r = await run({ routes: { '/wvw/guilds/na': { [GUID]: 11009 } } });
  assert.equal(r.code, 0, r.log);
});

test('the guild itself: a failure, or an answer without id, name or tag, is red', async () => {
  await red({ status: { [`/guild/${GUID}`]: 500 } }, /\/guild\/:id did not answer for 00000000-0000-0000-0000-000000000001 \(HTTP 500 after 3 attempts\)\. This is what turns a guild id/);
  await red({ guild: { tag: undefined } }, /\/guild\/:id no longer carries tag\./);
  await red({ guild: { id: undefined, name: undefined } }, /\/guild\/:id no longer carries id, name\./);
});

test('the search: a failure, or one that does not return the guild, is red', async () => {
  await red({ status: { '/guild/search?name=A': 500 } }, /\/guild\/search did not answer \(HTTP 500 after 3 attempts\)\./);
  await red({ routes: { '/guild/search?name=A': ['other'] } }, /\/guild\/search for "A" did not return 00000000-0000-0000-0000-000000000001 - it returned \['other'\]\./);
  await red({ routes: { '/guild/search?name=A': { a: 1 } } }, /it returned \{'a': 1\}\./);
});

test('the name is searched the way Python quoted it: / kept, ! * \' ( ) escaped', async () => {
  const name = "A b/c (d)!*'~é";
  const r = await run({ guild: { name }, routes: { [`/guild/search?name=${encodeURIComponent(name)}`]: [GUID] } });
  assert.ok(r.asked.includes(`GET ${BASE}/guild/search?name=A%20b/c%20%28d%29%21%2A%27~%C3%A9`), r.asked.join('\n'));
});

test('the EU table: a failure, an empty table and a list are each red', async () => {
  await red({ status: { '/wvw/guilds/eu': 500 } }, /\/wvw\/guilds\/eu did not answer \(HTTP 500 after 3 attempts\)\./);
  await red({ routes: { '/wvw/guilds/eu': {} } }, /\/wvw\/guilds\/eu came back empty\./);
  await red({ routes: { '/wvw/guilds/eu': ['a'] } }, /\/wvw\/guilds\/eu came back empty\./);
});

test('a note that carries a guild name cannot start a workflow command either', async () => {
  const name = 'Bad\n::error::injected::x';
  const r = await run({ guild: { name }, routes: { [`/guild/search?name=${encodeURIComponent(name)}`]: [GUID] } });
  assert.equal(r.code, 0, r.log);
  assert.equal(r.out.filter((l) => l.startsWith('::')).length, 0);
  assert.ok(r.log.includes('Bad%0A::error::injected::x'));
});

test('a problem that carries a guild name cannot start one either', async () => {
  const name = 'Bad\n::error::injected::x';
  const r = await red({ guild: { name }, routes: { [`/guild/search?name=${encodeURIComponent(name)}`]: [] } }, /did not return/);
  assert.ok(r.log.includes('Bad%0A::error::injected::x'));
});

test('the problems come after the notes, then a count', async () => {
  const r = await run({ status: { '/wvw/upgrades?ids=all': 500, '/emblem/foregrounds?ids=all': 500 } });
  assert.equal(r.out.at(-1), '2 problem(s).');
  assert.equal(r.out.at(-2), '');
  assert.ok(r.out.findIndex((l) => l.startsWith('::error::')) > r.out.indexOf(''));
});

test('the contract gives the required keys: no optional ones, and no coord for objectives', () => {
  const contract = loadContract();
  assert.deepEqual(contractKeys(contract, '/wvw/objectives?ids=all').sort(), ['id', 'map_id', 'map_type', 'name', 'type']);
  assert.deepEqual(contractKeys(contract, '/wvw/timers/lockout'), ['na']);
  assert.throws(() => contractKeys(contract, '/nowhere'), /KeyError/);
});
