// scripts/check-site.mjs with the site, the old Pages address and the registry made up: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, imagePaths, cspWritten, makeFetch, SITE, OLD_PAGES, RDAP, ROOT } from '../../../scripts/check-site.mjs';
import { fakeFetch, fakeSleep, lines, errors } from './fake-http.mjs';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY = 86400e3;
const CSP = cspWritten(ROOT);
const HTML = `<link rel="canonical" href="x"><link rel="icon" href="assets/i.png"><link rel="stylesheet" href="/css/a.css">
<img src="assets/a.webp"><script src="js/boot.js"></script><script src="/js/two.js" async></script>`;
const expiry = (days, at = NOW + days * DAY) => ({ events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: new Date(at).toISOString() }] });

// The site as it is served today; `plan` changes it.
function world(plan = {}) {
  const files = { 'js/boot.js': "load('js/late.js')", 'js/two.js': '', 'js/late.js': '', 'css/a.css': '', 'assets/a.webp': 'x', 'assets/i.png': 'x', ...plan.files };
  return (url) => {
    if (plan.down?.[url]) return plan.down[url];
    if (url === SITE) return { body: plan.html ?? HTML, headers: plan.csp === null ? {} : { 'Content-Security-Policy': plan.csp ?? CSP } };
    if (url === OLD_PAGES && plan.oldThrows) throw new TypeError('fetch failed');
    if (url === OLD_PAGES) return plan.old ?? { status: 404 };
    if (url === RDAP) return { body: plan.rdap ?? expiry(305) };
    const file = files[url.slice(SITE.length)];
    return file === undefined ? { status: 404 } : { body: file };
  };
}
async function run(plan) {
  const fetchFn = fakeFetch(world(plan));
  const result = await main({ fetchFn, sleep: fakeSleep(), now: () => NOW, root: ROOT });
  return { ...result, log: lines(result), asked: fetchFn.asked };
}
const red = async (plan, pattern, count = 1) => {
  const r = await run(plan);
  assert.equal(r.code, 1, r.log);
  assert.equal(errors(r).length, count, r.log);
  assert.match(r.log, pattern);
  return r;
};

test('the site as it should be: green, each fact noted', async () => {
  const r = await run({});
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /^https:\/\/wvwrelink\.com\/ +HTTP 200, 0 KB$/m);
  assert.match(r.log, /^Content-Security-Policy +as written in _headers$/m);
  assert.match(r.log, /^scripts and stylesheets +all 4 served$/m);
  assert.match(r.log, /^images in the HTML +all 2 served$/m);
  assert.ok(r.out.includes(`${'old GitHub Pages address'.padEnd(46)} HTTP 404`), r.log);
  assert.match(r.log, /^old GitHub Pages address +HTTP 404$/m);
  assert.match(r.log, /^domain expires +2027-09-24, 305 days left$/m);
  assert.ok(r.out.at(-1).startsWith('The site answers, and serves every script'));
});

test('the size counts characters, in whole KB', async () => {
  const r = await run({ html: HTML + '<!-- ' + '😀'.repeat(2500) + ' -->' });
  assert.match(r.log, /HTTP 200, 2 KB/);
});

test('a site that does not answer is one line and no summary: the rest is not asked', async () => {
  const r = await run({ down: { [SITE]: { status: 502 } } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, ['::error::https://wvwrelink.com/ did not answer (HTTP 502 after 3 attempts). The site is down, or DNS or the certificate is broken.']);
  assert.equal(r.asked.length, 3);
});

test('a script that names a late script inside a stylesheet is not followed: only scripts name scripts', async () => {
  const r = await run({ files: { 'css/a.css': "x { background: url('js/ghost.js') }" } });
  assert.ok(!r.asked.some((a) => a.includes('ghost')));
});

test('the policy is compared without the blanks around it, as the header comes', async () => {
  const answer = world({});
  const fetchFn = async (url, init) => {
    if (url !== SITE) return new Response('', { status: 200 });
    return { ok: true, status: 200, headers: { get: () => `  ${CSP}  ` }, text: async () => HTML, body: null };
  };
  const r = await main({ fetchFn: (url, init) => (url === SITE ? fetchFn(url, init) : fakeFetch(answer)(url, init)), sleep: fakeSleep(), now: () => NOW, root: ROOT });
  assert.equal(r.code, 0, lines(r));
});

test('a connection that breaks with a message that carries a newline cannot start a command', async () => {
  const r = await main({ fetchFn: async () => { throw new TypeError('x\n::error::y'); }, sleep: fakeSleep(), root: ROOT });
  assert.equal(r.out.length, 1);
  assert.ok(r.out[0].includes('x%0A::error::y'));
});

test('a page that is not this site: red for each missing marker', async () => {
  await red({ html: HTML.replace('rel="canonical"', 'rel="x"') }, /does not contain the canonical link/);
  await red({ html: HTML.replace('js/boot.js', 'js/b.js'), files: { 'js/b.js': '' } }, /does not contain the script that starts the page/);
});

test('the policy: absent, different and padded', async () => {
  await red({ csp: null }, /served with no Content-Security-Policy header/);
  await red({ csp: CSP + '; x' }, /^::error::The served Content-Security-Policy is not the one in site\/_headers\. Served: .*; x$/m);
  const r = await run({ csp: `  ${CSP}  ` });
  assert.equal(r.code, 0, r.log);
});

test('the policy written is the one of the /* rule in a planted _headers', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  fs.mkdirSync(path.join(root, 'site'));
  fs.writeFileSync(path.join(root, 'site', '_headers'), '# c\n/other\n  Content-Security-Policy: no\n\n/*\n  X-A: 1\n  content-security-policy:  yes ; ok \n');
  assert.equal(cspWritten(root), 'yes ; ok');
  fs.writeFileSync(path.join(root, 'site', '_headers'), '/*\n# a note\n  Content-Security-Policy: kept\n');
  assert.equal(cspWritten(root), 'kept');
  fs.writeFileSync(path.join(root, 'site', '_headers'), '/*\n  X-A: 1\n');
  assert.equal(cspWritten(root), null);
  fs.rmSync(root, { recursive: true });
});

test('a page with no scripts or stylesheets: red', async () => {
  await red({ html: '<link rel="canonical"> js/boot.js' }, /No scripts or stylesheets found in the served HTML/);
});

test('a script, a stylesheet, a late script or an image that is not served: red, all named in one line', async () => {
  const r = await run({ files: { 'js/two.js': undefined, 'css/a.css': undefined, 'js/late.js': undefined, 'assets/a.webp': undefined } });
  assert.equal(r.code, 1, r.log);
  assert.equal(errors(r).length, 1);
  assert.match(r.log, /asks for 4 file\(s\) the site does not serve: \/js\/two\.js \(HTTP 404 after 3 attempts\), \/css\/a\.css \(.*\), js\/late\.js \(.*\), assets\/a\.webp \(/);
});

test('a script that loads another by a quoted path: the other is fetched once, down a chain', async () => {
  const r = await run({ files: { 'js/boot.js': "a('js/late.js'); b('js/late.js'); c(\"js/ghost.js\")", 'js/late.js': "'js/deep-é.js'", 'js/deep-é.js': '' } });
  assert.equal(r.code, 0, r.log);
  assert.equal(r.asked.filter((a) => a.endsWith('/js/late.js')).length, 1);
  assert.ok(r.asked.includes('GET https://wvwrelink.com/js/deep-é.js'));
  assert.ok(!r.asked.some((a) => a.includes('ghost')));
  assert.match(r.log, /all 5 served/);
});

test('a late script a served script names that is not served: red', async () => {
  await red({ files: { 'js/late.js': "'js/deep.js'" } }, /js\/deep\.js \(HTTP 404/);
});

test('a script already in the HTML is not fetched again when another names it', async () => {
  const r = await run({ files: { 'js/boot.js': "'js/two.js'" } });
  assert.equal(r.asked.filter((a) => a.endsWith('/js/two.js')).length, 1);
});

test('images are the <img> and the icon links on this origin, each once, no other origin', () => {
  const html = `<link rel="icon" href="assets/favicon-192.png"><link rel="icon" href="favicon.ico">
    <link rel="stylesheet" href="css/base.css"><link rel="preconnect" href="https://render.guildwars2.com">
    <img src="assets/treb-arm.webp" alt=""><img class="x" src="assets/treb-arm.webp">
    <img src="https://example.com/a.png"><script src="js/a.js"></script>`;
  assert.deepEqual(imagePaths(html), ['assets/favicon-192.png', 'assets/treb-arm.webp', 'favicon.ico']);
});

test('main sends a HEAD for each image and goes red when one is not served', async () => {
  const r = await red({ files: { 'assets/a.webp': undefined } }, /assets\/a\.webp/);
  assert.ok(r.asked.includes('HEAD https://wvwrelink.com/assets/a.webp'), r.asked.join('\n'));
  assert.ok(r.asked.includes('HEAD https://wvwrelink.com/assets/i.png'));
});

test('a request is tried three times with a pause between, and a connection that breaks is told', async () => {
  const sleep = fakeSleep();
  const http = makeFetch({ fetchFn: async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); }, sleep });
  assert.deepEqual(await http.get('https://x/'), [null, null, 'TypeError: fetch failed (ENOTFOUND) after 3 attempts', null]);
  assert.deepEqual(sleep.slept, [5, 5]);
  assert.equal(await http.statusOf('https://x/'), null);
});

test('the old Pages address: 200 is red, anything else a note, a silent one too', async () => {
  await red({ old: { status: 200 } }, /answers 200: GitHub Pages is publishing the repository again/);
  const r = await run({ old: { status: 500 } });
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /old GitHub Pages address +HTTP 500/);
  const r2 = await run({ oldThrows: true });
  assert.equal(r2.code, 0, r2.log);
  assert.match(r2.log, /old GitHub Pages address +HTTP None$/m);
});

test('the old Pages address is looked at once, with no retry', async () => {
  const r = await run({ old: { status: 500 } });
  assert.equal(r.asked.filter((a) => a.endsWith('github.io/wvw-relink-checker/')).length, 1);
});

test('the registry: unreadable in each way gives one problem naming why', async () => {
  await red({ down: { [RDAP]: { status: 500 } } }, /Could not read when wvwrelink\.com expires from .* \(HTTP 500 after 3 attempts\)\./);
  await red({ rdap: 'nope' }, /\(no expiration event\)\./);
  await red({ rdap: {} }, /\(no expiration event\)\./);
  await red({ rdap: { events: [{ eventAction: 'expiration' }] } }, /\(no expiration event\)\./);
  await red({ rdap: { events: [{ eventAction: 'expiration', eventDate: 'soon' }] } }, /\(no expiration event\)\./);
});

test('only the expiration event gives the date, wherever it stands among the others', async () => {
  const r = await run({ rdap: { events: [expiry(300).events[1], { eventAction: 'last changed', eventDate: '2020-01-01T00:00:00Z' }] } });
  assert.match(r.log, /, 300 days left/);
});

test('the last valid expiration event before a broken one is the one read', async () => {
  const r = await run({ rdap: { events: [expiry(300).events[1], { eventAction: 'expiration', eventDate: 'soon' }, expiry(10).events[1]] } });
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /, 300 days left/);
});

test('60 days left is fine, 59 is red, and a past date counts negative days', async () => {
  const ok = await run({ rdap: expiry(60) });
  assert.equal(ok.code, 0, ok.log);
  await red({ rdap: expiry(0, NOW + 60 * DAY - 1000) }, /in 59 days, and auto-renew is off on purpose\. Renew it at Dynadot\./);
  await red({ rdap: expiry(-3) }, /expires on 2026-11-20, in -3 days/);
  await red({ rdap: expiry(0, NOW - 3600e3) }, /in -1 days/);
});

test('the date is the UTC one, and Z or +00:00 read alike', async () => {
  const r = await run({ rdap: { events: [{ eventAction: 'expiration', eventDate: '2027-03-01T23:59:59+00:00' }] } });
  assert.match(r.log, /domain expires +2027-03-01, 98 days left/);
});

test('a problem that carries a quoted text cannot start a workflow command', async () => {
  const r = await red({ html: HTML.replace('js/two.js', 'js/x\ny.js') }, /js\/x%0Ay\.js/);
  assert.ok(!r.out.some((l) => l.startsWith('y.js')));
});
