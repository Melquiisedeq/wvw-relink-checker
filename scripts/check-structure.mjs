#!/usr/bin/env node
// Structural checks for the mistakes that fail silently in a site with no build.
//
// Nothing in this file is shipped: Cloudflare publishes site/ and nothing else.
// It exists because the mistakes this project can actually make - a script
// missing from index.html, a host missing from the Content Security Policy -
// fail *silently* in production: the page looks fine and the feature simply
// does not happen.
//
// Run it by hand any time:  node scripts/check-structure.mjs
// Each exported check takes (problems, root) so the unit test can point it at a
// planted copy of the tree.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Every host that appears anywhere in the served files, and which kind it is.
//
//   FETCHED    the browser makes a request to it, so it must be in the CSP
//   MENTIONED  it only ever appears in a comment, an XML namespace, a licence
//              header or page metadata - no request, so no CSP entry
//
// A host in neither list fails: a new host is a decision about the CSP, and
// this is where the decision gets noticed.
export const FETCHED = {
  'wvwrelink.com': ['wss', 'the push socket, wss://wvwrelink.com/api/ws'],
  'api.guildwars2.com': ['https', 'guild search, matches, objectives, timers'],
  'docs.google.com': ['https', 'the three public spreadsheets'],
  'render.guildwars2.com': ['https', 'guild emblem images'],
  'static.cloudflareinsights.com': ['https', 'the Web Analytics beacon script'],
  'cloudflareinsights.com': ['https', 'where the Web Analytics beacon reports'],
};

export const MENTIONED = {
  'schema.org': 'JSON-LD vocabulary, not a URL anything loads',
  'www.w3.org': 'SVG and XML namespaces',
  'wiki.guildwars2.com': 'the footer links to the wiki',
  'www.guildwars2.com': 'a link in the page and its JSON-LD sameAs',
  'gw2mists.com': 'a link in the page (the leaderboards)',
  'en.wikipedia.org': 'the JSON-LD sameAs',
  'github.com': 'a link in the page and its JSON-LD sameAs',
  'lucide.dev': 'a comment crediting an icon',
};

const read = (root, rel) => fs.readFileSync(path.join(root, 'site', rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, 'site', rel));
const filesIn = (root, dir, suffix) =>
  fs.readdirSync(path.join(root, 'site', dir)).filter((f) => f.endsWith(suffix)).sort();
const lines = (text) => text.split(/\r\n|[\n\r]/);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A string as Python's repr writes it: the message ends up on one annotation line.
const quote = (s) => {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
};
const list = (a) => `[${a.map(quote).join(', ')}]`;

// Every <script> tag: its src, whether it is async, whether in <head>. Parsed,
// not grepped: the JSON-LD block has no src at all.
function scriptTags(html) {
  const body = html.toLowerCase().indexOf('<body');
  return [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => {
    const src = /\bsrc="([^"]+)"/i.exec(m[0]);
    return { src: src ? src[1] : null, async: /\basync\b/i.test(m[0]), head: m.index < body };
  });
}

// The Content-Security-Policy _headers sets for /*, or null.
function cspFromHeaders(root) {
  let rule = null;
  for (const line of lines(read(root, '_headers'))) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) rule = line.trim();
    else if (rule === '/*') {
      const at = line.indexOf(':');
      const name = at < 0 ? line : line.slice(0, at);
      if (name.trim().toLowerCase() === 'content-security-policy') return line.slice(at + 1).trim();
    }
  }
  return null;
}

export function checkHosts(problems, root = ROOT) {
  const found = {};
  const tree = ['index.html', '_headers',
    ...filesIn(root, 'js', '.js').map((f) => 'js/' + f),
    ...filesIn(root, 'css', '.css').map((f) => 'css/' + f)];
  for (const rel of tree) {
    for (const m of read(root, rel).matchAll(/(?:https?|wss?):\/\/([A-Za-z0-9.-]+)/g)) {
      (found[m[1]] ||= new Set()).add(rel);
    }
  }
  for (const host of Object.keys(found).sort()) {
    if (host in FETCHED || host in MENTIONED) continue;
    problems.push(`${host} is a host this check has never seen, in ${[...found[host]].sort().join(', ')}. If the browser `
      + 'requests it, add it to the Content Security Policy in _headers '
      + 'and to FETCHED in this file. If it is only mentioned in a comment '
      + 'or a namespace, add it to MENTIONED and leave the CSP alone.');
  }

  // A header, not a <meta>: a <meta> policy holds back Chromium's preload
  // scanner and the scripts load one after another (_headers says more).
  if (/<meta[^>]*http-equiv="Content-Security-Policy"/i.test(read(root, 'index.html'))) {
    problems.push('index.html has a Content-Security-Policy <meta> tag again. The '
      + 'policy lives in _headers; a <meta> copy slows every load and is '
      + 'one more policy to keep in step.');
  }

  const policy = cspFromHeaders(root);
  if (!policy) {
    problems.push('No Content-Security-Policy under /* in _headers. That policy is '
      + 'what denies everything by default, so this is either a typo in '
      + 'the file or something much worse.');
    return;
  }

  // Cloudflare's limit per _headers line (developers.cloudflare.com/workers/
  // static-assets/headers/); the whole policy is one line and grows by host.
  const longest = Math.max(...lines(read(root, '_headers')).map((l) => l.length));
  if (longest > 2000) {
    problems.push(`A line in _headers is ${longest} characters; Cloudflare allows 2,000. `
      + 'The Content Security Policy is one line and grows with every '
      + 'host.');
  }
  // With the scheme, so cloudflareinsights.com is not found inside
  // static.cloudflareinsights.com.
  for (const host of Object.keys(FETCHED).sort()) {
    const [scheme, what] = FETCHED[host];
    if (!policy.includes(scheme + '://' + host)) {
      problems.push(`${host} is fetched (${what}) but is not named in the Content Security `
        + 'Policy, so the browser blocks it - quietly, with the page '
        + 'looking fine.');
    }
  }

  // The page's own /api is reached by path, with no host for the loop above
  // to find, and connect-src names hosts only: without 'self' there the
  // browser blocks it and every read quietly falls back to the sheets.
  const own = tree.filter((rel) => rel.startsWith('js/') && /'\/api\//.test(read(root, rel))).sort();
  const connect = /connect-src([^;]*)/.exec(policy);
  if (own.length && !(connect && connect[1].split(/\s+/).includes("'self'"))) {
    problems.push(`${own.join(', ')} reads this site's own /api, but connect-src in the Content `
      + "Security Policy does not say 'self', so the browser blocks it.");
  }
}

export function checkScripts(problems, root = ROOT) {
  const tags = scriptTags(read(root, 'index.html'));
  const referenced = tags.filter((t) => t.src).map((t) => t.src);

  // A script from another host is checkHosts' business, not a file here.
  for (const src of referenced) {
    if (src.startsWith('https://')) continue;
    if (!exists(root, src)) {
      problems.push(`index.html loads ${src}, which does not exist. The browser 404s `
        + 'it and carries on without whatever was in it.');
    }
  }

  // A script loaded later by another one (js/maps.js, by js/maps-early.js) is
  // named there as a quoted path; it runs after everything in index.html.
  const late = new Set();
  for (const src of referenced) {
    if (src.startsWith('js/') && exists(root, src)) {
      for (const m of read(root, src).matchAll(/'(js\/[\w.-]+\.js)'/g)) late.add(m[1]);
    }
  }
  for (const src of [...late].sort()) {
    if (!exists(root, src)) {
      problems.push(`A script loads ${src} later, but it does not exist. The browser `
        + '404s it and whatever needed it never works.');
    }
  }
  for (const name of filesIn(root, 'js', '.js')) {
    if (!referenced.includes('js/' + name) && !late.has('js/' + name)) {
      problems.push(`js/${name} exists but nothing in index.html loads it. Either it `
        + 'belongs in the ordered list, or it is dead and should go.');
    }
  }

  // The scripts are not modules and share one global scope, so this order is
  // load-bearing: config.js and dom.js are read by everything, and boot.js
  // starts the page once the rest is defined. A script in <head> (js/region.js)
  // runs before config.js and reads nothing from the others.
  const ordered = tags.filter((t) => t.src && !t.async && !t.head).map((t) => t.src);
  if (ordered[0] !== 'js/config.js' || ordered[1] !== 'js/dom.js') {
    problems.push(`The first two scripts in index.html are ${ordered.length ? list(ordered.slice(0, 2)) : 'missing'}. They have to be `
      + 'js/config.js then js/dom.js - everything else reads them at load.');
  }
  if (ordered.length && ordered[ordered.length - 1] !== 'js/boot.js') {
    problems.push(`The last script loaded in order is ${ordered[ordered.length - 1]}, not js/boot.js. boot.js `
      + 'starts the page, so anything after it runs against a page that '
      + 'has already started.');
  }
}

export function checkStyles(problems, root = ROOT) {
  const referenced = [...read(root, 'index.html').matchAll(/<link\b[^>]*href="([^"]+\.css)"/gi)].map((m) => m[1]);
  for (const href of referenced) {
    if (!exists(root, href)) problems.push(`index.html links ${href}, which does not exist.`);
  }
  for (const name of filesIn(root, 'css', '.css')) {
    if (!referenced.includes('css/' + name)) {
      problems.push(`css/${name} exists but index.html does not link it.`);
    }
  }
}

// The banner demo hatch must never be committed: it makes the countdowns report
// any time you ask for, so a crafted link would show a relink that is not
// happening, with the real domain in the address bar.
export function checkDemoHatch(problems, root = ROOT) {
  for (const name of filesIn(root, 'js', '.js')) {
    const body = read(root, 'js/' + name);
    if (body.includes('TIMER_OVERRIDE') || /(?<![\p{L}\p{N}_])demo(?![\p{L}\p{N}_])/u.test(body)) {
      problems.push(`js/${name} mentions the banner demo hatch. That hatch stays in the `
        + 'patch outside this repository: committed, it lets anyone send '
        + 'a link that shows a relink which is not happening.');
    }
  }
}

// #teamsNotice has to be the first element in the body: it is a sticky bar, and
// sticky measures from where an element really sits, so moved down it would not
// be at the top of a freshly loaded page, and inside anything with overflow set
// it would not pin at all. Both failures are silent.
export function checkNoticePosition(problems, root = ROOT) {
  const html = read(root, 'index.html');
  const body = /<body[^>]*>/i.exec(html);
  if (!body) {
    problems.push('No <body> tag in index.html, so where the teams notice sits could '
      + 'not be checked. That is a much bigger problem than this check.');
    return;
  }

  // Comments and blank lines in front of it are fine. The first *element* is
  // not, whatever it is.
  let rest = html.slice(body.index + body[0].length).trimStart();
  while (rest.startsWith('<!--')) {
    const end = rest.indexOf('-->', 4);
    if (end < 0) break;
    rest = rest.slice(end + 3).trimStart();
  }
  const first = /^<([a-zA-Z][^\s>/]*)([^>]*)>/.exec(rest);
  if (!first || !first[2].includes('id="teamsNotice"')) {
    const found = first ? `<${first[1]}>` : '(no element at all)';
    problems.push(`The first element in the body of index.html is ${found}, not the teams `
      + 'notice. #teamsNotice has to come first: it is position:sticky, and '
      + 'sticky measures from where an element really sits - anywhere '
      + 'further down and the bar is not at the top of a freshly loaded '
      + 'page, it only pins after you scroll past it. Inside anything with '
      + 'overflow set it does not pin at all. Neither failure produces an '
      + 'error.');
  }
}

// Is sitemap.xml's lastmod a date at all, and not in the future? Not "is it
// current": whether a change was significant is a human call. Absent is fine:
// lastmod is optional in the protocol.
export function checkSitemap(problems, root = ROOT, today = new Date()) {
  const found = /<lastmod>([^<]+)<\/lastmod>/.exec(read(root, 'sitemap.xml'));
  if (!found) return;

  const stamp = found[1].trim();
  const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(stamp);
  const said = parts && new Date(+parts[1], +parts[2] - 1, +parts[3]);
  if (!said || +parts[1] < 1 || said.getMonth() !== +parts[2] - 1) {
    problems.push(`sitemap.xml has <lastmod>${stamp}</lastmod>, which is not a YYYY-MM-DD `
      + 'date. A crawler can drop a sitemap it cannot parse, and it does '
      + 'not tell anybody.');
    return;
  }
  if (said > new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
    problems.push(`sitemap.xml claims the page last changed on ${stamp}, which is in the `
      + 'future. Nothing is served differently; the date is simply not '
      + 'believable, which is how the field stops counting.');
  }
}

// First-column cells of the README table whose header row starts with `header`,
// as the text inside each backtick pair.
function readmeTable(root, header) {
  const all = lines(fs.readFileSync(path.join(root, 'README.md'), 'utf8'));
  const cells = [];
  const i = all.findIndex((line) => line.startsWith('| ' + header + ' |'));
  if (i >= 0) {
    for (const row of all.slice(i + 2)) {
      if (!row.startsWith('|')) break;
      cells.push([...row.split('|')[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]));
    }
  }
  return cells;
}

// Keys js/ passes to localStorage or sessionStorage, constants resolved. A key
// that does not resolve to a fixed text is a problem of its own: the README
// table could not be compared against it.
function storageKeys(problems, root) {
  const bodies = Object.fromEntries(filesIn(root, 'js', '.js').map((n) => [n, read(root, 'js/' + n)]));
  const keys = { written: new Set(), read: new Set() };

  const fixed = (arg) => {
    arg = arg.trim();
    const quoted = /^(['"`])([^'"`$\\]+)\1$/.exec(arg);
    if (quoted) return quoted[2];
    if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
      for (const body of Object.values(bodies)) {
        const constant = new RegExp('\\b' + escapeRe(arg) + '\\s*=\\s*([\'"`])([^\'"`$\\\\]+)\\1\\s*[;,\\n]').exec(body);
        if (constant) return constant[2];
      }
    }
    return null;
  };
  const note = (name, arg, writes) => {
    const key = fixed(arg);
    if (key === null) {
      problems.push(`js/${name} passes ${quote(arg.trim())} as a storage key and this check cannot read it `
        + 'as a fixed text. Use a quoted string or a const with one, so '
        + 'the README key table can be compared.');
      return;
    }
    keys.read.add(key);
    if (writes) keys.written.add(key);
  };

  for (const name of Object.keys(bodies).sort()) {
    const body = bodies[name];
    for (const m of body.matchAll(/\b(?:local|session)Storage\s*\.\s*(get|set|remove)Item\(\s*([^,)]*)/g)) {
      note(name, m[2], m[1] === 'set');
    }
    for (const m of body.matchAll(/\b(?:local|session)Storage\s*\[\s*([^\]]*)\]\s*(=(?!=))?/g)) {
      note(name, m[1], m[2] !== undefined);
    }
    for (const m of body.matchAll(/\b(?:local|session)Storage\.(?!(?:get|set|remove)Item\b|clear\b|key\b|length\b)\w+\s*=(?!=)/g)) {
      problems.push(`js/${name} assigns a storage key by property (${m[0]}). Use setItem `
        + 'with a fixed key so the README key table can be compared.');
    }
  }
  return keys;
}

// The Privacy tables in README.md name every fetched host and every key: a host
// in FETCHED must be in the host table, a key js/ writes must be in the key
// table, and the key table may name nothing js/ does not use.
export function checkReadme(problems, root = ROOT) {
  const listed = new Set(readmeTable(root, 'Host').flat().map((cell) => cell.split('/')[0]));
  for (const host of Object.keys(FETCHED).filter((h) => !listed.has(h)).sort()) {
    problems.push(`README.md Privacy host table does not list ${host}, which the page `
      + `fetches (${FETCHED[host][1]}). The table is the promise to visitors.`);
  }

  const named = new Set(readmeTable(root, 'Key').flat());
  const keys = storageKeys(problems, root);
  for (const key of [...keys.written].filter((k) => !named.has(k)).sort()) {
    problems.push(`js/ writes the localStorage key ${key} but the README.md Privacy key `
      + 'table does not list it.');
  }
  for (const key of [...named].filter((k) => !keys.read.has(k) && !keys.written.has(k)).sort()) {
    problems.push(`The README.md Privacy key table lists ${key}, which no file in js/ `
      + 'uses.');
  }
}

// What the sitemap says, for the summary: a check that prints nothing when it
// is happy is one nobody can tell ran at all.
function sitemapNote(root) {
  const found = /<lastmod>([^<]+)<\/lastmod>/.exec(read(root, 'sitemap.xml'));
  if (!found) return 'sitemap.xml carries no <lastmod>, which is allowed - the tag is optional.';
  return `sitemap.xml says the page last changed on ${found[1].trim()}; bump it only for a `
    + 'change to the content, the JSON-LD or the links.';
}

// The two Apps Script projects bound to a sheet pin the same two scopes: the annotation on the
// first line and a manifest with oauthScopes; without them Apps Script scans
// the source and may ask for every spreadsheet.
export function checkAppsScriptScopes(problems, root = ROOT) {
  const want = ['https://www.googleapis.com/auth/spreadsheets.currentonly',
    'https://www.googleapis.com/auth/script.external_request'];
  for (const name of ['relink-notice', 'kills']) {
    const base = path.join(root, 'apps-script', name);
    const head = fs.readFileSync(path.join(base, name + '.gs'), 'utf8').split('\n');
    if (head[0] !== '/**' || head[1] !== ' * @OnlyCurrentDoc') {
      problems.push(`apps-script/${name}/${name}.gs: "@OnlyCurrentDoc" must be `
        + 'the first line of the comment on line 1.');
    }
    let got;
    try {
      got = JSON.parse(fs.readFileSync(path.join(base, 'appsscript.json'), 'utf8')).oauthScopes;
    } catch {
      problems.push(`apps-script/${name}/appsscript.json: missing or not JSON.`);
      continue;
    }
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      problems.push(`apps-script/${name}/appsscript.json: oauthScopes must be exactly ${list(want)}.`);
    }
  }
  // The notes script is bound to no file: external requests only.
  let notes;
  try {
    notes = JSON.parse(fs.readFileSync(path.join(root, 'apps-script', 'notes', 'appsscript.json'), 'utf8')).oauthScopes;
  } catch {
    problems.push('apps-script/notes/appsscript.json: missing or not JSON.');
    return;
  }
  if (JSON.stringify(notes) !== JSON.stringify([want[1]])) {
    problems.push(`apps-script/notes/appsscript.json: oauthScopes must be exactly ${list([want[1]])}.`);
  }
}

// The report as printed lines and an exit code.
export function main(root = ROOT) {
  const problems = [];
  for (const check of [checkHosts, checkScripts, checkStyles, checkDemoHatch,
    checkNoticePosition, checkSitemap, checkReadme, checkAppsScriptScopes]) {
    check(problems, root);
  }
  if (problems.length) {
    return { code: 1, out: [...problems.map((p) => `::error::${p}`), '', `${problems.length} problem(s).`] };
  }
  const js = filesIn(root, 'js', '.js').length;
  const css = filesIn(root, 'css', '.css').length;
  const fetched = Object.keys(FETCHED).length;
  const mentioned = Object.keys(MENTIONED).length;
  return {
    code: 0,
    out: [
      `${js} scripts and ${css} stylesheets: all present, all referenced, and the load order holds.`,
      `${fetched + mentioned} hosts in the tree: ${fetched} fetched and named in the CSP, ${mentioned} mentioned only.`,
      'No demo hatch in js/.',
      'The teams notice is the first element in the body.',
      'The two sheet-bound Apps Script projects pin the same two scopes; the notes project, external requests only.',
      sitemapNote(root),
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const { out, code } = main();
  for (const line of out) console.log(line);
  process.exitCode = code;
}
