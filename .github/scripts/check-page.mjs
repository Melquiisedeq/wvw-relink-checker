// Loads the page in a real Chrome, with the API and the sheets answered from a
// recording, walks it as a visitor would (guild search, every map, every icon
// button and popover, the NA/EU swap, a map answered with the same body for
// minutes, what changed hands over such a gap summed up beside the map, the
// board picking what the map lights, the Board, Captures and Objective tabs
// beside it keeping their size, a frozen match answer that must not be painted, a load whose API reads fail and are tried again, then a second load with /api/* down), and
// fails on anything the browser objects to: an exception, a console error, a
// Content Security Policy violation, a step whose element never appears.
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
// The only outside hosts the page may reach; recording fetches from these
// constants, never from an address the page built.
const ORIGINS = {
  'api.guildwars2.com': 'https://api.guildwars2.com',
  'docs.google.com': 'https://docs.google.com',
};

const argv = process.argv.slice(2);
const RECORD = argv.includes('--record');
// A guard against a hang, not a speed bar. In a cloud container on 10/10/2026
// the walk took 129-181 s without the 'map pane' step and 213-282 s with it
// (the step alone 53 s: the board has to be seen standing still), and a
// shared CI machine can be slower. Recording waits on the real hosts.
const DEADLINE_MS = RECORD ? 420000 : 360000;
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
let guilds = [];                  // names the search step types: one per region, picked at record time
const recorded = new Map();

function loadRecordings() {
  const data = JSON.parse(gunzipSync(readFileSync(RECORDINGS)).toString('utf8'));
  recordedAt = data.recordedAt;
  guilds = data.guilds || [];
  for (const [url, e] of Object.entries(data.entries)) recorded.set(url, e);
}

function saveRecordings() {
  const entries = {};
  for (const url of [...recorded.keys()].sort()) entries[url] = recorded.get(url);
  mkdirSync(dirname(RECORDINGS), { recursive: true });
  writeFileSync(RECORDINGS, gzipSync(JSON.stringify({ recordedAt, guilds, entries }), { level: 9 }));
}

// Recording freezes the world at first sight: each URL is fetched once, from
// here, kept, and answered from the keep ever after - so the walk sees what the
// replay will. Live data moves between two fetches of one URL, and a later
// answer would send the page asking for URLs the first never had.
const inFlight = new Map();
function record(url) {
  if (recorded.has(url)) return Promise.resolve();
  if (!inFlight.has(url)) {
    let target = null;
    if ([...OWN_API.values()].includes(url)) target = url;
    else {
      const u = new URL(url);
      if (Object.hasOwn(ORIGINS, u.host)) target = ORIGINS[u.host] + u.pathname + u.search;
    }
    if (!target) return Promise.reject(new Error(`record: host not allowed, not fetched: ${url}`));
    inFlight.set(url, fetch(target).then(async res => {
      remember(url, res.status, res.headers.get('content-type') || '', Buffer.from(await res.arrayBuffer()));
    }));
  }
  return inFlight.get(url);
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
  const Real = Date;
  let off = ${anchor} - Real.now();
  const now = () => Real.now() + off;
  globalThis.__skewClock = ms => { off += ms; };
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
  if (!guilds.length) { console.error('check-page: the recording has no guild names; re-record with --record.'); process.exit(2); }
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
let stepNow = 'load';             // the walk's current step, for the 90 s message
setTimeout(() => {
  problem(`timeout: the page did not finish within ${DEADLINE_MS / 1000} s, in step '${stepNow}' (${seen})`);
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
  // Which step it stopped in: a protocol error says nothing of where.
  problem(`check-page: ${e && e.stack ? e.stack.split('\n')[0] : e}, in step '${stepNow}'`);
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
  const ids = new Map();            // in-flight requests, for "the page has gone quiet"
  let apiDown = false;              // second load: /api/* answers 503
  let apiRefused = 0, sheetReads = 0;
  // url -> { body, served }: answers the steps 'map corners' and 'frozen match'
  // put in place of the recording, filled only from constants and the
  // recording itself.
  const substitutes = new Map();
  // A list of matches by id (the page reads a tier again that way) is answered,
  // when not recorded, from ids=all - the step's substitute, or the recording -
  // filtered to the ids asked, each checked against a fixed pattern.
  const IDS_URL = 'https://api.guildwars2.com/v2/wvw/matches?ids=';
  const ALL_URL = IDS_URL + 'all';
  const isIdsRead = url => url.startsWith(IDS_URL) && url !== ALL_URL;
  const idsAsked = [];              // every such read, in order, for the steps to count
  let gameReads = 0;                // every read of api.guildwars2.com
  // Set by the step 'early actions': the script whose request is kept waiting.
  let holdUrl = null, held = null;
  // Set by the step 'failed load': API reads answered 503 on purpose.
  let failing = null;
  let limited = null;               // set by the step 'guild cache': { re, status } answers that status on purpose
  let limitedReads = 0;
  // /api/latest, the page's second read of the matches: 'down' answers 503 (the
  // walk's default), 'serve' answers `latestBody`, 'hang' never answers.
  let latestMode = 'down', latestBody = null, latestReads = 0;
  let failingLog = null;            // what the step may log errors for, kept past the end of the 503s (the log is late)

  // The hot-map floor is 50 kills in ten minutes and the recording may sit in a
  // lull, so the kills history is served with 200 fewer EBG kills before its
  // newest snapshot: a real fight, for the swords steps to find.
  function withFight(body) {
    try {
      const j = JSON.parse(body.toString('utf8'));
      const newest = Math.max(...j.rows.map(r => r[0]));
      for (const r of j.rows) if (r[0] < newest) r[2] = Math.max(0, r[2] - 200);
      return Buffer.from(JSON.stringify(j));
    } catch { return body; }
  }

  const reply = (requestId, status, type, body) => send('Fetch.fulfillRequest', {
    requestId, responseCode: status,
    responseHeaders: [{ name: 'Content-Type', value: type || 'application/octet-stream' },
      { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Cache-Control', value: 'no-store' }],
    body: body.toString('base64'),
  });

  async function paused(p) {
    const { requestId, request } = p;
    const url = request.url;
    const isApi = url.startsWith(base + '/api/');
    const own = isApi ? OWN_API.get(url.slice(base.length)) : null;
    try {
      if (isApi && url.slice(base.length) === '/api/latest' && request.method !== 'OPTIONS') {
        latestReads++;
        if (latestMode === 'hang') return;   // the page's own deadline ends it
        if (latestMode === 'serve' && !apiDown) return await reply(requestId, 200, 'application/json', latestBody);
        return await reply(requestId, 503, 'application/json', Buffer.from('{"error":"down"}'));
      }
      // The summary the page peeks at: what /api/latest serves, without the
      // bodies; {} when it serves nothing, as the Worker answers when empty.
      if (isApi && url.slice(base.length) === '/api/latest/summary' && request.method !== 'OPTIONS') {
        if (apiDown) return await reply(requestId, 503, 'application/json', Buffer.from('{"error":"down"}'));
        const out = {};
        if (latestMode === 'serve' && latestBody) {
          for (const m of JSON.parse(latestBody.toString('utf8')).matches || []) {
            if (m && typeof m.id === 'string') out[m.id] = { start: m.start, score: m.score, at: m.at, by: m.by };
          }
        }
        return await reply(requestId, 200, 'application/json', Buffer.from(JSON.stringify(out)));
      }
      if (isApi && !own) {
        problem(`unknown /api route, not fetched: ${url}`);
        return await send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      }
      if (request.method === 'OPTIONS') return await send('Fetch.fulfillRequest', { requestId, responseCode: 204,
        responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' }] });
      if (BLOCKED.test(url)) return await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      if (holdUrl && url === holdUrl) { held = requestId; return; }   // released by the step 'early actions'
      if (url.startsWith('https://render.guildwars2.com/')) return await reply(requestId, 200, 'image/png', PNG);
      if (url.startsWith('https://api.guildwars2.com/')) gameReads++;
      if (isIdsRead(url)) idsAsked.push(url);
      const swap = substitutes.get(url);
      if (swap) {
        swap.served++;
        return await reply(requestId, 200, 'application/json; charset=utf-8', swap.body);
      }
      if (limited && limited.re.test(url)) {
        limitedReads++;
        return await send('Fetch.fulfillRequest', { requestId, responseCode: limited.status,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Retry-After', value: '1' },
            { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Cache-Control', value: 'no-store' }],
          body: Buffer.from('{"error":"on purpose"}').toString('base64') });
      }
      if (failing && failing.test(url)) {
        return await reply(requestId, 503, 'application/json', Buffer.from('{"error":"down"}'));
      }
      if (isIdsRead(url) && !recorded.has(url)) {
        const want = url.slice(IDS_URL.length).split(',');
        const allBody = substitutes.get(ALL_URL)?.body || (recorded.has(ALL_URL) ? bodyOf(recorded.get(ALL_URL)) : null);
        if (!want.every(i => /^[12]-[1-9]$/.test(i)) || !allBody) {
          problem(`not answered: ${url} during step '${stepNow}' (${allBody ? 'ids outside 1-1..2-9' : 'ids=all not recorded'})`);
          return await send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        }
        const list = JSON.parse(allBody.toString('utf8')).filter(m => want.includes(m.id));
        return await reply(requestId, 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(list)));
      }
      if (own && apiDown) {
        apiRefused++;
        return await reply(requestId, 503, 'application/json', Buffer.from('{"error":"down"}'));
      }
      if (own || EXTERNAL.test(url)) {
        const key = own || url;
        if (/^https:\/\/docs\.google\.com\//.test(url)) sheetReads++;
        if (RECORD) await record(key);
        const hit = recorded.get(key);
        if (!hit) {
          problem(`not recorded: ${key}${apiDown ? ' (load with /api down)' : ''} during step '${stepNow}' - re-record with --record`);
          return await send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        }
        return await reply(requestId, hit[0], hit[1], key === OWN_API.get('/api/kills') ? withFight(bodyOf(hit)) : bodyOf(hit));
      }
      if (url.startsWith(base + '/') || url.startsWith('data:') || url.startsWith('blob:')) return await send('Fetch.continueRequest', { requestId });
      problem(`unexpected host, blocked: ${url}`);
      await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } catch (e) {
      if (/Invalid InterceptionId/.test(e.message)) return;   // the page gave up on the request first (an abort)
      problem(`check-page: while answering ${url}: ${e.message}`);
    }
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
      case 'Network.requestWillBeSent': ids.set(p.requestId, p.request.url); break;
      // An error answer the page never reads (fetchOwnApi throws on !ok) is not
      // waiting on the network, and Chrome holds its loadingFinished back.
      case 'Network.responseReceived': if (p.response.status >= 400) ids.delete(p.requestId); break;
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
        const refused = (apiDown && /\/api\//.test(e.url || '')) || /\/api\/latest$/.test(e.url || '') || (failingLog && failingLog.test(e.url || ''));   // the 503 we sent on purpose
        if (e.level === 'error' && !refused && !BLOCKED.test(e.url || '') && !BLOCKED.test(e.text)) {
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
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: clockShim(RECORD ? Date.now() : recordedAt) });
  // ---- Driving the page ---------------------------------------------------

  // Evaluate in the page; a throw there is an error here. An evaluation that
  // lands while the page is being replaced (a load the step just started) is
  // asked again on the new document: Chrome answers it "navigated or closed"
  // or with no context, which says nothing about the page. CI lost whole runs
  // to it (PRs #75 and #76, 09/10/2026).
  async function ev(expression) {
    let r;
    for (let tries = 0; ; tries++) {
      try {
        r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        break;
      } catch (e) {
        if (tries >= 40 || !/navigated or closed|context was destroyed|Cannot find context/.test(e.message)) throw e;
        await sleep(50);
      }
    }
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  // Wait for a condition, never for a fixed time. A page that already threw
  // gets less patience: it is not going to recover.
  async function until(name, expr, what) {
    stepNow = name;
    const t0 = Date.now();
    while (true) {
      if (await ev(expr)) return true;
      if (Date.now() - t0 > (problems.length ? 3000 : 15000)) { problem(`step '${name}': ${what} never appeared`); return false; }
      await sleep(25);
    }
  }

  // A visitor's click: scroll the element in, wait until it is the thing under
  // its own centre (so a covering overlay fails the step) and stands at the
  // same place two frames apart, then press and release the mouse there over
  // the protocol, with no finite animation running on it or around it, once
  // the page has seen the pointer over it. Not el.click(): that would fire
  // the handler even where a visitor could not reach the button. The frames,
  // the animations and the pointer: right after a width change the page still
  // moves things on its next frames, and the swap slides its button away; a
  // press made from the first measure landed on a team column instead of the
  // map button, or missed the swap back, about one walk in four (10/10/2026).
  async function click(name, el) {
    stepNow = name;
    // After a guild search the page scrolls to the found team and blinks its
    // card for a moment: wait until it has stopped, never clicking a moving page.
    // The scroll starts with the blink and is over well before it ends.
    await until(name, "!document.querySelector('.guild-found-flash, .guild-found-strip.is-leaving')", 'the page to stop moving');
    const t0 = Date.now();
    let r;
    while (true) {
      r = await ev(`(async () => {
        const look = () => {
          const el = ${el};
          if (!el) return { gone: true };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height) return { hidden: true };
          const x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y);
          return { x, y, hit: !!top && (top === el || el.contains(top)), over: top ? top.tagName + '.' + top.className : 'nothing' };
        };
        const a = look();
        if (!a.hit) return a;
        // A finite animation on the target or around it (the NA/EU swap slides
        // the columns for 650 ms) moves it under a press made from a measure.
        const el = ${el};
        if (document.getAnimations().some(n => n.playState === 'running' && n.effect?.target?.contains?.(el)
          && n.effect.getComputedTiming().endTime !== Infinity)) return { ...a, hit: false, moved: true };
        await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
        const b = look();
        return b.hit && Math.abs(b.x - a.x) < 1 && Math.abs(b.y - a.y) < 1 ? b : { ...b, hit: false, moved: true };
      })()`);
      if (r.hit) {
        // The pointer goes there first, and the page must see it over the
        // target: whatever moved since the measure shows here, not as a
        // press on something else.
        await ev(`(() => { window.__checkPageOver = null; if (!window.__checkPageMoves) { window.__checkPageMoves = true;
          document.addEventListener('pointermove', e => { window.__checkPageOver = e.target; }, true); } return true; })()`);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + 1, y: r.y });
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
        if (await ev(`(() => { const el = ${el}; return !!el && !!window.__checkPageOver && el.contains(window.__checkPageOver); })()`)) break;
        r = { ...r, hit: false, moved: true };
      }
      if (r.gone || r.hidden || Date.now() - t0 > 3000) {
        problem(`step '${name}': ${r.gone ? 'target missing' : r.hidden ? 'target has no size' : r.moved ? 'target still moving' : 'target covered by ' + r.over}`);
        return false;
      }
      await sleep(50);
    }
    const at = { x: r.x, y: r.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
    return true;
  }

  // The target still and where it was a moment ago: a width just changed, or a row moved.
  async function steady(name, el) {
    stepNow = name;
    let last = '';
    for (let i = 0; i < 40; i++) {
      const now = await ev(`(() => { const e = ${el}; if (!e) return ''; const b = e.getBoundingClientRect(); return [b.x, b.y, b.width, b.height].join(); })()`);
      if (now && now === last) return;
      last = now;
      await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    }
  }
  async function press(name, el) { await steady(name, el); return click(name, el); }

  // Nothing in flight on three looks running. A step that moves on while the
  // page is still asking (a popover closed mid-lookup) makes the set of URLs
  // depend on how fast the answers come, and the recording is slower than its replay.
  async function idle(name) {
    stepNow = name;
    const t0 = Date.now();
    for (let quiet = 0; quiet < 3; ) {
      quiet = ids.size === 0 ? quiet + 1 : 0;
      if (Date.now() - t0 > 15000) return void problem(`step '${name}': requests never settled (${[...ids.values()].join(' ').slice(0, 200)})`);
      await sleep(25);
    }
  }

  async function escape() {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
  }

  // Navigate and wait for the page to go quiet with every tier of both regions up.
  async function load(name, during) {
    loaded = false;
    ids.clear();
    await send('Page.navigate', { url: base + '/' });
    if (during) await during();
    let quiet = 0, tiersUp = false;
    while (true) {
      await sleep(100);
      want = expectedTiers();
      got = JSON.parse((await send('Runtime.evaluate', { expression: probe, returnByValue: true })).result.value);
      seen = `${name}: tiers shown: NA ${got.NA}/${want ? want.NA : '?'}, EU ${got.EU}/${want ? want.EU : '?'}; ${ids.size} request(s) in flight${ids.size ? ': ' + [...ids.values()].join(' ').slice(0, 300) : ''}`;
      tiersUp = !!want && want.NA > 0 && want.EU > 0 && got.NA >= want.NA && got.EU >= want.EU;
      // Tiers up, then nothing in flight on two looks in a row: late requests
      // and late exceptions get their chance to show.
      // A page that threw and then went quiet is not going to recover: say so now, not at 90 s.
      quiet = loaded && ids.size === 0 && (tiersUp || problems.length) ? quiet + 1 : 0;
      if (quiet >= 3) break;
    }
    if (!tiersUp) problem(`step '${name}': tiers never appeared (${seen})`);
    return tiersUp;
  }

  const probe = `JSON.stringify({
    NA: document.querySelectorAll('#standingsGridNA > .standing-match').length,
    EU: document.querySelectorAll('#standingsGridEU > .standing-match').length })`;
  let want = null, got = null;
  const clicked = new Set();

  // What each icon button's popover must hold once it has finished loading.
  const POPOVERS = {
    'tier-map-btn': ".info-popover .wvw-plot g[role='button']",
    'server-guilds-btn': '.info-popover .info-popover-body',
    'map-kd-btn': '.info-popover > :nth-child(2)',
    'activity-btn': '.info-popover > :nth-child(2)',
    'activity-info-btn': '.info-popover > :nth-child(2)',
  };
  const BUTTON = i => `document.querySelectorAll('.icon-btn')[${i}]`;
  const NO_POPOVER = "!document.querySelector('.info-popover')";

  async function closePopover(name) {
    if (await ev(NO_POPOVER)) return;
    if (!(await click(name + ' close', "document.querySelector('.info-popover .info-popover-close')"))) return escape();
    await until(name, NO_POPOVER, 'closing popover (it stayed open)');
  }

  // Every tab of an opened tier map, each with its objectives drawn.
  async function mapTabs(name) {
    const types = await ev("[...document.querySelectorAll('.info-popover .wvw-tab')].map(b => b.dataset.type)");
    for (const type of types) {
      const tab = `${name} ${type}`;
      const sel = `.info-popover .wvw-tab[data-type="${type}"]`;
      if (!(await click(tab, `document.querySelector('${sel}')`))) continue;
      await until(tab, `!!document.querySelector('${sel}.is-active') && !!document.querySelector("${POPOVERS['tier-map-btn']}")`,
        'drawn objectives');
      await idle(tab);
    }
  }

  // Every icon button, in page order: open, content, close.
  async function iconButtons() {
    for (let i = 0; i < (await ev("document.querySelectorAll('.icon-btn').length")); i++) {
      const read = await ev(`(() => { const b = ${BUTTON(i)}; return { label: b.getAttribute('aria-label'),
        classes: [...b.classList], shown: !!b.offsetParent }; })()`);
      const info = { label: read.label, shown: read.shown, kind: Object.keys(POPOVERS).find(k => read.classes.includes(k)) };
      if (!info.shown) continue;   // folded away at this width: a visitor cannot press it either
      const name = `${info.kind} '${info.label}'`;
      if (!(await ev(NO_POPOVER))) await closePopover(name);
      if (!(await click(name, BUTTON(i)))) continue;
      clicked.add(info.kind);
      if (!(await until(name, `!!document.querySelector("${POPOVERS[info.kind]}")`, 'popover content'))) { await escape(); continue; }
      await idle(name);
      if (info.kind === 'tier-map-btn') await mapTabs(name);
      await closePopover(name);
    }
    for (const kind of Object.keys(POPOVERS)) {
      if (!clicked.has(kind)) problem(`step 'icon buttons': no visible ${kind} to press`);
    }
  }

  // A relink night (03/10/2026). A normal cycle asks ids=all and nothing else.
  // A partial list is read again for the missing tiers only, by id, and they
  // stay; a gap the second read lacks too keeps the last body seen, or, never
  // seen, a "Waiting on the API" card; a tier missing from both reads with no
  // gap is gone. A tier on last week (the list from both weeks) is read again
  // by id, alone; still old, its card shows where a shared team plays now.
  async function partialLists() {
    const step = 'partial lists';
    const allHit = recorded.get(ALL_URL);
    if (!allHit) return void problem(`step '${step}': ${ALL_URL} not recorded`);
    const all = JSON.parse(bodyOf(allHit).toString('utf8'));
    const rec = new Map(all.map(m => [m.id, m]));
    if (!['1-1', '1-2', '1-3', '1-4'].every(i => rec.has(i)) || rec.size !== all.length) return void problem(`step '${step}': the recording does not hold NA tiers 1 to 4`);
    const json = v => ({ body: Buffer.from(JSON.stringify(v)), served: 0 });
    const cards = `JSON.stringify([...document.querySelectorAll('#standingsGridNA > .standing-match')].map(b => ({
      id: b.dataset.matchId, sides: b.querySelectorAll('.standing-side').length,
      stale: b.querySelectorAll('.standing-stale').length, map: !!b.querySelector('.tier-map-btn'),
      title: b.querySelector('.standing-match-title')?.textContent || '',
      waiting: [...b.querySelectorAll('.standings-waiting')].map(p => p.textContent),
      moved: [...b.querySelectorAll('.standing-moved')].map(e => [e.previousElementSibling?.textContent || '', e.textContent, e.title]) })))`;
    const cycle = async (name) => {
      const at = idsAsked.length, reads = gameReads;
      await ev('loadStandings()');
      await idle(name);
      return { ids: idsAsked.slice(at), game: gameReads - reads, cards: JSON.parse(await ev(cards)) };
    };
    const ids = c => c.map(x => x.id).join(' ');

    // (c) The normal path: the load and a cycle, no read by id.
    if (idsAsked.length) problem(`step '${step}': the first load read again by id: ${idsAsked.join(' ')}`);
    let r = await cycle(step + ': normal cycle');
    if (r.ids.length || r.game !== 1) problem(`step '${step}': a normal cycle read the game's API ${r.game} time(s) (${r.ids.join(' ') || 'no ?ids='}), wanted ids=all once`);

    // (a) ids=all without 1-1 and 1-4; the second read finds them.
    const partial = all.filter(m => m.id !== '1-1' && m.id !== '1-4');
    substitutes.set(ALL_URL, json(partial));
    const both = json([rec.get('1-1'), rec.get('1-4')]);
    substitutes.set(IDS_URL + '1-1,1-4', both);
    r = await cycle(step + ': partial list');
    if (r.ids.length !== 2 || both.served !== 2) problem(`step '${step}': partial list read again ${r.ids.join(' ') || 'nothing'}, wanted ?ids=1-1,1-4 twice`);
    if (ids(r.cards) !== '1-1 1-2 1-3 1-4' || r.cards.some(c => c.sides !== 3)) problem(`step '${step}': partial list left NA cards ${ids(r.cards)}, wanted 1-1 to 1-4 painted`);

    // The second read lacks them too: 1-1 (a gap) keeps its last body, 1-4 goes.
    substitutes.set(IDS_URL + '1-1,1-4', json([]));
    r = await cycle(step + ': partial twice');
    if (ids(r.cards) !== '1-1 1-2 1-3' || r.cards[0].sides !== 3) problem(`step '${step}': partial twice left NA cards ${ids(r.cards)} (tier 1 with ${r.cards[0]?.sides} sides), wanted 1-1 from its last body, 1-2, 1-3`);

    // A gap this page never saw: a waiting card, no map button.
    await ev("newestMatches.delete('1-1'); matchDataCache.delete('1-1')");
    substitutes.set(IDS_URL + '1-1', json([]));
    r = await cycle(step + ': never seen');
    const w = r.cards[0];
    if (ids(r.cards) !== '1-1 1-2 1-3' || w.sides || w.map || w.title !== 'Tier 1' || w.waiting.join('|') !== 'Waiting on the API') {
      problem(`step '${step}': a tier never seen reads ${JSON.stringify(w)} (cards ${ids(r.cards)}), wanted "Tier 1" and "Waiting on the API", no map`);
    }
    substitutes.clear();
    r = await cycle(step + ': restore');
    if (ids(r.cards) !== '1-1 1-2 1-3 1-4') problem(`step '${step}': restored NA cards ${ids(r.cards)}`);

    // (b) Last week's bodies, each holding a team of a tier that is new; the
    // read by id still old. Alone, 1-2 is deduced; 1-2 with 1-4, both stay old.
    const week = 7 * 86400000, iso = t => new Date(t).toISOString().replace('.000Z', 'Z');
    const oldOf = (m, from) => {
      const shared = from.all_worlds.red.find(n => n >= 10000);
      return { shared, body: { ...m, start_time: iso(Date.parse(m.start_time) - week), end_time: iso(Date.parse(m.end_time) - week),
        all_worlds: { ...m.all_worlds, red: m.all_worlds.red.map(n => (n >= 10000 ? shared : n)) } } };
    };
    const nameOf = id => ev(`getTeamName(${JSON.stringify(String(id))})`);
    const old2 = oldOf(rec.get('1-2'), rec.get('1-3')), old4 = oldOf(rec.get('1-4'), rec.get('1-1'));
    const LAST = "Last week's line-up · waiting on the API", LINE = "This week's line-up · scores not in yet";
    const newLine = await Promise.all(['red', 'blue', 'green'].map(c => nameOf(rec.get('1-2').all_worlds[c].find(n => n >= 10000))));

    // (b1) Only 1-2 on last week: its card holds the three teams left over.
    await ev("newestMatches.delete('1-2')");
    substitutes.set(ALL_URL, json(all.map(m => (m.id === '1-2' ? old2.body : m))));
    const stillOld = json([old2.body]);
    substitutes.set(IDS_URL + '1-2', stillOld);
    r = await cycle(step + ': one late tier');
    if (r.ids.length !== 2 || stillOld.served !== 2) problem(`step '${step}': one late tier read again ${r.ids.join(' ') || 'nothing'}, wanted ?ids=1-2 twice and nothing else`);
    const c2 = r.cards.find(c => c.id === '1-2');
    const lineNames = await ev(`JSON.stringify([...document.querySelectorAll('#standingsGridNA > [data-match-id="1-2"] .standing-stale .standing-side-name')].map(e => e.textContent))`);
    if (!c2 || c2.stale !== 3 || c2.sides || c2.map || c2.waiting.join('|') !== LINE || c2.moved.length
      || JSON.parse(lineNames).sort().join('|') !== [...newLine].sort().join('|')) {
      problem(`step '${step}': the only late tier 1-2 reads ${JSON.stringify(c2)} ${lineNames}, wanted ${JSON.stringify(newLine)}, "${LINE}", no "→" and no map`);
    }
    substitutes.clear();
    r = await cycle(step + ': restore');
    if (r.cards.find(c => c.id === '1-2')?.sides !== 3) problem(`step '${step}': the recorded 1-2 did not replace last week's`);

    // (b2) 1-2 and 1-4 on last week: nothing to deduce, both stay old.
    await ev("newestMatches.delete('1-2'); newestMatches.delete('1-4')");
    substitutes.set(ALL_URL, json(all.map(m => (m.id === '1-2' ? old2.body : m.id === '1-4' ? old4.body : m))));
    const stillOld2 = json([old2.body, old4.body]);
    substitutes.set(IDS_URL + '1-2,1-4', stillOld2);
    r = await cycle(step + ': two late tiers');
    if (r.ids.length !== 2 || stillOld2.served !== 2) problem(`step '${step}': two late tiers read again ${r.ids.join(' ') || 'nothing'}, wanted ?ids=1-2,1-4 twice and nothing else`);
    const mark = async (id, shared, tier) => {
      const c = r.cards.find(x => x.id === id), name = await nameOf(shared);
      if (!c || c.stale !== 3 || c.waiting.join('|') !== LAST
        || JSON.stringify(c.moved) !== JSON.stringify([[name, `→ Tier ${tier}`, `This week: Tier ${tier}`]])) {
        problem(`step '${step}': last week's ${id} reads ${JSON.stringify(c)}, wanted three names, "${name}" with "→ Tier ${tier}", and the old line`);
      }
    };
    await mark('1-2', old2.shared, 3);
    await mark('1-4', old4.shared, 1);
    if (r.cards.find(c => c.id === '1-3')?.moved.length) problem(`step '${step}': this week's 1-3 shows a "→ Tier" mark`);
    substitutes.clear();
    r = await cycle(step + ': restore');
    if (r.cards.some(c => c.sides !== 3)) problem(`step '${step}': the recorded tiers did not replace last week's`);

    // (d) The rule itself, on the recorded bodies. Only one late tier and a
    // count that closes give a line-up: two late tiers leave 6 teams with 10
    // ways to split them, three leave 9 with 280, and a table with a team too
    // many or too few breaks the count. The first late tier holds a team of a
    // live one, so a deduced line-up is never just last week's.
    const eu = all.filter(m => m.id.startsWith('2-')).sort((x, y) => x.id.localeCompare(y.id));
    if (eu.length !== 5) problem(`step '${step}': the recording holds ${eu.length} EU tiers, wanted 5`);
    const na = ['1-1', '1-2', '1-3', '1-4'].map(i => rec.get(i));
    const lateOf = (list, late) => list.map(m => {
      if (!late.includes(m.id)) return m;
      const live = list.find(x => !late.includes(x.id));
      return oldOf(m, m.id === late[0] ? live : m).body;
    });
    const cases = [
      ['NA, 1-2 late', lateOf(na, ['1-2']), '1', 4, '1-2'],
      ['NA, 1-2 live but on last week', lateOf(na, ['1-2']).map(m => (m.id === '1-2' ? { ...m, end_time: iso(Date.now() + week) } : m)), '1', 4, '1-2'],
      ['NA, 1-2 and 1-4 late', lateOf(na, ['1-2', '1-4']), '1', 4, null],
      ['NA, three late', lateOf(na, ['1-2', '1-3', '1-4']), '1', 4, null],
      ['NA, all on this week', na, '1', 4, null],
      ['NA, a team too many', lateOf(na, ['1-2']), '1+', 4, null],
      ['NA, a team too few', lateOf(na, ['1-2']), '1-', 4, null],
      ['EU, 2-3 late', lateOf(eu, ['2-3']), '2', 5, '2-3'],
    ];
    for (const [what, list, set, tiers, want] of cases) {
      const got = JSON.parse(await ev(`(() => {
        const list = ${JSON.stringify(list)}, set = ${JSON.stringify(set)}, want = ${JSON.stringify(want || '')};
        const teams = new Set(Object.keys(TEAM_NAMES).filter(id => id.startsWith('1' + set[0])));
        if (set[1] === '+') teams.add('1' + set[0] + '999');
        if (set[1] === '-') {
          const taken = new Set(list.filter(m => m.id !== '1-2').flatMap(m => COLORS.map(c => matchTeamId(m, c))));
          teams.delete([...teams].find(id => !taken.has(id)));
        }
        const line = deduceLineup(list, teams, ${tiers});
        return JSON.stringify(line && { id: line.id, teams: COLORS.map(c => matchTeamId(line, c)).sort() });
      })()`));
      const real = want && rec.get(want);
      const expect = want && { id: want, teams: ['red', 'blue', 'green'].map(c => String(real.all_worlds[c].find(n => n >= 10000))).sort() };
      if (JSON.stringify(got) !== JSON.stringify(expect)) problem(`step '${step}': deduceLineup for ${what} gave ${JSON.stringify(got)}, wanted ${JSON.stringify(expect)}`);
    }
  }

  // Every red/green/blue count of a match times `k`, objective owners moved
  // one colour on: a body behind the real one that, painted, changes the map.
  const ROTATE = { Red: 'Blue', Blue: 'Green', Green: 'Red' };
  const rewind = (v, k, key = '') => {
    if (key === 'worlds' || key === 'all_worlds') return v;
    if (Array.isArray(v)) return v.map(x => rewind(x, k));
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).map(([n, x]) => [n,
      n === 'owner' && Object.hasOwn(ROTATE, x) ? ROTATE[x]
        : ['red', 'green', 'blue'].includes(n) && typeof x === 'number' ? Math.floor(x * k)
          : rewind(x, k, n)]));
  };
  const activity = m => ['kills', 'deaths'].reduce((n, f) => n + Object.values(m[f] || {}).reduce((a, b) => a + b, 0), 0);

  // A tier's maps open, then the same match answered with half its counters
  // (the map pull and ids=all): the map, the standings and the fight log stay,
  // with at most two re-reads each. Then a body from the next week, every
  // counter zero, which must still replace it.
  async function frozenMatch() {
    const step = 'frozen match';
    const label = await ev("document.querySelector('.tier-map-btn')?.getAttribute('aria-label') || ''");
    const t = /\b(NA|EU) Tier (\d+)/.exec(label);
    if (!t) return void problem(`step '${step}': no tier map button to read a match from`);
    const matchId = `${t[1] === 'NA' ? 1 : 2}-${t[2]}`;
    const allUrl = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
    const oneUrl = `https://api.guildwars2.com/v2/wvw/matches?id=${matchId}`;
    const allHit = recorded.get(allUrl), oneHit = recorded.get(oneUrl);
    if (!allHit || !oneHit) return void problem(`step '${step}': ${allHit ? oneUrl : allUrl} not recorded`);
    const all = JSON.parse(bodyOf(allHit).toString('utf8'));
    const one = JSON.parse(bodyOf(oneHit).toString('utf8'));
    if (!(activity(rewind(one, 0.5)) < activity(one))) return void problem(`step '${step}': ${matchId} has no kills to rewind`);
    const withMatch = m => all.map(x => (x.id === matchId ? m : x));

    const mapState = `JSON.stringify({
      owners: [...document.querySelectorAll('.info-popover .wvw-plot [class*="own-"]')].map(e => e.getAttribute('class')),
      board: document.querySelector('.info-popover .wvw-board')?.textContent || '',
      bar: [...document.querySelectorAll('.info-popover .wvw-scorebar-seg')].map(e => e.getAttribute('style')) })`;
    const grid = `document.getElementById('standingsGrid${t[1]}').textContent`;
    // Every reading the fight log holds for this match, as one total each.
    const fightLog = `(JSON.parse(localStorage.getItem('wvw-fight-v1') || '{}')['${matchId}'] || [])
      .map(s => Object.values(s.n).reduce((a, b) => a + b, 0))`;
    const openMap = async (name) => {
      if (!(await click(name, "document.querySelector('.tier-map-btn')"))) return false;
      const ok = await until(name, `!!document.querySelector("${POPOVERS['tier-map-btn']}")`, 'drawn objectives');
      await idle(name);
      return ok;
    };

    if (!(await openMap(step + ': open'))) return;
    const mapBefore = await ev(mapState);
    await closePopover(step);
    // The map pulls left newer bodies than the recorded ids=all: a refresh
    // first, so the standings show what this page already knows.
    await ev('loadStandings()');
    await idle(step);
    const gridBefore = await ev(grid);
    // Older than the log's one-minute gap, so a frozen reading would be kept.
    await ev(`(() => { const log = JSON.parse(localStorage.getItem('wvw-fight-v1') || '{}');
      for (const s of log['${matchId}'] || []) s.at -= 120000;
      localStorage.setItem('wvw-fight-v1', JSON.stringify(log)); })()`);
    const logBefore = await ev(fightLog);

    const frozenOne = { body: Buffer.from(JSON.stringify(rewind(one, 0.5))), served: 0 };
    const frozenAll = { body: Buffer.from(JSON.stringify(withMatch(rewind(one, 0.5)))), served: 0 };
    substitutes.set(oneUrl, frozenOne);
    substitutes.set(allUrl, frozenAll);
    if (await openMap(step + ': reopen')) {
      if (await ev(mapState) !== mapBefore) problem(`step '${step}': the map repainted from the frozen answer`);
      await closePopover(step);
    }
    const idsBefore = idsAsked.length;
    await ev('loadStandings()');
    await idle(step);
    if (await ev(grid) !== gridBefore) problem(`step '${step}': the standings repainted from the frozen answer`);
    const logAfter = await ev(fightLog);
    if (logAfter.some(n => n < Math.max(...logBefore, 0))) problem(`step '${step}': the fight log took a frozen reading (${logAfter.join(' ')})`);
    if (frozenOne.served < 1 || frozenOne.served - 1 > 2) problem(`step '${step}': map pull asked ${frozenOne.served} time(s), wanted 1 and at most 2 re-reads`);
    // The list is read again only for its ids that need it, answered frozen too (from the substitute ids=all).
    const reread = idsAsked.slice(idsBefore);
    if (frozenAll.served !== 1 || reread.length < 1 || reread.length > 2
      || reread.some(u => !u.slice(IDS_URL.length).split(',').includes(matchId))) {
      problem(`step '${step}': ids=all asked ${frozenAll.served} time(s), then ${reread.length} re-read(s) ${reread.join(' ')}; wanted 1, then 1 or 2 by id holding ${matchId}`);
    }

    const end = Date.parse(one.end_time);
    if (!Number.isFinite(end)) return void problem(`step '${step}': ${matchId} has no end_time`);
    const nextWeek = { ...rewind(one, 0), start_time: new Date(end).toISOString().replace('.000Z', 'Z'),
      end_time: new Date(end + 7 * 86400000).toISOString().replace('.000Z', 'Z') };
    substitutes.delete(oneUrl);
    substitutes.set(allUrl, { body: Buffer.from(JSON.stringify(withMatch(nextWeek))), served: 0 });
    await ev('loadStandings()');
    await idle(step + ': next week');
    if (await ev(`matchDataCache.get('${matchId}')?.start_time`) !== nextWeek.start_time) {
      problem(`step '${step}': a body from the next week did not replace the kept one`);
    }
    substitutes.clear();
  }

  // The first hours of a week: every side on 0 VP is tied with the others, so no
  // arrow and no bar says who moves; one kill and no deaths has no ratio, so K/D
  // is a dash and nobody is underlined. A tier left as recorded keeps its arrows.
  async function freshWeek() {
    const step = 'fresh week';
    const label = await ev("document.querySelector('.tier-map-btn')?.getAttribute('aria-label') || ''");
    const t = /\b(NA|EU) Tier (\d+)/.exec(label);
    if (!t) return void problem(`step '${step}': no tier map button to read a match from`);
    const matchId = `${t[1] === 'NA' ? 1 : 2}-${t[2]}`;
    const allUrl = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
    const allHit = recorded.get(allUrl);
    if (!allHit) return void problem(`step '${step}': ${allUrl} not recorded`);
    const all = JSON.parse(bodyOf(allHit).toString('utf8'));
    const fresh = all.find(x => x.id === matchId);
    if (!fresh) return void problem(`step '${step}': ${matchId} not in ids=all`);
    const other = all.find(x => x.id.startsWith(matchId[0] + '-') && x.id !== matchId
      && new Set(Object.values(x.victory_points)).size === 3);
    if (!other) return void problem(`step '${step}': no other ${t[1]} tier with three different VP`);
    const body = { ...fresh, start_time: new Date().toISOString(),
      victory_points: { red: 0, green: 0, blue: 0 },
      kills: { red: 1, green: 0, blue: 0 }, deaths: { red: 0, green: 0, blue: 0 } };
    substitutes.set(allUrl, { body: Buffer.from(JSON.stringify(all.map(x => (x.id === matchId ? body : x)))), served: 0 });
    await ev('loadStandings()');
    await idle(step);
    // Every card of the region in one read, picked by id here: nothing read is built into code.
    const grid = t[1] === 'NA' ? '#standingsGridNA' : '#standingsGridEU';
    const cards = await ev(`Object.fromEntries([...document.querySelectorAll('${grid} .standing-match')].map(box => {
      const kd = [...box.querySelectorAll('.standing-side-stats')].map(l => [...l.querySelectorAll('.stat-value')].pop());
      return [box.dataset.matchId, { sides: box.querySelectorAll('.standing-side').length,
        arrows: box.querySelectorAll('.movement-up, .movement-down, .movement-bar').length,
        tied: [...box.querySelectorAll('.movement-tied')].map(e => e.title),
        kd: kd.map(e => e.textContent.trim()), kdLeaders: kd.filter(e => e.classList.contains('stat-leader')).length,
        kdColoured: kd.filter(e => e.classList.contains('kd-good') || e.classList.contains('kd-bad')).length }];
    }))`) || {};
    const a = cards[matchId] || null, b = cards[other.id] || null;
    if (!a || a.sides !== 3) problem(`step '${step}': ${matchId} has no card with three sides`);
    else {
      if (a.arrows) problem(`step '${step}': ${matchId} on 0-0-0 VP still shows ${a.arrows} arrow(s) or bar(s)`);
      if (a.tied.length !== 3 || a.tied.some(x => x !== 'Tied on VP')) problem(`step '${step}': ${matchId} tied sides read ${JSON.stringify(a.tied)}, wanted three "Tied on VP"`);
      if (a.kd.some(x => !x.startsWith('\u2013'))) problem(`step '${step}': ${matchId} K/D reads ${JSON.stringify(a.kd)}, wanted a dash with no deaths`);
      if (a.kdLeaders) problem(`step '${step}': ${matchId} underlines a K/D leader with no deaths anywhere`);
      if (a.kdColoured) problem(`step '${step}': ${matchId} colours a dash as good or bad K/D`);
    }
    if (!b || !b.arrows || b.tied.length) problem(`step '${step}': ${other.id}, left as recorded, lost its arrows (${JSON.stringify(b)})`);
    // No reload to the recorded body: the page keeps a later start_time over an earlier one.
    substitutes.clear();
  }

  // The Check on a relink day: the same team in last week's tier (read last in
  // the list) and this week's must land on this week's; a team whose match the
  // API does not hold yet (?world= answers another team's) gets a grey dot and
  // a note, and no wrong pair is kept, so a second Check finds it once the API
  // answers right. The guilds are the recorded two; their teams come from the
  // recorded guild tables, the second one moved to a team no match holds.
  async function mixedWeeks() {
    const step = 'mixed weeks check';
    const allUrl = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
    const allHit = recorded.get(allUrl);
    if (!allHit || guilds.length < 2) return void problem(`step '${step}': ${allUrl} or the two guild names not recorded`);
    const all = JSON.parse(bodyOf(allHit).toString('utf8'));
    const tables = {};
    for (const r of ['na', 'eu']) {
      const hit = recorded.get(`https://api.guildwars2.com/v2/wvw/guilds/${r}`);
      if (!hit) return void problem(`step '${step}': wvw/guilds/${r} not recorded`);
      tables[r] = { url: `https://api.guildwars2.com/v2/wvw/guilds/${r}`, body: JSON.parse(bodyOf(hit).toString('utf8')) };
    }
    const where = [];
    for (const name of guilds.slice(0, 2)) {
      const hit = recorded.get(`https://api.guildwars2.com/v2/guild/search?name=${encodeURIComponent(name)}`);
      const gid = hit && JSON.parse(bodyOf(hit).toString('utf8'))[0];
      const r = ['na', 'eu'].find(x => gid && Object.hasOwn(tables[x].body, gid));
      if (!r) return void problem(`step '${step}': ${name} is in neither recorded guild table`);
      where.push({ gid, r });
    }
    const T = String(tables[where[0].r].body[where[0].gid]);
    const holds = (m, t) => Object.values(m.all_worlds).some(l => l.map(String).includes(String(t)));
    const colorOf = (m, t) => ['red', 'blue', 'green'].find(c => m.all_worlds[c].map(String).includes(String(t)));
    const fresh = all.find(m => holds(m, T));
    const other = all.find(m => m.id !== fresh?.id && m.id.startsWith('1-') === where[1].r.startsWith('n'));
    if (!fresh || !other) return void problem(`step '${step}': no match holds team ${T}, or no second match to borrow`);
    const MISSING = '99999';
    const week = 7 * 86400000, iso = t => new Date(t).toISOString().replace('.000Z', 'Z');
    const rot = { red: 'blue', blue: 'green', green: 'red' };
    const old = { ...fresh, id: fresh.id.replace(/-\d+$/, '-9'),
      start_time: iso(Date.parse(fresh.start_time) - week), end_time: iso(Date.parse(fresh.end_time) - week),
      all_worlds: Object.fromEntries(Object.entries(fresh.all_worlds).map(([c, l]) => [rot[c], l])) };
    if (colorOf(old, T) === colorOf(fresh, T)) return void problem(`step '${step}': the old tier could not be given another side`);
    const moved = JSON.parse(JSON.stringify(tables[where[1].r].body));
    moved[where[1].gid] = typeof moved[where[1].gid] === 'string' ? MISSING : Number(MISSING);
    const worldUrl = `https://api.guildwars2.com/v2/wvw/matches?world=${MISSING}`;
    const rows = `JSON.stringify([...document.querySelectorAll('#resultBody tr')].map(tr => {
      const d = tr.querySelector('.dot'); return d ? { cls: d.className, title: d.title } : null; }))`;
    const check = async (name) => {
      await ev("document.getElementById('guildInput').value = " + JSON.stringify(guilds.slice(0, 2).join('\n')));
      if (!(await click(name, "document.getElementById('runBtn')"))) return null;
      await until(name, "/^Done/.test(document.getElementById('statusMsg').textContent)", 'the "Done" status');
      await until(name, "!document.getElementById('runBtn').disabled", 'the Check button enabled again');
      await idle(name);
      return JSON.parse(await ev(rows));
    };

    substitutes.set(allUrl, { body: Buffer.from(JSON.stringify([...all, old])), served: 0 });
    substitutes.set(tables[where[1].r].url, { body: Buffer.from(JSON.stringify(moved)), served: 0 });
    const wrong = { body: Buffer.from(JSON.stringify(other)), served: 0 };
    substitutes.set(worldUrl, wrong);
    await ev('wvwMapCache = null; loadStandings()');
    await idle(step);
    let got = await check(step + ': first Check');
    if (got) {
      const dot = `dot dot-${colorOf(fresh, T)}`;
      if (got[0]?.cls !== dot) problem(`step '${step}': team ${T} is in ${fresh.id} (${colorOf(fresh, T)}) and in last week's ${old.id} (${colorOf(old, T)}); its dot is "${got[0]?.cls}"`);
      if (await ev(`teamToMatchId.get('${T}')`) !== fresh.id) problem(`step '${step}': team ${T} is tied to ${await ev(`teamToMatchId.get('${T}')`)}, not to ${fresh.id}`);
      if (got[1]?.cls !== 'dot dot-pending' || !/not on the API yet/.test(got[1]?.title || '')) problem(`step '${step}': the guild with no match has dot "${got[1]?.cls}" / "${got[1]?.title}", wanted grey with a title`);
      const note = await ev("[...document.querySelectorAll('#matchPanelsContainer .panel-note')].map(n => n.textContent).join('|')");
      if (note !== `Unknown team (ID ${MISSING}): this week's match isn't on the API yet.`) problem(`step '${step}': the note reads "${note}"`);
      if (await ev(`teamToMatchId.has('${MISSING}') || teamToMatchId.has(${MISSING})`)) problem(`step '${step}': a wrong match was kept for team ${MISSING}`);
      if (wrong.served < 1 || wrong.served > 3) problem(`step '${step}': ?world= asked ${wrong.served} time(s), wanted 1 to 3`);
    }

    // The API now answers right: a second Check finds the guild.
    const right = { ...other, all_worlds: { ...other.all_worlds, red: [Number(MISSING)] } };
    substitutes.set(worldUrl, { body: Buffer.from(JSON.stringify(right)), served: 0 });
    got = await check(step + ': second Check');
    if (got && got[1]?.cls !== 'dot dot-red') problem(`step '${step}': the second Check left the guild at "${got[1]?.cls}" once ?world= answered right`);
    if (await ev("document.querySelectorAll('#matchPanelsContainer .panel-note').length")) problem(`step '${step}': a note is still shown after the API answered right`);

    substitutes.clear();
    await ev('wvwMapCache = null; matchDataCache.delete(' + JSON.stringify(old.id) + '); teamToMatchId.delete(' + JSON.stringify(MISSING) + '); loadStandings()');
    await idle(step + ': restore');
  }

  // The week's line-up kept between loads (wvw-weeks-v1). A load sees 1-2 and
  // 1-3 on a new week with each other's teams; the next load, same profile, is
  // served last week's 1-2 and 1-3 everywhere: their cards show the new line-up
  // by name with "This week's line-up · scores not in yet", no score, no map,
  // and the Check gets that line-up for one of its teams, never cached.
  // Two hours after that week began the API has the last word again. A corrupt
  // memory (not JSON, an unknown team, a __proto__ key, 10 KB, a start ahead) is ignored with
  // nothing logged. With one late tier, the line-up deduced from the API wins over the
  // memory. Each load starts the page's clock at the recording's instant.
  async function weekMemory() {
    const step = 'week memory';
    const KEY = 'wvw-weeks-v1';
    const allHit = recorded.get(ALL_URL);
    if (!allHit) return void problem(`step '${step}': ${ALL_URL} not recorded`);
    const all = JSON.parse(bodyOf(allHit).toString('utf8'));
    const rec = new Map(all.map(m => [m.id, m]));
    const t2 = rec.get('1-2'), t3 = rec.get('1-3');
    if (!t2 || !t3) return void problem(`step '${step}': the recording does not hold NA tiers 2 and 3`);
    const json = v => ({ body: Buffer.from(JSON.stringify(v)), served: 0 });
    const week = 7 * 86400000, iso = t => new Date(t).toISOString().replace('.000Z', 'Z');
    const start = Math.floor((recordedAt - 600000) / 60000) * 60000;
    const fresh = (m, worlds) => ({ ...m, start_time: iso(start), end_time: iso(start + week), all_worlds: worlds });
    const old = m => ({ ...m, start_time: iso(Date.parse(m.start_time) - week), end_time: iso(Date.parse(m.end_time) - week) });
    const team = m => ['red', 'blue', 'green'].map(c => String(m.all_worlds[c].find(n => n >= 10000)));
    const card = id => `(() => { const b = document.querySelector('#standingsGridNA > .standing-match[data-match-id="${id}"]');
      return b ? JSON.stringify({ sides: b.querySelectorAll('.standing-side').length, map: !!b.querySelector('.tier-map-btn'),
        vp: !!b.querySelector('.standing-vp'), names: [...b.querySelectorAll('.standing-side-name')].map(e => e.textContent),
        waiting: [...b.querySelectorAll('.standings-waiting')].map(p => p.textContent) }) : 'null'; })()`;
    const read = async id => JSON.parse(await ev(card(id)));
    const names = async m => ev(`${JSON.stringify(team(m))}.map(getTeamName)`);

    // A clean start: earlier steps kept bodies of later weeks.
    await ev(`localStorage.removeItem('${KEY}')`);
    substitutes.set(ALL_URL, json(all.map(m => (m.id === '1-2' ? fresh(t2, t3.all_worlds) : m.id === '1-3' ? fresh(t3, t2.all_worlds) : m))));
    if (!(await load(step + ': new week'))) return void substitutes.clear();
    const seen = await read('1-2');
    if (seen?.sides !== 3 || JSON.stringify([...seen.names].sort()) !== JSON.stringify([...(await names(t3))].sort())) problem(`step '${step}': the new week's 1-2 reads ${JSON.stringify(seen)}`);
    const kept = await ev(`localStorage.getItem('${KEY}')`);
    const mem = kept ? JSON.parse(kept) : {};
    if (!mem['1-2'] || mem['1-2'].s !== start || JSON.stringify(['red', 'blue', 'green'].map(c => String(mem['1-2'].t[c]))) !== JSON.stringify(team(t3))) {
      problem(`step '${step}': the memory holds ${JSON.stringify(mem['1-2'])} for 1-2, wanted start ${start} and 1-3's teams`);
    }
    console.log(`week memory: ${kept ? kept.length : 0} characters for ${Object.keys(mem).length} matches`);
    if (!kept || kept.length >= 2048) problem(`step '${step}': the memory is ${kept ? kept.length : 0} characters, wanted under 2048`);

    // Reloaded onto last week's 1-2 and 1-3, the read by id too.
    const back = all.map(m => (m.id === '1-2' || m.id === '1-3' ? old(m) : m));
    substitutes.set(ALL_URL, json(back));
    const byId = json([old(t2), old(t3)]);
    substitutes.set(IDS_URL + '1-2,1-3', byId);
    if (await load(step + ': last week again')) {
      const c = await read('1-2');
      const want = JSON.stringify({ sides: 0, map: false, vp: false, names: await names(t3), waiting: ["This week's line-up · scores not in yet"] });
      if (JSON.stringify(c) !== want) problem(`step '${step}': reloaded onto last week, 1-2 reads ${JSON.stringify(c)}, wanted ${want}`);
      if (!byId.served) problem(`step '${step}': last week's 1-2 and 1-3 were not read again by id`);
      // The Check: a team of the new 1-2, every body in hand and ?world= on last week.
      const x = team(t3)[0];
      const world = json(old(t3));
      substitutes.set(`https://api.guildwars2.com/v2/wvw/matches?world=${x}`, world);
      const got = await ev(`getMatchForTeam('${x}').then(m => JSON.stringify({ id: m.id, memory: !!m.fromMemory,
        cached: [...matchDataCache.values(), ...[...newestMatches.values()].map(k => k.match)].some(b => b.fromMemory) }))`);
      if (got !== JSON.stringify({ id: '1-2', memory: true, cached: false }) || !world.served) {
        problem(`step '${step}': the Check for team ${x} got ${got} after ${world.served} ?world= read(s), wanted the remembered 1-2, uncached`);
      }
    }

    // Two hours after the remembered week began: the API's body stands.
    const later = await send('Page.addScriptToEvaluateOnNewDocument', { source: `__skewClock(${2 * 3600000});` });
    const ok = await load(step + ': two hours on');
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: later.identifier });
    if (ok) {
      const c = await read('1-2');
      if (JSON.stringify(c?.names) !== JSON.stringify(await names(t2)) || c.waiting.join('|') !== "Last week's line-up · waiting on the API") {
        problem(`step '${step}': two hours on, 1-2 reads ${JSON.stringify(c)}, wanted last week's line-up from the API`);
      }
    }
    substitutes.clear();

    // A corrupt memory, each would-be winner for 1-2 otherwise well formed,
    // over last week's 1-2: a whole region on one week would rewrite it.
    const entry = (t, s = start) => ({ s, e: s + week, t, v: start });
    const good = Object.fromEntries(['red', 'blue', 'green'].map((c, i) => [c, Number(team(t3)[i])]));
    const corrupt = {
      'not JSON': '{"1-2": {"s": ',
      'team 99999 and __proto__': `{"__proto__": ${JSON.stringify(entry(good))}, "1-2": ${JSON.stringify(entry({ ...good, green: 99999 }))}}`,
      '10 KB': JSON.stringify({ '1-2': entry(good), pad: 'x'.repeat(10240) }),
      'a week 20 h ahead': JSON.stringify({ '1-2': entry(good, start + 20 * 3600000) }),
      'a start past any date': JSON.stringify({ '1-2': entry(good, 8.7e15) }),
    };
    // One late tier is deduced from the API before the memory is asked: a
    // well-formed memory of 1-3's teams for 1-2 loses to the teams left over.
    substitutes.set(ALL_URL, json(all.map(m => (m.id === '1-2' ? old(t2) : m))));
    await ev(`localStorage.setItem('${KEY}', ${JSON.stringify(JSON.stringify({ '1-2': entry(good) }))})`);
    if (await load(`${step}: deduced over memory`)) {
      const c = await read('1-2');
      const want = JSON.stringify({ sides: 0, map: false, vp: false, names: [...(await names(t2))].sort(), waiting: ["This week's line-up · scores not in yet"] });
      if (JSON.stringify(c && { ...c, names: [...c.names].sort() }) !== want) problem(`step '${step}': one late tier with a memory, 1-2 reads ${JSON.stringify(c)}, wanted the deduced ${want}`);
    }
    // Two late tiers: nothing to deduce, so each corrupt memory is the only
    // thing that could change 1-2.
    const t4 = rec.get('1-4');
    substitutes.set(ALL_URL, json(all.map(m => (m.id === '1-2' ? old(t2) : m.id === '1-4' && t4 ? old(t4) : m))));
    for (const [what, text] of Object.entries(corrupt)) {
      const before = problems.length;
      await ev(`localStorage.setItem('${KEY}', ${JSON.stringify(text)})`);
      if (!(await load(`${step}: ${what}`))) continue;
      const c = await read('1-2');
      if (c?.waiting?.join('|') !== "Last week's line-up · waiting on the API") problem(`step '${step}': with a memory of ${what}, 1-2 reads ${JSON.stringify(c)}, wanted last week's line-up from the API`);
      if (await ev("Object.prototype.s !== undefined || ({}).t !== undefined")) problem(`step '${step}': a memory of ${what} reached Object.prototype`);
      if (problems.length !== before) problem(`step '${step}': a memory of ${what} was not ignored quietly`);
    }
    substitutes.clear();
    await ev(`localStorage.removeItem('${KEY}')`);
  }

  // The corners over a map: the age of the data turns amber with words once
  // the API has answered the same body for over 6 min, and comes back on a
  // body whose score rose; the kills match the hot tab's title; zoom hides
  // both and "home" shows them.
  async function mapCorners() {
    const step = 'map corners';
    // The tier button with the swords badge, when the recording has a busy map:
    // its label must name the map the tab with swords shows on opening.
    const badged = await ev("!!document.querySelector('.tier-map-btn .tier-map-badge')");
    if (!badged) problem(`step '${step}': no tier button carries the swords badge`);
    const name = badged ? "document.querySelector('.tier-map-btn:has(.tier-map-badge)')" : "document.querySelector('.tier-map-btn')";
    const busiest = badged ? await ev(`/busiest: (.+)$/.exec(${name}.getAttribute('aria-label'))?.[1] || ''`) : '';
    const t = /\b(NA|EU) Tier (\d+)/.exec(await ev(`${name}?.getAttribute('aria-label') || ''`));
    const oneUrl = t && `https://api.guildwars2.com/v2/wvw/matches?id=${t[1] === 'NA' ? 1 : 2}-${t[2]}`;
    const oneHit = oneUrl && recorded.get(oneUrl);
    if (!oneHit) return void problem(`step '${step}': ${oneUrl || "the tier map button's match"} not recorded`);
    // The standings' score time made old before the map opens: the corner must
    // not show it. A page-side observer notes any amber or spoken turn from the start.
    await ev(`__skewClock(100000); window.__amber = false;
      new MutationObserver(() => {
        if (document.querySelector('.wvw-hud-ago.is-stale') || document.querySelector('.wvw-hud-live')?.textContent) window.__amber = true;
      }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })`);
    if (!(await click(step + ': open', name))) return;
    if (!(await until(step, `!!document.querySelector("${POPOVERS['tier-map-btn']}")`, 'drawn objectives'))) return;
    await idle(step);
    const q = sel => `document.querySelector('.info-popover .wvw-plot-wrap ${sel}')`;
    const shown = sel => `(() => { const e = ${q(sel)}; return !!e && !!e.offsetParent; })()`;
    const text = sel => `(${q(sel)}?.textContent || '')`;
    if (!(await until(step, shown('.wvw-hud-r'), '"Updated" corner'))) return;
    if (!/^Updated /.test(await ev(text('.wvw-hud-ago')))) problem(`step '${step}': the corner does not start with "Updated"`);
    await idle(step);
    if (await ev('window.__amber') || (await ev(text('.wvw-hud-live')))) problem(`step '${step}': the corner went amber, or spoke, on opening`);
    if (await ev(`!!${q('.wvw-hud-ago.is-stale')}`)) problem(`step '${step}': the corner is amber after the opening read`);
    const hot = await ev(`(() => { const b = document.querySelector('.info-popover .wvw-tab.is-hot'); return b ? { type: b.dataset.type, title: b.title, label: b.textContent.trim() } : null; })()`);
    if (badged && (!hot || hot.label !== busiest)) problem(`step '${step}': the button says busiest "${busiest}", the hot tab is ${hot ? `"${hot.label}"` : 'none'}`);
    if (hot) {
      await click(step + ': hot tab', `document.querySelector('.info-popover .wvw-tab[data-type="${hot.type}"]')`);
      await until(step, shown('.wvw-hud-l'), 'kills corner on the hot tab');
      const kills = await ev(text('.wvw-hud-big'));
      if (!hot.title.includes(` ${kills} kills `)) problem(`step '${step}': corner says ${kills} kills, the tab says "${hot.title}"`);
      if (await ev(`!!${q('.wvw-hud-l.is-cold')}`)) problem(`step '${step}': the swords are neutral on the hot tab`);
    }
    const cold = await ev(`(() => { const b = [...document.querySelectorAll('.info-popover .wvw-tab')].find(t => !t.classList.contains('is-hot')); return b ? b.dataset.type : null; })()`);
    if (cold) {
      await click(step + ': other tab', `document.querySelector('.info-popover .wvw-tab[data-type="${cold}"]')`);
      await until(step, `!!${q('.wvw-hud-l.is-cold')} && ${shown('.wvw-hud-l')}`, 'the kills corner, neutral, on a tab without swords');
      // With a hot tab there are rates, so a number; without, a dash. Never a bare 0 from no measurement.
      const big = await ev(text('.wvw-hud-big'));
      if (!(hot ? /^\d+$/.test(big) : /^(\d+|\u2013)$/.test(big))) problem(`step '${step}': the neutral corner reads "${big}"`);
      // A number always carries the minutes it was counted over: a count with no window is a dash.
      const small = await ev(`${q('.wvw-hud-small')}.innerText`);
      if (/^\d+$/.test(big) && !/^kills · (\d+ min|until \S+|\u26a0 until \S+)$/.test(small)) problem(`step '${step}': the corner reads "${big}" with "${small}", a count with no window`);
    }
    // A frozen API: the recorded body answered again on every pull for 400 s
    // more. Each answer arrives; none is new data.
    const one = JSON.parse(bodyOf(oneHit).toString('utf8'));
    const same = { body: bodyOf(oneHit), served: 0 };
    substitutes.set(oneUrl, same);
    for (let i = 0; i < 4; i++) {
      await ev("__skewClock(100000); window.dispatchEvent(new Event('focus'))");
      await idle(step + ': same body');
    }
    if (same.served < 4) problem(`step '${step}': the map asked ${same.served} time(s) over 400 s, wanted 4`);
    await until(step, `${q('.wvw-hud-ago.is-stale')} && /^\u26a0 No new data /.test(${text('.wvw-hud-ago')})`, 'amber "No new data" after 6 min of the same body');
    if (!/No new map data for/.test(await ev(text('.wvw-hud-live')))) problem(`step '${step}': the gap was not spoken`);
    // Stale data claims no fight: no swords on a tab, and the kills corner is neutral -
    // either a dash with only "kills" (no window), or the last count dimmed with
    // "\u26a0 until HH:MM", the time the kills last moved (never a bare 0 from no window).
    if (await ev(`!!document.querySelector('.info-popover .wvw-tab.is-hot')`)) problem(`step '${step}': swords still show on a tab on stale data`);
    const frozen = await ev(`(() => {
      return { shown: ${shown('.wvw-hud-l')}, cold: !!${q('.wvw-hud-l.is-cold')}, dim: !!${q('.wvw-hud-l.is-dim')},
        big: ${text('.wvw-hud-big')}, small: ${q('.wvw-hud-small')}.innerText,
        when: ${q('.wvw-hud-small time')}?.dateTime || '' };
    })()`);
    const dash = frozen.big === '\u2013' && frozen.small === 'kills' && !frozen.dim;
    const dimmed = /^\d+$/.test(frozen.big) && /^kills · \u26a0 until \S/.test(frozen.small) && frozen.dim && Number.isFinite(Date.parse(frozen.when));
    if (!frozen.shown || !frozen.cold || !(dash || dimmed)) problem(`step '${step}': on stale data the kills corner reads ${JSON.stringify(frozen)}, wanted a neutral dash or the last count dimmed "\u26a0 until HH:MM"`);
    // The score one point up: new data, the corner back to "Updated".
    const bumped = { ...one, scores: { ...one.scores, red: (Number(one.scores?.red) || 0) + 1 } };
    substitutes.set(oneUrl, { body: Buffer.from(JSON.stringify(bumped)), served: 0 });
    await ev("__skewClock(31000); window.dispatchEvent(new Event('focus'))");
    await until(step, `${q('.wvw-hud-ago')} && !${q('.wvw-hud-ago.is-stale')} && /^Updated /.test(${text('.wvw-hud-ago')})`, '"Updated" back on a higher score');
    if (!/New map data again/.test(await ev(text('.wvw-hud-live')))) problem(`step '${step}': the return was not spoken`);
    await idle(step);
    substitutes.delete(oneUrl);
    const touch = () => ev("getComputedStyle(document.querySelector('.info-popover .wvw-plot-wrap')).touchAction");
    if (await touch() !== 'pan-y') problem(`step '${step}': the whole map has touch-action '${await touch()}', wanted pan-y (a swipe must scroll the page)`);
    const overscroll = await ev("getComputedStyle(document.querySelector('.info-popover')).overscrollBehaviorY");
    if (overscroll !== 'contain') problem(`step '${step}': the popover has overscroll-behavior-y '${overscroll}', wanted contain`);
    if (await click(step + ': zoom in', "document.querySelector('.info-popover .wvw-zoom button')")) {
      await until(step, `!(${shown('.wvw-hud-r')})`, 'corners hidden while zoomed');
      if (await touch() !== 'none') problem(`step '${step}': the zoomed map has touch-action '${await touch()}', wanted none (the drag moves the map)`);
      if (await click(step + ': home', "document.querySelector('.info-popover .wvw-zoom button:last-child')")) {
        await until(step, shown('.wvw-hud-r'), 'corners back after "home"');
        if (await touch() !== 'pan-y') problem(`step '${step}': after home the map has touch-action '${await touch()}', wanted pan-y`);
      }
    }
    await closePopover(step);
    // The clock back, and the fight log this step fed dropped: the frozen-match step reads the log's totals.
    await ev("__skewClock(-531000); localStorage.removeItem('wvw-fight-v1')");
  }

  // A guild lookup answered 429 (after its retries) says nothing about the
  // guild: the next Check asks again. A 404 is a definite answer and is kept.
  // A refresh that skips (a popover open) returns false and the scheduler
  // does not count it, so a focus return right after runs it; one that ran
  // is counted, so the same return does not.
  async function guildCache() {
    const step = 'guild cache';
    stepNow = step;
    const id = 'ZZZZ-CHECK-PAGE-GUILD';
    const url = `https://api.guildwars2.com/v2/guild/${id}`;
    const ask = `getGuildInfo('${id}').then(g => 'ok ' + g.name, e => 'err ' + e.status)`;
    failingLog = /^https:\/\/api\.guildwars2\.com\/v2\/guild\//;
    limited = { re: new RegExp('^' + url.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '$'), status: 429 };
    limitedReads = 0;
    const first = await ev(ask);
    if (first !== 'err 429') problem(`step '${step}': the 429 lookup gave "${first}"`);
    if (await ev(`guildNameCache.has('${id}')`)) problem(`step '${step}': a 429 was kept in guildNameCache`);
    limited = null;
    substitutes.set(url, { body: Buffer.from(JSON.stringify({ id, name: 'Check Page Guild', tag: 'CPG', emblem: null })), served: 0 });
    const second = await ev(ask);
    if (second !== 'ok Check Page Guild') problem(`step '${step}': the lookup after the 429 gave "${second}", wanted a fresh fetch`);
    substitutes.clear();
    await ev(`guildNameCache.delete('${id}')`);

    limited = { re: new RegExp('^' + url.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '$'), status: 404 };
    limitedReads = 0;
    await ev(ask); await ev(ask);
    if (limitedReads !== 1) problem(`step '${step}': a 404 was asked ${limitedReads} time(s) in two lookups, wanted 1 (kept)`);
    limited = null;
    await ev(`guildNameCache.delete('${id}')`);
    await sleep(500);
    failingLog = null;

    if (await ev('(async () => { activeTrigger = document.body; const r = await refreshStandings(); activeTrigger = null; return r; })()') !== false) {
      problem(`step '${step}': refreshStandings with a popover open did not return false`);
    }
    const sched = await ev(`new Promise(res => {
      const out = {};
      for (const [k, ret] of [['skipped', false], ['ran', true]]) {
        out[k] = 0;
        schedulePeriodicRefresh(async () => { out[k]++; return ret; }, 2000);
      }
      setTimeout(() => {
        document.dispatchEvent(new Event('visibilitychange'));
        setTimeout(() => res(out), 300);
      }, 2300);
    })`);
    if (sched.skipped !== 2) problem(`step '${step}': a skipped run was counted: it ran ${sched.skipped} time(s) over a tick and a focus return, wanted 2`);
    if (sched.ran !== 1) problem(`step '${step}': a run that did its work ran ${sched.ran} time(s) over a tick and a focus return, wanted 1`);
  }

  // A pasted list of more than MAX_ENTRIES distinct names asks for the first
  // MAX_ENTRIES only, and says so; exactly MAX_ENTRIES says nothing. Every
  // search answers 404 on purpose, so only the asking is counted.
  async function guildLimit() {
    const step = 'guild limit';
    stepNow = step;
    const max = await ev('MAX_ENTRIES');
    failingLog = /^https:\/\/api\.guildwars2\.com\/v2\/guild\//;
    limited = { re: /^https:\/\/api\.guildwars2\.com\/v2\/guild\/search\?/, status: 404 };
    for (const count of [max + 1, max]) {
      limitedReads = 0;
      const names = Array.from({ length: count }, (_, i) => `Check Page Limit ${i + 1}`);
      await ev(`document.getElementById('guildInput').value = ${JSON.stringify(names.join('\n'))}`);
      if (!(await click(`${step} (${count})`, "document.getElementById('runBtn')"))) break;
      await until(step, "/^Done/.test(document.getElementById('statusMsg').textContent) && !document.getElementById('runBtn').disabled", `the "Done" status for ${count} names`);
      const said = await ev("document.getElementById('statusMsg').textContent");
      const warned = said.includes(`Only the first ${max} guilds were checked.`);
      if (limitedReads !== max) problem(`step '${step}': ${count} names asked ${limitedReads} search(es), wanted ${max}`);
      if (warned !== (count > max)) problem(`step '${step}': ${count} names gave status "${said}", the warning ${count > max ? 'was due' : 'was not due'}`);
    }
    limited = null;
    await sleep(500);
    failingLog = null;
    await ev("document.getElementById('guildInput').value = ''");
  }

  // 8a. Scripts run in order and the page is usable before the last one: with
  // one held, Escape, a resize, the Check button, Ctrl+Enter and a click
  // must raise nothing, and the page must work once it is let go.
  async function earlyActions() {
    for (const script of ['maps.js', 'trebuchet.js', 'boot.js']) {
      const step = `early actions (${script} held)`;
      holdUrl = `${base}/js/${script}`;
      held = null;
      const ok = await load(step, async () => {
        for (let i = 0; i < 300 && !held; i++) await sleep(50);
        if (!held) return void problem(`step '${step}': the request was never held`);
        await escape();
        await ev("window.dispatchEvent(new Event('resize')); if (window.visualViewport) window.visualViewport.dispatchEvent(new Event('resize')); true");
        await ev("document.getElementById('guildInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); true");
        await ev("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', clientX: 50, clientY: 50 })); true");
        await click(step, "document.getElementById('runBtn')");
        await sleep(200);   // a throw is reported late
        const id = held;
        holdUrl = null; held = null;
        await send('Fetch.continueRequest', { requestId: id });
      });
      holdUrl = null;
      if (ok && !await ev("!document.getElementById('runBtn').disabled && !document.querySelector('#statusMsg .spinner')")) {
        problem(`step '${step}': the Check button was left disabled`);
      }
    }
  }

  // 8. A failed load and a slow line: the live standings and the guild tables
  // answer 503, the page says it will try again and counts down, and once the
  // API answers again the table paints with no reload. Then the guild search
  // fails the same way, and its button repeats it. The page's random is pinned
  // to 0 for this load so the first extra try waits 5 s, the window's start.
  async function failedLoad() {
    const step = 'failed load';
    const tiers = `document.querySelectorAll('#standingsGridNA > .standing-match').length > 0 && document.querySelectorAll('#standingsGridEU > .standing-match').length > 0`;
    const status = region => `document.getElementById('standingsAlert${region}')?`;
    failing = failingLog = /^https:\/\/api\.guildwars2\.com\//;
    const pin = await send('Page.addScriptToEvaluateOnNewDocument', { source: 'Math.random = () => 0;' });
    stepNow = step;
    loaded = false;
    ids.clear();
    await send('Page.navigate', { url: base + '/' });
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: pin.identifier });
    await until(step, `/Trying again in \\d+ s/.test(${status('NA')}.textContent) && /Trying again in \\d+ s/.test(${status('EU')}.textContent)`, 'the "Trying again in N s" message under both standings');
    await until(step, `!!${status('NA')}.querySelector('button.retry-btn') && ${status('NA')}.querySelector('button.retry-btn').textContent === 'Try again'`, 'the Try again button');
    if (await ev("!!document.querySelector('.standings-header .retry-btn, .standings-header .sr-only')")) problem(`step '${step}': the error message sits in the title's row, not the card's top strip`);
    if (await ev(tiers)) problem(`step '${step}': tiers painted while the API was failing`);
    // The whole API down: no relink bar either, so the columns' tops must still
    // clear the notice bar. Measured at 1920, where the columns stand beside the
    // page: the error text's top must be on screen and hit the strip itself.
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(step, "document.getElementById('relinkBanner').style.display === 'none'", 'the relink bar gone with the API down');
    const clear = await ev(`(() => {
      window.scrollTo(0, 0);
      const box = document.getElementById('standingsAlertNA');
      const r = document.createRange(); r.selectNodeContents(box.querySelector('.retry-vis'));
      const b = r.getClientRects()[0], n = document.getElementById('teamsNotice');
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 1);
      return JSON.stringify({ top: Math.round(b.top), hit: !!hit && box.contains(hit),
        under: n && getComputedStyle(n).display !== 'none' ? Math.round(n.getBoundingClientRect().bottom) : 0 });
    })()`);
    const seenAt = JSON.parse(clear);
    if (!seenAt.hit || seenAt.top < seenAt.under) problem(`step '${step}': the error text's top (${seenAt.top}px) is hidden or under the notice bar (${seenAt.under}px) at 1920 px`);
    await send('Emulation.clearDeviceMetricsOverride');
    await ev('window.__sameDocument = true');
    failing = null;
    await until(step, tiers, 'the tables painted by the extra try, without a reload');
    if (!(await ev('window.__sameDocument === true'))) problem(`step '${step}': the page was reloaded`);
    await until(step, `!${status('NA')}.querySelector('.retry-btn')`, 'the message gone once the standings loaded');
    await idle(step);

    failing = /^https:\/\/api\.guildwars2\.com\/v2\/wvw\/guilds\/(na|eu)$/;
    await ev(`document.getElementById('guildInput').value = ${JSON.stringify(guilds.join('\n'))}`);
    if (!(await click(step + ' search', "document.getElementById('runBtn')"))) return;
    const again = "document.querySelector('#statusMsg .retry-btn')";
    await until(step, `!!${again} && !document.getElementById('runBtn').disabled`, 'the guild search message with its Try again button');
    failing = null;
    if (await click(step + ' search again', again)) {
      await until(step, "/^Done/.test(document.getElementById('statusMsg').textContent)", 'the "Done" status after Try again');
      await idle(step);
    }
    await sleep(500);
    failingLog = null;
  }

  // /api/latest: gzip + base64 bodies of the live matches. One is made newer
  // (score up), one is offered under another match's id, one under an id the
  // game never gave; only the first may reach the page.
  async function latestSecondRead() {
    const step = 'latest';
    const allHit = recorded.get(ALL_URL);
    if (!allHit) return void problem(`step '${step}': ${ALL_URL} not recorded`);
    const all = JSON.parse(bodyOf(allHit).toString('utf8'));
    const live = all.filter(m => Date.parse(m.end_time) > recordedAt);
    if (live.length < 2) return void problem(`step '${step}': the recording has fewer than two live matches`);
    const [a, b] = live;
    const sum = m => ['red', 'blue', 'green'].reduce((n, c) => n + m.scores[c], 0);
    const entry = (id, m) => ({ id, start: Date.parse(m.start_time), score: sum(m), at: 0, by: 'check-page',
      gz: gzipSync(Buffer.from(JSON.stringify(m))).toString('base64') });
    const bump = (m, n) => ({ ...m, scores: { ...m.scores, red: m.scores.red + n } });
    const body = JSON.stringify({ at: 0, matches: [
      entry(a.id, bump(a, 5000)),             // newer: must show
      entry(b.id, bump(a, 99999)),            // the body says another id: must not
      entry('1-9', bump(a, 99999)),           // an id the game never gave: must not
    ] });
    const scoreOf = id => ev(`(() => { const m = matchDataCache.get('${id}'); return m ? colorSum(m.scores) : -1; })()`);
    const known = ev("typeof matchDataCache.has === 'function' && matchDataCache.has('1-9')");

    latestMode = 'serve'; latestBody = Buffer.from(body); latestReads = 0;
    if (await load(step + ': newer')) {
      if (!latestReads) problem(`step '${step}': the page never asked /api/latest`);
      if (await scoreOf(a.id) !== sum(a) + 5000) problem(`step '${step}': the newer body of ${a.id} did not reach the page (${await scoreOf(a.id)}, wanted ${sum(a) + 5000})`);
      if (await scoreOf(b.id) !== sum(b)) problem(`step '${step}': a body under the wrong id changed ${b.id}`);
      if (await known) problem(`step '${step}': an id the game never gave was kept`);
    }
    // Garbage in every field the page checks: nothing may change, nothing may be said.
    latestBody = Buffer.from(JSON.stringify({ at: 0, matches: [
      { id: a.id, start: Date.parse(a.start_time), gz: 'not base64 !' },
      { id: a.id, start: Date.parse(a.start_time), gz: gzipSync(Buffer.from('{not json')).toString('base64') },
      { id: a.id, start: Date.parse(a.start_time) + 1, gz: entry(a.id, bump(a, 5000)).gz },
      { id: a.id, start: Date.parse(a.start_time), gz: gzipSync(Buffer.alloc(300 * 1024, 32)).toString('base64') },
    ] }));
    if (await load(step + ': garbage') && await scoreOf(a.id) !== sum(a)) problem(`step '${step}': a bad /api/latest entry changed ${a.id}`);

    latestMode = 'down'; latestReads = 0;
    const t0 = Date.now();
    const downOk = await load(step + ': 503');
    const baseMs = Date.now() - t0;
    if (downOk && !latestReads) problem(`step '${step}': the page never asked /api/latest`);
    if (downOk && await scoreOf(a.id) !== sum(a)) problem(`step '${step}': the numbers moved with /api/latest down`);

    // Hung: tiers must be up about as fast as with the 503. Timed to the tiers,
    // not to quiet: the page's own deadline closes the request later.
    latestMode = 'hang'; latestReads = 0;
    loaded = false; ids.clear(); stepNow = step + ': hang';
    const h0 = Date.now();
    await send('Page.navigate', { url: base + '/' });
    let up = false;
    while (Date.now() - h0 < 30000 && !up) {
      await sleep(100);
      const w = expectedTiers();
      const g = JSON.parse((await send('Runtime.evaluate', { expression: probe, returnByValue: true })).result.value);
      up = !!w && g.NA >= w.NA && g.EU >= w.EU && w.NA > 0 && w.EU > 0;
    }
    const hangMs = Date.now() - h0;
    if (!up) problem(`step '${step}': tiers never appeared with /api/latest hung`);
    else if (!latestReads) problem(`step '${step}': the page never asked /api/latest (hung)`);
    else if (hangMs > baseMs + 2500) problem(`step '${step}': a hung /api/latest slowed the tiers to ${hangMs} ms (503: ${baseMs} ms)`);
    await idle(step + ': hang');
    latestMode = 'down';
  }

  // The tiers in the standings carry no staleness mark: the recorded body
  // repeated for 1600 s puts no .tier-age on any tier, and at 320 px wide no
  // tier box or title row spills over.
  async function tierMarks() {
    const step = 'tier marks';
    const allUrl = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
    const allHit = recorded.get(allUrl);
    if (!allHit) return void problem(`step '${step}': ${allUrl} not recorded`);
    await ev("__skewClock(1600000); localStorage.removeItem('wvw-fight-v1')");
    substitutes.set(allUrl, { body: bodyOf(allHit), served: 0 });
    await ev('loadStandings()');
    await idle(step);
    const shown = await ev("document.querySelectorAll('.standing-match').length");
    if (!shown) return void problem(`step '${step}': no tiers in the standings`);
    const marked = await ev("document.querySelectorAll('.tier-age').length");
    if (marked) problem(`step '${step}': ${marked} tier(s) wear a mark after 1600 s of the same body`);
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: true });
    await idle(step + ': 320 px');
    const spill = await ev(`(() => ({
      page: Math.max(0, ...[...document.querySelectorAll('.standing-match')].map(b => Math.round(b.getBoundingClientRect().right - innerWidth))),
      rows: [...document.querySelectorAll('.standing-match-title')].filter(t => t.scrollWidth > t.clientWidth).length,
      tall: [...document.querySelectorAll('.standing-match-title')].filter(t => t.offsetHeight > 24).length }))()`);
    if (spill.page > 0 || spill.rows || spill.tall) problem(`step '${step}': at 320 px a tier box spills ${spill.page}px, ${spill.rows} title row(s) overflow, ${spill.tall} grew taller`);
    await send('Emulation.clearDeviceMetricsOverride');
    substitutes.delete(allUrl);
    await ev("__skewClock(-1600000); localStorage.removeItem('wvw-fight-v1')");
    await ev('loadStandings()');
    await idle(step);
  }

  // The kill history says a match stopped before this page ever saw it move:
  // the corner opens amber with a dash, with the history put in place before
  // the map opens (awaited, so the order is certain). With every line old the
  // history is not trusted and nothing turns amber. A score up clears it.
  // Only the replay is changed: /api/kills is swapped, the recording is intact.
  async function historyAge() {
    const step = 'history ages first sight';
    const label = await ev("document.querySelector('.tier-map-btn')?.getAttribute('aria-label') || ''");
    const t = /\b(NA|EU) Tier (\d+)/.exec(label);
    if (!t) return void problem(`step '${step}': no tier map button to read a match from`);
    const matchId = `${t[1] === 'NA' ? 1 : 2}-${t[2]}`;
    const killsUrl = base + '/api/kills';   // what the page asks; the swap is checked before the recording's key
    const q = sel => `document.querySelector('.info-popover .wvw-plot-wrap ${sel}')`;
    const text = sel => `(${q(sel)}?.textContent || '')`;
    const history = (ageOfTarget, ageOfOthers) => `(async () => {
      const now = Date.now();
      const rows = [...newestMatches.keys()].map(id => [now - (id === '${matchId}' ? ${ageOfTarget} : ${ageOfOthers}), id, 5, 5, 5, 5]);
      return JSON.stringify({ rows });
    })()`;
    // The page's kept matches as a first sight with no rise, the history asked again.
    const reset = async (ageOfTarget, ageOfOthers) => {
      const body = await ev(history(ageOfTarget, ageOfOthers));
      substitutes.set(killsUrl, { body: Buffer.from(body), served: 0 });
      await ev(`(async () => {
        for (const k of newestMatches.values()) { k.rose = false; k.at = Date.now(); }
        killSheetAt = 0;
        await getKillSheet();
      })()`);
    };
    const open = async (name) => {
      if (!(await click(name, "document.querySelector('.tier-map-btn')"))) return false;
      if (!(await until(name, `!!document.querySelector("${POPOVERS['tier-map-btn']}")`, 'drawn objectives'))) return false;
      await idle(name);
      return await until(name, `!!${q('.wvw-hud-ago')}`, 'the age corner');
    };
    const kept = `(() => { const k = newestMatches.get('${matchId}'); return Date.now() - k.at; })()`;

    await reset(7 * 60000, 60000);
    if (await ev(kept) < 6 * 60000) problem(`step '${step}': the match was not backdated by a live history (${await ev(kept)} ms)`);
    if (await open(step + ': open')) {
      if (!(await ev(`!!${q('.wvw-hud-ago.is-stale')} && /^⚠ No new data /.test(${text('.wvw-hud-ago')})`))) problem(`step '${step}': the corner did not open amber`);
      if ((await ev(text('.wvw-hud-big'))) !== '–') problem(`step '${step}': the kills corner is not a dash on opening`);
      // The score up, on the kept body: back to "Updated".
      const bumped = await ev(`(() => { const m = JSON.parse(JSON.stringify(newestMatches.get('${matchId}').match));
        m.scores.red = (Number(m.scores.red) || 0) + 1; return JSON.stringify(m); })()`);
      substitutes.set(`https://api.guildwars2.com/v2/wvw/matches?id=${matchId}`, { body: Buffer.from(bumped), served: 0 });
      await ev("__skewClock(31000); window.dispatchEvent(new Event('focus'))");
      await until(step, `${q('.wvw-hud-ago')} && !${q('.wvw-hud-ago.is-stale')} && /^Updated /.test(${text('.wvw-hud-ago')})`, '"Updated" back on a higher score');
      substitutes.delete(`https://api.guildwars2.com/v2/wvw/matches?id=${matchId}`);
      await closePopover(step);
    }

    await reset(30 * 60000, 30 * 60000);
    if (await ev(kept) > 60000) problem(`step '${step}': a history with every line old moved the match's time`);
    if (await open(step + ': all old')) {
      if (await ev(`!!${q('.wvw-hud-ago.is-stale')}`) || !/^Updated /.test(await ev(text('.wvw-hud-ago')))) problem(`step '${step}': a history with every line old turned the corner amber`);
      await closePopover(step);
    }
    substitutes.delete(killsUrl);
  }

  // The rules behind "What happened", straight on missedMatchOffered with
  // bodies made from a kept match: no clicks, no clock, nothing that can be
  // late. A summary only for a real gap (the score still past 6 min, the page
  // reading through it, something changed) or a return to the tab; never for
  // the same body, one behind, a new week, a laptop asleep, a short stop, or
  // a gap the page did not read through; Ruins and Spawn never chips; kills
  // never below 0; gone after 10 min; and a fault in the hook never costs
  // keepNewestMatch its body. Everything it touched is put back.
  async function whatHappenedRules() {
    const step = 'what happened rules';
    stepNow = step;
    const failed = await ev(`(() => {
      const out = [];
      const check = (name, cond, info) => { if (!cond) out.push(name + (info ? ' (' + info + ')' : '')); };
      const id = [...newestMatches.keys()].find(k => matchIsLive(newestMatches.get(k).match));
      if (!id) return ['no live match kept'];
      const keptWas = newestMatches.get(id);
      const M0 = JSON.parse(JSON.stringify(keptWas.match));
      const clone = () => JSON.parse(JSON.stringify(M0));
      const reset = () => { missedNotes.clear(); missedLastOffer.clear(); missedRings.clear(); missedReturn = null; };
      const now = Date.now(), MIN = 60000;
      const flipTo = o => ({ Red: 'Blue', Blue: 'Green', Green: 'Red' }[o] || 'Red');
      const after = () => {
        const m = clone(); const taken = [];
        for (const map of m.maps) {
          const o = map.objectives.find(x => ['Camp', 'Tower', 'Keep'].includes(x.type));
          if (o && taken.length < 2) { o.owner = flipTo(o.owner); o.last_flipped = new Date(now).toISOString(); taken.push(o.id); }
        }
        m.maps[0].kills.red += 30; m.maps[0].kills.blue += 20; m.scores.red += 10;
        return { m, taken };
      };
      const offer = (body, keptAt, lastOfferAgo) => {
        reset();
        if (lastOfferAgo != null) missedLastOffer.set(id, now - lastOfferAgo);
        missedMatchOffered(body, { match: clone(), at: now - keptAt });
        return missedNotes.get(id) || null;
      };
      try {
        const a = after();
        let n = offer(a.m, 7 * MIN, 30000);
        check('a real gap raised no summary', !!n && n.kind === 'pause');
        check('a real gap listed other changes', !!n && n.changes.length === 2 && a.taken.every(x => n.changes.some(c => c.id === x)), n && n.changes.map(c => c.id).join(','));
        check('a real gap counted kills other than after minus before', !!n && n.kills === 50, n && n.kills);
        check('the same body again raised a summary', !offer(clone(), 7 * MIN, 30000));
        const behind = clone(); behind.scores.red -= 50; behind.maps[0].kills.red += 5;
        check('a body behind raised a summary', !offer(behind, 7 * MIN, 30000));
        const week = after().m; week.start_time = new Date(Date.parse(M0.start_time) + 7 * 86400000).toISOString();
        check('a new week raised a summary', !offer(week, 7 * MIN, 30000));
        check('a laptop asleep raised a summary', !offer(after().m, 20 * MIN, 5 * MIN));
        check('a 3-minute stop raised a summary', !offer(after().m, 3 * MIN, 30000));
        check('a gap with no read in it raised a summary', !offer(after().m, 7 * MIN, 8 * MIN));
        reset();
        missedReturn = { since: now - 5 * MIN, back: now, bodies: new Map([[id, clone()]]) };
        const r = after(); missedMatchOffered(r.m, { match: r.m, at: now });
        n = missedNotes.get(id);
        check('a return with changes raised no "return" summary', !!n && n.kind === 'return' && n.kills === 50, n && n.kind);
        reset();
        missedReturn = { since: now - 5 * MIN, back: now, bodies: new Map([[id, clone()]]) };
        missedMatchOffered(clone(), { match: clone(), at: now });
        check('a return with nothing changed raised a summary', !missedNotes.get(id));
        const ruins = clone();
        for (const map of ruins.maps) for (const o of map.objectives) if (o.type === 'Ruins' || o.type === 'Spawn') o.owner = flipTo(o.owner);
        ruins.maps[0].kills.red += 5;
        n = offer(ruins, 7 * MIN, 30000);
        check('Ruins or Spawn became chips', !!n && n.changes.length === 0, n && n.changes.map(c => c.type).join(','));
        const fewer = after().m; fewer.maps[0].kills.red -= 500;
        n = offer(fewer, 7 * MIN, 30000);
        check('kills went below 0', !n || n.kills >= 0, n && n.kills);
        n = offer(after().m, 7 * MIN, 30000);
        if (n) n.until = Date.now() - 1;
        check('a summary outlived its 10 minutes', missedNoteFor(id) === null);
        reset();
        const real = missedMatchOffered;
        missedMatchOffered = () => { throw new Error('on purpose'); };
        const up = clone(); up.scores.red += 100;
        let got, threw = false;
        try { got = keepNewestMatch(up); } catch { threw = true; }
        missedMatchOffered = real;
        check('a fault in the hook cost keepNewestMatch its body', !threw && got === up && newestMatches.get(id).match === up);
      } catch (e) {
        out.push('threw: ' + e.message);
      } finally {
        newestMatches.set(id, keptWas);
        reset();
      }
      return out;
    })()`);
    for (const f of failed) problem(`step '${step}': ${f}`);
  }

  // The skirmish trend when the clock is a block ahead of the body. Built
  // from a kept match: 63 whole blocks of 1,000 and a 64th of 400, the clock
  // 30 min into block 65. Body time before the end of block 64 (the API
  // froze mid-block): 400 is not "Last block", the average ignores it and the
  // text says the data stopped. Body time after it: 400 is a finished block,
  // as before. Everything it touched is put back.
  async function skirmishStalled() {
    const step = 'skirmish trend stalled';
    stepNow = step;
    const failed = await ev(`(() => {
      const out = [];
      const id = [...newestMatches.keys()][0];
      if (!id) return ['no match kept'];
      const kept = newestMatches.get(id);
      const keptAt = kept.at;
      const H = 3600000;
      const start = Date.now() - (128 * H + 0.5 * H);
      const lastEnd = start + 128 * H;
      const sk = (n) => ({ scores: { red: n, blue: n, green: n } });
      const match = { id, start_time: new Date(start).toISOString(), end_time: new Date(start + 168 * H).toISOString(),
        skirmishes: [...Array(63).fill(1000), 400].map(sk) };
      const render = (at) => {
        kept.at = at;
        const el = document.createElement('div');
        renderSkirmishTrendPopoverContent(el, 'X', match, 'red');
        return el.textContent;
      };
      try {
        const stalled = render(lastEnd - 40 * 60000);
        if (/Last block\s*400/.test(stalled) || !/Last block\s*1,000/.test(stalled)) out.push('a block cut off midway shows as "Last block": ' + stalled.slice(0, 160));
        if (!/63 of 84 finished/.test(stalled)) out.push('the finished count is not 63: ' + stalled.slice(0, 160));
        if (!/stopped partway through block 64/.test(stalled) || /ArenaNet hasn't published/.test(stalled)) out.push('the text does not say the data stopped: ' + stalled.slice(0, 200));
        const current = render(lastEnd + 5 * 60000);
        if (!/Last block\s*400/.test(current) || !/64 of 84 finished/.test(current)) out.push('a body past the end of block 64 does not show it finished: ' + current.slice(0, 160));
        if (/stopped partway/.test(current)) out.push('a body past the end of block 64 says the data stopped');
      } finally { kept.at = keptAt; }
      return out;
    })()`);
    for (const f of failed) problem(`step '${step}': ${f}`);
  }

  // The maps' "What happened": a match answered with the same body for over
  // 6 min while the page kept asking, then a body with two objectives taken
  // (one on the open map, one on another) and a known number of kills more.
  // The block shows both chips, the open map's first, and exactly those
  // kills; the taken marker rings, the other map's tab carries a dot, and its
  // chip opens that tab with the objective selected. On a phone the block
  // starts folded and opens on a tap. Ten minutes on it is gone, and a body
  // with only the score up after another long gap raises none.
  async function whatHappened() {
    const step = 'what happened';
    const label = await ev("document.querySelector('.tier-map-btn')?.getAttribute('aria-label') || ''");
    const t = /\b(NA|EU) Tier (\d+)/.exec(label);
    if (!t) return void problem(`step '${step}': no tier map button to read a match from`);
    const matchId = `${t[1] === 'NA' ? 1 : 2}-${t[2]}`;
    const oneUrl = `https://api.guildwars2.com/v2/wvw/matches?id=${matchId}`;
    // The score last rose now: earlier steps moved the clock back past it.
    const before = JSON.parse(await ev(`(() => { const k = newestMatches.get('${matchId}'); k.at = Date.now();
      return JSON.stringify(k.match); })()`));
    const serve = body => { const s = { body: Buffer.from(JSON.stringify(body)), served: 0 }; substitutes.set(oneUrl, s); return s; };
    const same = serve(before);
    let skew = 0;
    const later = async (ms, name) => {
      skew += ms;
      await ev(`__skewClock(${ms}); window.dispatchEvent(new Event('focus'))`);
      await idle(name);
    };
    const block = "document.querySelector('.info-popover .wvw-missed:not(.is-leaving)')";
    const cleanup = async () => {
      substitutes.delete(oneUrl);
      await send('Emulation.clearDeviceMetricsOverride');
      await closePopover(step);
      await ev(`__skewClock(${-skew}); localStorage.removeItem('wvw-fight-v1')`);
    };

    if (!(await click(step + ': open', "document.querySelector('.tier-map-btn')"))) return cleanup();
    if (!(await until(step, `!!document.querySelector("${POPOVERS['tier-map-btn']}")`, 'drawn objectives'))) return cleanup();
    await idle(step);
    for (let i = 0; i < 4; i++) await later(100000, step + ': same body');
    if (same.served < 4) problem(`step '${step}': the map asked ${same.served} time(s) over 400 s, wanted 4`);
    if (await ev(`!!${block}`)) problem(`step '${step}': the block showed while the body stood still`);

    // One objective taken here, one on another map, and kills on both.
    const here = await ev("document.querySelector('.info-popover .wvw-tab.is-active')?.dataset.type || ''");
    const other = (before.maps || []).map(m => m.type).find(type => type !== here);
    const OWNERS = ['Red', 'Blue', 'Green'];
    const takeable = m => (m?.objectives || []).filter(o => ['Camp', 'Tower', 'Keep'].includes(o.type)
      && OWNERS.includes(o.owner) && /^\d+-\d+$/.test(o.id));
    const drawn = await ev(`[...document.querySelectorAll('.info-popover .wvw-marker')].map(g => g.dataset.obj)`);
    const a = takeable(before.maps.find(m => m.type === here)).find(o => drawn.includes(o.id));
    const b = takeable(before.maps.find(m => m.type === other))[0];
    if (!a || !b) { problem(`step '${step}': no camp, tower or keep held on ${here} and ${other} to take`); return cleanup(); }
    const after = JSON.parse(JSON.stringify(before));
    const KILLS = { [here]: ['red', 37], [other]: ['blue', 15] };
    const taken = new Date(Date.parse(before.start_time) + 60000).toISOString().replace('.000Z', 'Z');
    for (const m of after.maps) {
      for (const o of m.objectives) {
        if (o.id === a.id || o.id === b.id) { o.owner = OWNERS[(OWNERS.indexOf(o.owner) + 1) % 3]; o.last_flipped = taken; }
      }
      const k = KILLS[m.type];
      if (k) { m.kills[k[0]] += k[1]; after.kills[k[0]] += k[1]; }
    }
    after.scores.red += 1;
    const killsMore = 37 + 15;
    serve(after);
    await later(31000, step + ': after');
    if (await until(step, `!!${block}`, 'the block after the gap')) {
      const seen = await ev(`(() => { const b = ${block};
        return { title: b.querySelector('.wvw-missed-title').textContent, open: b.classList.contains('is-open'),
          top: b === b.parentElement.firstElementChild && b.parentElement.classList.contains('wvw-side'),
          chips: [...b.querySelectorAll('.wvw-chip[data-obj]')].map(c => c.dataset.obj + ' ' + c.dataset.map),
          kills: b.querySelector('.wvw-missed-kills .wvw-missed-killn')?.textContent || '',
          rings: [...document.querySelectorAll('.info-popover .wvw-marker')].filter(g => g.querySelector('.wvw-ring')).map(g => g.dataset.obj),
          dots: [...document.querySelectorAll('.info-popover .wvw-tab')].filter(t => t.querySelector('.wvw-tab-dot')).map(t => t.dataset.type) }; })()`);
      const want = { chips: [`${a.id} ${here}`, `${b.id} ${other}`], kills: String(killsMore), rings: [a.id], dots: [other] };
      if (!/^What happened · \S/.test(seen.title) || !seen.open || !seen.top) problem(`step '${step}': the block reads "${seen.title}", open ${seen.open}, at the top of the column ${seen.top}`);
      // Over the tabs, and the board standing still beside it.
      const boardWith = `(() => { const p = document.querySelector('.info-popover');
        return Math.round(p.querySelector('.wvw-board').getBoundingClientRect().height) + '/' + Math.round(p.getBoundingClientRect().height)
          + '/' + (${block}.getBoundingClientRect().bottom <= p.querySelector('.wvw-subtabs').getBoundingClientRect().top); })()`;
      const with1 = await ev(boardWith);
      await sleep(2500);
      const with2 = await ev(boardWith);
      if (with1 !== with2 || !with1.endsWith('/true')) problem(`step '${step}': with the block shown the board/popover/block-over-tabs read ${with1}, then ${with2}`);
      for (const k of Object.keys(want)) {
        if (JSON.stringify(seen[k]) !== JSON.stringify(want[k])) problem(`step '${step}': ${k} ${JSON.stringify(seen[k])}, wanted ${JSON.stringify(want[k])}`);
      }
      // Pointed at, a chip of this map lights its objective alone; left, nothing.
      const lit = "[...document.querySelectorAll('.info-popover .wvw-marker.is-lit')].map(g => g.dataset.obj).join()";
      const at = await ev(`(() => { const e = document.querySelector('.info-popover .wvw-chip[data-obj="${a.id}"]');
        e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      if (await until(step + ': chip pointed at', `${lit} === '${a.id}'`, `${a.id} alone lit while its chip is pointed at`)) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
        await until(step + ': chip left', `${lit} === ''`, 'nothing lit once the chip is left');
      }
      if (await click(step + ': chip', `document.querySelector('.info-popover .wvw-chip[data-obj="${b.id}"]')`)) {
        await until(step, `!!document.querySelector('.info-popover .wvw-tab[data-type="${other}"].is-active')
          && !!document.querySelector('.info-popover .wvw-marker.is-selected[data-obj="${b.id}"]')
          && document.querySelector('.info-popover .wvw-subtab.is-active')?.dataset.pane === 'objective'
          && !document.querySelector('.info-popover .wvw-tab-dot')`, "the other map's tab open, its objective selected in the Objective tab, no dot left");
        await until(step + ': chip tapped', `${lit} === '${b.id}'`, `${b.id} lit a moment after its chip is pressed`);
      }
      // A phone: folded, the kills in its title; a tap opens it to the chips.
      await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
      if (await until(step + ', 360 px', `!!${block} && !${block}.classList.contains('is-open') && !${block}.querySelector('.wvw-chip')`, 'the block folded')) {
        const folded = await ev(`${block}.textContent`);
        if (!folded.includes(`${killsMore} kills`)) problem(`step '${step}, 360 px': folded it reads "${folded}", without the ${killsMore} kills`);
        if (await click(step + ', 360 px: open', `${block}.querySelector('.wvw-missed-head')`)) {
          await until(step + ', 360 px', `${block}.classList.contains('is-open') && ${block}.querySelectorAll('.wvw-chip[data-obj]').length === 2`, 'the block open with its two chips');
        }
      }
      await send('Emulation.clearDeviceMetricsOverride');
    }

    // Ten minutes on the same body: gone. Then the score alone up: nothing.
    for (let i = 0; i < 7; i++) await later(100000, step + ': ten minutes on');
    await until(step, `!${block}`, 'the block gone ten minutes after the data came back');
    const scoreOnly = JSON.parse(JSON.stringify(after));
    scoreOnly.scores.red += 1;
    serve(scoreOnly);
    await later(31000, step + ': score only');
    await sleep(1500);   // the popover's one-second repaint
    if (await ev(`!!${block} || missedNotes.has('${matchId}')`)) problem(`step '${step}': a body with only the score up raised the block`);
    await cleanup();
  }

  // The board picks what the map lights: a team's row, a type's column (the
  // Darken focus: the picked markers marked is-lit, the rest darkened), the
  // label "<Colour> only ✕" in place of "Objectives held", the row picked and
  // the team's segment of the bar glowing. Enter on the board picks too; Esc
  // and the ✕ let go, the popover staying open. A 30 s repaint that moves an
  // owner keeps the pick on every frame. At 1280 and 360 px.
  async function mapFocus() {
    const step = 'map focus';
    const label = await ev("document.querySelector('.tier-map-btn')?.getAttribute('aria-label') || ''");
    const t = /\b(NA|EU) Tier (\d+)/.exec(label);
    if (!t) return void problem(`step '${step}': no tier map button to read a match from`);
    const matchId = `${t[1] === 'NA' ? 1 : 2}-${t[2]}`;
    const oneUrl = `https://api.guildwars2.com/v2/wvw/matches?id=${matchId}`;
    // The score last rose now: earlier steps moved the clock back past it.
    const before = JSON.parse(await ev(`(() => { const k = newestMatches.get('${matchId}'); k.at = Date.now();
      return JSON.stringify(k.match); })()`));
    const serve = body => substitutes.set(oneUrl, { body: Buffer.from(JSON.stringify(body)), served: 0 });
    serve(before);
    let skew = 0;
    const cleanup = async () => {
      substitutes.delete(oneUrl);
      await send('Emulation.clearDeviceMetricsOverride');
      await closePopover(step);
      await ev(`__skewClock(${-skew}); localStorage.removeItem('wvw-fight-v1')`);
    };
    const WORD = { red: 'Red', blue: 'Blue', green: 'Green' };
    const pop = "document.querySelector('.info-popover')";
    // Everything the focus shows, read at once.
    const state = () => ev(`(() => {
      const pop = ${pop};
      const own = g => ([...g.classList].find(c => c.startsWith('own-')) || '').slice(4);
      const wrap = pop.querySelector('.wvw-plot-wrap');
      const head = pop.querySelector('.wvw-board-head');
      return {
        focused: pop.querySelector('.wvw-plot').classList.contains('is-focused'),
        veil: !!pop.querySelector('.wvw-focus-veil'),
        marks: [...pop.querySelectorAll('.wvw-marker')].map(g => ({ id: g.dataset.obj, own: own(g),
          type: objectiveCatalogue.get(g.dataset.obj)?.type || '', lit: g.classList.contains('is-lit') })),
        label: head.querySelector('.wvw-board-team').textContent,
        rows: [...pop.querySelectorAll('.wvw-board-row.is-picked')].map(r => r.dataset.focusColor || 'head'),
        pressed: [...pop.querySelectorAll('.wvw-board [aria-pressed="true"]')].map(e => (e.closest('[data-focus-color]')?.dataset.focusColor || '') + '/' + (e.dataset.focusType || '')),
        cols: [...head.querySelectorAll('.is-picked')].map(e => e.dataset.focusType),
        team: wrap.dataset.focusTeam || '',
        bar: Object.fromEntries([...wrap.querySelectorAll('.wvw-scorebar-seg')].map(s => [own(s), getComputedStyle(s).filter])) };
    })()`);
    // Lit exactly where want(marker) holds, the rest not, and at least one lit.
    const litCheck = (name, st, want, what) => {
      const wrong = st.marks.filter(m => m.lit !== want(m));
      if (wrong.length || !st.marks.some(m => m.lit)) problem(`step '${name}': ${what}: ${wrong.length ? wrong.length + ' marker(s) lit wrong, e.g. ' + JSON.stringify(wrong[0]) : 'nothing lit'}`);
      if (!st.focused || !st.veil) problem(`step '${name}': ${what}: the map is not darkened (is-focused ${st.focused}, veil ${st.veil})`);
    };
    const cleared = (name, st, what) => {
      if (st.marks.some(m => m.lit) || st.focused || st.veil || st.rows.length || st.cols.length || st.team || !/^(Objectives held|Held)$/.test(st.label)) {
        problem(`step '${name}': ${what} left ${JSON.stringify({ lit: st.marks.filter(m => m.lit).length, focused: st.focused, rows: st.rows, cols: st.cols, team: st.team, label: st.label })}`);
      }
      return ev(`!!${pop}`).then(open => { if (!open) problem(`step '${name}': ${what} closed the popover`); });
    };

    for (const width of [1280, 360]) {
      const name = `${step}, ${width} px`;
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 600 });
      await until(name, `innerWidth === ${width}`, 'the new width');
      await steady(name, "document.querySelector('.tier-map-btn')");
      if (!(await press(name + ': open', "document.querySelector('.tier-map-btn')"))) continue;
      if (!(await until(name, `!!document.querySelector("${POPOVERS['tier-map-btn']}") && !!document.querySelector('.info-popover .wvw-board-row[data-focus-color]')`, 'drawn objectives and the board'))) continue;
      await idle(name);
      const row = "document.querySelector('.info-popover .wvw-board-row[data-focus-color]')";
      const color = await ev(`${row}.dataset.focusColor`);
      const word = WORD[color];

      // A team's row.
      if (await press(name + ': row', `${row}.querySelector('.wvw-board-team')`)) {
        await until(name, `${pop}.querySelector('.wvw-plot').classList.contains('is-focused')`, 'the map focused on a team');
        // The bar eases over .2 s; a side scoring nothing on this map has no segment.
        const seg = `${pop}.querySelector('.wvw-scorebar-seg.own-${color}')`;
        await until(name, `!${seg} || /brightness\\(1\\.35\\)/.test(getComputedStyle(${seg}).filter)`, `the ${color} segment of the bar lit`);
        await sleep(300);
        const st = await state();
        litCheck(name, st, m => m.own === color, `${word} picked`);
        if (st.label !== `${word} only✕`) problem(`step '${name}': the label reads "${st.label}", wanted "${word} only✕"`);
        if (JSON.stringify(st.rows) !== JSON.stringify([color]) || JSON.stringify(st.pressed) !== JSON.stringify([`${color}/`])) problem(`step '${name}': picked rows ${JSON.stringify(st.rows)}, pressed ${JSON.stringify(st.pressed)}, wanted the ${color} row`);
        if (st.team !== color) problem(`step '${name}': the map's bar follows "${st.team}", wanted ${color}`);
        for (const [c, f] of Object.entries(st.bar)) {
          if (!(c === color ? /brightness\(1\.35\)/ : /brightness\(0\.5\)/).test(f)) problem(`step '${name}': the bar's ${c} segment has filter "${f}"`);
        }
        if (!(color in st.bar)) problem(`step '${name}': the bar has no ${color} segment to light`);
      }

      // A column: towers, whoever holds them.
      if (await press(name + ': tower column', `${pop}.querySelector('.wvw-board-head [data-focus-type="Tower"]')`)) {
        await until(name, `${pop}.querySelector('.wvw-board-head [data-focus-type="Tower"]').classList.contains('is-picked')`, 'the Tower column picked');
        const st = await state();
        litCheck(name, st, m => m.type === 'Tower', 'Tower picked');
        if (st.label !== 'Towers only✕' || st.rows.length || st.team) problem(`step '${name}': on Tower the label reads "${st.label}", rows ${JSON.stringify(st.rows)}, bar "${st.team}"`);
      }

      // Esc lets go and leaves the popover open.
      await escape();
      await until(name, `!${pop}.querySelector('.wvw-plot').classList.contains('is-focused')`, 'the focus gone on Esc');
      await cleared(name, await state(), 'Esc');

      // Enter on the team's name picks it; the ✕ lets go.
      await ev(`${row}.querySelector('.wvw-board-team').focus()`);
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
      }
      if (await until(name, `${row}.classList.contains('is-picked')`, 'the row picked by Enter')) {
        if (await press(name + ': ✕', `${pop}.querySelector('.wvw-focus-pill')`)) {
          await until(name, `!${pop}.querySelector('.wvw-focus-pill')`, 'the pill gone on its ✕');
          await cleared(name, await state(), 'the ✕');
        }
      }

      // Picked again, then a repaint that hands one of the team's objectives
      // to the next side: every frame keeps the pick, and the lost one goes dark.
      if (width === 1280 && await press(name + ': row again', `${row}.querySelector('.wvw-board-team')`)) {
        await until(name, `${row}.classList.contains('is-picked')`, 'the row picked again');
        const drawn = (await state()).marks.filter(m => m.lit && ['Camp', 'Tower', 'Keep'].includes(m.type)).map(m => m.id);
        const kept = JSON.parse(await ev(`JSON.stringify(newestMatches.get('${matchId}').match)`));
        const flip = kept.maps.flatMap(m => m.objectives).filter(o => drawn.includes(o.id) && /^\d+-\d+$/.test(o.id))
          .sort((a, b) => !!a.claimed_by - !!b.claimed_by)[0];
        if (!flip) { problem(`step '${name}': no camp, tower or keep of ${color} to hand over`); continue; }
        const next = { red: 'Blue', blue: 'Green', green: 'Red' }[color];
        for (const m of kept.maps) for (const o of m.objectives) if (o.id === flip.id) o.owner = next;
        kept.scores.red += 1;
        serve(kept);
        await ev(`window.__focusFrames = []; window.__focusWatch = true;
          (function look() {
            if (!window.__focusWatch) return;
            const p = document.querySelector('.info-popover');
            __focusFrames.push(!!p && p.querySelector('.wvw-plot').classList.contains('is-focused')
              && !!p.querySelector('.wvw-focus-pill') && !!p.querySelector('.wvw-board-row.is-picked'));
            requestAnimationFrame(look);
          })()`);
        skew += 31000;
        await ev("__skewClock(31000); window.dispatchEvent(new Event('focus'))");
        await until(name, `!!${pop}.querySelector('.wvw-marker.own-${next.toLowerCase()}[data-obj="${flip.id}"]')`, 'the handed-over objective repainted');
        await ev('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
        const frames = await ev('window.__focusWatch = false; window.__focusFrames');
        if (!frames.length || frames.some(f => !f)) problem(`step '${name}': the pick was missing on ${frames.filter(f => !f).length} of ${frames.length} frames around the repaint`);
        const st = await state();
        litCheck(name, st, m => m.own === color, `${word} picked, after the repaint`);
        if (st.marks.find(m => m.id === flip.id)?.lit) problem(`step '${name}': ${flip.id}, handed to ${next}, is still lit`);
        if (JSON.stringify(st.rows) !== JSON.stringify([color]) || st.team !== color || st.label !== `${word} only✕`) problem(`step '${name}': after the repaint rows ${JSON.stringify(st.rows)}, bar "${st.team}", label "${st.label}"`);
        await idle(name);
      }

      await chooseRules(name, width, matchId);
      await closePopover(name);
    }
    await cleanup();
  }

  // What the board's pick does when the map in view holds none of it, applied
  // at the click only: one case per rule, counted from the body the page holds,
  // the way the page counts. (1) the view holds some: stays. (2) one other map
  // holds some: goes there. (3) several do: goes to the one with most (a tie:
  // tab order), the note names the rest and its button goes there. (4) no map
  // holds any: nothing darkens and the note says so.
  async function chooseRules(name, width, matchId) {
    const nm = `${name}, where the pick lands`;
    const pop = "document.querySelector('.info-popover')";
    const SEL = {
      row: c => `.info-popover .wvw-board-row[data-focus-color="${c}"] .wvw-board-team`,
      cell: (c, t) => `.info-popover .wvw-board-row[data-focus-color="${c}"] [data-focus-type="${t}"]`,
      col: t => `.info-popover .wvw-board-head [data-focus-type="${t}"]` };
    const specs = [];
    for (const c of ['red', 'blue', 'green']) specs.push({ color: c, type: null, sel: SEL.row(c) });
    for (const t of ['Camp', 'Tower', 'Keep', 'Castle']) specs.push({ color: null, type: t, sel: SEL.col(t) });
    for (const c of ['red', 'blue', 'green']) for (const t of ['Camp', 'Tower', 'Keep', 'Castle']) specs.push({ color: c, type: t, sel: SEL.cell(c, t) });
    const cat = JSON.parse(await ev("JSON.stringify([...objectiveCatalogue.values()].map(m => [m.id, m.map_id, m.type]))"));
    const bodyNow = async () => JSON.parse(await ev(`JSON.stringify(newestMatches.get('${matchId}').match)`));
    const tabs = async () => JSON.parse(await ev(`JSON.stringify([...${pop}.querySelectorAll('.wvw-tab')].map(b => [b.dataset.type, b.textContent]))`));
    const tally = (body, spec, order) => Object.fromEntries(order.map(type => {
      const m = body.maps.find(x => x.type === type);
      const held = new Map((m.objectives || []).map(o => [o.id, o.owner]));
      return [type, cat.filter(([id, map, t]) => map === m.id && t !== 'Spawn'
        && (!spec.color || String(held.get(id) || 'neutral').toLowerCase() === spec.color) && (!spec.type || t === spec.type)).length];
    }));
    const active = () => ev(`${pop}.querySelector('.wvw-tab.is-active')?.dataset.type || ''`);
    const view = () => ev(`(() => { const p = ${pop}; const n = p.querySelector('.wvw-focus-note');
      return { tab: p.querySelector('.wvw-tab.is-active')?.dataset.type || '', note: n ? n.textContent : '', lit: p.querySelectorAll('.wvw-marker.is-lit').length,
        veil: !!p.querySelector('.wvw-focus-veil'), pill: !!p.querySelector('.wvw-focus-pill'),
        said: p.querySelector(':scope > .sr-only[role="status"]')?.textContent || '' }; })()`);
    const goTab = async type => {
      if ((await active()) !== type) await press(nm, `${pop}.querySelector('.wvw-tab[data-type="${type}"]')`);
      await until(nm, `${pop}.querySelector('.wvw-tab.is-active')?.dataset.type === '${type}' && !!${pop}.querySelector('.wvw-marker')`, `the ${type} tab drawn`);
      await idle(nm);
    };
    const letGo = async () => { if (await ev(`!!${pop}.querySelector('.wvw-focus-pill')`)) await press(nm, `${pop}.querySelector('.wvw-focus-pill')`); };
    const pick = async (start, spec) => {
      await letGo();
      await goTab(start);
      await press(nm, `document.querySelector('${spec.sel}')`);
      await until(nm, `!!${pop}.querySelector('.wvw-focus-pill')`, 'the pick made');
      // A map not drawn yet shows "Loading"; the pick waits for its markers.
      await until(nm, `!!${pop}.querySelector('.wvw-marker')`, 'the map after the pick');
      await sleep(200);
      return view();
    };
    const label = (spec, start, to) => `${spec.color || 'any'}/${spec.type || 'any'} from ${start}${to ? ' to ' + to : ''}`;
    const order = (await tabs()).map(t => t[0]);
    const short = Object.fromEntries(await tabs());
    const body = await bodyNow();
    const found = { 1: null, 2: null, 3: null };
    for (const start of order) for (const spec of specs) {
      const n = tally(body, spec, order);
      const have = order.filter(t => n[t] > 0);
      if (!found[1] && n[start] > 0 && have.length > 1) found[1] = { start, spec, n };
      if (!found[2] && !n[start] && have.length === 1) found[2] = { start, spec, n };
      if (!found[3] && !n[start] && have.length > 1) found[3] = { start, spec, n };
    }
    for (const r of [1, 2, 3]) if (!found[r]) problem(`step '${nm}': the recorded body has no case for rule ${r} (${width} px)`);

    if (found[1]) {
      const { start, spec } = found[1];
      const v = await pick(start, spec);
      if (v.tab !== start || !v.lit || !v.veil || v.note) problem(`step '${nm}': rule 1 ${label(spec, start)}: ${JSON.stringify(v)}, wanted to stay with some lit and no note`);
    }
    if (found[2]) {
      const { start, spec, n } = found[2];
      const to = order.find(t => n[t] > 0);
      const v = await pick(start, spec);
      if (v.tab !== to || !v.lit || !v.veil || v.note) problem(`step '${nm}': rule 2 ${label(spec, start, to)}: ${JSON.stringify(v)}, wanted the ${to} tab, some lit, no note`);
      if (!v.said) problem(`step '${nm}': rule 2: the switch was not said in the status line`);
    }
    if (found[3]) {
      const { start, spec, n } = found[3];
      const have = order.filter(t => n[t] > 0);
      const to = have.reduce((b, t) => (n[t] > n[b] ? t : b), have[0]);
      const rest = have.filter(t => t !== to);
      const v = await pick(start, spec);
      const wantNote = 'also ' + rest.map(t => `${n[t]} on ${short[t]}`).join(', ');
      if (v.tab !== to || !v.lit || !v.veil || v.note !== wantNote) problem(`step '${nm}': rule 3 ${label(spec, start, to)} ${JSON.stringify(n)}: ${JSON.stringify(v)}, wanted the ${to} tab, some lit, note "${wantNote}"`);
      if (!v.said) problem(`step '${nm}': rule 3: the switch was not said in the status line`);
      if (await ev(`!!${pop}.querySelector('.wvw-focus-note button')`)) {
        await press(nm, `${pop}.querySelector('.wvw-focus-note button')`);
        await until(nm, `${pop}.querySelector('.wvw-tab.is-active')?.dataset.type === '${rest[0]}'`, `the note's button going to ${rest[0]}`);
        await until(nm, `!!${pop}.querySelector('.wvw-marker')`, 'the map after the note');
        await sleep(200);
        const w = await view();
        if (!w.lit || !w.pill) problem(`step '${nm}': rule 3: after the note's button, ${JSON.stringify(w)}, wanted some lit and the pick kept`);
      } else problem(`step '${nm}': rule 3: the note has no button`);
    }

    // Rule 4: every castle is Blue's, so Red's castles are nowhere.
    await letGo();
    const none = JSON.parse(JSON.stringify(body));
    for (const m of none.maps) for (const o of m.objectives) if (o.type === 'Castle') o.owner = 'Blue';
    none.scores.red += 5;
    const spec = { color: 'red', type: 'Castle', sel: SEL.cell('red', 'Castle') };
    if (Object.values(tally(none, spec, order)).some(x => x)) return void problem(`step '${nm}': the made-up body still has Red castles`);
    await closePopover(nm);
    substitutes.set(`https://api.guildwars2.com/v2/wvw/matches?id=${matchId}`, { body: Buffer.from(JSON.stringify(none)), served: 0 });
    if (!(await press(nm + ': open', "document.querySelector('.tier-map-btn')"))) return;
    if (!(await until(nm, `!!document.querySelector("${POPOVERS['tier-map-btn']}") && !!${pop}.querySelector('.wvw-board-row[data-focus-color]')`, 'the map reopened'))) return;
    await until(nm, `newestMatches.get('${matchId}').match.scores.red >= ${none.scores.red}`, 'the made-up body taken');
    await sleep(400);
    const start = order[order.length - 1];
    const v = await pick(start, spec);
    if (v.tab !== start || v.veil || v.lit || !v.pill || v.note !== 'None on any map right now') problem(`step '${nm}': rule 4 ${label(spec, start)}: ${JSON.stringify(v)}, wanted to stay, nothing darkened, note "None on any map right now"`);
    if (await ev(`${pop}.querySelector('.wvw-plot').classList.contains('is-focused')`)) problem(`step '${nm}': rule 4: the map is darkened`);
  }

  // The column beside the map: three tabs, Board, Captures and Objective, over
  // one pane that keeps its size. The board stands still for 6 s and its box
  // hugs its rows; a marker opens the Objective tab without the popover or the
  // map moving on any frame; the captures are the body's own, in the 30 min up
  // to its newest, and a row lights its objective on its map; beside the map
  // every box ends above the map's bottom, stacked under it every tab ends on
  // the same line, the map on top and still; fifteen switches change nothing.
  // A map tab change keeps the board on the freshest body. At 1280 and 360 px.
  async function mapPane() {
    const step = 'map pane';
    const label = await ev("document.querySelector('.tier-map-btn')?.getAttribute('aria-label') || ''");
    const t = /\b(NA|EU) Tier (\d+)/.exec(label);
    if (!t) return void problem(`step '${step}': no tier map button to read a match from`);
    const matchId = `${t[1] === 'NA' ? 1 : 2}-${t[2]}`;
    const oneUrl = `https://api.guildwars2.com/v2/wvw/matches?id=${matchId}`;
    // The score last rose now: earlier steps moved the clock back past it.
    const before = JSON.parse(await ev(`(() => { const k = newestMatches.get('${matchId}'); k.at = Date.now();
      return JSON.stringify(k.match); })()`));
    const serve = body => substitutes.set(oneUrl, { body: Buffer.from(JSON.stringify(body)), served: 0 });
    serve(before);
    let skew = 0;
    const cleanup = async () => {
      substitutes.delete(oneUrl);
      await send('Emulation.clearDeviceMetricsOverride');
      await closePopover(step);
      await ev(`__skewClock(${-skew}); localStorage.removeItem('wvw-fight-v1')`);
    };
    // The captures the list must show, worked out here from the same body.
    const OWNERS = ['Red', 'Blue', 'Green'];
    const flips = before.maps.flatMap(m => m.objectives.map(o => ({ id: o.id, type: o.type, owner: o.owner, map: m.type, at: Date.parse(o.last_flipped) })));
    const newest = Math.max(...flips.map(o => o.at).filter(Number.isFinite));
    const wantCaps = flips.filter(o => ['Camp', 'Tower', 'Keep', 'Castle'].includes(o.type) && OWNERS.includes(o.owner)
      && o.at <= newest && newest - o.at <= 30 * 60000).sort((a, b) => (b.at - a.at) || a.id.localeCompare(b.id));
    if (!wantCaps.length) return void problem(`step '${step}': the recording has no capture in its last 30 min to list`);

    const pop = "document.querySelector('.info-popover')";
    const frame = 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))';
    // Everything the pane shows and where, read at once.
    const state = () => ev(`(() => {
      const p = ${pop};
      const r = e => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) }; };
      const shown = [...p.querySelectorAll('.wvw-pane > *')].filter(e => getComputedStyle(e).display !== 'none');
      const board = p.querySelector('.wvw-board');
      return {
        tabs: [...p.querySelectorAll('.wvw-subtab')].map(b => ({ text: b.textContent, on: b.classList.contains('is-active'), off: b.disabled })),
        shown: shown.map(e => e.className.split(' ')[0]), box: shown[0] ? r(shown[0]) : null,
        pop: r(p), plot: r(p.querySelector('.wvw-plot-wrap')), tabsBar: r(p.querySelector('.wvw-subtabs')), pane: r(p.querySelector('.wvw-pane')),
        board: board.offsetParent ? Math.round(board.getBoundingClientRect().height) : 0,
        rows: [...board.children].reduce((n, c) => n + c.offsetHeight, 0),
        caps: [...p.querySelectorAll('.wvw-caps .wvw-cap')].map(c => c.dataset.obj),
        map: p.querySelector('.wvw-tab.is-active')?.dataset.type || '',
        lit: [...p.querySelectorAll('.wvw-marker.is-lit')].map(g => g.dataset.obj).join(),
        selected: p.querySelector('.wvw-marker.is-selected')?.dataset.obj || '' };
    })()`);
    // n readings 'every' ms apart, of one field.
    const samples = async (n, every, pick) => { const v = []; for (let i = 0; i < n; i++) { if (i) await sleep(every); v.push(pick(await state())); } return v; };
    const active = st => (st.tabs.find(x => x.on) || {}).text || '';
    const tab = key => `${pop}.querySelector('.wvw-subtab[data-pane="${key}"]')`;
    // A marker on the open map whose centre takes the click (not under a corner or the zoom).
    const marker = n => `[...${pop}.querySelectorAll('.wvw-plot .wvw-marker')].filter(g => {
      const b = g.getBoundingClientRect(), e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!e && g.contains(e) && !e.closest('.wvw-zoom, .wvw-hud');
    })[${n}]`;
    // Pressed with every frame watched for 1.5 s after: the popover's top and
    // height and the map's top, as one set of distinct readings.
    const pressWatched = async (name, el) => {
      await steady(name, el);
      const at = await ev(`(() => { const e = ${el}; if (!e) return null; const b = e.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      if (!at) { problem(`step '${name}': target missing`); return null; }
      await ev(`(() => { window.__paneSeen = new Set(); const t0 = performance.now();
        const look = () => { const p = ${pop}; const a = p.getBoundingClientRect(), m = p.querySelector('.wvw-plot-wrap').getBoundingClientRect();
          __paneSeen.add(Math.round(a.top) + ',' + Math.round(a.height) + ',' + Math.round(m.top));
          if (performance.now() - t0 < 1500) requestAnimationFrame(look); };
        requestAnimationFrame(look); })()`);
      const ms = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...ms });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...ms });
      await sleep(1600);
      return ev('[...window.__paneSeen]');
    };

    for (const width of [1280, 360]) {
      const name = `${step}, ${width} px`;
      const stacked = width <= 760;
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width < 600 });
      await until(name, `innerWidth === ${width}`, 'the new width');
      await ev(frame);
      if (!(await press(name + ': open', "document.querySelector('.tier-map-btn')"))) continue;
      if (!(await until(name, `!!document.querySelector("${POPOVERS['tier-map-btn']}") && !!${pop}.querySelector('.wvw-subtab') && !!${pop}.querySelector('.wvw-board-row')`, 'drawn objectives and the tabs'))) continue;
      await idle(name);
      await ev(frame);
      const home = (await state()).map;

      // The tabs, in order; the board first, the objective off until one is picked.
      let st = await state();
      const order = st.tabs.map(x => x.text.replace(/ \(\d+\)$/, '')).join();
      if (order !== 'Board,Captures,Objective') problem(`step '${name}': the tabs read ${order}`);
      if (active(st) !== 'Board' || !st.tabs[2].off || st.tabs[0].off || st.tabs[1].off) problem(`step '${name}': on opening ${JSON.stringify(st.tabs)}`);
      if (st.tabs[1].text !== `Captures (${wantCaps.length})`) problem(`step '${name}': the tab reads "${st.tabs[1].text}", wanted "Captures (${wantCaps.length})"`);
      // Standing still: the board measured once, never again (it grew 2 px a second when it was).
      const boardH = await samples(6, 1000, x => `${x.board}/${x.pop.height}`);
      if (new Set(boardH).size !== 1) problem(`step '${name}': the board (height/popover) moved over 6 s: ${boardH.join(' ')}`);
      st = await state();
      if (st.board - st.rows >= 40) problem(`step '${name}': the board is ${st.board} px for ${st.rows} px of rows`);
      const popH = st.pop.height, board0 = st.board, ends = {};
      ends.board = st.box && st.box.bottom;
      const pane0 = st.pane.bottom;

      // A marker: the Objective tab opens by itself, nothing moves on any frame.
      const seen = await pressWatched(name + ': marker', marker(3));
      if (seen && seen.length !== 1) problem(`step '${name}': picking an objective moved the popover or the map: ${seen.join(' ; ')}`);
      if (await until(name, `${pop}.querySelector('.wvw-subtab.is-active')?.dataset.pane === 'objective'`, 'the Objective tab opened by the marker')) {
        const det = await samples(4, 500, x => `${x.box && x.box.height}/${x.pop.height}`);
        if (new Set(det).size !== 1) problem(`step '${name}': the objective (height/popover) moved: ${det.join(' ')}`);
        st = await state();
        if (JSON.stringify(st.shown) !== '["wvw-detail"]' || st.tabs[2].off) problem(`step '${name}': on Objective the pane shows ${JSON.stringify(st.shown)}`);
        if (Math.abs(st.pop.height - popH) > 4) problem(`step '${name}': the popover went from ${popH} to ${st.pop.height} px on opening an objective`);
        ends.objective = st.box && st.box.bottom;
      }
      // Back to the board: the same board.
      if (await press(name + ': board', tab('board'))) {
        await ev(frame);
        const back = await samples(3, 500, x => x.board);
        if (new Set(back).size !== 1 || Math.abs(back[0] - board0) > 2) problem(`step '${name}': the board came back ${back.join(',')} px, was ${board0}`);
      }
      // Captures: the body's own, still.
      if (await press(name + ': captures', tab('captures'))) {
        await ev(frame);
        st = await state();
        const want = wantCaps.slice(0, 40).map(o => o.id);
        if (JSON.stringify(st.caps) !== JSON.stringify(want)) problem(`step '${name}': the captures listed ${st.caps.slice(0, 6).join(',')}… (${st.caps.length}), wanted ${want.slice(0, 6).join(',')}… (${want.length})`);
        const capsH = await samples(3, 500, x => x.box && x.box.height);
        if (new Set(capsH).size !== 1) problem(`step '${name}': the captures moved: ${capsH.join(',')}`);
        ends.captures = (await state()).box?.bottom;
        // A capture on this map lights its objective, the list staying.
        const here = wantCaps.find(o => o.map === home);
        const picked = (await state()).selected;
        if (here && await press(name + ': a capture here', `${pop}.querySelector('.wvw-cap[data-obj="${here.id}"]')`)) {
          if (await until(name, `[...${pop}.querySelectorAll('.wvw-marker.is-lit')].map(g => g.dataset.obj).join() === '${here.id}'`, `${here.id} lit by its capture`)) {
            st = await state();
            if (!active(st).startsWith('Captures') || st.selected !== picked) problem(`step '${name}': a capture's row left the tab on "${active(st)}", selected "${st.selected}" (was "${picked}")`);
          }
        }
        // One on another map opens that map's tab and lights it there.
        const away = width === 1280 && wantCaps.find(o => o.map !== home);
        if (away && await press(name + ': a capture elsewhere', `${pop}.querySelector('.wvw-cap[data-obj="${away.id}"]')`)) {
          await until(name, `${pop}.querySelector('.wvw-tab.is-active')?.dataset.type === '${away.map}'
            && [...${pop}.querySelectorAll('.wvw-marker.is-lit')].map(g => g.dataset.obj).join() === '${away.id}'
            && ${pop}.querySelector('.wvw-subtab.is-active')?.dataset.pane === 'captures'`, `${away.map} open, ${away.id} lit, the captures still shown`);
          await idle(name);
          if (await press(name + ': back home', `${pop}.querySelector('.wvw-tab[data-type="${home}"]')`)) {
            await until(name, `${pop}.querySelector('.wvw-tab.is-active')?.dataset.type === '${home}' && !!document.querySelector("${POPOVERS['tier-map-btn']}")`, `${home} open again`);
            await idle(name);
          }
        }
      }
      // Where each tab ends: under the map, one line; beside it, above the map's bottom.
      if (await press(name + ': board again', tab('board'))) await ev(frame);
      st = await state();
      if (stacked) {
        const lines = Object.values(ends);
        if (st.pane.bottom !== pane0 || lines.some(b => !b || b > st.pane.bottom)) problem(`step '${name}': the tabs end at ${JSON.stringify(ends)}, the pane at ${st.pane.bottom} (was ${pane0})`);
      } else if (Object.values(ends).some(b => !b || b > st.plot.bottom + 1)) {
        problem(`step '${name}': the tabs end at ${JSON.stringify(ends)}, past the map's bottom ${st.plot.bottom}`);
      }

      // Three objectives picked in turn, each watched frame by frame.
      for (const n of [2, 6, 10]) {
        const moved = await pressWatched(`${name}: marker ${n}`, marker(n));
        if (moved && moved.length !== 1) problem(`step '${name}': picking marker ${n} moved the popover or the map: ${moved.join(' ; ')}`);
      }
      await until(name, `${pop}.querySelector('.wvw-subtab.is-active')?.dataset.pane === 'objective'`, 'the Objective tab after the markers');

      // Fifteen switches: the board and the popover as they were. On a phone
      // the map on top, its top the same in every tab, the tabs and pane under it.
      const seenBoard = new Set(), seenPop = new Set(), mapTops = new Set();
      for (let i = 0; i < 5; i++) {
        for (const key of ['objective', 'captures', 'board']) {
          if (!(await click(`${name}: switch ${key}`, tab(key)))) break;
          await until(name, `${pop}.querySelector('.wvw-subtab.is-active')?.dataset.pane === '${key}'`, `the ${key} tab`);
          await ev(frame);
          st = await state();
          seenPop.add(st.pop.height);
          if (key === 'board') seenBoard.add(st.board);
          if (stacked) {
            mapTops.add(st.plot.top);
            if (!(st.tabsBar.top > st.plot.bottom && st.box && st.box.top > st.tabsBar.bottom)) problem(`step '${name}': on ${key} the map is not on top (map ${st.plot.top}-${st.plot.bottom}, tabs ${st.tabsBar.top}, pane ${st.box && st.box.top})`);
          }
        }
      }
      if (seenBoard.size !== 1 || Math.abs([...seenBoard][0] - board0) > 2 || [...seenPop].some(h => Math.abs(h - popH) > 4)) problem(`step '${name}': over 15 switches the board read ${[...seenBoard]} (was ${board0}), the popover ${[...seenPop]} (was ${popH})`);
      if (stacked && mapTops.size !== 1) problem(`step '${name}': the map moved with the tabs: tops ${[...mapTops]}`);

      // A refresh moves the board; a map tab change keeps it there.
      if (!stacked) {
        const kept = JSON.parse(await ev(`JSON.stringify(newestMatches.get('${matchId}').match)`));
        const flip = kept.maps.flatMap(m => m.objectives).find(o => o.type === 'Camp' && OWNERS.includes(o.owner));
        if (flip) {
          const boardText = `${pop}.querySelector('.wvw-board').textContent`;
          const was = await ev(boardText);
          for (const m of kept.maps) for (const o of m.objectives) if (o.id === flip.id) o.owner = OWNERS[(OWNERS.indexOf(o.owner) + 1) % 3];
          kept.scores.red += 1;
          serve(kept);
          skew += 31000;
          await ev("__skewClock(31000); window.dispatchEvent(new Event('focus'))");
          if (await until(name, `${boardText} !== ${JSON.stringify(was)}`, 'the board repainted by the refresh')) {
            await idle(name);
            const now = await ev(boardText);
            const other = kept.maps.map(m => m.type).find(type => type !== home);
            if (await press(name + ': another map', `${pop}.querySelector('.wvw-tab[data-type="${other}"]')`)) {
              await until(name, `${pop}.querySelector('.wvw-tab.is-active')?.dataset.type === '${other}' && !!document.querySelector("${POPOVERS['tier-map-btn']}")`, `${other} open`);
              await idle(name);
              const after = await ev(boardText);
              if (after !== now) problem(`step '${name}': a map tab change put the board back to "${after.slice(0, 80)}", the refresh had "${now.slice(0, 80)}"`);
            }
          }
          serve(before);
        }
      }
      await closePopover(name);
    }
    await cleanup();
  }

  // The walk, the same for the recording and for the replay: whatever it asks
  // of the hosts, the recording has. Recording picks the guild names first.
  recordedAt = RECORD ? Date.now() : recordedAt;
  if (!(await load('load'))) return finishWalk();

  if (RECORD) {
    guilds = await ev(`(async () => {
      const out = [];
      for (const region of ['na', 'eu']) {
        const table = await (await fetch('https://api.guildwars2.com/v2/wvw/guilds/' + region)).json();
        const keys = Object.keys(table).sort(() => Math.random() - 0.5);
        for (const id of keys.slice(0, 20)) {
          const r = await fetch('https://api.guildwars2.com/v2/guild/' + id);
          const g = r.ok ? await r.json() : null;
          if (g && g.name && !/[\\n\\r]/.test(g.name)) { out.push(g.name); break; }
        }
      }
      return out;
    })()`);
    if (guilds.length < 2) problem(`record: found ${guilds.length} guild name(s) for NA and EU, wanted 2`);
  }
  // What the first load showed of the relink: the 503 load must still show it.
  const notice = "getComputedStyle(document.getElementById('teamsNotice')).display !== 'none'"
    + " || getComputedStyle(document.getElementById('relinkBanner')).display !== 'none'";
  const hadNotice = await ev(notice);

  // 3b. Partial lists and tiers from two weeks, while the kept bodies are the recorded ones.
  await partialLists();

  // 4. NA/EU swap, and back.
  const first = () => ev('document.documentElement.dataset.railFirst');
  const was = await first();
  if (await click('swap NA/EU', "document.querySelector('.rail-swap')")) {
    await until('swap NA/EU', `document.documentElement.dataset.railFirst !== '${was}'`, 'swapped columns (data-rail-first unchanged)');
    await until('swap NA/EU', `document.querySelector('.rail-left #standingsGrid${was === 'na' ? 'EU' : 'NA'}') && document.querySelector('.rail-right #standingsGrid${was === 'na' ? 'NA' : 'EU'}')`, 'columns on their new sides');
    if (await click('swap back', "document.querySelector('.rail-swap')")) {
      await until('swap back', `document.documentElement.dataset.railFirst === '${was}'`, 'columns back on their sides');
    }
  }

  // 1. Guild search: one name per region, typed as a visitor does.
  await ev("document.getElementById('guildInput').focus()");
  await send('Input.insertText', { text: guilds.join('\n') });
  // Watches what the search does to the standings, so the step below does
  // not depend on catching the blink in a poll.
  await ev(`window.__found = { flash: false, strip: null, gone: false };
    new MutationObserver(() => {
      const f = window.__found;
      if (document.querySelector('.guild-found-flash')) f.flash = true;
      const s = document.querySelector('.guild-found-strip');
      if (s) { f.strip = s.textContent; f.gone = false; }
      else if (f.strip) f.gone = true;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })`);
  if (await click('search', "document.getElementById('runBtn')")) {
    await until('search', "/^Done/.test(document.getElementById('statusMsg').textContent)", 'the "Done" status');
    await until('search', "document.querySelectorAll('#resultBody tr').length > 0 && !!document.querySelector('#matchPanelsContainer > *')", 'result rows and match panels');
    await until('search', "!document.getElementById('runBtn').disabled", 'the Check button enabled again');
    await idle('search');

    // 1b. The team the first guild landed on: its card blinks, the page brings
    // it into view, a strip names the guild, and the strip leaves by itself.
    const step = 'guild found';
    await until(step, "window.__found.flash && !!window.__found.strip", 'the found team\'s card blinking and the strip appearing');
    const named = await ev("(() => { const tr = [...document.querySelectorAll('#resultBody tr')].find(r => r.querySelector('.server-cell')); return tr ? tr.cells[0].textContent : null; })()");
    const said = await ev('window.__found.strip');
    if (named === null || said.toLowerCase() !== `${named} \u00b7 from your search`.toLowerCase()) problem(`step '${step}': the strip reads "${said}", wanted "${named} \u00b7 from your search"`);
    await until(step, `(() => { const s = document.querySelector('.guild-found-strip'); if (!s) return true;
      const b = s.previousElementSibling.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; })()`, 'the found team\'s card in view');
  }

  // 2 and 3. Every icon button, maps and popovers.
  await iconButtons();

  // 6. The corners over a map, while the page's kept bodies are the recorded ones.
  await mapCorners();

  // The map board and the phone: the team names get room back,
  // the map's tabs and zoom buttons are 34 px targets, the map's popover has
  // no shrink button and the alliances popover keeps its own. At 320 and 360 px.
  async function phoneBoard() {
    const step = 'phone board';
    for (const width of [320, 360]) {
      const name = `${step}, ${width} px`;
      // Not a mobile viewport: that one widens to fit anything past its edge,
      // and this step measures the board at this width, not the page's.
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await until(name, `innerWidth === ${width}`, 'the new width');
      await steady(name, "document.querySelector('.tier-map-btn')");
      if (!(await press(name + ': open', "document.querySelector('.tier-map-btn')"))) continue;
      if (!(await until(name, "!!document.querySelector('.info-popover .wvw-board-row[data-focus-color]') && !!document.querySelector('.info-popover .wvw-zoom button')", 'the board and the zoom buttons'))) continue;
      await idle(name);
      await steady(name, "document.querySelector('.info-popover .wvw-board')");
      const m = await ev(`(() => {
        const pop = document.querySelector('.info-popover');
        const names = [...pop.querySelectorAll('.wvw-board-row[data-focus-color] .wvw-board-team')];
        const small = sel => [...pop.querySelectorAll(sel)].map(e => { const b = e.getBoundingClientRect(); return Math.round(Math.min(b.width, b.height)); });
        return { names: names.length, room: Math.min(...names.map(n => n.clientWidth)),
          head: pop.querySelector('.wvw-board-head .wvw-board-team').textContent,
          tabs: small('.wvw-tab'), zoom: small('.wvw-zoom button'), shrink: !!pop.querySelector('.info-popover-expand'), close: !!pop.querySelector('.info-popover-close') };
      })()`);
      // Names still end in an ellipsis when long; what counts is the room they
      // get: 16 px at 320 and 53 px at 360 before the board gave it back.
      const floor = width === 320 ? 30 : 65;
      if (!(m.room >= floor)) problem(`step '${name}': the team names get ${m.room}px of room, wanted ${floor} or more`);
      if (m.head !== 'Held') problem(`step '${name}': the board header reads "${m.head}", wanted "Held"`);
      if (!m.tabs.length || !m.zoom.length || m.tabs.some(h => h < 34) || m.zoom.some(h => h < 34)) problem(`step '${name}': tabs ${JSON.stringify(m.tabs)} and zoom ${JSON.stringify(m.zoom)} should all be 34 px or more`);
      if (m.shrink || !m.close) problem(`step '${name}': the map popover has ${m.shrink ? 'a shrink button' : 'no close button'}`);
      await closePopover(name);
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await until(step, 'innerWidth === 1280', 'the wide width back');
    await steady(step, "document.querySelector('.server-guilds-btn')");
    if (await ev("!!document.querySelector('.server-guilds-btn')")) {
      if (await press(step + ': alliances open', "document.querySelector('.server-guilds-btn')")) {
        await until(step, "!!document.querySelector('.info-popover .info-popover-body')", 'the alliances popover');
        if (!(await ev("!!document.querySelector('.info-popover .info-popover-expand')"))) problem(`step '${step}': the alliances popover lost its expand button`);
        await closePopover(step);
      }
    } else problem(`step '${step}': no alliances button to look at`);
    await send('Emulation.clearDeviceMetricsOverride');
  }

  // 6b. The tiers whose data is old.
  await tierMarks();

  // 6c. The result table on a phone: no column cut off, nothing past the screen.
  const tagLine = await ev(`Math.max(0, ...[...document.querySelectorAll('#resultCard .tag')].map(t => Math.round(t.getBoundingClientRect().height)))`);
  for (const width of [320, 390]) {
    const step = `result table, ${width} px`;
    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
    await idle(step);
    const fit = await ev(`(() => {
      const card = document.getElementById('resultCard');
      const cells = [...card.querySelectorAll('th, td, .server-cell, .server-cell *')];
      return { scroll: card.scrollWidth - card.clientWidth,
        past: Math.max(0, ...cells.map(c => Math.round(c.getBoundingClientRect().right - innerWidth))),
        beyond: Math.max(0, ...cells.map(c => Math.round(c.getBoundingClientRect().right - card.getBoundingClientRect().right))) };
    })()`);
    const tags = await ev(`JSON.stringify([...document.querySelectorAll('#resultCard .tag')].map(t => Math.round(t.getBoundingClientRect().height)))`);
    if (JSON.parse(tags).some(h => h > tagLine)) problem(`step '${step}': a tag is wider than one line (heights ${tags}, one line is ${tagLine}px)`);
    if (fit.scroll > 0 || fit.past > 0 || fit.beyond > 0) problem(`step '${step}': the table overflows its card by ${fit.scroll}px, ${fit.past}px past the screen, a cell ${fit.beyond}px past the card's edge`);
    await send('Emulation.clearDeviceMetricsOverride');
  }

  // 1b, last part: the strip of the guild search leaves by itself.
  await until('guild found', "window.__found.gone && !document.querySelector('.guild-found-flash, .guild-found-strip')", 'the strip leaving by itself');

  // 6b. The kill history backdating a match this page never saw move.
  await historyAge();

  // 6d. The maps' summary of a gap: what changed hands and the kills. In this
  // load, whose maps have all been opened: a new load would ask for guild
  // tactics in an order the recording does not hold.
  await whatHappened();
  await whatHappenedRules();

  // 6d2. The skirmish trend with the body frozen partway through a block.
  await skirmishStalled();

  // 6e. The board picks a team or a type, and the map lights it.
  await mapFocus();
  await phoneBoard();

  // 6f. Board, Captures and Objective: three tabs over one pane that keeps its size.
  await mapPane();

  // 7. A frozen answer: some API servers serve a match body from the past.
  await frozenMatch();

  // 7a. The first hours of a week: tied VP, no deaths.
  await freshWeek();

  // 7b. Last week's tier and this week's, and a team the API does not hold yet.
  await mixedWeeks();

  // 7c. The week's line-up between loads.
  await weekMemory();

  // 7d. A 429 is not kept against a guild; a skipped refresh does not spend its turn.
  await guildCache();
  await guildLimit();

  // 8a. A visitor acting before the last scripts have loaded.
  await earlyActions();

  // 8. A failed load, tried again.
  await failedLoad();

  // 8b. /api/latest: a newer body wins, a bad one is ignored, a 503 or a hang costs nothing.
  await latestSecondRead();

  // 5. A second load, /api/* answering 503: the page falls back to the sheets.
  apiDown = true;
  // The page keeps guild names in localStorage on a timer; what that timer got
  // to would decide which guild URLs the second load asks for.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.removeItem('wvw-guilds-v1'); } catch {}" });
  if (await load('load with /api down')) {
    if (!apiRefused) problem("step 'load with /api down': the page never asked /api");
    if (!sheetReads) problem("step 'load with /api down': the page never read the sheets instead");
    if (hadNotice) await until('relink notice from the sheets', notice, 'the relink notice');
  }
  finishWalk();

  function finishWalk() {
    if (RECORD) {
      if (!problems.length) {
        // A recording is only good if the replay of it passes: the page's
        // lookups can depend on how slow the real hosts were that day.
        const before = existsSync(RECORDINGS) ? readFileSync(RECORDINGS) : null;
        saveRecordings();
        console.log(`recorded ${recorded.size} responses (${statSync(RECORDINGS).size} bytes gzipped) at ${new Date(recordedAt).toISOString()}; guilds: ${guilds.join(' | ')}`);
        console.log('replaying it to check it holds...');
        const replay = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...(ci >= 0 ? ['--chrome', argv[ci + 1]] : [])], { stdio: 'inherit' });
        if (replay.status !== 0) {
          if (before) writeFileSync(RECORDINGS, before); else rmSync(RECORDINGS);
          problem('the new recording does not replay (the old one is back); record again');
        }
      }
    } else if (!problems.length) {
      console.log(`walked: ${clicked.size} kinds of popover, tiers NA ${got.NA}/${want.NA}, EU ${got.EU}/${want.EU}`);
    }
    report();
  }
}

