#!/usr/bin/env node
// Is the written-out copy of the objectives and sectors still what the game says?
//
// js/wvw-static.js carries the objectives of the WvW maps and the polygons of
// their sectors, and the page draws a map from that copy without asking the game
// for either list. So nothing on the page notices when ArenaNet moves an
// objective, renames a sector or adds one: the map would keep drawing the old one.
// This is what notices instead.
//
// Only the fields the drawing code reads are compared (the ones the header of
// js/wvw-static.js lists), coordinates within a rounding of one decimal, plus
// objectives or sectors the copy has and the game does not, or the other way round.
// Only the maps in play now are compared (the ids in /wvw/matches): a map in play
// the copy lacks fails, a map in the copy out of play is listed and left alone (the
// game swaps borderlands out and back, and asking for one out of play is an HTTP
// 400). A mismatch is an equality, not a judgement. To refresh the copy, rebuild it as
// that header says.
//
// Every request gets three attempts, spaced out, as in check-api.mjs.
//
// Run it by hand any time:  node scripts/check-catalogue.mjs
// main() takes the fetch and the sleep, so the unit test answers without a network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { escape, show, truthy, isObject, describe } from './workflow-text.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BASE = 'https://api.guildwars2.com/v2';
const OBJECTIVE_FIELDS = ['name', 'type', 'map_id', 'sector_id', 'upgrade_id'];
const POINT_FIELDS = ['coord', 'label_coord'];
// The copy is rounded to one decimal: it can sit 0.05 from the game's value.
const TOLERANCE = 0.06;
const ATTEMPTS = 3;
const PAUSE_SECONDS = 5;
const TIMEOUT_SECONDS = 30;
const REBUILD = 'Rebuild the copy in site/js/wvw-static.js as the comment at its top says.';
const MAX_LISTED = 8;

const byText = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
const sortedText = (items) => [...items].sort(byText);
const isNumber = (x) => typeof x === 'number' || typeof x === 'boolean';
// An absent key and a null compare equal.
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
// item['key'] of a parsed object: a missing key stops the check.
function must(item, key) {
  if (!isObject(item) || !Object.hasOwn(item, key)) throw new TypeError(`KeyError: '${key}'`);
  return item[key];
}
const get = (item, key) => {
  if (!isObject(item)) throw new TypeError("AttributeError: no .get on a value that is not an object");
  return item[key];
};

// The JSON literal after `const WVW_STATIC = `, up to where it closes.
export function readStatic(file = path.join(ROOT, 'site', 'js', 'wvw-static.js')) {
  const text = fs.readFileSync(file, 'utf8');
  const marker = 'const WVW_STATIC = ';
  const at = text.indexOf(marker);
  if (at < 0) throw new Error('ValueError: substring not found');
  const start = at + marker.length;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '{' || c === '[') {
      depth++;
    } else if ((c === '}' || c === ']') && --depth === 0) {
      return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('JSONDecodeError: the literal does not close');
}

// GET and parse, retrying before giving up. Returns [data, error].
export function makeFetch({ fetchFn = fetch, sleep = (s) => pause(s * 1000) } = {}) {
  return async function fetchJson(url) {
    let last = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt) await sleep(PAUSE_SECONDS);
      try {
        const res = await fetchFn(url, {
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

// Two lists of numbers, equal in length and within TOLERANCE.
export function near(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!near(x, y)) return false;
    } else if (!isNumber(x) || !isNumber(y) || Math.abs(Number(x) - Number(y)) > TOLERANCE) {
      return false;
    }
  }
  return true;
}

export function listed(items) {
  const sorted = sortedText(items);
  const text = sorted.slice(0, MAX_LISTED).map(String).join(', ');
  return text + (sorted.length > MAX_LISTED ? ` and ${sorted.length - MAX_LISTED} more` : '');
}

const minus = (a, b) => [...a].filter((x) => !b.has(x));

// Problems between the copy's objectives and the game's, on those maps.
export function compareObjectives(copy, live, mapIds) {
  const problems = [];
  live = live.filter((o) => mapIds.has(get(o, 'map_id')));
  const mine = new Map(copy.filter((o) => mapIds.has(get(o, 'map_id'))).map((o) => [must(o, 'id'), o]));
  const theirs = new Map(live.map((o) => [must(o, 'id'), o]));
  const lacking = minus(theirs.keys(), mine);
  if (lacking.length) problems.push(`Objectives the game has and the copy lacks: ${listed(lacking)}.`);
  const gone = minus(mine.keys(), theirs);
  if (gone.length) problems.push(`Objectives the copy has and the game no longer does: ${listed(gone)}.`);
  for (const oid of sortedText([...mine.keys()].filter((k) => theirs.has(k)))) {
    const a = mine.get(oid);
    const b = theirs.get(oid);
    const changed = OBJECTIVE_FIELDS.filter((k) => !same(a[k], b[k]));
    // A point the game does not give (a spawn has no coord) is absent in the copy too.
    changed.push(...POINT_FIELDS.filter((k) => (truthy(b[k]) || truthy(a[k])) && !near(a[k], b[k])));
    if (changed.length) problems.push(`Objective ${show(oid)} (${show(b.name)}) differs in ${changed.join(', ')}.`);
  }
  return problems;
}

// Problems between the copy's sectors of one map and the game's.
export function compareSectors(mapId, copy, live) {
  const problems = [];
  live = live.filter((s) => Array.isArray(get(s, 'bounds')));
  const mine = new Map(copy.map((s) => [must(s, 'id'), s]));
  const theirs = new Map(live.map((s) => [must(s, 'id'), s]));
  const lacking = minus(theirs.keys(), mine);
  if (lacking.length) problems.push(`Map ${mapId}: sectors the game has and the copy lacks: ${listed(lacking)}.`);
  const gone = minus(mine.keys(), theirs);
  if (gone.length) problems.push(`Map ${mapId}: sectors the copy has and the game no longer does: ${listed(gone)}.`);
  for (const sid of sortedText([...mine.keys()].filter((k) => theirs.has(k)))) {
    const a = mine.get(sid);
    const b = theirs.get(sid);
    const changed = same(a.name, b.name) ? [] : ['name'];
    if (!near(a.bounds, b.bounds)) changed.push('bounds');
    if (changed.length) problems.push(`Map ${mapId}: sector ${show(sid)} (${show(b.name)}) differs in ${changed.join(', ')}.`);
  }
  return problems;
}

// sectors: a Map of map id to the game's list, one per map compared. Returns the problems, empty when equal.
export function compare(copy, objectives, sectors) {
  const mapIds = new Set(sectors.keys());
  const problems = compareObjectives(truthy(copy.objectives) ? copy.objectives : [], objectives, mapIds);
  for (const mapId of [...mapIds].sort((a, b) => a - b)) {
    const mine = truthy(copy.sectors) ? copy.sectors[String(mapId)] : undefined;
    const theirs = sectors.get(mapId);
    problems.push(...compareSectors(mapId, truthy(mine) ? mine : [], truthy(theirs) ? theirs : []));
  }
  return problems;
}

// The map ids of every match, sorted; empty when the answer has none.
export function inPlay(matches) {
  const ids = new Set();
  for (const match of Array.isArray(matches) ? matches : []) {
    const maps = isObject(match) && truthy(match.maps) ? match.maps : [];
    if (typeof maps === 'number' || maps === true) throw new TypeError("TypeError: 'maps' is not iterable");
    if (!Array.isArray(maps)) continue;
    for (const m of maps) if (isObject(m) && Number.isInteger(m.id)) ids.add(m.id);
  }
  return [...ids].sort((a, b) => a - b);
}

const asInt = (k) => {
  if (!/^\s*[+-]?[0-9]+\s*$/.test(k)) throw new Error(`ValueError: invalid literal for int(): ${k}`);
  return Number(k);
};

export async function main({ fetchFn = fetch, sleep, root = ROOT } = {}) {
  const fetchJson = makeFetch({ fetchFn, sleep });
  const copy = readStatic(path.join(root, 'site', 'js', 'wvw-static.js'));
  let problems = [];
  const notes = [];
  const copied = Object.keys(truthy(copy.sectors) ? copy.sectors : {}).map(asInt).sort((a, b) => a - b);
  const [matches, matchError] = await fetchJson(`${BASE}/wvw/matches?ids=all`);
  const mapIds = inPlay(matches);
  if (matchError) problems.push(`/wvw/matches did not answer (${matchError}).`);
  else if (!mapIds.length) problems.push('/wvw/matches named no map.');
  const lacking = mapIds.filter((m) => !copied.includes(m));
  if (lacking.length) problems.push(`Maps in play the copy lacks: ${listed(lacking)}.`);
  const leftOut = copied.filter((m) => !mapIds.includes(m));
  if (mapIds.length && leftOut.length) notes.push(`Not in play, not compared: ${leftOut.join(', ')}`);
  let objectives = null;
  if (!problems.length) {
    let error;
    [objectives, error] = await fetchJson(`${BASE}/wvw/objectives?ids=all`);
    if (error) problems.push(`/wvw/objectives did not answer (${error}).`);
  }
  const sectors = new Map();
  for (const mapId of mapIds) {
    if (problems.length) break;
    const [data, error] = await fetchJson(`${BASE}/continents/2/floors/3/regions/7/maps/${mapId}/sectors?ids=all`);
    sectors.set(mapId, data);
    if (error) problems.push(`Sectors of map ${mapId} did not answer (${error}).`);
  }
  if (!problems.length) {
    problems = compare(copy, objectives, sectors);
    const objectiveCount = must(copy, 'objectives').filter((o) => sectors.has(get(o, 'map_id'))).length;
    const sectorCount = [...sectors.keys()].reduce((n, m) => {
      const list = must(copy, 'sectors')[String(m)];
      return n + (truthy(list) ? list.length : 0);
    }, 0);
    notes.push(`${objectiveCount} objectives and ${sectorCount} sectors compared, maps ${mapIds.join(', ')}`);
  }

  const out = [...notes, ...problems.map((p) => `::error::${escape(p)}`)];
  if (problems.length) {
    out.push('', `${problems.length} problem(s). The page draws its maps from the copy, so it draws the old ones. ${REBUILD}`);
    return { code: 1, out };
  }
  out.push('The copy in js/wvw-static.js is what the game says.');
  return { code: 0, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { out, code } = await main();
  for (const line of out) console.log(line);
  process.exitCode = code;
}
