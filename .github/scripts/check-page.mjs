// Loads the page in a real Chrome, with the API and the sheets answered from a
// recording, and fails on anything the browser objects to: an exception, a
// console error, a Content Security Policy violation, a tier that never shows.
//
//   node .github/scripts/check-page.mjs [--chrome PATH]           replay (the check)
//   node .github/scripts/check-page.mjs --record [--chrome PATH]  re-record from the real hosts
//
// Node only, nothing to install: the global WebSocket and fetch drive Chrome
// over the DevTools protocol. Chrome comes from --chrome, $CHROME, or
// google-chrome / chromium on the PATH. The page runs its own JavaScript, so
// a pull request from a stranger runs in CI only, never on a machine you care
// about.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { X509Certificate, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'site');
const RECORDINGS = join(ROOT, '.github', 'scripts', 'check-page', 'recordings.json.gz');
// The only two routes the page reads from /api (site/js/config.js), each with
// its full address fixed here; anything else is never fetched.
const OWN_API = new Map([
  ['/api/kills', 'https://wvwrelink.com/api/kills'],
  ['/api/relink', 'https://wvwrelink.com/api/relink'],
]);
const DEADLINE_MS = 90000;

const argv = process.argv.slice(2);
const RECORD = argv.includes('--record');
const ci = argv.indexOf('--chrome');

const problems = [];
// One line each: page text (an error message, a guild name in a URL) must not
// start a line of its own, where the Actions runner would read "::" as a command.
const problem = text => {
  const line = String(text).replace(/\s+/g, ' ');
  if (!problems.includes(line)) problems.push(line);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Chrome ---------------------------------------------------------------

function findChrome() {
  const given = ci >= 0 ? argv[ci + 1] : process.env.CHROME;
  if (given) return given;
  for (const name of ['google-chrome', 'chromium']) {
    for (const dir of (process.env.PATH || '').split(delimiter)) {
      if (dir && existsSync(join(dir, name))) return join(dir, name);
    }
  }
  return null;
}

// A proxy that re-signs HTTPS (some CI and sandbox networks) needs its CA
// trusted by Chrome; the flag takes the CA's public key hash.
function proxyArgs() {
  const ca = '/root/.ccr/agent-proxy-ca.crt';
  if (!existsSync(ca)) return [];
  const der = new X509Certificate(readFileSync(ca)).publicKey.export({ type: 'spki', format: 'der' });
  return ['--ignore-certificate-errors-spki-list=' + createHash('sha256').update(der).digest('base64')];
}

// ---- The site, served as Cloudflare serves it -----------------------------

// The `/*` block of site/_headers, so the CSP is the one production sends.
function siteHeaders() {
  const out = {};
  let inBlock = false;
  for (const line of readFileSync(join(SITE, '_headers'), 'utf8').split('\n')) {
    if (/^\S/.test(line)) { inBlock = line.trim() === '/*'; continue; }
    const m = inBlock && line.match(/^\s+([A-Za-z-]+):\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  if (!out['Content-Security-Policy']) throw new Error('no Content-Security-Policy under /* in site/_headers');
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8' };

// Every file under site/ is listed once, here; a request only looks its path
// up, so no file path is ever built from what the browser asked for.
function siteFiles() {
  const map = new Map();
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), prefix + e.name + '/');
      else if (e.isFile() && e.name !== '_headers') map.set(prefix + e.name, join(dir, e.name));
    }
  };
  walk(SITE, '/');
  if (map.has('/index.html')) map.set('/', map.get('/index.html'));
  return map;
}

function serve() {
  const headers = siteHeaders();
  const files = siteFiles();
  const server = createServer((req, res) => {
    const file = files.get(req.url.split('?')[0]);
    if (!file) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server)));
}

// ---- Recordings -----------------------------------------------------------

// url -> [status, content-type, body, base64?]
let recordedAt = Date.now();
const recorded = new Map();

function loadRecordings() {
  const data = JSON.parse(gunzipSync(readFileSync(RECORDINGS)).toString('utf8'));
  recordedAt = data.recordedAt;
  for (const [url, e] of Object.entries(data.entries)) recorded.set(url, e);
}

function saveRecordings() {
  const entries = {};
  for (const url of [...recorded.keys()].sort()) entries[url] = recorded.get(url);
  mkdirSync(dirname(RECORDINGS), { recursive: true });
  writeFileSync(RECORDINGS, gzipSync(JSON.stringify({ recordedAt, entries }), { level: 9 }));
}

function remember(url, status, type, bytes) {
  const text = bytes.toString('utf8');
  const plain = Buffer.from(text, 'utf8').equals(bytes);
  recorded.set(url, [status, type, plain ? text : bytes.toString('base64'), !plain]);
}

const bodyOf = e => Buffer.from(e[2], e[3] ? 'base64' : 'utf8');

// How many tiers each region should show: the matches the recording holds.
function expectedTiers() {
  const e = recorded.get('https://api.guildwars2.com/v2/wvw/matches?ids=all');
  if (!e) return null;
  try {
    const ids = JSON.parse(bodyOf(e).toString('utf8')).map(m => String(m.id));
    return { NA: ids.filter(i => i.startsWith('1-')).length, EU: ids.filter(i => i.startsWith('2-')).length };
  } catch { return null; }
}

// 1x1 transparent PNG: guild emblems and icons, which only need to decode.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// ---- The clock ------------------------------------------------------------

// Recorded matches age: "live", the relink banner and the stale-fight cutoff
// all read Date.now(). So the page's clock starts at the moment of the
// recording and runs normally from there. Date.parse and new Date(x) stay real.
const clockShim = anchor => `(() => {
  const Real = Date, off = ${anchor} - Real.now();
  const now = () => Real.now() + off;
  globalThis.Date = new Proxy(Real, {
    construct: (t, a, nt) => Reflect.construct(t, a.length ? a : [now()], nt),
    apply: () => new Real(now()).toString(),
    get: (t, p) => (p === 'now' ? now : Reflect.get(t, p, t)),
  });
})();`;

// ---- The run --------------------------------------------------------------

const chromePath = findChrome();
if (!chromePath) {
  console.error('check-page: no Chrome found. Pass --chrome PATH, set CHROME, or put google-chrome or chromium on the PATH.');
  process.exit(2);
}
const ver = spawnSync(chromePath, ['--version'], { encoding: 'utf8' });
if (ver.error || ver.status !== 0) {
  console.error(`check-page: cannot run Chrome at ${chromePath}: ${ver.error ? ver.error.message : 'exit ' + ver.status}`);
  process.exit(2);
}
console.log(`Chrome: ${ver.stdout.trim()} (${chromePath})`);
if (!RECORD) {
  if (!existsSync(RECORDINGS)) { console.error('check-page: no recordings; run with --record first.'); process.exit(2); }
  loadRecordings();
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'check-page-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--window-size=1280,900',
  ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),   // root only: a container or CI, never a desktop
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...proxyArgs(), 'about:blank',
], { stdio: 'ignore' });

let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try { chrome.kill('SIGKILL'); } catch {}
  server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
let seen = 'no tier counts read';
setTimeout(() => {
  problem(`timeout: the page did not finish within ${DEADLINE_MS / 1000} s (${seen})`);
  report();
}, DEADLINE_MS).unref();

function report() {
  if (problems.length) {
    console.log(`check-page: ${problems.length} problem(s)`);
    for (const p of problems) console.log('  ' + p);
    return finish(1);
  }
  finish(0);
}

try {
  await main();
} catch (e) {
  problem('check-page: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
  report();
}

async function main() {
  // DevTools picked a port itself; it says which in the profile directory.
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    const f = join(profile, 'DevToolsActivePort');
    if (existsSync(f)) port = readFileSync(f, 'utf8').split('\n')[0];
    else await sleep(100);
  }
  if (!port) throw new Error('Chrome did not open its DevTools port');
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('Chrome has no page to drive');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', () => no(new Error('DevTools connection failed'))); });

  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((ok, no) => {
    const n = ++id;
    pending.set(n, msg => (msg.error ? no(new Error(`${method}: ${msg.error.message}`)) : ok(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  const BLOCKED = /goatcounter|cloudflareinsights/;
  const EXTERNAL = /^https:\/\/(api\.guildwars2\.com|docs\.google\.com)\//;
  const ids = new Set();            // in-flight requests, for "the page has gone quiet"
  const origin = new Map();         // networkId -> first URL of a redirect chain

  const reply = (requestId, status, type, body) => send('Fetch.fulfillRequest', {
    requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: type || 'application/octet-stream' },
      { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Cache-Control', value: 'no-store' }],
    body: body.toString('base64'),
  });

  async function paused(p) {
    const { requestId, request, networkId } = p;
    const url = request.url;
    const isApi = url.startsWith(base + '/api/');
    const own = isApi ? OWN_API.get(url.slice(base.length)) : null;
    try {
      if (isApi && !own) {
        problem(`unknown /api route, not fetched: ${url}`);
        return await send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      }
      if (request.method === 'OPTIONS') return await send('Fetch.fulfillRequest', { requestId, responseCode: 204,
        responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' }] });
      if (BLOCKED.test(url)) return await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      if (url.startsWith('https://render.guildwars2.com/')) return await reply(requestId, 200, 'image/png', PNG);
      if (p.responseStatusCode !== undefined || p.responseErrorReason) return await responded(p, networkId, url);
      if (own || EXTERNAL.test(url)) {
        const key = own || url;
        if (RECORD && own) {
          const res = await fetch(own);
          const bytes = Buffer.from(await res.arrayBuffer());
          remember(own, res.status, res.headers.get('content-type') || '', bytes);
          return await reply(requestId, res.status, res.headers.get('content-type') || '', bytes);
        }
        if (RECORD) return await send('Fetch.continueRequest', { requestId });
        const hit = recorded.get(key);
        if (!hit) {
          problem(`not recorded: ${key} - re-record with --record`);
          return await send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        }
        return await reply(requestId, hit[0], hit[1], bodyOf(hit));
      }
      if (url.startsWith(base + '/') || url.startsWith('data:') || url.startsWith('blob:')) return await send('Fetch.continueRequest', { requestId });
      problem(`unexpected host, blocked: ${url}`);
      await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } catch (e) {
      problem(`check-page: while answering ${url}: ${e.message}`);
    }
  }

  // Record mode, response stage: the answer is read where it arrives. A
  // redirect hop is passed on, and the final answer is kept under the URL the
  // page asked for.
  async function responded(p, networkId, url) {
    const { requestId } = p;
    const first = origin.get(networkId) || url;
    origin.set(networkId, first);
    const status = p.responseStatusCode;
    if (p.responseErrorReason || (status >= 300 && status < 400)) {
      return await send(p.responseErrorReason ? 'Fetch.failRequest' : 'Fetch.continueResponse',
        p.responseErrorReason ? { requestId, errorReason: p.responseErrorReason } : { requestId });
    }
    const { body, base64Encoded } = await send('Fetch.getResponseBody', { requestId });
    const type = (p.responseHeaders || []).find(h => h.name.toLowerCase() === 'content-type');
    remember(first, status, type ? type.value : '', Buffer.from(body, base64Encoded ? 'base64' : 'utf8'));
    await send('Fetch.continueResponse', { requestId });
  }

  let loaded = false;
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) {
      const cb = pending.get(msg.id);
      if (typeof cb !== 'function') return;
      pending.delete(msg.id);
      return cb(msg);
    }
    const p = msg.params || {};
    switch (msg.method) {
      case 'Fetch.requestPaused': paused(p); break;
      case 'Network.requestWillBeSent': ids.add(p.requestId); break;
      case 'Network.loadingFinished': case 'Network.loadingFailed': ids.delete(p.requestId); break;
      case 'Page.loadEventFired': loaded = true; break;
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails;
        problem('exception: ' + (d.exception?.description || d.text).split('\n')[0] + (d.url ? ` (${d.url}:${d.lineNumber + 1})` : ''));
        break;
      }
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error') problem('console.error: ' + p.args.map(a => a.value ?? a.description).join(' '));
        break;
      case 'Log.entryAdded': {
        const e = p.entry;
        if (e.level === 'error' && !BLOCKED.test(e.url || '') && !BLOCKED.test(e.text)) {
          problem(`log error (${e.source}): ${e.text}${e.url ? ' ' + e.url : ''}`);
        }
        break;
      }
      case 'Audits.issueAdded': {
        const i = p.issue;
        if (i.code === 'ContentSecurityPolicyIssue') {
          const d = i.details.contentSecurityPolicyIssueDetails;
          problem(`CSP violation: ${d.violatedDirective} blocked ${d.blockedURL || d.violatedDirective}`);
        }
        break;
      }
    }
  });

  for (const d of ['Runtime', 'Log', 'Page', 'Network', 'Audits']) await send(d + '.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' },
    ...(RECORD ? [{ urlPattern: 'https://api.guildwars2.com/*', requestStage: 'Response' },
      { urlPattern: 'https://docs.google.com/*', requestStage: 'Response' }] : [])] });
  if (!RECORD) await send('Page.addScriptToEvaluateOnNewDocument', { source: clockShim(recordedAt) });
  if (RECORD) recordedAt = Date.now();
  await send('Page.navigate', { url: base + '/' });

  // The walk: load, then wait for every tier of both regions.
  const probe = `JSON.stringify({
    NA: document.querySelectorAll('#standingsGridNA > .standing-match').length,
    EU: document.querySelectorAll('#standingsGridEU > .standing-match').length })`;
  let want = null, got = null, quiet = 0;
  while (true) {
    await sleep(100);
    want = expectedTiers();
    got = JSON.parse((await send('Runtime.evaluate', { expression: probe, returnByValue: true })).result.value);
    seen = `tiers shown: NA ${got.NA}/${want ? want.NA : '?'}, EU ${got.EU}/${want ? want.EU : '?'}; ${ids.size} request(s) in flight`;
    const tiersUp = want && want.NA > 0 && want.EU > 0 && got.NA >= want.NA && got.EU >= want.EU;
    // Tiers up, then nothing in flight on two looks in a row: late requests
    // and late exceptions get their chance to show.
    // A page that threw and then went quiet is not going to recover: say so now, not at 90 s.
    quiet = loaded && ids.size === 0 && (tiersUp || problems.length) ? quiet + 1 : 0;
    if (quiet >= 3) break;
  }

  if (RECORD) {
    if (!problems.length) {
      saveRecordings();
      console.log(`recorded ${recorded.size} responses (${statSync(RECORDINGS).size} bytes gzipped) at ${new Date(recordedAt).toISOString()}`);
    }
  } else {
    console.log(`tiers: NA ${got.NA}/${want.NA}, EU ${got.EU}/${want.EU}`);
  }
  report();
}
