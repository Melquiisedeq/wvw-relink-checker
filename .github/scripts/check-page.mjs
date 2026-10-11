// Loads the page in a real Chrome, with the API and the sheets answered from a
// recording, walks it as a visitor would (the maps, a map answered with the same body for
// minutes, what changed hands over such a gap summed up beside the map, the
// board picking what the map lights, the Board, Captures and Objective tabs
// beside it keeping their size, a frozen match answer that must not be painted),
// and fails on anything the browser objects to: an exception, a console error, a
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
// shared CI machine can be slower; the 'corners by the data clock' step adds
// about 50 s (300-325 s in total, 10/10/2026). Recording waits on the real hosts.
const DEADLINE_MS = RECORD ? 480000 : 420000;
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
  // The guild tactics a map asks for are the ones its match holds that no map
  // opened before it asked for, so the address depends on the order maps are
  // opened in. Replaying, an unrecorded list of ids is answered from the
  // tactics the recording holds, one by one, in the order asked.
  const TACTICS_URL = 'https://api.guildwars2.com/v2/guild/upgrades?ids=';
  // /api/latest, the page's second read of the matches, answers 503 here and
  // its summary nothing; the states of it are in .github/e2e/latest.spec.mjs.

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
        return await reply(requestId, 503, 'application/json', Buffer.from('{"error":"down"}'));
      }
      // The summary the page peeks at: {} when nothing is kept, as the Worker answers when empty.
      if (isApi && url.slice(base.length) === '/api/latest/summary' && request.method !== 'OPTIONS') {
        return await reply(requestId, 200, 'application/json', Buffer.from('{}'));
      }
      if (isApi && !own) {
        problem(`unknown /api route, not fetched: ${url}`);
        return await send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
      }
      if (request.method === 'OPTIONS') return await send('Fetch.fulfillRequest', { requestId, responseCode: 204,
        responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' }] });
      if (BLOCKED.test(url)) return await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      if (url.startsWith('https://render.guildwars2.com/')) return await reply(requestId, 200, 'image/png', PNG);
      const swap = substitutes.get(url);
      if (swap) {
        swap.served++;
        return await reply(requestId, 200, 'application/json; charset=utf-8', swap.body);
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
      if (!RECORD && url.startsWith(TACTICS_URL) && !recorded.has(url)) {
        const want = url.slice(TACTICS_URL.length).split(',');
        const known = new Map();
        for (const [key, e] of recorded) {
          if (!key.startsWith(TACTICS_URL)) continue;
          for (const t of JSON.parse(bodyOf(e).toString('utf8'))) known.set(String(t.id), t);
        }
        if (!want.every(i => /^\d{1,6}$/.test(i) && known.has(i))) {
          problem(`not answered: ${url} during step '${stepNow}' (a tactic the recording does not hold)`);
          return await send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        }
        return await reply(requestId, 200, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(want.map(i => known.get(i)))));
      }
      if (own || EXTERNAL.test(url)) {
        const key = own || url;
        if (RECORD) await record(key);
        const hit = recorded.get(key);
        if (!hit) {
          problem(`not recorded: ${key} during step '${stepNow}' - re-record with --record`);
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
        const refused = /\/api\/latest$/.test(e.url || '');   // the 503 we sent on purpose
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

  // The page after a navigation, not the one before it. Page.navigate answers
  // when the load has started: until the new document is `complete` every
  // script of the page, `matchDataCache` among them, may not have run, and a
  // question asked then reads the old document or a half-built one (CI: main,
  // run 248, "matchDataCache is not defined"). `navigateAndSettle` marks the
  // old document, navigates, and `settled` waits for an unmarked one that has
  // finished loading; the scripts are synchronous, so `complete` is the page's
  // own "everything ran". Not for a load a step holds on purpose.
  async function navigate() {
    await ev('window.__checkPageOld = true').catch(() => {});
    await send('Page.navigate', { url: base + '/' });
  }
  async function settled(name) {
    const t0 = Date.now();
    while (true) {
      try {
        if (await ev("!window.__checkPageOld && document.readyState === 'complete'")) return true;
      } catch (e) {
        if (!/navigated or closed|context was destroyed|Cannot find context/.test(e.message)) throw e;
      }
      if (Date.now() - t0 > 30000) { problem(`step '${name}': the new document never finished loading`); return false; }
      await sleep(25);
    }
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
  async function load(name) {
    loaded = false;
    ids.clear();
    await navigate();
    await settled(name);
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

  // What a tier map's popover must hold once it has finished loading.
  const POPOVERS = { 'tier-map-btn': ".info-popover .wvw-plot g[role='button']" };
  const NO_POPOVER = "!document.querySelector('.info-popover')";

  async function closePopover(name) {
    if (await ev(NO_POPOVER)) return;
    if (!(await click(name + ' close', "document.querySelector('.info-popover .info-popover-close')"))) return escape();
    await until(name, NO_POPOVER, 'closing popover (it stayed open)');
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
    if (!(await until(step, shown('.wvw-hud-r'), '"data from" corner'))) return;
    if (!/^data from \d/.test(await ev(text('.wvw-hud-ago')))) problem(`step '${step}': the corner does not start with "data from"`);
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
      if (/^\d+$/.test(big) && !/^kills (· \d+ min|in \d+ min)$/.test(small)) problem(`step '${step}': the corner reads "${big}" with "${small}", a count with no window`);
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
    await until(step, `${q('.wvw-hud-ago.is-stale')} && /^\u26a0 data from \\d/.test(${text('.wvw-hud-ago')})`, 'amber "data from" after 6 min of the same body');
    if (!/No new map data for/.test(await ev(text('.wvw-hud-live')))) problem(`step '${step}': the gap was not spoken`);
    // Stale data claims no fight: no swords on a tab, and the kills corner is neutral -
    // either a dash with only "kills" (no window), or the last count dimmed with
    // two lines, "N kills in M min" over "\u26a0 data up to HH:MM" (never a bare 0 from no window).
    if (await ev(`!!document.querySelector('.info-popover .wvw-tab.is-hot')`)) problem(`step '${step}': swords still show on a tab on stale data`);
    const frozen = await ev(`(() => {
      return { shown: ${shown('.wvw-hud-l')}, cold: !!${q('.wvw-hud-l.is-cold')}, dim: !!${q('.wvw-hud-l.is-dim')},
        big: ${text('.wvw-hud-big')}, small: ${q('.wvw-hud-small')}.innerText,
        line2: ${q('.wvw-hud-small2')}?.hidden === false ? ${q('.wvw-hud-small2')}.textContent : '',
        when: ${q('.wvw-hud-small2 time')}?.dateTime || '' };
    })()`);
    const dash = frozen.big === '\u2013' && frozen.small === 'kills' && !frozen.dim;
    const dimmed = /^\d+$/.test(frozen.big) && /^kills in \d+ min$/.test(frozen.small) && /^\u26a0\sdata up to \S+( \S+)?$/.test(frozen.line2) && frozen.dim && Number.isFinite(Date.parse(frozen.when));
    if (!frozen.shown || !frozen.cold || !(dash || dimmed)) problem(`step '${step}': on stale data the kills corner reads ${JSON.stringify(frozen)}, wanted a neutral dash or the last count dimmed over "\u26a0 data up to HH:MM"`);
    // The score one point up: new data, the corner back to a plain "data from".
    const bumped = { ...one, scores: { ...one.scores, red: (Number(one.scores?.red) || 0) + 1 } };
    substitutes.set(oneUrl, { body: Buffer.from(JSON.stringify(bumped)), served: 0 });
    await ev("__skewClock(31000); window.dispatchEvent(new Event('focus'))");
    await until(step, `${q('.wvw-hud-ago')} && !${q('.wvw-hud-ago.is-stale')} && /^data from \\d/.test(${text('.wvw-hud-ago')})`, '"data from" unmarked again on a higher score');
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
      if (!(await ev(`!!${q('.wvw-hud-ago.is-stale')} && /^⚠ data from /.test(${text('.wvw-hud-ago')})`))) problem(`step '${step}': the corner did not open amber`);
      if ((await ev(text('.wvw-hud-big'))) !== '–') problem(`step '${step}': the kills corner is not a dash on opening`);
      // The score up, on the kept body: back to a plain "data from".
      const bumped = await ev(`(() => { const m = JSON.parse(JSON.stringify(newestMatches.get('${matchId}').match));
        m.scores.red = (Number(m.scores.red) || 0) + 1; return JSON.stringify(m); })()`);
      substitutes.set(`https://api.guildwars2.com/v2/wvw/matches?id=${matchId}`, { body: Buffer.from(bumped), served: 0 });
      await ev("__skewClock(31000); window.dispatchEvent(new Event('focus'))");
      await until(step, `${q('.wvw-hud-ago')} && !${q('.wvw-hud-ago.is-stale')} && /^data from \\d/.test(${text('.wvw-hud-ago')})`, '"data from" unmarked again on a higher score');
      substitutes.delete(`https://api.guildwars2.com/v2/wvw/matches?id=${matchId}`);
      await closePopover(step);
    }

    await reset(30 * 60000, 30 * 60000);
    if (await ev(kept) > 60000) problem(`step '${step}': a history with every line old moved the match's time`);
    if (await open(step + ': all old')) {
      if (await ev(`!!${q('.wvw-hud-ago.is-stale')}`) || !/^data from /.test(await ev(text('.wvw-hud-ago')))) problem(`step '${step}': a history with every line old turned the corner amber`);
      await closePopover(step);
    }
    substitutes.delete(killsUrl);
  }

  // The map's two corners by the data's clock: the kills window is the reading
  // nearest to 10 min before the kills' own clock, 8 to 15 min back or a dash;
  // old kills take two lines ("data up to" when the API is behind, "no new
  // kills since" on a quiet map); a jump after the kills stood still lights no
  // swords and says so; the right corner says "data from HH:MM" in the
  // viewer's time zone. The history and the score time are planted in the
  // page, and the kept body is served back for the match so nothing replaces them.
  async function cornersByClock() {
    const step = 'corners by the data clock';
    const label = await ev("document.querySelector('.tier-map-btn')?.getAttribute('aria-label') || ''");
    const t = /\b(NA|EU) Tier (\d+)/.exec(label);
    if (!t) return void problem(`step '${step}': no tier map button to read a match from`);
    const matchId = `${t[1] === 'NA' ? 1 : 2}-${t[2]}`;
    const matchUrl = `https://api.guildwars2.com/v2/wvw/matches?id=${matchId}`;
    const q = sel => `document.querySelector('.info-popover .wvw-plot-wrap ${sel}')`;
    const text = sel => `(${q(sel)}?.textContent || '')`;
    const shown = sel => `(() => { const e = ${q(sel)}; return !!e && !!e.offsetParent && !e.hidden; })()`;
    // Times are in ms before now. `top`: when the kills reached their newest
    // total (+`add` on Center), `base`: how far before that the other reading
    // is, `still`: a reading between the two with the older total (the kills
    // stood still), `rose`: how long ago the score last rose, `startAgo`: the week's start.
    const scenarios = {
      nine: { top: 20e3, base: 9 * 60e3, add: 70, rose: 0 },
      twenty: { top: 20e3, base: 20 * 60e3, add: 200, rose: 0 },
      gap: { top: 20e3, base: 65 * 60e3, add: 700, rose: 0 },
      gapLate: { top: 40 * 60e3, base: 65 * 60e3, add: 700, rose: 40 * 60e3 },
      gapQuiet: { top: 8 * 60e3, base: 65 * 60e3, add: 30, rose: 0 },
      late: { top: 40 * 60e3, base: 10 * 60e3, add: 70, rose: 40 * 60e3 },
      quiet: { top: 8 * 60e3, base: 10 * 60e3, add: 30, rose: 0 },
      jumpOn: { top: 20e3, base: 15 * 60e3, add: 155, rose: 0, still: 5 * 60e3 },
      jumpLong: { top: 20e3, base: 25 * 60e3, add: 155, rose: 0, still: 5 * 60e3 },
      jumpSmall: { top: 20e3, base: 12 * 60e3, add: 30, rose: 0, still: 5 * 60e3 },
      reset: { none: true, startAgo: 12 * 60e3 },
      nodata: { none: true },
    };
    const plant = async (name) => {
      await ev("localStorage.removeItem('wvw-fight-v1')");
      const body = await ev(`(() => {
        const sc = ${JSON.stringify(scenarios[name])};
        const now = Date.now();
        const k = newestMatches.get('${matchId}');
        const T = fightTotals(k.match);
        const row = (age, bonus) => ({ at: now - age, n: Object.fromEntries(KILLS_MAP_ORDER.map(ty => [ty, (T[ty] || 0) + (ty === 'Center' ? bonus : 0)])) });
        const list = [];
        if (!sc.none) {
          list.push(row(sc.top + sc.base, 0));
          if (sc.still) list.push(row(sc.top + sc.still, 0));
          list.push(row(sc.top, sc.add));
        }
        killSheet = new Map([['${matchId}', list]]);
        killSheetAt = now;
        k.rose = true;
        k.at = now - (sc.rose || 0);
        k.match.start_time = new Date(now - (sc.startAgo || 4 * 86400e3)).toISOString();
        return JSON.stringify(k.match);
      })()`);
      substitutes.set(matchUrl, { body: Buffer.from(body), served: 0 });
    };
    const open = async (name) => {
      if (!(await click(name + ': open', "document.querySelector('.tier-map-btn')"))) return false;
      if (!(await until(name, `!!document.querySelector("${POPOVERS['tier-map-btn']}")`, 'drawn objectives'))) return false;
      await idle(name);
      await click(name + ': Center tab', "document.querySelector('.info-popover .wvw-tab[data-type=\"Center\"]')");
      return await until(name, `${shown('.wvw-hud-l')} && ${shown('.wvw-hud-r')}`, 'both corners');
    };
    const corner = () => ev(`(() => ({
      big: ${text('.wvw-hud-big')}, small: ${q('.wvw-hud-small')}.innerText,
      two: !!${q('.wvw-hud-small2')} && !${q('.wvw-hud-small2')}.hidden, line2: ${q('.wvw-hud-small2')}?.hidden === false ? ${text('.wvw-hud-small2')} : '',
      dim: !!${q('.wvw-hud-l.is-dim')}, cold: !!${q('.wvw-hud-l.is-cold')},
      swords: !!document.querySelector('.info-popover .wvw-tab.is-hot'), right: ${text('.wvw-hud-ago')},
      when: ${q('.wvw-hud-ago')}?.dateTime || '' }))()`);
    // The balloon of a corner, opened by a tap and closed again.
    const balloon = async (name, side) => {
      const btn = `document.querySelector('.info-popover .wvw-hud-${side} .wvw-hud-btn')`;
      if (!(await click(name + `: ${side} balloon`, btn))) return '';
      const said = await ev("document.querySelector('.info-popover .wvw-hud-note')?.textContent || ''");
      await click(name + `: ${side} balloon closed`, btn);
      return said;
    };

    await send('Emulation.setTimezoneOverride', { timezoneId: 'America/Sao_Paulo' });
    for (const name of ['nine', 'twenty', 'gap', 'gapLate', 'gapQuiet', 'late', 'quiet', 'jumpOn', 'jumpLong', 'jumpSmall', 'reset', 'nodata']) {
      await plant(name);
      const label = `${step}: ${name}`;
      if (!(await open(label))) { await closePopover(label); continue; }
      const c = await corner();
      const bad = what => problem(`step '${label}': ${what}, the corner reads ${JSON.stringify(c)}`);
      if (name === 'nine') {
        // A reading 9 min back is a window: the minutes are the real ones, one line.
        if (!/^\d+$/.test(c.big) || c.small !== 'kills · 9 min' || c.two || c.cold || !c.swords) bad('a base 9 min back should count, on one line, with swords');
        // The right corner: the viewer's own time zone, and the balloon starts with the last check.
        const want = await ev(`new Date('${c.when}').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })`);
        if (c.right !== `data from ${want}`) bad(`the right corner should read "data from ${want}"`);
        if (await ev(`new Date('${c.when}').getUTCHours() === new Date('${c.when}').getHours()`)) bad('the time is not in the viewer\'s zone (the same hour as UTC)');
        const tip = await balloon(label, 'r');
        if (!/^Checked \d+ (s|min) ago: this page asks the game's API every 30 s\. Data from /.test(tip) || !tip.includes(`Data from ${want}:`)) problem(`step '${label}': the right balloon reads "${tip}"`);
      }
      // No reading 8 to 15 min back: the newest one at least 10 min back, the real span in two lines, no swords.
      if (['twenty', 'gap', 'gapLate', 'gapQuiet'].includes(name)) {
        const mins = name === 'twenty' ? 20 : 65;
        const late = name === 'gapLate';
        const lead = name === 'gapQuiet' ? 'no new kills since' : 'data up to';
        if (!/^\d+$/.test(c.big) || c.small !== `kills in ${mins} min` || !c.two || c.dim !== late
          || !new RegExp(`^${late ? '\\u26a0\\s' : ''}${lead} \\S+( \\S+)?$`).test(c.line2)) bad(`a base ${mins} min back should take two lines, "kills in ${mins} min" over "${late ? '⚠ ' : ''}${lead} HH:MM"`);
        if (c.swords) bad('a window over 15 min should light no swords');
        const tip = await balloon(label, 'l');
        if (!/ The window is longer than 10 minutes because the game's API stopped sending data between \S+( \S+)? and \S+( \S+)?\./.test(tip)) problem(`step '${label}': the long window's balloon reads "${tip}"`);
      }
      if (name === 'late') {
        if (!/^\d+$/.test(c.big) || c.small !== 'kills in 10 min' || !c.two || !c.dim || !/^⚠\sdata up to \S+( \S+)?$/.test(c.line2)) bad('stalled data should take two lines, "kills in 10 min" over "⚠ data up to HH:MM", dimmed');
        if (!/^⚠ data from /.test(c.right)) bad('the right corner should carry the warning sign past 6 min');
        if (c.swords) bad('a stalled match should light no swords');
      }
      if (name === 'quiet') {
        if (!/^\d+$/.test(c.big) || c.small !== 'kills in 10 min' || !c.two || c.dim || !/^no new kills since \S+( \S+)?$/.test(c.line2)) bad('a quiet map should take two lines, "kills in 10 min" over "no new kills since HH:MM", not dimmed');
        if (/^⚠/.test(c.right)) bad('a quiet map with a fresh score should not warn on the right');
      }
      // A jump after a stall: the swords light when the stall was at most 20 min and the kills spread over it
      // still make 50 per 10 min; otherwise not, and the balloon says why.
      if (name === 'jumpOn' && (!c.swords || c.cold || !/^\d+$/.test(c.big))) bad('155 kills after a 15 min stall should light the swords');
      if (name === 'jumpLong' || name === 'jumpSmall') {
        if (c.swords) bad(name === 'jumpLong' ? 'a jump after a 25 min stall should light no swords' : '30 kills after 12 min should light no swords');
        const tip = await balloon(label, 'l');
        const mins = name === 'jumpLong' ? 25 : 12;
        if (!tip.endsWith(` The last jump came after the game's API sent nothing for ${mins} min, so when those kills happened is unknown; it lights no swords.`)) problem(`step '${label}': the balloon does not say why there are no swords: "${tip}"`);
      }
      if (name === 'reset' || name === 'nodata') {
        if (c.big !== '–' || c.small !== 'kills') bad('no reading should give a dash');
        const tip = await balloon(label, 'l');
        const want = name === 'reset' ? /^Counting starts about 10 minutes after the reset: /.test(tip) : tip === 'Not enough kill data to count 10 minutes.';
        if (!want) problem(`step '${label}': the dash balloon reads "${tip}"`);
      }
      // The same states on a phone: nothing past the corners' room either side of the score bar.
      if (['late', 'quiet', 'nine', 'gap'].includes(name)) {
        for (const width of [390, 320]) {
          await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: true });
          await idle(`${label}, ${width} px`);
          const room = await ev(`(() => {
            const r = s => { const e = document.querySelector('.info-popover .wvw-plot-wrap ' + s); return e && e.offsetParent ? e.getBoundingClientRect() : null; };
            const l = r('.wvw-hud-l .wvw-hud-btn'), rt = r('.wvw-hud-r .wvw-hud-btn'), bar = r('.wvw-scorebar');
            return { left: l && bar ? Math.round(l.right - bar.left) : null, right: rt && bar ? Math.round(bar.right - rt.left) : null,
              page: document.documentElement.scrollWidth - innerWidth };
          })()`);
          if (room.left === null || room.right === null) problem(`step '${label}, ${width} px': a corner or the score bar is missing`);
          else if (room.left > 0 || room.right > 0 || room.page > 0) problem(`step '${label}, ${width} px': a corner reaches ${room.left}px / ${room.right}px into the score bar, the page spills ${room.page}px`);
        }
        await send('Emulation.clearDeviceMetricsOverride');
      }
      await closePopover(label);
    }
    await send('Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
    substitutes.delete(matchUrl);
    await ev("localStorage.removeItem('wvw-fight-v1'); killSheetAt = 0");
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
      const after = (base) => {
        const m = base ? JSON.parse(JSON.stringify(base)) : clone(); const taken = [];
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
      const sheetWas = killSheet;
      const logWas = localStorage.getItem(FIGHT_KEY);
      localStorage.removeItem(FIGHT_KEY);
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
        // A newer body while the summary is up: it follows the newest data.
        n.open = true; n.wideOpen = false;
        const newer = JSON.parse(JSON.stringify(r.m)); newer.maps[0].kills.red += 9; newer.scores.red += 20;
        missedMatchOffered(newer, { match: r.m, at: now });
        n = missedNotes.get(id);
        check('a newer body did not update the summary', !!n && n.kills === 59 && n.perMap.reduce((t, m) => t + m.n, 0) === 59, n && n.kills);
        check('a newer body reset what the reader had opened', !!n && n.open === true && n.wideOpen === false);
        reset();
        missedReturn = { since: now - 5 * MIN, back: now, bodies: new Map([[id, clone()]]) };
        missedMatchOffered(clone(), { match: clone(), at: now });
        check('a return with nothing changed raised a summary', !missedNotes.get(id));
        // The period is the data's, not the page's clock: the history says when
        // the total of the body before first appeared.
        const sample = (at, body) => ({ at, n: fightTotals(body) });
        const stalled = clone(); stalled.maps[0].kills.red += 200;
        const longer = after(stalled);
        longer.m.maps[1].kills.green += 7;
        // Its flips happened 3 min ago, before the history's row of the new total.
        for (const map of longer.m.maps) for (const o of map.objectives) if (longer.taken.includes(o.id)) o.last_flipped = new Date(now - 3 * MIN).toISOString();
        killSheet = new Map([[id, [sample(now - 40 * MIN, M0), sample(now - 36 * MIN, stalled)]]]);
        reset();
        missedLastOffer.set(id, now - 30000);
        missedMatchOffered(longer.m, { match: stalled, at: now - 7 * MIN });
        n = missedNotes.get(id);
        check('a body stopped 36 min did not start the period at the stop', !!n && n.since === now - 36 * MIN && n.sure === true, n && (n.since - now) / MIN);
        check('the period ended before the page read the new body', !!n && n.end >= n.since && n.end <= Date.now() + 1000);
        const diff = missedKillTotal(longer.m) - missedKillTotal(stalled);
        check('the kills per map did not add up to the difference of the bodies', !!n && n.kills === diff
          && n.perMap.reduce((t, m) => t + m.n, 0) === diff, n && JSON.stringify(n.perMap));
        check('only the maps that moved were listed', !!n && n.perMap.length === 2
          && n.perMap.some(m => m.type === stalled.maps[0].type && m.n === 50)
          && n.perMap.some(m => m.type === stalled.maps[1].type && m.n === 7), n && JSON.stringify(n.perMap));
        // The new body already in the history: the period ends where it first showed.
        killSheet = new Map([[id, [sample(now - 40 * MIN, M0), sample(now - 36 * MIN, stalled), sample(now - 2 * MIN, longer.m)]]]);
        reset();
        missedLastOffer.set(id, now - 30000);
        missedMatchOffered(longer.m, { match: stalled, at: now - 7 * MIN });
        n = missedNotes.get(id);
        check('the period did not end where the new total first showed', !!n && n.sure && n.end === now - 2 * MIN, n && (n.end - now) / MIN);
        // A return: the body before is older than the tab's hiding.
        killSheet = new Map([[id, [sample(now - 50 * MIN, M0), sample(now - 30 * MIN, stalled)]]]);
        reset();
        missedReturn = { since: now - 5 * MIN, back: now, bodies: new Map([[id, JSON.parse(JSON.stringify(stalled))]]) };
        missedMatchOffered(longer.m, { match: longer.m, at: now });
        n = missedNotes.get(id);
        check('a return started at the hiding, not where the body before began', !!n && n.kind === 'return' && n.since === now - 30 * MIN && n.sure === true, n && (n.since - now) / MIN);
        // A normal return: a row a minute, none with the total of the body before
        // (the page read another copy 30 s after the row under it).
        const lower = clone(); lower.maps[0].kills.red += 190;
        const upper = clone(); upper.maps[0].kills.red += 210;
        killSheet = new Map([[id, [sample(now - 9 * MIN, lower), sample(now - 8 * MIN, lower), sample(now - 7 * MIN + 30000, upper), sample(now - 6 * MIN, upper)]]]);
        reset();
        missedLastOffer.set(id, now - 30000);
        missedMatchOffered(longer.m, { match: stalled, at: now - 7 * MIN });
        n = missedNotes.get(id);
        check('a normal return between rows was not sure', !!n && n.sure === true && n.since === now - 7 * MIN, n && (n.since - now) / MIN + ' ' + n.sure);
        // The oldest reading there is only bounds the start: not sure, never later.
        killSheet = new Map([[id, [sample(now - 36 * MIN, stalled)]]]);
        reset();
        missedLastOffer.set(id, now - 30000);
        missedMatchOffered(longer.m, { match: stalled, at: now - 7 * MIN });
        n = missedNotes.get(id);
        check('an oldest reading was taken as the exact start', !!n && n.sure === false && n.since === now - 36 * MIN, n && (n.since - now) / MIN + ' ' + n.sure);
        // No reading of that total at all: the page's own time, not sure.
        killSheet = new Map();
        reset();
        missedLastOffer.set(id, now - 30000);
        missedMatchOffered(longer.m, { match: stalled, at: now - 7 * MIN });
        n = missedNotes.get(id);
        check('no history claimed a sure start', !!n && n.sure === false && n.since <= now - 7 * MIN, n && n.sure);
        // A listed flip older than the period the history proves: the period
        // starts at that flip (its last_flipped is exact), a future one is skipped.
        const old = after();
        const flips = (k) => { const o = [].concat(...old.m.maps.map(x => x.objectives)).find(x => x.id === old.taken[k]); return o; };
        flips(0).last_flipped = new Date(now - 120 * MIN).toISOString();
        flips(1).last_flipped = new Date(now + 60 * MIN).toISOString();
        reset();
        missedReturn = { since: now - 5 * MIN, back: now, bodies: new Map([[id, clone()]]) };
        missedMatchOffered(old.m, { match: old.m, at: now });
        n = missedNotes.get(id);
        check('a return with a flip 2 h old started later than the flip', !!n && n.kind === 'return' && n.since === now - 120 * MIN && n.sure === true, n && (n.since - now) / MIN + ' ' + n.sure);
        reset();
        missedLastOffer.set(id, now - 30000);
        missedMatchOffered(old.m, { match: clone(), at: now - 7 * MIN });
        n = missedNotes.get(id);
        check('a pause with a flip 2 h old started later than the flip', !!n && n.kind === 'pause' && n.since === now - 120 * MIN && n.sure === true, n && (n.since - now) / MIN + ' ' + n.sure);
        // The history showed the new total 5 min ago, a listed flip came 1 min ago:
        // the period must reach the flip.
        flips(0).last_flipped = new Date(now - MIN).toISOString();
        killSheet = new Map([[id, [sample(now - 40 * MIN, M0), sample(now - 5 * MIN, old.m)]]]);
        reset();
        missedLastOffer.set(id, now - 30000);
        missedMatchOffered(old.m, { match: clone(), at: now - 7 * MIN });
        n = missedNotes.get(id);
        check('the period ended before a flip it lists', !!n && n.end >= now - MIN, n && (n.end - now) / MIN);
        killSheet = sheetWas;
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
        killSheet = sheetWas;
        if (logWas === null) localStorage.removeItem(FIGHT_KEY); else localStorage.setItem(FIGHT_KEY, logWas);
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
    const NAMES = { Center: 'EBG', RedHome: 'Red BL', BlueHome: 'Blue BL', GreenHome: 'Green BL' };
    serve(after);
    await later(31000, step + ': after');
    if (await until(step, `!!${block}`, 'the block after the gap')) {
      const seen = await ev(`(() => { const b = ${block};
        return { title: b.querySelector('.wvw-missed-title').textContent, open: b.classList.contains('is-open'),
          top: b === b.parentElement.firstElementChild && b.parentElement.classList.contains('wvw-side'),
          chips: [...b.querySelectorAll('.wvw-chip[data-obj]')].map(c => c.dataset.obj + ' ' + c.dataset.map),
          kills: [...b.querySelectorAll('.wvw-missed-row')].map(r => r.querySelector('.wvw-missed-mapname').textContent + ' ' + (r.querySelector('.wvw-missed-kills')?.textContent || '')),
          rings: [...document.querySelectorAll('.info-popover .wvw-marker')].filter(g => g.querySelector('.wvw-ring')).map(g => g.dataset.obj),
          dots: [...document.querySelectorAll('.info-popover .wvw-tab')].filter(t => t.querySelector('.wvw-tab-dot')).map(t => t.dataset.type) }; })()`);
      const TABS = ['Center', 'RedHome', 'BlueHome', 'GreenHome'];
      const want = { chips: [[a.id, here], [b.id, other]].sort((x, y) => TABS.indexOf(x[1]) - TABS.indexOf(y[1])).map(([id, ty]) => `${id} ${ty}`), kills: TABS.filter(ty => KILLS[ty]).map(ty => `${NAMES[ty]} ${KILLS[ty][1]} kills`), rings: [a.id], dots: [] };
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
          && !document.querySelector('.info-popover .wvw-tab-dot')`, "the other map's tab open, its objective selected in the Objective tab, no tab dot");
        await until(step + ': chip tapped', `${lit} === '${b.id}'`, `${b.id} lit a moment after its chip is pressed`);
      }
      // A phone: folded, the title alone; a tap opens it to the chips.
      await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
      if (await until(step + ', 360 px', `!!${block} && !${block}.classList.contains('is-open') && !${block}.querySelector('.wvw-chip')`, 'the block folded')) {
        const folded = await ev(`${block}.textContent`);
        if (/\bkills\b/.test(folded)) problem(`step '${step}, 360 px': folded it reads "${folded}", with the kills total in its title`);
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

  // 6. The corners over a map, while the page's kept bodies are the recorded ones.
  await mapCorners();

  // 6b. The kill history backdating a match this page never saw move.
  await historyAge();

  // 6c. The corners by the data's clock.
  await cornersByClock();

  // 6d. The maps' summary of a gap: what changed hands and the kills. In this
  // load, whose maps have all been opened: a new load would ask for guild
  // tactics in an order the recording does not hold.
  await whatHappened();
  await whatHappenedRules();

  // 6d2. The skirmish trend with the body frozen partway through a block.
  await skirmishStalled();

  // 6e. The board picks a team or a type, and the map lights it.
  await mapFocus();

  // 6f. Board, Captures and Objective: three tabs over one pane that keeps its size.
  await mapPane();

  // 7 to 8b (frozen answer, fresh week, mixed weeks, week memory, /api/latest): .github/e2e/ (frozen, weeks, notice, latest specs).
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
      console.log(`walked: tiers NA ${got.NA}/${want.NA}, EU ${got.EU}/${want.EU}`);
    }
    report();
  }
}

