#!/usr/bin/env node
// Does the Guild Wars 2 API still answer, in the shape this site reads?
//
// Every number on the site comes from somebody else's API, which can change
// shape without telling anyone - and when it does, the failure is not an error
// message, it is a panel that renders empty or a countdown that never appears.
//
// This check owns what check-contract.mjs does not: that each route answers at
// all, the match lookups the page makes, and the guild search end to end. The
// keys each item must carry are not listed here: they are the required keys of
// gw2-contract.json (one list, what site/js/ reads), and every item is judged.
// The objectives and sectors are a fallback on the page (it draws from the
// catalogue in js/wvw-static.js and asks the game only if it is missing);
// check-catalogue.mjs compares them in depth.
//
// Every request gets three attempts, spaced out. The API genuinely flaps around
// reset, and an alarm that fires on a blip is an alarm that gets ignored.
//
// Run it by hand any time:  node scripts/check-api.mjs
// main() takes the fetch and the sleep, so the unit test answers without a network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { escape, show, repr, typeName, truthy, has, isObject, describe } from './workflow-text.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BASE = 'https://api.guildwars2.com/v2';
const ATTEMPTS = 3;
const PAUSE_SECONDS = 5;
const TIMEOUT_SECONDS = 30;

// path, and what breaks on the page if it goes. The path is also the route's
// name in gw2-contract.json, which says the keys each item must carry.
// 'regions' means an object keyed by region rather than a list.
export const ROUTES = [
  ['/wvw/timers/lockout', 'the lockout countdown in the banner', 'regions'],
  ['/wvw/timers/teamAssignment', 'the relink countdown in the banner', 'regions'],
  ['/wvw/matches', 'the list of match ids the standings start from', null],
  ['/wvw/matches?ids=all', 'standings, scores and every tier', 'contract'],
  ['/wvw/objectives?ids=all', 'the fallback for the objectives drawn on the maps', 'contract'],
  ['/wvw/upgrades?ids=all', 'objective upgrade tiers', 'contract'],
  ['/emblem/backgrounds?ids=all', 'guild emblems on claimed objectives', 'contract'],
  ['/emblem/foregrounds?ids=all', 'guild emblems on claimed objectives', 'contract'],
  ['/guild/upgrades?ids=222', 'the name of a claimed objective upgrade', 'contract'],
  ['/continents/2/floors/3/regions/7/maps/38/sectors?ids=all',
    'the fallback for the sector names on the maps', 'contract'],
];

// Objectives that carry a label_coord but no coord: where a team starts, and
// the mercenary camps.
const POINTLESS_TYPES = ['Spawn', 'Mercenary'];

const label = (name) => name.padEnd(58);
// A 5-digit team id however it is typed: all_worlds gives numbers, the guild table strings.
const isTeamId = (w) => /^[0-9]+$/.test(String(w)) && Number(w) >= 10000;
// Percent-encodes all but letters, digits, '/' and -_.~ (urllib.parse.quote's set).
const quote = (s) => encodeURIComponent(s)
  .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  .replace(/%2F/g, '/');

export function loadContract(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'gw2-contract.json'), 'utf8'));
}

// The keys every item of this route must carry, from the contract.
export function contractKeys(contract, route) {
  const found = contract.routes.find((r) => r.route === route);
  if (!found) throw new Error(`KeyError: ${repr(route)}`);
  let shape = found.shape;
  while (typeof shape === 'string' && shape.startsWith('$')) shape = contract.defs[shape.slice(1)];
  let item = Array.isArray(shape) ? shape[0] : shape;
  while (typeof item === 'string' && item.startsWith('$')) item = contract.defs[item.slice(1)];
  return Object.keys(item).filter((k) => !k.endsWith('?'));
}

// GET and parse, retrying before giving up. Returns [data, error].
export function makeFetch({ fetchFn = fetch, sleep = (s) => pause(s * 1000) } = {}) {
  return async function get(route) {
    let last = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt) await sleep(PAUSE_SECONDS);
      try {
        const res = await fetchFn(BASE + route, {
          headers: { 'User-Agent': 'wvwrelink-health-check' },
          signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000),
        });
        if (!res.ok) {
          last = `HTTP ${res.status}`;
          await res.body?.cancel();
          continue;
        }
        return [await res.json(), null];
      } catch (error) { // timeout, DNS, truncated body, bad JSON
        last = describe(error);
      }
    }
    return [null, `${last} after ${ATTEMPTS} attempts`];
  };
}

export async function checkRoutes(get, contract, problems, notes) {
  for (const [route, purpose, expected] of ROUTES) {
    const [data, error] = await get(route);
    if (error) {
      problems.push(`${route} did not answer (${error}). On the page this is ${purpose}.`);
      continue;
    }

    if (expected === 'regions') {
      const missing = contractKeys(contract, route).filter((r) => !has(data, r));
      if (missing.length) {
        problems.push(`${route} no longer carries ${missing.join(' and ')}. On the page this is ${purpose}.`);
      } else {
        notes.push(`${label(route)} na=${show(data.na)}`);
      }
      continue;
    }

    if (!Array.isArray(data) || !data.length) {
      problems.push(`${route} came back ${Array.isArray(data) ? 'empty' : typeName(data)} rather than a list with items in it. On the page this is ${purpose}.`);
      continue;
    }

    const keys = expected === 'contract' ? contractKeys(contract, route) : [];
    const bare = keys.length ? data.filter((i) => !isObject(i)) : [];
    const short = {};
    for (const item of data) {
      for (const k of keys) {
        if (isObject(item) && !has(item, k)) short[k] = (short[k] || 0) + 1;
      }
    }
    if (bare.length || Object.keys(short).length) {
      const which = Object.entries(short).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, n]) => `${k} (${n} of ${data.length})`).join(', ') || 'objects';
      problems.push(`${route} items no longer carry ${which}. On the page this is ${purpose}.`);
    } else {
      notes.push(`${label(route)} ${data.length} items`);
    }
  }
}

// Ids of objectives on the maps in play that carry no coord or label_coord.
export function positionless(objectives, matches) {
  const inPlay = new Set();
  for (const match of matches) {
    if (!isObject(match)) continue;
    for (const m of (truthy(match.maps) ? match.maps : [])) {
      if (isObject(m) && Number.isInteger(m.id)) inPlay.add(m.id);
    }
  }
  return objectives
    .filter((o) => isObject(o) && inPlay.has(o.map_id) && !POINTLESS_TYPES.includes(o.type)
      && !(truthy(o.coord) || truthy(o.label_coord)))
    .map((o) => show(o.id)).sort();
}

// Every objective on the maps in play can be placed.
export async function checkObjectivePositions(get, problems, notes) {
  const [matches, error] = await get('/wvw/matches?ids=all');
  const [objectives, error2] = await get('/wvw/objectives?ids=all');
  if (error || error2 || !Array.isArray(matches) || !Array.isArray(objectives)) {
    return; // the routes above already say which one did not answer
  }
  const lost = positionless(objectives, matches);
  if (lost.length) {
    problems.push(`/wvw/objectives?ids=all: ${lost.length} objective(s) on the maps in play carry no coord (${lost.slice(0, 5).join(', ')}). On the page this is the fallback for placing them.`);
  } else {
    notes.push(`${label('objectives in play')} all have a coord or label_coord`);
  }
}

// The inner shapes behind the maps and the skirmish scores.
//
// These are nested, so a change here would pass the top-level check above and
// still empty out a panel.
//
// Every match, not a sample. There is no representative one: ArenaNet
// republishes the tiers one at a time and not always forwards, so tiers can
// sit on different weeks. js/config.js carries matchIsLive for that.
//
// And nothing here asks whether a match is fresh. Freshness is the page's
// problem and the page already handles it. A check that wanted every tier on
// the current week would fail for an hour every reset - on purpose, by
// ArenaNet, over something already dealt with.
export async function checkMatchDetail(get, problems, notes) {
  const [data, error] = await get('/wvw/matches?ids=all');
  if (error) {
    problems.push(`Could not read match detail (${error}).`);
    return;
  }

  const teamIds = (match) => Object.values(isObject(match.all_worlds) ? match.all_worlds : {})
    .flat().filter(isTeamId);
  let totalTeamIds = 0;
  for (const match of data) {
    const where = `match ${has(match, 'id') ? show(match.id) : '?'}`;
    const maps = truthy(match.maps) ? match.maps : [{}];
    const skirmishes = truthy(match.skirmishes) ? match.skirmishes : [{}];
    const lists = [
      ['maps', maps, ['id', 'kills', 'deaths', 'objectives', 'scores', 'type']],
      ['skirmishes', skirmishes, ['id', 'map_scores', 'scores']],
    ];
    for (const [kind, items, expected] of lists) {
      for (const key of expected) {
        const gone = [];
        items.forEach((v, i) => { if (!has(v, key)) gone.push(i); });
        if (gone.length) {
          problems.push(`/wvw/matches ${where} ${kind} no longer carry ${key} (${gone.length} of ${items.length}, from ${kind}[${gone[0]}]).`);
        }
      }
    }
    for (const [part, value] of [['scores', truthy(match.scores) ? match.scores : {}],
      ['all_worlds', truthy(match.all_worlds) ? match.all_worlds : {}]]) {
      const missing = ['blue', 'green', 'red'].filter((k) => !has(value, k));
      if (missing.length) problems.push(`/wvw/matches ${where} ${part} no longer carries ${missing.join(', ')}.`);
    }

    // all_worlds mixes legacy world ids with 5-digit team ids, and those
    // team ids are what every lookup on the page turns on.
    const found = teamIds(match);
    if (!found.length) {
      problems.push(`/wvw/matches ${where} has no 5-digit team ids in all_worlds. Every team lookup reads those.`);
    }
    totalTeamIds += found.length;
  }

  notes.push(`${label('/wvw/matches detail')} ${data.length} matches, ${totalTeamIds} team ids`);

  const teams = data.flatMap(teamIds);
  if (teams.length) {
    const [one, error1] = await get(`/wvw/matches?world=${show(teams[0])}`);
    if (error1) {
      problems.push(`/wvw/matches?world=${show(teams[0])} did not answer (${error1}). This is how a team finds its own match.`);
    } else if (!has(one, 'id')) {
      problems.push(`/wvw/matches?world=${show(teams[0])} no longer returns a match with an id.`);
    }
  }
}

// The whole guild lookup, end to end, with nothing hard-coded.
//
// A guild is taken from the team table, resolved to its name, and that name
// searched back. Naming a guild here instead would mean the check breaks the
// day that guild disbands - a false alarm about somebody else's decision.
export async function checkGuildPipeline(get, problems, notes) {
  const [table, error] = await get('/wvw/guilds/na');
  if (error) {
    problems.push(`/wvw/guilds/na did not answer (${error}). This is the table that says which team a guild landed on - the reason the site exists.`);
    return;
  }

  if (!isObject(table) || !Object.keys(table).length) {
    problems.push(`/wvw/guilds/na came back ${typeName(table)} rather than an object of guilds. This is the table the whole site turns on.`);
    return;
  }

  // The table gives team ids as strings ("11009") while all_worlds gives them
  // as numbers. The page (matchTeamId, colorForTeam) puts String() around each side, so neither type is
  // asserted here - only that the value still reads as a 5-digit team id.
  const guid = Object.keys(table).sort()[0];
  const team = table[guid];
  if (!isTeamId(team)) {
    problems.push(`/wvw/guilds/na maps ${guid} to ${repr(team)}, which is not a 5-digit team id. Every guild on the page is placed by that number.`);
    return;
  }
  notes.push(`${label('/wvw/guilds/na')} ${Object.keys(table).length} guilds`);

  const [guild, error1] = await get(`/guild/${quote(guid)}`);
  if (error1) {
    problems.push(`/guild/:id did not answer for ${guid} (${error1}). This is what turns a guild id into a name and tag.`);
    return;
  }
  const missing = ['id', 'name', 'tag'].filter((k) => !has(guild, k));
  if (missing.length) {
    problems.push(`/guild/:id no longer carries ${missing.join(', ')}.`);
    return;
  }

  const [found, error2] = await get(`/guild/search?name=${quote(show(guild.name))}`);
  if (error2) {
    problems.push(`/guild/search did not answer (${error2}). This is the lookup the site is for: it is how a pasted name becomes a team.`);
    return;
  }
  if (!Array.isArray(found) || !found.includes(guid)) {
    problems.push(`/guild/search for "${show(guild.name)}" did not return ${guid} - it returned ${repr(found)}. The exact-name search is how every lookup on the site starts.`);
    return;
  }
  notes.push(`${label('guild pipeline')} ${show(guild.tag)} -> "${show(guild.name)}" -> found again`);

  const [eu, error3] = await get('/wvw/guilds/eu');
  if (error3) {
    problems.push(`/wvw/guilds/eu did not answer (${error3}).`);
  } else if (!isObject(eu) || !Object.keys(eu).length) {
    problems.push('/wvw/guilds/eu came back empty.');
  } else {
    notes.push(`${label('/wvw/guilds/eu')} ${Object.keys(eu).length} guilds`);
  }
}

export async function main({ fetchFn, sleep, root = ROOT } = {}) {
  const get = makeFetch({ fetchFn, sleep });
  const contract = loadContract(root);
  const problems = [];
  const notes = [];
  await checkRoutes(get, contract, problems, notes);
  await checkObjectivePositions(get, problems, notes);
  await checkMatchDetail(get, problems, notes);
  await checkGuildPipeline(get, problems, notes);

  const out = [...notes.map(escape), ''];
  if (problems.length) {
    out.push(...problems.map((p) => `::error::${escape(p)}`), '', `${problems.length} problem(s).`);
    return { code: 1, out };
  }
  out.push('Every route the page reads still answers in the shape it reads.');
  return { code: 0, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { out, code } = await main();
  for (const line of out) console.log(line);
  process.exitCode = code;
}
