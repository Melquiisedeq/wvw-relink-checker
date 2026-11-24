// The browser tests know the page's insides through one file, tests/e2e/support/page.mjs:
// every other spec and support file finds the page by its roles, its text, its
// requests and its clock. A name is one declared at the top of a site/js script
// (camelCase, or UPPER_CASE with an underscore), read from the scripts at each run,
// that is not an id in index.html and that the file neither declares nor imports. That frees
// by part: the Node side, and each body of a call that runs in the page, is judged alone.
// No spec or support file is let off: one that needs a name asks the port for a function.
// Not seen, so a review has to: a name built as a string, reached as `globalThis.x`,
// `self.x`, `window?.x` or `{ x: f } = window`; text after a `/*` or `//` inside a
// string; a `(` or `)` in a string or regex inside a page body, which cuts the body in
// the wrong place; `page.evaluate(fn)` with `fn` declared in Node, which counts as Node; names outside NAMED (`COLORS`, `run`); ids of index.html, which are globals too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('../../../', import.meta.url).pathname;
const E2E = path.join(ROOT, 'tests/e2e');
const PORT = 'support/page.mjs';

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

// The page's side is the body of a call that runs in the page; a declaration there
// frees only its own body, and one outside frees only the Node side.
const IN_PAGE = /(?:\b(?:evaluate|evaluateHandle|waitForFunction|addInitScript)|(?<![\w$])\$\$?eval)\s*\(/g;

function sides(body) {
  const bodies = [];
  let outside = '', at = 0;
  for (const m of body.matchAll(IN_PAGE)) {
    if (m.index < at) continue;
    let depth = 1, i = m.index + m[0].length;
    for (; i < body.length && depth; i++) depth += body[i] === '(' ? 1 : body[i] === ')' ? -1 : 0;
    outside += body.slice(at, m.index + m[0].length);
    bodies.push(body.slice(m.index + m[0].length, i));
    at = i - 1;
  }
  return [outside + body.slice(at), ...bodies];
}

export function namesIn(src, names) {
  const parts = sides(code(src));
  return [...names].filter(n => parts.some(p => used(p, n)
    && !new RegExp(`\\b(?:const|let|var|function\\*?|class)\\s+${escape(n)}\\b|\\bimport\\s*\\{[^}]*\\b${escape(n)}\\b`).test(p))).sort();
}

// The config's `**/*.spec.mjs`, and everything under support/.
const SKIP = new Set(['node_modules', 'test-results']);
function walk(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(e => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : walk(dir, r);
    return e.name.endsWith('.mjs') ? [r] : [];
  });
}

export function testFiles(dir = E2E) {
  return walk(dir).filter(f => f.endsWith('.spec.mjs') || f.startsWith('support/')).filter(f => f !== PORT).sort();
}

test('the names come from the site: a few the specs lean on are there, ids are not', () => {
  const names = pageNames();
  for (const n of ['loadStandings', 'newestMatches', 'MISSED_AWAY_MS']) assert.ok(names.has(n), n);
  assert.ok(!names.has('guildInput'), 'an id of index.html');
});

test('outside the port, a spec or support file uses no name of site/js', () => {
  const names = pageNames();
  const wrong = [];
  for (const f of testFiles()) {
    const got = namesIn(fs.readFileSync(path.join(E2E, f), 'utf8'), names);
    if (got.length) wrong.push(`${f}: uses [${got.join(' ')}]`);
  }
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

test('a name declared in one place frees no use of it in the page, and the reverse', () => {
  const names = new Set(['newestMatches', 'loadStandings', 'byId']);
  assert.deepEqual(namesIn('const newestMatches = await page.evaluate(() => newestMatches);', names), ['newestMatches']);
  assert.deepEqual(namesIn("await page.evaluate(() => { let loadStandings = 1; });\nawait page.evaluate(() => loadStandings());", names), ['loadStandings']);
  assert.deepEqual(namesIn("const loadStandings = 1; await page.evaluate(() => loadStandings());", names), ['loadStandings']);
  assert.deepEqual(namesIn("await page.evaluate(() => { const byId = 1; return byId; });\nconst r = [1].sort(byId);", names), ['byId']);
  assert.deepEqual(namesIn("const newestMatches = 1; await page.$eval('#x', el => newestMatches); await page.$$eval('a', l => newestMatches);", names), ['newestMatches']);
  assert.deepEqual(namesIn("const byId = 1; await page.evaluate(() => { a.evaluate(() => 1); return byId; }); [1].sort(byId);", names), ['byId']);
  assert.deepEqual(namesIn("await page.evaluate(() => { a.evaluate(() => 1); let byId = 1; }); [1].sort(byId);", names), ['byId']);
  assert.deepEqual(namesIn("const byId = (a, b) => a - b; await page.evaluate(() => 1); [1].sort(byId);", names), []);
  assert.deepEqual(namesIn("await page.evaluate(() => { const byId = 1; return byId; });", names), []);
});

test('a spec in a subfolder is read, node_modules and test-results are not', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'ports-'));
  try {
    for (const f of ['a.spec.mjs', 'deep/er/b.spec.mjs', 'support/s.mjs', 'support/page.mjs', 'playwright.config.mjs', 'node_modules/x/c.spec.mjs', 'test-results/d.spec.mjs', 'e.txt']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), '');
    }
    assert.deepEqual(testFiles(dir), ['a.spec.mjs', 'deep/er/b.spec.mjs', 'support/s.mjs']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no function of the port has the name of one of the page\'s', () => {
  const src = fs.readFileSync(path.join(E2E, PORT), 'utf8');
  const exported = [...src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/gm)].map(m => m[1]);
  for (const [, list] of src.matchAll(/^export\s*\{([^}]*)\}/gm)) exported.push(...list.split(',').map(x => x.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  assert.ok(exported.length > 20, 'the exports were read');
  const names = pageNames();
  assert.deepEqual(exported.filter(n => names.has(n)), [], 'a spec importing it would be let off for the page\'s own');
});
