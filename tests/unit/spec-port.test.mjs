// The browser tests know the page's insides through one file, tests/e2e/support/page.mjs:
// every other spec and support file finds the page by its roles, its text, its
// requests and its clock. A name is one declared at the top of a site/js script
// (camelCase, or UPPER_CASE with an underscore), read from the scripts at each run,
// that is not an id in index.html and that the file neither declares nor imports.
// A file that still uses some is listed in WAITING with exactly those names; a review
// takes no name added there.
// Not seen, so a review has to: a name built as a string, reached as `globalThis.x`,
// `self.x`, `window?.x` or `{ x: f } = window`; text after a `/*` or `//` inside a
// string; names outside NAMED (`COLORS`, `run`); ids of index.html, which are globals too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const E2E = path.join(ROOT, 'tests/e2e');
const PORT = 'support/page.mjs';

const WAITING = {
  'notice.spec.mjs': ['assignNA', 'getTeamName', 'relinkStateAt', 'updateRelinkBanner', 'wvwMapCache'],
  'popovers.spec.mjs': ['OBJ_SIZE', 'WVW_STATIC'],
  'relink.spec.mjs': ['WVW_STATIC'],
};

const TOP = /^(?:async\s+)?(?:function\*?\s+|const\s+|let\s+|var\s+|class\s+)([A-Za-z_$][\w$]*)/;
const NAMED = n => /[a-z][A-Z]/.test(n) || /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(n);
const escape = n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function pageNames(root = ROOT) {
  const dir = path.join(root, 'site/js');
  const names = new Set();
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      const m = line.match(TOP);
      if (m && NAMED(m[1])) names.add(m[1]);
    }
  }
  const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) names.delete(id);
  return names;
}

// Comments out; strings stay in, so a name handed to the page as text counts too.
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

// A property (`r.byId`) or an object's key (`{ byId: … }`, `, byId:`) is the file's
// own; `window.name`, `ok ? name : null` and `case name:` are the page's.
const used = (body, n) => [...body.matchAll(new RegExp(`(?<![\\w$])(?:(?<![^.]\\.)|(?<=window\\.))${escape(n)}(?![\\w$])`, 'g'))]
  .some(m => !(/[{,]\s*$/.test(body.slice(0, m.index)) && /^\s*:(?!:)/.test(body.slice(m.index + n.length))));

export function namesIn(src, names) {
  const body = code(src);
  return [...names].filter(n => used(body, n)
    && !new RegExp(`\\b(?:const|let|var|function\\*?|class)\\s+${escape(n)}\\b|\\bimport\\s*\\{[^}]*\\b${escape(n)}\\b`).test(body)).sort();
}

function testFiles() {
  const specs = fs.readdirSync(E2E).filter(f => f.endsWith('.spec.mjs'));
  const support = fs.readdirSync(path.join(E2E, 'support')).filter(f => f.endsWith('.mjs')).map(f => `support/${f}`);
  return [...specs, ...support].filter(f => f !== PORT).sort();
}

test('the names come from the site: a few the specs lean on are there, ids are not', () => {
  const names = pageNames();
  for (const n of ['loadStandings', 'newestMatches', 'MISSED_AWAY_MS']) assert.ok(names.has(n), n);
  assert.ok(!names.has('guildInput'), 'an id of index.html');
});

test('outside the port, a spec or support file uses no name of site/js but those WAITING lists for it', () => {
  const names = pageNames();
  const wrong = [];
  for (const f of testFiles()) {
    const got = namesIn(fs.readFileSync(path.join(E2E, f), 'utf8'), names);
    const want = [...(WAITING[f] || [])].sort();
    if (got.join() !== want.join()) wrong.push(`${f}: uses [${got.join(' ')}], WAITING lists [${want.join(' ')}]`);
  }
  for (const f of Object.keys(WAITING)) if (!fs.existsSync(path.join(E2E, f))) wrong.push(`${f}: in WAITING, not a file`);
  assert.deepEqual(wrong, [], 'reach the page through tests/e2e/support/page.mjs, or by its roles, text, requests and clock');
});

test('a name planted in a spec is caught, and one the file declares itself is not', () => {
  const names = new Set(['loadStandings', 'byId']);
  assert.deepEqual(namesIn("await page.evaluate(() => loadStandings('manual'));", names), ['loadStandings']);
  assert.deepEqual(namesIn("page.evaluate('loadStandings()')", names), ['loadStandings']);
  assert.deepEqual(namesIn("page.evaluate(() => window.loadStandings)", names), ['loadStandings']);
  assert.deepEqual(namesIn('// loadStandings, in a comment\nconst byId = (a, b) => a - b;', names), []);
  assert.deepEqual(namesIn('const r = { byId: [] }; r.byId.length;', names), []);
  assert.deepEqual(namesIn('[...loadStandings]', names), ['loadStandings']);
  assert.deepEqual(namesIn('const f = ok ? loadStandings : null;', names), ['loadStandings']);
  assert.deepEqual(namesIn('switch (x) { case loadStandings: break; }', names), ['loadStandings']);
  assert.deepEqual(namesIn('const r = { a: 1, byId: 2 };', names), []);
});

test('no function of the port has the name of one of the page\'s', () => {
  const src = fs.readFileSync(path.join(E2E, PORT), 'utf8');
  const exported = [...src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/gm)].map(m => m[1]);
  for (const [, list] of src.matchAll(/^export\s*\{([^}]*)\}/gm)) exported.push(...list.split(',').map(x => x.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  assert.ok(exported.length > 20, 'the exports were read');
  const names = pageNames();
  assert.deepEqual(exported.filter(n => names.has(n)), [], 'a spec importing it would be let off for the page\'s own');
});
