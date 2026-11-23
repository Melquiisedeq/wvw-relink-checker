#!/usr/bin/env node
// Is the published site actually serving everything it asks for?
//
// check-structure.mjs reads the repository. This reads wvwrelink.com. The two are
// not the same question: the repository can be perfectly consistent while a file
// failed to deploy, and then the page loads, looks right, and one feature is
// missing with nothing in the logs anywhere.
//
// So the list of files is taken from the *served* HTML, not from the repository,
// with the scripts those files load later by a quoted path, and every one of them
// is fetched; the images the HTML names get a HEAD (the maps and icons the code
// and the stylesheets ask for are not looked for). A 404 on js/maps.js is the whole maps panel gone, and the only
// place it shows is the console of whoever happened to open the site.
//
// The Content Security Policy is a response header, so it is compared with the
// line in site/_headers: a deploy that dropped or mangled that file serves the
// page with no policy at all, and it looks exactly the same.
//
// Two more facts about the domain, each a date or a status and no judgement:
// the old GitHub Pages address stays gone (removing the custom domain does not
// unpublish it), and the domain is not about to expire - it is renewed by hand, on
// purpose, so this is what remembers.
//
// Run it by hand any time:  node scripts/check-site.mjs
// main() takes the fetch, the sleep and the clock, so the unit test answers without a network.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { escape, show, describe } from './workflow-text.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SITE = 'https://wvwrelink.com/';
const ATTEMPTS = 3;
const PAUSE_SECONDS = 5;
const TIMEOUT_SECONDS = 30;
export const OLD_PAGES = 'https://melquiisedeq.github.io/wvw-relink-checker/';
export const RDAP = 'https://rdap.verisign.com/com/v1/domain/wvwrelink.com';
const RENEW_WARN_DAYS = 60;
const DAY_MS = 86400e3;

const label = (name) => name.padEnd(46);
const withoutSlashes = (p) => p.replace(/^\/+/, '');
const HEADERS = { 'User-Agent': 'wvwrelink-health-check' };

// The fetch the checks go through: [status, body, error, headers], after the retries.
export function makeFetch({ fetchFn = fetch, sleep = (s) => pause(s * 1000) } = {}) {
  async function get(url, method = 'GET') {
    let last = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt) await sleep(PAUSE_SECONDS);
      try {
        const res = await fetchFn(url, { method, headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000) });
        if (!res.ok) {
          last = `HTTP ${res.status}`;
          await res.body?.cancel();
          continue;
        }
        return [res.status, await res.text(), null, res.headers];
      } catch (error) {
        last = describe(error);
      }
    }
    return [null, null, `${last} after ${ATTEMPTS} attempts`, null];
  }

  // The HTTP status, 404 included, or null if nothing answered.
  async function statusOf(url) {
    try {
      const res = await fetchFn(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_SECONDS * 1000) });
      await res.body?.cancel();
      return res.status;
    } catch {
      return null;
    }
  }
  return { get, statusOf };
}

// Same-origin images the HTML names: <img src>, and <link href> to an image.
export function imagePaths(html) {
  const found = [...html.matchAll(/<img\b[^>]*\bsrc="([^":]+)"/gi)].map((m) => m[1])
    .concat([...html.matchAll(/<link\b[^>]*href="([^":]+\.(?:png|ico|webp|jpe?g|svg))"/gi)].map((m) => m[1]));
  return [...new Set(found)].sort();
}

// The policy site/_headers sets for /*, as the page should receive it.
export function cspWritten(root = ROOT) {
  let rule = null;
  for (const line of fs.readFileSync(path.join(root, 'site', '_headers'), 'utf8').split(/\r\n|[\n\r]/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      rule = line.trim();
    } else if (rule === '/*') {
      const trimmed = line.trim();
      const at = trimmed.indexOf(':');
      const name = at < 0 ? trimmed : trimmed.slice(0, at);
      if (name.trim().toLowerCase() === 'content-security-policy') return at < 0 ? '' : trimmed.slice(at + 1).trim();
    }
  }
  return null;
}

export async function domainChecks({ get, statusOf, now }, problems, notes) {
  const status = await statusOf(OLD_PAGES);
  if (status === 200) {
    problems.push(`${OLD_PAGES} answers 200: GitHub Pages is publishing the repository again. Settings > Pages > Unpublish.`);
  } else {
    notes.push(`${label('old GitHub Pages address')} HTTP ${show(status)}`);
  }

  const [, body, error] = await get(RDAP);
  let expires = null;
  if (!error) {
    try {
      for (const event of JSON.parse(body).events ?? []) {
        if (event.eventAction === 'expiration') {
          const at = new Date(event.eventDate);
          if (Number.isNaN(at.getTime())) throw new Error('not a date');
          expires = at;
        }
      }
    } catch { /* an answer that is not what it was: no date read */ }
  }
  if (expires === null) {
    problems.push(`Could not read when wvwrelink.com expires from ${RDAP} (${error || 'no expiration event'}).`);
    return;
  }
  const left = Math.floor((expires.getTime() - now()) / DAY_MS);
  const date = expires.toISOString().slice(0, 10);
  if (left < RENEW_WARN_DAYS) {
    problems.push(`wvwrelink.com expires on ${date}, in ${left} days, and auto-renew is off on purpose. Renew it at Dynadot.`);
  } else {
    notes.push(`${label('domain expires')} ${date}, ${left} days left`);
  }
}

export async function main({ fetchFn, sleep, now = Date.now, root = ROOT } = {}) {
  const http = makeFetch({ fetchFn, sleep });
  const problems = [];
  const notes = [];

  const [status, html, error, headers] = await http.get(SITE);
  if (error) {
    return { code: 1, out: [`::error::${SITE} did not answer (${escape(error)}). The site is down, or DNS or the certificate is broken.`] };
  }

  notes.push(`${label(SITE)} HTTP ${status}, ${Math.floor([...html].length / 1024)} KB`);

  // Enough to tell the real page from a placeholder, a parked domain, or a
  // half-finished deploy that happens to answer 200.
  for (const [needle, what] of [
    ['rel="canonical"', 'the canonical link'],
    ['js/boot.js', 'the script that starts the page'],
  ]) {
    if (!html.includes(needle)) {
      problems.push(`The served page does not contain ${what}. Something is answering on the domain, but it is not this site as it is written here.`);
    }
  }

  const written = cspWritten(root);
  const served = headers.get('Content-Security-Policy');
  if (!served) {
    problems.push('The page is served with no Content-Security-Policy header. Nothing denies anything by default; site/_headers did not deploy, or its /* rule broke.');
  } else if (served.trim() !== written) {
    problems.push(`The served Content-Security-Policy is not the one in site/_headers. Served: ${served}`);
  } else {
    notes.push(`${label('Content-Security-Policy')} as written in _headers`);
  }

  // From the served HTML, not from the repository: the point is to catch a
  // file the deploy left behind.
  const assets = [...html.matchAll(/<script\b[^>]*\bsrc="([^":]+)"/gi)].map((m) => m[1])
    .concat([...html.matchAll(/<link\b[^>]*href="([^":]+\.css)"/gi)].map((m) => m[1]));
  const images = imagePaths(html);

  if (!assets.length) {
    problems.push('No scripts or stylesheets found in the served HTML at all. Either the page is not what we think it is, or it was rewritten on the way out.');
  }

  // A script can load another later by a quoted path (js/maps.js, by
  // js/maps-early.js; check-structure.mjs reads the same pattern): those
  // are fetched too, from the served bodies.
  const missing = [];
  const seen = new Set(assets.map(withoutSlashes));
  for (const asset of assets) {
    const [, body, error1] = await http.get(SITE + withoutSlashes(asset));
    if (error1) {
      missing.push(`${asset} (${error1})`);
    } else if (asset.endsWith('.js')) {
      for (const m of body.matchAll(/'(js\/[\p{L}\p{N}_.-]+\.js)'/gu)) {
        if (!seen.has(m[1])) {
          seen.add(m[1]);
          assets.push(m[1]);
        }
      }
    }
  }

  for (const image of images) {
    const [, , error1] = await http.get(SITE + withoutSlashes(image), 'HEAD');
    if (error1) missing.push(`${image} (${error1})`);
  }

  if (missing.length) {
    problems.push(`The page asks for ${missing.length} file(s) the site does not serve: ${missing.join(', ')}. The page still loads and whatever was in them simply does not happen.`);
  } else {
    notes.push(`${label('scripts and stylesheets')} all ${assets.length} served`);
    notes.push(`${label('images in the HTML')} all ${images.length} served`);
  }

  await domainChecks({ ...http, now }, problems, notes);

  const out = [...notes, ''];
  if (problems.length) {
    out.push(...problems.map((p) => `::error::${escape(p)}`), '', `${problems.length} problem(s).`);
    return { code: 1, out };
  }
  out.push('The site answers, and serves every script, stylesheet and image its own HTML names.');
  return { code: 0, out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { out, code } = await main();
  for (const line of out) console.log(line);
  process.exitCode = code;
}
