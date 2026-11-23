#!/usr/bin/env node
// Are the spreadsheets the page reads still shaped the way it reads them?
//
// Two of the three, and the two that have a shape to be wrong about. The third is
// a single cell that check-notice.mjs owns, and its whole shape is "two integers
// and a colon".
//
// Two very different sources, so two very different checks.
//
// The community sheet is maintained by the NA WvW Discord - other people, who
// can rename a column at any time and have every right to. js/sheet.js resolves
// its columns by header name, and falls back to a fixed index when the name is
// not found. That fallback is the danger: nothing errors, the page just reads
// the wrong column and places guilds on teams the sheet never put them on. So a
// missing header is a failure here.
//
// The kills sheet is filled by an Apps Script trigger every five minutes, and it
// is the project's own. Here freshness *is* the signal: if the newest row is old,
// the trigger stopped and the crossed swords quietly stop marking the busiest
// map.
//
// Neither check asserts how many rows or columns there are. Both sheets grow and
// shrink as people maintain them, and a check that pinned those numbers would
// fail on somebody doing their job.
//
// Run it by hand any time:  node scripts/check-sheets.mjs
// main() takes the fetch, the sleep and the clock, so the unit test answers without a network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { escape, strip, fixed, makeFetchText } from './workflow-text.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// The spreadsheet ids are read out of js/config.js, never written here: a copy
// that drifted would keep this check reading the old sheet and passing while
// the page reads the new one and is broken.
const CONFIG_ID = { community: 'SHEET_ID', kills: 'KILLS_SHEET_ID' };

export const GAME_MATCHES = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';

// kills.gs writes a match's row only when its score rose, and the GW2 API can
// serve frozen data for about an hour, so the whole sheet can honestly sit
// still that long. 90 keeps a frozen API from being reported as a stopped
// trigger; a stopped trigger is still caught.
export const KILLS_STALE_MINUTES = 90;

// The columns js/sheet.js looks for, in the order it looks for them, and the
// name of the constant it falls back to. Alliances is asked for 'World ID'
// first and 'World' second, which matters: that tab has no 'World' column at
// all, so a check demanding both would fail on a sheet that is perfectly fine.
export const COMMUNITY_COLUMNS = {
  SoloGuilds: [
    [['World'], 'SOLO_WORLD_FALLBACK'],
    [['API Mismatch'], 'SOLO_MISMATCH_FALLBACK'],
  ],
  Alliances: [
    [['World ID', 'World'], 'ALLIANCE_WORLD_FALLBACK'],
    [['Guilds'], 'ALLIANCE_MEMBERS_FALLBACK'],
  ],
};

// The two spreadsheet ids this check needs: [ids, null] or [null, the missing name].
// Looked up by the constant's own name so that renaming one in js/config.js
// fails here loudly, instead of quietly leaving this pointed at a sheet
// nobody reads any more.
export function sheetIds(root = ROOT) {
  const config = fs.readFileSync(path.join(root, 'site', 'js', 'config.js'), 'utf8');
  const found = {};
  for (const [key, name] of Object.entries(CONFIG_ID)) {
    const value = new RegExp(`const ${name}\\s*=\\s*'([^']+)'`).exec(config);
    if (!value) return [null, name];
    found[key] = value[1];
  }
  return [found, null];
}

export const csvUrl = (sheetId, tab) =>
  `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;

// Python's csv.reader on the text of a file: quotes, a doubled quote, commas inside quotes, a quoted
// line break, \r\n; a blank line is an empty row. A bare \r inside a line is the error csv raises.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let state = 'start'; // start of a row, start of a field, in a field, in quotes, a quote seen in quotes, eating the line end
  const save = () => { row.push(field); field = ''; };
  for (const line of text.split(/(?<=\n)/).filter(Boolean)) {
    for (const c of line) {
      if (state === 'start' || state === 'field-start') {
        if (state === 'start' && (c === '\n' || c === '\r')) { state = 'eol'; continue; }
        if (c === '\n' || c === '\r') { save(); state = 'eol'; }
        else if (c === '"') state = 'quoted';
        else if (c === ',') { save(); state = 'field-start'; }
        else { field += c; state = 'field'; }
      } else if (state === 'field') {
        if (c === '\n' || c === '\r') { save(); state = 'eol'; }
        else if (c === ',') { save(); state = 'field-start'; }
        else field += c;
      } else if (state === 'quoted') {
        if (c === '"') state = 'quote'; else field += c;
      } else if (state === 'quote') {
        if (c === '"') { field += c; state = 'quoted'; }
        else if (c === ',') { save(); state = 'field-start'; }
        else if (c === '\n' || c === '\r') { save(); state = 'eol'; }
        else { field += c; state = 'field'; }
      } else if (c !== '\n' && c !== '\r') {
        throw new Error('new-line character seen in unquoted field - do you need to open the file in universal-newline mode?');
      }
    }
    // The end of the line: a row is done unless a quote is still open.
    if (state === 'field' || state === 'field-start' || state === 'quote') { save(); state = 'start'; }
    if (state === 'eol' || state === 'start') { state = 'start'; rows.push(row); row = []; }
  }
  if (state === 'quoted') { save(); rows.push(row); }
  return rows;
}

// The fallback indices, read out of js/sheet.js rather than copied here.
// Copying them would mean this file and the code drifting apart in silence,
// which is the exact failure the check is about.
export function fallbacksInCode(root = ROOT) {
  const body = fs.readFileSync(path.join(root, 'site', 'js', 'sheet.js'), 'utf8');
  return Object.fromEntries([...body.matchAll(/const ([A-Za-z0-9_]+_FALLBACK)\s*=\s*([0-9]+)/g)].map((m) => [m[1], Number(m[2])]));
}

const left = (text, width) => String(text).padEnd(width);

export async function main({ fetchFn = fetch, sleep = (s) => pause(s * 1000), now = () => Date.now(), root = ROOT } = {}) {
  const fetchText = makeFetchText({ fetchFn, sleep, userAgent: 'wvwrelink-health-check' });

  // GET a gviz CSV export and parse it: [rows, error].
  async function fetchRows(url) {
    const [body, error] = await fetchText(url);
    if (error) return [null, error];
    try {
      return [parseCsv(body), null];
    } catch (e) {
      return [null, `Error: ${e.message}`];
    }
  }

  // True when the game's own API does not answer (retried); asked only once
  // the kills sheet is already late.
  async function gameApiDown() {
    const [body, error] = await fetchText(GAME_MATCHES);
    if (error) return true;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return true;
    }
    return !Array.isArray(data) || !data.length;
  }

  async function checkCommunity(problems, notes, sheetId) {
    const fallbacks = fallbacksInCode(root);

    for (const [tab, wanted] of Object.entries(COMMUNITY_COLUMNS)) {
      const [rows, error] = await fetchRows(csvUrl(sheetId, tab));
      if (error) {
        problems.push(`The ${tab} tab of the community sheet did not answer (${error}). The shield icon reads that tab.`);
        continue;
      }
      if (!rows.length) {
        problems.push(`The ${tab} tab of the community sheet came back with nothing at all - not even a header row.`);
        continue;
      }
      if (rows.length < 2) {
        problems.push(`The ${tab} tab of the community sheet has a header and no data under it.`);
        continue;
      }

      const header = rows[0].map(strip);
      notes.push(`${left(tab, 22)} ${rows.length} rows, ${header.length} columns`);

      for (const [names, constant] of wanted) {
        const name = names.find((n) => header.includes(n));
        const index = name === undefined ? null : header.indexOf(name);
        if (index === null) {
          problems.push(`The ${tab} tab no longer has a ${names.map((n) => `"${n}"`).join(' or ')} column. js/sheet.js falls back to index `
            + `${fallbacks[constant] ?? '?'}, so nothing will error - the page will read whatever sits in that position and place guilds on `
            + 'teams the sheet does not put them on.');
          continue;
        }

        const expected = fallbacks[constant];
        if (expected === undefined) {
          notes.push(`  ${left(names[0], 30)} column ${index} (${constant} not found in js/sheet.js)`);
        } else if (index === expected) {
          notes.push(`  ${left(names[0], 30)} column ${index}, ${constant} agrees`);
        } else {
          // Not a failure: the page finds the column by name, so it is
          // correct today. Worth saying, because the safety net in the
          // code now points somewhere else.
          notes.push(`  ${left(names[0], 30)} column ${index}, but ${constant} says ${expected} - the fallback is stale, harmless while the header is there`);
        }
      }
    }
  }

  async function checkKills(problems, notes, sheetId) {
    const [rows, error] = await fetchRows(csvUrl(sheetId, 'kills'));
    if (error) {
      problems.push(`The kills sheet did not answer (${error}). This is what puts the crossed swords on the busiest map.`);
      return;
    }

    // No header on this one: the rows are written by the Apps Script as
    // timestamp, match id, then one kill count per map.
    const stamped = rows.filter((r) => r.length && /^[0-9]+$/.test(strip(r[0])));
    if (!stamped.length) {
      problems.push('The kills sheet has no rows with a timestamp in them. Either the Apps Script stopped writing or the column order changed.');
      return;
    }

    const narrow = stamped.filter((r) => r.length < 6);
    if (narrow.length) {
      problems.push(`${narrow.length} row(s) in the kills sheet have fewer than 6 columns. js/maps-early.js skips those, so the swords go quiet without any error.`);
    }

    let newest = -Infinity;
    for (const r of stamped) newest = Math.max(newest, Number(strip(r[0])));
    const ageMinutes = (now() - newest) / 60000;
    const matches = new Set(stamped.filter((r) => r.length > 1 && strip(r[1])).map((r) => strip(r[1]))).size;

    notes.push(`${left('kills', 22)} ${stamped.length} rows, ${matches} matches, newest ${fixed(ageMinutes, 1)} min old`);

    if (ageMinutes > KILLS_STALE_MINUTES) {
      if (await gameApiDown()) {
        problems.push('The game API is not answering, so kills.gs has nothing to write; the newest row in the kills '
          + `sheet is ${fixed(ageMinutes, 0)} minutes old. This clears when the game API is back.`);
        return;
      }
      problems.push(`The newest row in the kills sheet is ${fixed(ageMinutes, 0)} minutes old. The Apps Script trigger runs every five minutes and `
        + 'writes whenever a score rose, so it has stopped - and the crossed swords stop with it, silently.');
    }
  }

  const [ids, missing] = sheetIds(root);
  if (ids === null) {
    return {
      code: 1,
      out: [`::error::${missing} could not be read out of js/config.js, so this cannot tell which spreadsheet the page is looking at. It was `
        + "renamed, and this check has to be taught the new name - it deliberately keeps no copy of the id of its own."],
    };
  }

  const problems = [];
  const notes = [];
  await checkCommunity(problems, notes, ids.community);
  await checkKills(problems, notes, ids.kills);

  const out = [...notes, ''];
  if (problems.length) {
    out.push(...problems.map((p) => `::error::${escape(p)}`), '', `${problems.length} problem(s).`);
    return { code: 1, out };
  }
  out.push('Both sheets answer, and every column the page resolves by name is still there.');
  return { code: 0, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { out, code } = await main();
  for (const line of out) console.log(line);
  process.exitCode = code;
}
