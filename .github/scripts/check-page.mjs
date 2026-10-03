// Loads the page in a real Chrome, with the API and the sheets answered from a
// recording, walks it as a visitor would (guild search, every map, every icon
// button and popover, the NA/EU swap, a map answered with the same body for
// minutes, a frozen match answer that must not be painted, then a second load with /api/* down), and
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
        return await reply(requestId, hit[0], hit[1], bodyOf(hit));
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
        const refused = apiDown && /\/api\//.test(e.url || '');   // the 503 we sent on purpose
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
  async function load(name) {
    loaded = false;
    ids.clear();
    await send('Page.navigate', { url: base + '/' });
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
    await ev('loadStandings()');
    await idle(step);
    if (await ev(grid) !== gridBefore) problem(`step '${step}': the standings repainted from the frozen answer`);
    const logAfter = await ev(fightLog);
    if (logAfter.some(n => n < Math.max(...logBefore, 0))) problem(`step '${step}': the fight log took a frozen reading (${logAfter.join(' ')})`);
    for (const [name, s] of [['map pull', frozenOne], ['ids=all', frozenAll]]) {
      if (s.served < 1 || s.served - 1 > 2) problem(`step '${step}': ${name} asked ${s.served} time(s), wanted 1 and at most 2 re-reads`);
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
    if (hot && cold) {
      await click(step + ': other tab', `document.querySelector('.info-popover .wvw-tab[data-type="${cold}"]')`);
      await until(step, `!!${q('.wvw-hud-l.is-cold')}`, 'neutral swords on a tab without swords');
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

  // 7. A frozen answer: some API servers serve a match body from the past.
  await frozenMatch();

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
