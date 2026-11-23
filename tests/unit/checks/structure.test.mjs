// scripts/check-structure.mjs: green on the real tree, and every rule fails on a planted copy of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, FETCHED, main, checkSitemap } from '../../../scripts/check-structure.mjs';

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);
const edit = (root, rel, from, to) => {
  const text = read(root, rel);
  assert.ok(text.includes(from), `${rel} no longer has ${from}`);
  write(root, rel, text.split(from).join(to));
};
const LASTMOD = /<lastmod>[^<]*<\/lastmod>/;
const setLastmod = (value) => (r) => write(r, 'site/sitemap.xml', read(r, 'site/sitemap.xml').replace(LASTMOD, `<lastmod>${value}</lastmod>`));
const append = (root, rel, text) => write(root, rel, read(root, rel) + text);

// A copy of what the check reads (not the assets), changed by `plant`; the report it gets.
function planted(plant) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-'));
  try {
    fs.cpSync(path.join(ROOT, 'site'), path.join(root, 'site'), {
      recursive: true,
      filter: (src) => !src.startsWith(path.join(ROOT, 'site', 'assets')),
    });
    fs.cpSync(path.join(ROOT, 'apps-script'), path.join(root, 'apps-script'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(root, 'README.md'));
    plant(root);
    return main(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function fails(plant, pattern) {
  const { code, out } = planted(plant);
  assert.equal(code, 1);
  assert.match(out.join('\n'), pattern);
}

test('the real tree passes, with the summary', () => {
  const { code, out } = main();
  assert.equal(code, 0);
  assert.equal(out.length, 6);
  assert.match(out[0], /^\d+ scripts and \d+ stylesheets: all present/);
  assert.match(out[5], /^sitemap\.xml says the page last changed on \d{4}-\d\d-\d\d/);
});

test('run through a symlink it still runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-link-'));
  try {
    const link = path.join(dir, 'link.mjs');
    fs.symlinkSync(path.join(ROOT, 'scripts', 'check-structure.mjs'), link);
    const run = spawnSync(process.execPath, [link], { encoding: 'utf8' });
    assert.equal(run.stdout.trimEnd().split('\n').length, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('run as a script it prints the report and exits 0', () => {
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../../../scripts/check-structure.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trimEnd().split('\n').length, 6);
});

test('checkHosts: a host it has never seen', () => {
  fails((r) => append(r, 'site/js/boot.js', '\n// https://new.example/x\n'), /new\.example is a host this check has never seen, in js\/boot\.js/);
});
test('checkHosts: a Content-Security-Policy <meta> tag', () => {
  fails((r) => edit(r, 'site/index.html', '<head>', '<head><meta http-equiv="Content-Security-Policy" content="x">'), /has a Content-Security-Policy <meta> tag again/);
});
test('checkHosts: no policy under /*', () => {
  fails((r) => edit(r, 'site/_headers', '  Content-Security-Policy:', '  X-Other:'), /No Content-Security-Policy under \/\* in _headers/);
});
test('checkHosts: a _headers line over 2000 characters', () => {
  fails((r) => append(r, 'site/_headers', '/x\n  X-Long: ' + 'a'.repeat(2100) + '\n'), /A line in _headers is \d+ characters; Cloudflare allows 2,000/);
});
test('checkHosts: a fetched host the policy does not name', () => {
  fails((r) => edit(r, 'site/_headers', 'https://render.guildwars2.com', 'https://render.example'), /render\.guildwars2\.com is fetched .* not named in the Content Security Policy/);
});
test("checkHosts: the own /api without 'self' in connect-src", () => {
  fails((r) => edit(r, 'site/_headers', "connect-src 'self'", 'connect-src'), /reads this site's own \/api, but connect-src .* does not say 'self'/);
});

test('checkScripts: index.html loads a script that does not exist', () => {
  fails((r) => edit(r, 'site/index.html', '<script src="js/boot.js">', '<script src="js/nope.js"></script>\n<script src="js/boot.js">'), /index\.html loads js\/nope\.js, which does not exist/);
});
test('checkScripts: a script another one loads later does not exist', () => {
  fails((r) => append(r, 'site/js/maps-early.js', "\nvar g = 'js/ghost.js';\n"), /A script loads js\/ghost\.js later, but it does not exist/);
});
test('checkScripts: a js file nothing loads', () => {
  fails((r) => write(r, 'site/js/orphan.js', '// x\n'), /js\/orphan\.js exists but nothing in index\.html loads it/);
});
test('checkScripts: config.js then dom.js come first', () => {
  fails((r) => edit(r, 'site/index.html', '<script src="js/config.js">', '<script src="js/api.js"></script>\n<script src="js/config.js">'),
    /The first two scripts in index\.html are \['js\/api\.js', 'js\/config\.js'\]/);
});
test('checkScripts: config.js first but something else second', () => {
  fails((r) => edit(r, 'site/index.html', '<script src="js/dom.js">', '<script src="js/api.js"></script>\n<script src="js/dom.js">'), /The first two scripts in index\.html are \['js\/config\.js', 'js\/api\.js'\]/);
});
test('checkScripts: dom.js second but something else first', () => {
  fails((r) => edit(r, 'site/index.html', 'src="js/config.js"', 'src="js/api.js"'), /The first two scripts in index\.html are \['js\/api\.js', 'js\/dom\.js'\]/);
});
test('checkScripts: no script in the body is reported as missing', () => {
  fails((r) => write(r, 'site/index.html', read(r, 'site/index.html').replace(/<script src="js\/(?!region)[^"]*"><\/script>\n/g, '')), /The first two scripts in index\.html are missing/);
});
test('checkScripts: boot.js is last', () => {
  fails((r) => edit(r, 'site/index.html', '<script src="js/boot.js"></script>', '<script src="js/boot.js"></script>\n<script src="js/trebuchet.js"></script>'),
    /The last script loaded in order is js\/trebuchet\.js, not js\/boot\.js/);
});

test('checkStyles: index.html links a stylesheet that does not exist', () => {
  fails((r) => edit(r, 'site/index.html', '<head>', '<head><link rel="stylesheet" href="css/nope.css">'), /index\.html links css\/nope\.css, which does not exist/);
});
test('checkStyles: a stylesheet nothing links', () => {
  fails((r) => write(r, 'site/css/orphan.css', 'a{}'), /css\/orphan\.css exists but index\.html does not link it/);
});

test('checkDemoHatch: the word demo in js/', () => {
  fails((r) => append(r, 'site/js/boot.js', '\n// demo\n'), /js\/boot\.js mentions the banner demo hatch/);
});
test('checkDemoHatch: TIMER_OVERRIDE in js/', () => {
  fails((r) => append(r, 'site/js/boot.js', '\nvar TIMER_OVERRIDE = 1;\n'), /js\/boot\.js mentions the banner demo hatch/);
});

test('checkNoticePosition: another element before #teamsNotice', () => {
  fails((r) => edit(r, 'site/index.html', '<body>', '<body><div></div>'), /first element in the body of index\.html is <div>, not the teams notice/);
});
test('checkNoticePosition: no element at all after <body>', () => {
  fails((r) => write(r, 'site/index.html', read(r, 'site/index.html').replace(/<body>[\s\S]*$/, '<body>text')), /body of index\.html is \(no element at all\), not the teams notice/);
});
test('checkNoticePosition: no <body> tag', () => {
  fails((r) => edit(r, 'site/index.html', '<body>', '<bod>'), /No <body> tag in index\.html/);
});

test('checkSitemap: a lastmod that is not a date', () => {
  fails(setLastmod('2026-13-45'), /which is not a YYYY-MM-DD date/);
});
test('checkSitemap: a lastmod with no date shape', () => {
  fails(setLastmod('soon'), /<lastmod>soon<\/lastmod>, which is not a YYYY-MM-DD date/);
});
test('checkSitemap: year 0000 is not a date', () => {
  fails(setLastmod('0000-01-01'), /<lastmod>0000-01-01<\/lastmod>, which is not a YYYY-MM-DD date/);
});
test('checkSitemap: today is not the future, tomorrow is', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'structure-'));
  try {
    fs.mkdirSync(path.join(root, 'site'));
    write(root, 'site/sitemap.xml', '<lastmod>2026-05-10</lastmod>');
    const at = (day) => { const p = []; checkSitemap(p, root, new Date(2026, 4, day, 23, 59)); return p; };
    assert.deepEqual(at(10), []);
    assert.deepEqual(at(11), []);
    assert.equal(at(9).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('checkSitemap: a lastmod in the future', () => {
  fails(setLastmod('2099-01-01'), /claims the page last changed on 2099-01-01, which is in the future/);
});
test('checkSitemap: no lastmod at all is fine', () => {
  const { code, out } = planted((r) => write(r, 'site/sitemap.xml', read(r, 'site/sitemap.xml').replace(LASTMOD, '')));
  assert.equal(code, 0);
  assert.match(out[5], /carries no <lastmod>/);
});

test('checkReadme: a fetched host the README table lacks is reported, not a crash', () => {
  FETCHED['unlisted.example'] = ['https', 'a made-up host'];
  try {
    const { code, out } = main();
    assert.equal(code, 1);
    assert.match(out.join('\n'), /does not list unlisted\.example.*a made-up host/);
  } finally {
    delete FETCHED['unlisted.example'];
  }
});
test('checkReadme: a host row removed from the table', () => {
  fails((r) => edit(r, 'README.md', '| `render.guildwars2.com` |', '| `render.example` |'), /Privacy host table does not list render\.guildwars2\.com/);
});
test('checkReadme: a key the table lists and js/ does not use', () => {
  fails((r) => edit(r, 'README.md', '| `wvw-rail-first` |', '| `wvw-rail-first` | x |\n| `wvw-ghost` |'), /key table lists wvw-ghost, which no file in js\/ uses/);
});
test('checkReadme: a key js/ writes that the table lacks', () => {
  fails((r) => append(r, 'site/js/boot.js', "\nlocalStorage.setItem('wvw-new', 1);\n"), /writes the localStorage key wvw-new but the README\.md Privacy key table does not list it/);
});
test('checkReadme: a key set by index on sessionStorage is read too', () => {
  fails((r) => append(r, 'site/js/boot.js', "\nsessionStorage['wvw-idx'] = 1;\n"), /writes the localStorage key wvw-idx/);
});
test('checkReadme: a key js/ only reads need not be in the table', () => {
  const { code } = planted((r) => append(r, 'site/js/boot.js', "\nlocalStorage.getItem('wvw-read-only');\n"));
  assert.equal(code, 0);
});
test('checkReadme: a key that is not a fixed text', () => {
  fails((r) => append(r, 'site/js/boot.js', '\nlocalStorage.setItem(someFn(), 1);\n'), /js\/boot\.js passes 'someFn\(' as a storage key/);
});
test('checkReadme: a key with a newline in it stays on one annotation line', () => {
  const { out } = planted((r) => append(r, 'site/js/boot.js', "\nlocalStorage.setItem(a\n+b, 1);\n"));
  assert.ok(out.some((l) => l.includes("passes 'a\\n+b' as a storage key")));
  assert.ok(out.every((l) => !l.startsWith('+b')));
});
test('checkReadme: a key assigned by property', () => {
  fails((r) => append(r, 'site/js/boot.js', '\nlocalStorage.foo = 1;\n'), /js\/boot\.js assigns a storage key by property \(localStorage\.foo =\)/);
});

test('checkAppsScriptScopes: the annotation is not on line 2', () => {
  fails((r) => edit(r, 'apps-script/kills/kills.gs', ' * @OnlyCurrentDoc', ' * x'), /apps-script\/kills\/kills\.gs: "@OnlyCurrentDoc" must be the first line/);
});
test('checkAppsScriptScopes: the comment does not open on line 1', () => {
  fails((r) => edit(r, 'apps-script/kills/kills.gs', '/**\n * @OnlyCurrentDoc', '/*\n * @OnlyCurrentDoc'), /kills\.gs: "@OnlyCurrentDoc" must be the first line/);
});
test('checkAppsScriptScopes: the manifest is missing', () => {
  fails((r) => fs.rmSync(path.join(r, 'apps-script/relink-notice/appsscript.json')), /apps-script\/relink-notice\/appsscript\.json: missing or not JSON/);
});
test('checkAppsScriptScopes: the manifest is not JSON', () => {
  fails((r) => write(r, 'apps-script/kills/appsscript.json', '{'), /apps-script\/kills\/appsscript\.json: missing or not JSON/);
});
test('checkAppsScriptScopes: the scopes differ', () => {
  fails((r) => write(r, 'apps-script/kills/appsscript.json', '{"oauthScopes":["a"]}'), /oauthScopes must be exactly \['https:\/\/www\.googleapis\.com\/auth\/spreadsheets\.currentonly', /);
});
