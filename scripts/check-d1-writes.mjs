#!/usr/bin/env node
// Is the D1 database still far from its daily write limit?
//
// The Free plan allows 100,000 rows written a day, and past it D1 refuses every
// write until 00:00 UTC: the push from the Apps Scripts and the readers stops
// without a sound, and the page falls back to the sheets. Nothing outside the
// account can read that number, so this asks Cloudflare's GraphQL Analytics for
// `rowsWritten` of yesterday and of today (UTC) and fails when either passes
// 80,000. Cloudflare says these figures are not the billing ones.
//
// Needs, from the environment and never printed:
//   CLOUDFLARE_ANALYTICS_TOKEN   a token with Account Analytics: Read, nothing else
//   CLOUDFLARE_ACCOUNT_ID        32 hex characters
//
// The database ID is read from worker/wrangler.jsonc. A failure prints the
// status or the error codes of the answer, never its body.
//
// Yesterday with no rows at all fails too: the readers write tens of thousands
// a day, so zero means the query reads the wrong database or an empty dataset,
// and the alarm would stay green for ever. Today may still be empty just after
// 00:00 UTC.
//
// Run it by hand any time (with both set):  node scripts/check-d1-writes.mjs
// main() takes the fetch, the clock and the environment, so the unit test answers without a network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { escape, repr, isObject } from './workflow-text.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
export const LIMIT = 80000;
const TIMEOUT_SECONDS = 30;
const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const DATABASE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const CODE_RE = /^[\p{L}\p{N}_-]{1,40}$/u;

// What the check cannot continue past: its message says why.
export class Refusal extends Error {}

// The D1 database ID of worker/wrangler.jsonc, read and not copied.
export function databaseId(root = ROOT) {
  const m = /"database_id"\s*:\s*"([^"]*)"/.exec(fs.readFileSync(path.join(root, 'worker', 'wrangler.jsonc'), 'utf8'));
  if (!m || !DATABASE_RE.test(m[1])) {
    throw new Refusal('::error::worker/wrangler.jsonc no longer has a "database_id" that is a UUID: update databaseId in check-d1-writes.mjs.');
  }
  return m[1];
}

// The query with its values written in, each one checked first.
// No variables: nothing here depends on the declared type of one.
export function buildQuery(account, database, first, last) {
  if (!ACCOUNT_RE.test(account)) throw new Refusal('CLOUDFLARE_ACCOUNT_ID is not 32 hex characters.');
  for (const value of [first, last]) {
    if (!DATE_RE.test(value)) throw new Refusal(`Not a date: ${repr(value)}`);
  }
  return '{ viewer { accounts(filter: {accountTag: "' + account + '"}) {'
    + ' d1AnalyticsAdaptiveGroups(limit: 10, orderBy: [date_ASC],'
    + ' filter: {databaseId: "' + database + '", date_geq: "' + first + '", date_leq: "' + last + '"}) {'
    + ' sum { rowsWritten } dimensions { date } } } } }';
}

// [parsed answer, null], or [null, why] with no part of the body in why.
export async function ask(fetchFn, token, query) {
  let res;
  try {
    res = await fetchFn(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ query }),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'wvwrelink-health-check' },
      signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return [null, `HTTP ${res.status}`];
    }
    return [JSON.parse(await res.text()), null];
  } catch (error) {
    return [null, error instanceof SyntaxError ? 'the answer is not JSON' : String(error && error.name)];
  }
}

const SHAPE = 'the answer is not data.viewer.accounts[0].d1AnalyticsAdaptiveGroups of {sum.rowsWritten, dimensions.date}';
// value[key] of a parsed answer, or the shape fault: a wrong type or a missing key is the same failure.
// An index past the end gives undefined, which the next step refuses.
function at(value, key) {
  if (!(typeof key === 'number' ? Array.isArray(value) : isObject(value) && Object.hasOwn(value, key))) throw new Refusal(SHAPE);
  return value[key];
}

// [{date: rowsWritten}, null], or [null, why]: why names no part of the body.
export function rowsByDate(answer) {
  if (!isObject(answer)) return [null, 'the answer is not an object'];
  const errors = answer.errors;
  const some = Array.isArray(errors) ? errors.length > 0 : isObject(errors) ? Object.keys(errors).length > 0 : Boolean(errors);
  if (some) {
    const codes = [];
    for (const e of Array.isArray(errors) ? errors : []) {
      const code = isObject(e) && isObject(e.extensions) ? e.extensions.code : undefined;
      if (typeof code === 'string' && CODE_RE.test(code)) codes.push(code);
    }
    const unique = [...new Set(codes)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return [null, `the API answered with ${Array.isArray(errors) ? errors.length : 'some'} error(s)${unique.length ? ` (${unique.join(', ')})` : ''}`];
  }
  try {
    const groups = at(at(at(at(at(answer, 'data'), 'viewer'), 'accounts'), 0), 'd1AnalyticsAdaptiveGroups');
    const empty = (typeof groups === 'string' && groups === '') || (isObject(groups) && !Object.keys(groups).length);
    if (!Array.isArray(groups) && !empty) throw new Refusal(SHAPE);
    const found = new Map();
    for (const g of empty ? [] : groups) {
      const n = at(at(g, 'sum'), 'rowsWritten');
      if (!Number.isInteger(n)) throw new Refusal(SHAPE);
      const date = at(at(g, 'dimensions'), 'date');
      if (date !== null && typeof date === 'object') throw new Refusal(SHAPE);
      found.set(date, (found.get(date) || 0) + n);
    }
    return [found, null];
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return [null, error.message];
  }
}

// [line, problems] for the two days of an answer: nothing printed here.
export function judge(answer, first, last) {
  const [found, why] = rowsByDate(answer);
  if (why) return [null, [`D1 rows written: ${why}`]];
  const counts = [first, last].map((d) => [d, found.get(d) || 0]);
  const line = `D1 rows written (limit ${LIMIT}): ${counts.map(([d, n]) => `${d} ${n}`).join(', ')}`;
  const problems = [];
  if (counts[0][1] === 0) {
    problems.push(`D1 rows written: none on ${first}, which the readers fill every day: the query reads the wrong database or an empty dataset.`);
  }
  const over = counts.filter(([, n]) => n > LIMIT).map(([d]) => d);
  if (over.length) {
    problems.push(`D1 rows written passed ${LIMIT} on ${over.join(' and ')}. At 100,000 the Free plan refuses every write until 00:00 UTC (developers.cloudflare.com/d1/platform/pricing/). The D1 page of the dashboard shows which tables and queries write; the figures here are not the billing ones (developers.cloudflare.com/d1/observability/metrics-analytics/).`);
  }
  return [line, problems];
}

export async function main({ fetchFn = fetch, now = Date.now, root = ROOT, env = process.env } = {}) {
  const t = now();
  const day = new Date(t).toISOString().slice(0, 10);
  const first = new Date(t - 86400e3).toISOString().slice(0, 10);
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN || '';
  const account = env.CLOUDFLARE_ACCOUNT_ID || '';
  const missing = [['CLOUDFLARE_ANALYTICS_TOKEN', token], ['CLOUDFLARE_ACCOUNT_ID', account]].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) return { code: 1, out: [`::error::${missing.join(' and ')} not set: the job needs the repository secret(s).`] };
  let query;
  try {
    query = buildQuery(account, databaseId(root), first, day);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { code: 1, out: [error.message.startsWith('::error::') ? error.message : `::error::${escape(error.message)}`] };
  }
  const [answer, why] = await ask(fetchFn, token, query);
  if (why) return { code: 1, out: [`::error::${escape(`D1 rows written: ${why}`)}`] };
  const [line, problems] = judge(answer, first, day);
  const out = [...(line ? [line] : []), ...problems.map((p) => `::error::${escape(p)}`)];
  return { code: problems.length ? 1 : 0, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { out, code } = await main();
  for (const line of out) console.log(line);
  process.exitCode = code;
}
