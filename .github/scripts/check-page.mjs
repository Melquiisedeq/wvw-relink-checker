// Loads the page in a real Chrome, with the API and the sheets answered from a
// recording, walks it as a visitor would (guild search, every map, every icon
// button and popover, the NA/EU swap, a map answered with the same body for
// minutes, a frozen match answer that must not be painted, a load whose API reads fail and are tried again, then a second load with /api/* down), and
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
// A guard against a hang, not a speed bar: the walk takes ~47 s here, and a
// shared CI machine can be twice as slow. Recording waits on the real hosts.
const DEADLINE_MS = RECORD ? 240000 : 180000;
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
  // /api/agora, the page's second read of the matches: 'down' answers 503 (the
  // walk's default), 'serve' answers `agoraBody`, 'hang' never answers.
  let agoraMode = 'down', agoraBody = null, agoraReads = 0;
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
      if (isApi && url.slice(base.length) === '/api/agora' && request.method !== 'OPTIONS') {
        agoraReads++;
        if (agoraMode === 'hang') return;   // the page's own deadline ends it
        if (agoraMode === 'serve' && !apiDown) return await reply(requestId, 200, 'application/json', agoraBody);
        return await reply(requestId, 503, 'application/json', Buffer.from('{"error":"down"}'));
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
        const refused = (apiDown && /\/api\//.test(e.url || '')) || /\/api\/agora$/.test(e.url || '') || (failingLog && failingLog.test(e.url || ''));   // the 503 we sent on purpose
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

  // Evaluate in the page; a throw there is an error here.
  async function ev(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
  // its own centre (so a covering overlay fails the step), then press and
  // release the mouse there over the protocol. Not el.click(): that would
  // fire the handler even where a visitor could not reach the button.
  async function click(name, el) {
    stepNow = name;
    const t0 = Date.now();
    let r;
    while (true) {
      r = await ev(`(() => {
        const el = ${el};
        if (!el) return { gone: true };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const b = el.getBoundingClientRect();
        if (!b.width || !b.height) return { hidden: true };
        const x = b.left + b.width / 2, y = b.top + b.height / 2, top = document.elementFromPoint(x, y);
        return { x, y, hit: !!top && (top === el || el.contains(top)), over: top ? top.tagName + '.' + top.className : 'nothing' };
      })()`);
      if (r.hit) break;
      if (r.gone || r.hidden || Date.now() - t0 > 3000) {
        problem(`step '${name}': ${r.gone ? 'target missing' : r.hidden ? 'target has no size' : 'target covered by ' + r.over}`);
        return false;
      }
      await sleep(50);
    }
    const at = { x: r.x, y: r.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
    return true;
  }

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
    if (await click(step + ': zoom in', "document.querySelector('.info-popover .wvw-zoom button')")) {
      await until(step, `!(${shown('.wvw-hud-r')})`, 'corners hidden while zoomed');
      if (await click(step + ': home', "document.querySelector('.info-popover .wvw-zoom button:last-child')")) {
        await until(step, shown('.wvw-hud-r'), 'corners back after "home"');
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

  // /api/agora: gzip + base64 bodies of the live matches. One is made newer
  // (score up), one is offered under another match's id, one under an id the
  // game never gave; only the first may reach the page.
  async function agoraSecondRead() {
    const step = 'agora';
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

    agoraMode = 'serve'; agoraBody = Buffer.from(body); agoraReads = 0;
    if (await load(step + ': newer')) {
      if (!agoraReads) problem(`step '${step}': the page never asked /api/agora`);
      if (await scoreOf(a.id) !== sum(a) + 5000) problem(`step '${step}': the newer body of ${a.id} did not reach the page (${await scoreOf(a.id)}, wanted ${sum(a) + 5000})`);
      if (await scoreOf(b.id) !== sum(b)) problem(`step '${step}': a body under the wrong id changed ${b.id}`);
      if (await known) problem(`step '${step}': an id the game never gave was kept`);
    }
    // Garbage in every field the page checks: nothing may change, nothing may be said.
    agoraBody = Buffer.from(JSON.stringify({ at: 0, matches: [
      { id: a.id, start: Date.parse(a.start_time), gz: 'not base64 !' },
      { id: a.id, start: Date.parse(a.start_time), gz: gzipSync(Buffer.from('{not json')).toString('base64') },
      { id: a.id, start: Date.parse(a.start_time) + 1, gz: entry(a.id, bump(a, 5000)).gz },
      { id: a.id, start: Date.parse(a.start_time), gz: gzipSync(Buffer.alloc(300 * 1024, 32)).toString('base64') },
    ] }));
    if (await load(step + ': garbage') && await scoreOf(a.id) !== sum(a)) problem(`step '${step}': a bad /api/agora entry changed ${a.id}`);

    agoraMode = 'down'; agoraReads = 0;
    const t0 = Date.now();
    const downOk = await load(step + ': 503');
    const baseMs = Date.now() - t0;
    if (downOk && !agoraReads) problem(`step '${step}': the page never asked /api/agora`);
    if (downOk && await scoreOf(a.id) !== sum(a)) problem(`step '${step}': the numbers moved with /api/agora down`);

    // Hung: tiers must be up about as fast as with the 503. Timed to the tiers,
    // not to quiet: the page's own deadline closes the request later.
    agoraMode = 'hang'; agoraReads = 0;
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
    if (!up) problem(`step '${step}': tiers never appeared with /api/agora hung`);
    else if (!agoraReads) problem(`step '${step}': the page never asked /api/agora (hung)`);
    else if (hangMs > baseMs + 2500) problem(`step '${step}': a hung /api/agora slowed the tiers to ${hangMs} ms (503: ${baseMs} ms)`);
    await idle(step + ': hang');
    agoraMode = 'down';
  }

  // The tiers in the standings: one whose match has answered the same score for
  // over 15 min ends its card with "\u26a0 No new data for N min", outside the
  // title row; the others wear nothing; a higher score takes it off; the number
  // moves with the minute tick and, at 320 px wide, no title row spills over.
  async function tierMarks() {
    const step = 'tier marks';
    const allUrl = 'https://api.guildwars2.com/v2/wvw/matches?ids=all';
    const allHit = recorded.get(allUrl);
    if (!allHit) return void problem(`step '${step}': ${allUrl} not recorded`);
    const all = JSON.parse(bodyOf(allHit).toString('utf8'));
    const live = all.find(x => x.id.startsWith('1-'));
    if (!live) return void problem(`step '${step}': no NA match in the recording`);
    const marks = `[...document.querySelectorAll('.standing-match')].map(b => {
      const m = b.querySelector('.tier-age');
      return {
        tier: b.querySelector('.standing-match-title span')?.textContent,
        region: b.closest('.standings-grid').id,
        mark: m?.textContent || '',
        nodes: m ? m.childNodes.length : 0,
        last: !!m && b.lastElementChild === m,
        inTitle: !!b.querySelector('.standing-match-title .tier-age'),
        title: m?.title || '' };
    })`;
    const markOf = (rows, region, tier) => rows.find(r => r.region === region && r.tier === tier);
    const tier = `Tier ${live.id.split('-')[1]}`;
    await ev("__skewClock(600000); localStorage.removeItem('wvw-fight-v1')");
    // 0. The recorded bodies again, 600 s later: past the map's 6 min, short of the
    // table's 15, so no tier wears a mark yet.
    substitutes.set(allUrl, { body: bodyOf(allHit), served: 0 });
    await ev('loadStandings()');
    await idle(step);
    let rows = await ev(marks);
    if (!rows.length) return void problem(`step '${step}': no tiers in the standings`);
    if (rows.some(r => r.mark)) problem(`step '${step}': a tier wears a mark after only 600 s of the same body`);
    // 1. 1600 s in all: past 15 min even for the tier first seen last, every tier is marked.
    await ev('__skewClock(1000000); updateTierAges()');
    rows = await ev(marks);
    for (const r of rows) {
      if (!/^\u26a0 No new data for \d+ min$/.test(r.mark) || r.nodes !== 1 || !r.last || r.inTitle || !r.title.includes('No new data from the game')) problem(`step '${step}': ${r.region} ${r.tier} wears "${r.mark}" (${r.nodes} nodes, last ${r.last}, in the title ${r.inTitle}) / "${r.title}" after 1600 s of the same body`);
    }
    const first = markOf(rows, 'standingsGridNA', tier).mark;
    // 2. The minute tick moves the number.
    await ev("__skewClock(120000); updateTierAges()");
    rows = await ev(marks);
    if (markOf(rows, 'standingsGridNA', tier).mark === first) problem(`step '${step}': "${first}" did not move two minutes later`);
    // 3. One match answers a higher score: its mark goes, the others stay.
    const bumped = { ...live, scores: { ...live.scores, red: (Number(live.scores?.red) || 0) + 1 } };
    substitutes.set(allUrl, { body: Buffer.from(JSON.stringify(all.map(x => (x.id === live.id ? bumped : x)))), served: 0 });
    await ev('loadStandings()');
    await idle(step);
    rows = await ev(marks);
    if (markOf(rows, 'standingsGridNA', tier).mark) problem(`step '${step}': ${tier} still wears its mark after a higher score`);
    if (rows.length > 1 && !rows.some(r => r.mark)) problem(`step '${step}': the other tiers lost their marks with it`);
    // 4. The mark back, 320 px wide: no tier box wider than the screen.
    await ev("__skewClock(500000); updateTierAges()");
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 800, deviceScaleFactor: 1, mobile: true });
    await idle(step + ': 320 px');
    const spill = await ev(`(() => ({
      page: Math.max(0, ...[...document.querySelectorAll('.standing-match')].map(b => Math.round(b.getBoundingClientRect().right - innerWidth))),
      rows: [...document.querySelectorAll('.standing-match-title')].filter(t => t.scrollWidth > t.clientWidth).length,
      tall: [...document.querySelectorAll('.standing-match-title')].filter(t => t.offsetHeight > 24).length,
      marks: [...document.querySelectorAll('.tier-age')].filter(m => m.scrollWidth > m.clientWidth).length }))()`);
    if (spill.page > 0 || spill.rows || spill.tall || spill.marks) problem(`step '${step}': at 320 px a tier box spills ${spill.page}px, ${spill.rows} title row(s) overflow, ${spill.tall} grew taller, ${spill.marks} mark(s) overflow`);
    await send('Emulation.clearDeviceMetricsOverride');
    substitutes.delete(allUrl);
    await ev("__skewClock(-2220000); localStorage.removeItem('wvw-fight-v1')");
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
  if (await click('search', "document.getElementById('runBtn')")) {
    await until('search', "/^Done/.test(document.getElementById('statusMsg').textContent)", 'the "Done" status');
    await until('search', "document.querySelectorAll('#resultBody tr').length > 0 && !!document.querySelector('#matchPanelsContainer > *')", 'result rows and match panels');
    await until('search', "!document.getElementById('runBtn').disabled", 'the Check button enabled again');
    await idle('search');
  }

  // 2 and 3. Every icon button, maps and popovers.
  await iconButtons();

  // 6. The corners over a map, while the page's kept bodies are the recorded ones.
  await mapCorners();

  // 6b. The tiers whose data is old.
  await tierMarks();

  // 6b. The kill history backdating a match this page never saw move.
  await historyAge();

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

  // 8a. A visitor acting before the last scripts have loaded.
  await earlyActions();

  // 8. A failed load, tried again.
  await failedLoad();

  // 8b. /api/agora: a newer body wins, a bad one is ignored, a 503 or a hang costs nothing.
  await agoraSecondRead();

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

