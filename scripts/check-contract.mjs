#!/usr/bin/env node
// Does the Guild Wars 2 API still carry the keys and types the page reads?
//
// check-api.mjs asks whether each route answers and carries its top-level keys.
// This goes further, in two ways:
//   1. every key and type in gw2-contract.json (what site/js/ reads, nested),
//      checked against a live answer;
//   2. the live answer's keys and types against the recording the page tests
//      run on (tests/e2e/data/recordings.json.gz): a field gone, new or of another
//      type fails, so the recording is re-made when the game changes.
//
// Guild routes use ids and names already in the recording; no new guild name is
// looked up. Run it by hand:  node scripts/check-contract.mjs
// main() takes the fetch and the sleep, so the unit test answers without a network.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { escape, isObject, describe } from './workflow-text.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BASE = 'https://api.guildwars2.com/v2';
const ATTEMPTS = 3;
const PAUSE_SECONDS = 5;
const TIMEOUT_SECONDS = 30;
const GUILD_SAMPLE = 5;
const GUID = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

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

export function tname(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'string') return 'str';
  return Array.isArray(v) ? 'list' : 'object';
}

// ---- 1. the contract ------------------------------------------------------

// A "$name" shape replaced by its definition, all the way down.
export function resolve(shape, defs) {
  if (typeof shape === 'string' && shape.startsWith('$')) {
    const name = shape.slice(1);
    if (!Object.hasOwn(defs, name)) throw new TypeError(`KeyError: '${name}'`);
    return resolve(defs[name], defs);
  }
  if (Array.isArray(shape)) return [resolve(shape[0], defs)];
  if (isObject(shape)) return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, resolve(v, defs)]));
  return shape;
}

// The ways `value` departs from `shape`, pushed on `out`, each saying where.
export function against(value, shape, where, out) {
  if (typeof shape === 'string') {
    if (!shape.split('|').includes(tname(value))) out.push(`${where} is ${tname(value)}, the page reads ${shape}`);
  } else if (Array.isArray(shape)) {
    if (!Array.isArray(value)) {
      out.push(`${where} is ${tname(value)}, the page reads a list`);
      return;
    }
    for (const item of value) {
      const before = out.length;
      against(item, shape[0], `${where}[]`, out);
      if (out.length > before + 3) break;
    }
  } else {
    if (!isObject(value)) {
      out.push(`${where} is ${tname(value)}, the page reads an object`);
      return;
    }
    if (Object.hasOwn(shape, '*')) {
      for (const v of Object.values(value).slice(0, 50)) against(v, shape['*'], `${where}.*`, out);
      return;
    }
    for (const [key, sub] of Object.entries(shape)) {
      const opt = key.endsWith('?');
      const name = key.replace(/\?+$/, '');
      if (!Object.hasOwn(value, name)) {
        if (!opt) out.push(`${where} lacks key ${name}`);
        continue;
      }
      if (typeof sub === 'string' && opt && value[name] === null) continue;
      against(value[name], sub, `${where}.${name}`, out);
    }
  }
}

// ---- 2. the recording -----------------------------------------------------

// Union of key paths -> set of type names, over every item, added to `into`.
export function shapeOf(v, into) {
  const walk = (x, where) => {
    if (!into.has(where)) into.set(where, new Set());
    into.get(where).add(tname(x));
    if (isObject(x)) {
      const entries = Object.entries(x);
      if (entries.length > 50) { // keyed by arbitrary ids
        for (const [, val] of entries) walk(val, `${where}.*`);
      } else {
        for (const [k, val] of entries) walk(val, `${where}.${k}`);
      }
    } else if (Array.isArray(x)) {
      for (const val of x) walk(val, `${where}[]`);
    }
  };
  walk(v, '');
  return into;
}

const joined = (set) => [...set].sort(byText).join('/');
const parentOf = (p) => p.replace(/(\.[^.[\]]+|\[\])$/, '');

// What differs between the live key paths and the recorded ones.
export function versus(live, rec) {
  const out = [];
  for (const [where, types] of [...rec].sort(([a], [b]) => byText(a, b))) {
    if (!live.has(where)) {
      // an empty list on the live side carries no children to compare
      if ([...live.keys()].some((p) => p && where.startsWith(`${p}[]`) && (live.get(p) || new Set()).has('list') && !live.has(`${p}[]`))) continue;
      out.push(`field gone from the live answer: ${where || '(root)'} (recorded ${joined(types)})`);
    } else if (![...live.get(where)].every((t) => types.has(t))) {
      out.push(`type changed at ${where || '(root)'}: recorded ${joined(types)}, live ${joined(live.get(where))}`);
    }
  }
  for (const [where, types] of [...live].sort(([a], [b]) => byText(a, b))) {
    if (rec.has(where)) continue;
    let parent = where;
    // A path that no longer shrinks (a trailing dot, a stray bracket) is its own last parent.
    while (parent && !rec.has(parent)) {
      const up = parentOf(parent);
      if (up === parent) break;
      parent = up;
    }
    if (rec.has(parent) && sameSet(rec.get(parent), new Set(['list']))
        && ![...rec.keys()].some((p) => p.startsWith(`${parent}[]`))) {
      continue; // recorded list was empty: nothing to compare against
    }
    out.push(`new field in the live answer: ${where} (${joined(types)})`);
  }
  return out;
}

// The recorded answers of the game's API, by route: what the browser tests run on.
export function readRecording(root) {
  const rec = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'tests', 'e2e', 'data', 'recordings.json.gz'))).toString('utf8'));
  const entries = new Map();
  for (const [url, e] of Object.entries(rec.entries)) {
    if (url.slice(0, BASE.length) === BASE && e[0] === 200) entries.set(url.slice(BASE.length), JSON.parse(e[2]));
  }
  return entries;
}

export async function main({ fetchFn = fetch, sleep, root = ROOT } = {}) {
  const get = makeFetch({ fetchFn, sleep });
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'gw2-contract.json'), 'utf8'));
  const entries = readRecording(root);
  const paths = [...entries.keys()].sort(byText);
  const problems = [];
  const notes = [];

  for (const spec of contract.routes) {
    const route = spec.route;
    const shape = resolve(spec.shape, contract.defs);
    let todo; // [live path, recorded path]
    if (route.includes('$guildId')) {
      const ids = paths.filter((p) => p.startsWith('/guild/') && GUID.test(p.slice('/guild/'.length))).map((p) => p.slice('/guild/'.length));
      todo = ids.slice(0, GUILD_SAMPLE).map((i) => [`/guild/${i}`, `/guild/${i}`]);
    } else if (route.includes('$guild')) {
      todo = paths.filter((p) => p.startsWith('/guild/search?name=')).map((p) => [p, p]);
    } else {
      todo = [[route, Object.hasOwn(spec, 'recorded') ? spec.recorded : route]];
    }
    if (!todo.length) {
      problems.push(`${route}: nothing in the recording to ask with`);
      continue;
    }
    const liveAll = new Map();
    const recAll = new Map();
    for (const [livePath, recPath] of todo) {
      const [data, error] = await get(livePath);
      if (error) {
        problems.push(`${livePath} did not answer (${error})`);
        continue;
      }
      const found = [];
      against(data, shape, livePath.split('?')[0], found);
      for (const m of found.slice(0, 5)) problems.push(`contract (${spec.read_in}): ${m}`);
      if (Array.isArray(data) && !data.length) problems.push(`${livePath} came back as an empty list`);
      shapeOf(data, liveAll);
      if (entries.has(recPath)) shapeOf(entries.get(recPath), recAll);
      else notes.push(`${recPath} is not in the recording`);
    }
    if (recAll.size) {
      for (const m of versus(liveAll, recAll).slice(0, 8)) problems.push(`recording (${route}): ${m}`);
    }
    notes.push(`${route.slice(0, 62).padEnd(62)} ${todo.length} request(s)`);
  }

  const out = [...notes, ''];
  if (problems.length) {
    out.push(...problems.map((p) => `::error::${escape(p)}`), '', `${problems.length} problem(s).`);
    return { code: 1, out };
  }
  out.push('The live API matches the contract and the recording.');
  return { code: 0, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { out, code } = await main();
  for (const line of out) console.log(line);
  process.exitCode = code;
}
