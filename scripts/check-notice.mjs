#!/usr/bin/env node
// Did the teams notice actually happen for the last relink?
//
// The notice is meant to appear every month, in the days between the season
// lockout closing and the relink landing. A month where it did not appear is a
// bug, not weather - so this asserts the thing itself rather than any symptom of
// it, and it runs on a schedule so the answer arrives by email instead of waiting
// to be noticed.
//
// How it can be asked at all: the relink tab of this project's sheet holds
// "window:published" - the relink the notice last fired for, and when - and the
// API holds teamAssignment, the relink coming next. In a healthy month those are
// exactly one cycle apart: the notice fired for the last relink, and the next one
// is about thirty days out. Two cycles apart means a relink went by with no
// notice.
//
// A missed window fails this check for thirty-six hours after the relink it lost and
// then goes quiet - see MISSED_ALARM_SECONDS. Nothing about a month that already
// ended is actionable, and an alarm repeating for four weeks is an alarm that
// teaches you to filter the sender.
//
// That question can only be answered once a month, though, and the answer arrives
// six weeks after the fault. So the cell beside it, relink!A2, holds a heartbeat:
// the trigger stamps the time there before it does anything else, on every run, in
// and out of the window. A stale one says the trigger is not firing - and says it
// the same day instead of after the window it was going to miss.
//
// The two are deliberately different questions. The heartbeat asks whether the
// script RUNS, which nothing else on earth can see: a deleted trigger, a locked
// account, a lapsed authorisation and a project Google disabled all produce no
// execution, no log and no email. A script that runs and then fails is already
// loud, because Apps Script emails the owner on an uncaught exception. The gap
// asks whether a run that happened actually produced the notice.
//
// Everything the two of them catch, all of which is otherwise silent:
//
//   - the Apps Script trigger stopped, deleted, or never firing       (heartbeat)
//   - the Google account locked, or its authorisation lapsed          (heartbeat)
//   - the spreadsheet unreachable or unwritable                       (heartbeat)
//   - the threshold never tripping, because ArenaNet changed how it publishes
//   - the assignment being published outside the window the trigger watches
//   - the cell being overwritten by hand, or written in a shape the page rejects
//   - the sheet not being shared, which only a reader can ever notice
//
// It is the counterpart of check-sheets.mjs, which asks whether the kills history
// is still being written. Same failure mode, same reason it needs asking: a
// stopped trigger makes no noise at all.
//
// Run it by hand any time:  node scripts/check-notice.mjs
// main() takes the fetch, the sleep and the clock, so the unit test answers without a network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { escape, strip, makeFetchText } from './workflow-text.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const API = 'https://api.guildwars2.com/v2';

// Read out of js/config.js rather than repeated: the page and this check
// have to be looking at the same cell.
const SHEET_URL_LINE = /const RELINK_SHEET_URL\s*=\s*\n?\s*`([^`]+)`/;
// Must match RELINK_STATE_RE in js/relink.js: what the page will accept is what
// counts as the notice having fired.
const STATE_CELL = /^"?([0-9]{1,12}):([0-9]{1,12})"?$/;

// One relink cycle is a month, so one is about thirty days and two about sixty;
// forty-five sits between them.
export const MAX_GAP_SECONDS = 45 * 24 * 60 * 60;

// The heartbeat: one epoch integer in A2, written by the trigger every 5
// minutes. As strict as the state cell, for the same reason: the sheet is
// world-readable.
const HEARTBEAT_CELL = /^"?([0-9]{1,12})"?$/;

// Thirty-six missed ticks. Not tighter: this check runs on a six-hour schedule
// that GitHub need not keep, so the real cadence, not this number, decides
// how fast a dead trigger is caught; a
// tighter threshold only fails on Apps Script jitter and ticks Google skips
// under quota.
export const MAX_SILENCE_SECONDS = 3 * 60 * 60;

// How long a missed window keeps failing this check after the relink it lost.
//
// The fault is only visible once the relink has gone by, and by then that
// month's notice is gone: only telling somebody is left, and repeating does not
// help. Unbounded it would fail on every run for about 27 days. Thirty-six hours
// holds at least two runs of this workflow at its slowest cadence, two so that a
// single run failing for an unrelated reason does not swallow the only
// notification.
//
// A trigger that is actually dead keeps failing this check through the
// heartbeat above, which is the part somebody can fix.
export const MISSED_ALARM_SECONDS = 36 * 60 * 60;

const pad = (n, width = 2) => String(n).padStart(width, '0');

export function iso(epoch) {
  const d = new Date(epoch * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

const first = (text, n) => Array.from(text).slice(0, n).join('');

// The relink cell's CSV export, exactly as js/config.js builds it: the template's
// own `${NAME}` is looked up rather than assumed, so renaming that constant fails
// loudly here instead of quietly checking the wrong sheet. Null when it cannot be read.
export function sheetUrl(root = ROOT) {
  const config = fs.readFileSync(path.join(root, 'site', 'js', 'config.js'), 'utf8');
  const found = SHEET_URL_LINE.exec(config);
  if (!found) return null;
  let url = found[1];
  for (const [, name] of url.matchAll(/\$\{([A-Z_]+)\}/g)) {
    const value = new RegExp(`const ${name}\\s*=\\s*'([^']+)'`).exec(config);
    if (!value) return null;
    url = url.split(`\${${name}}`).join(value[1]);
  }
  return url;
}

// "2025-11-23T12:00:00Z" in epoch seconds, or null for a date that is not one. Months, days and
// hours may have one digit, as the timer's own format allows; the timestamp is UTC.
export function parseTimestamp(text) {
  const m = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})T([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})Z$/.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (year < 1 || hour > 23 || minute > 59 || second > 61) return null;
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  if (d.getUTCMonth() !== month - 1) return null; // a day or a month out of range rolls into another month
  return d.getTime() / 1000 + hour * 3600 + minute * 60 + second;
}

// The NA teamAssignment, in epoch seconds: [seconds, null] or [null, error].
export async function nextRelink(fetchText) {
  const [body, error] = await fetchText(`${API}/wvw/timers/teamAssignment`);
  if (error) return [null, error];
  const found = /"na"\s*:\s*"([0-9TZ:-]+)"/.exec(body);
  if (!found) return [null, 'no readable na field'];
  const epoch = parseTimestamp(found[1]);
  return epoch === null ? [null, `time data '${found[1]}' does not match format '%Y-%m-%dT%H:%M:%SZ'`] : [epoch, null];
}

// The A2 of the same tab, derived from the URL the page itself uses. If the page's
// URL stops asking for a single cell this returns null and says so loudly, because
// that case is not "the heartbeat moved" - it is the page reading a range that now
// has two rows in it.
export function heartbeatUrl(pageUrl) {
  if (!pageUrl.includes('range=A1:A1')) return null;
  return pageUrl.split('range=A1:A1').join('range=A2:A2');
}

// Is the trigger running at all? True means something is wrong. It does not stop the
// rest of the check: a dead trigger and a missed window are cause and effect, and
// seeing both in one email is what makes the cause obvious.
export async function checkHeartbeat(fetchText, pageUrl, now, out) {
  const url = heartbeatUrl(pageUrl);
  if (url === null) {
    out.push('::error::RELINK_SHEET_URL in js/config.js no longer asks for range=A1:A1, so the heartbeat cell beside it cannot be found. '
      + 'That range is not tidiness: without it the heartbeat row lands inside what the page reads, and the page refuses a body with two '
      + 'rows in it. Put it back, or teach this check where the heartbeat moved to.');
    return true;
  }

  const [body, error] = await fetchText(url);
  if (error) {
    out.push(`::error::The heartbeat cell did not answer (${escape(error)}). The state cell beside it answered a moment ago, `
      + 'so this is something about that one cell rather than the sheet being down.');
    return true;
  }

  const found = HEARTBEAT_CELL.exec(strip(body));
  if (!found) {
    const shown = first(strip(body), 80) || '(empty)';
    out.push(`::error::The heartbeat cell holds no timestamp. It holds: ${escape(shown)}. Something other than relinkTick wrote over it.`);
    return true;
  }

  const beat = Number(found[1]);
  const age = now - beat;
  out.push(`last tick      ${iso(beat)}, ${Math.floor(age / 60)} min ago`);
  if (age <= MAX_SILENCE_SECONDS) return false;

  out.push('');
  out.push(`::error::The Apps Script trigger has not run for ${Math.floor(age / 60)} minutes and is supposed to run every 5. `
    + 'It stamps that cell before it does anything else, so this is not the API failing, not the threshold '
    + 'refusing to trip and not the sheet being unwritable - it is the trigger itself not firing. A deleted trigger, a locked account, an '
    + 'authorisation that lapsed, or a project Google disabled: none of those produce an execution, a log or an email, and this cell is the '
    + 'only place any of them shows. Open the Apps Script project for the account that owns the sheet and look at Triggers, then Executions.');
  return true;
}

export async function main({ fetchFn = fetch, sleep = (s) => pause(s * 1000), now = () => Date.now(), root = ROOT } = {}) {
  const fetchText = makeFetchText({ fetchFn, sleep, userAgent: 'wvwrelink-notice-check' });
  const out = [];
  const clock = Math.floor(now() / 1000);
  out.push(`read at        ${iso(clock)}`);

  const url = sheetUrl(root);
  if (url && url.includes('PASTE')) {
    out.push('::error::RELINK_SHEET_ID in js/config.js still holds PASTE, not a spreadsheet id, so the page has no cell to read.');
    return { code: 1, out };
  }
  if (url === null) {
    out.push('::error::RELINK_SHEET_URL or RELINK_SHEET_ID could not be read out of js/config.js, so this cannot tell which cell the page is '
      + 'looking at. One of the two was renamed; this check has to be taught the new name.');
    return { code: 1, out };
  }

  const [assignNa, assignError] = await nextRelink(fetchText);
  if (assignError) {
    out.push(`::error::The teamAssignment timer did not answer (${escape(assignError)}), so there is nothing to measure the notice against. `
      + 'This is about the API, not about the notice.');
    return { code: 1, out };
  }
  out.push(`next relink    ${iso(assignNa)}`);

  const [body, error] = await fetchText(url);
  if (error) {
    out.push(`::error::The relink tab of the sheet did not answer (${escape(error)}). The page reads that same cell, so while this is true `
      + 'the notice cannot appear at all.');
    // 401 and 403 mean the sheet is not published, not that it is broken.
    // The Apps Script that writes the cell runs as the owner and works
    // either way, so only the reader ever sees this failure.
    if (error.includes('HTTP 401') || error.includes('HTTP 403')) {
      out.push('::error::That is an authorisation failure, not a missing cell: the spreadsheet is not shared. Set it to "anyone with '
        + 'the link" as VIEWER - never Editor, since whoever can write that cell decides what the page tells people about their teams.');
    }
    return { code: 1, out };
  }

  const found = STATE_CELL.exec(strip(body));
  if (!found) {
    const shown = first(strip(body), 80) || '(empty)';
    out.push(`::error::The relink cell does not hold two integers separated by a colon. It holds: ${escape(shown)}. The page refuses anything else, `
      + 'so while this is true the notice cannot appear.');
    // The gviz export does not 404 a tab that is not there - it serves the
    // first sheet instead. The likeliest cause looks like data, not like an
    // error, so it is named before anybody hunts through the Apps Script.
    out.push('::error::If that looks like the kills history, the tab named in RELINK_SHEET_URL does not exist under that name: the CSV export '
      + 'answers with the first sheet rather than failing. Otherwise check what the Apps Script trigger is writing.');
    return { code: 1, out };
  }

  const window = Number(found[1]);
  const published = Number(found[2]);
  if (published) {
    out.push(`last notice    ${iso(published)}, for the relink of ${iso(window)}`);
  } else {
    // "nothing yet", not "never": the cell holds only the window it is about,
    // so a new window resets this to 0 and the earlier months are not in it.
    out.push('last notice    nothing for this window yet');
  }

  // Asked after the state cell so that the sharing diagnosis above gets first
  // word on an unreachable sheet, and before the reasoning below so that a
  // dead trigger is named before the month it is about to cost.
  const beatBad = await checkHeartbeat(fetchText, url, clock, out);

  // Nothing has fired yet. There is no earlier timestamp to measure from, so
  // the only thing that can be said is whether a relink has gone by: `window`
  // is written by the trigger the first time it runs inside a window, so a
  // zero published with a window already in the past means that window
  // produced nothing.
  if (!published) {
    if (window && window < clock) {
      const missedFor = clock - window;
      if (missedFor <= MISSED_ALARM_SECONDS) {
        out.push('');
        out.push(`::error::The relink of ${iso(window)} has gone by and the notice never fired for it. This is a bug, not a quiet month: `
          + 'the trigger was watching, so either the threshold never tripped or the assignment was published outside the '
          + 'window it watches. Check the Apps Script executions for that account.');
        return { code: 1, out };
      }
      // Past the alarm window: said plainly and without failing, since
      // the month is gone and the next window rewrites this cell. See
      // MISSED_ALARM_SECONDS.
      out.push('');
      out.push(`The relink of ${iso(window)} went by with no notice, ${Math.floor(missedFor / 86400)} days ago - reported at the time, `
        + 'and nothing can be done about that month now. The next window starts clean.');
      return { code: beatBad ? 1 : 0, out };
    }
    out.push('');
    // Deliberately not "the notice has never fired": the cell only ever
    // holds the window it is currently about, so "never" would be wrong
    // from the second month onward.
    if (window) {
      out.push(`Nothing published for the relink of ${iso(window)} yet, which is the normal state until the table moves. `
        + 'No relink has gone by unannounced.');
    } else {
      out.push('No window is being watched yet - run relinkSetup() once.');
    }
    return { code: beatBad ? 1 : 0, out };
  }

  const gap = assignNa - window;
  out.push('');
  out.push(`${Math.floor(gap / 86400)} days between the relink the notice last fired for and the next one.`);

  if (gap > MAX_GAP_SECONDS) {
    out.push(`::error::A relink has gone by without the teams notice appearing. It last fired for the relink of ${iso(window)} and the next is `
      + `${iso(assignNa)} - that is ${Math.floor(gap / 86400)} days, so at least one whole window was missed. `
      + 'This is a bug, not a quiet month. Start at the Apps Script executions for the account that owns the sheet: a stopped '
      + 'trigger is the most likely cause and it stops silently.');
    return { code: 1, out };
  }

  out.push('The notice fired for the most recent relink.');
  return { code: beatBad ? 1 : 0, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { out, code } = await main();
  for (const line of out) console.log(line);
  process.exitCode = code;
}
