// Serves site/ as Cloudflare does for the tests: the `/*` headers of
// site/_headers on every answer, so the Content Security Policy is production's
// and acts before any request reaches page.route. 127.0.0.1 only, and only the files
// listed when the server starts - a request only looks its path up in that list, so no
// file path is ever built from what the browser asked for.
//
// SITE_DIR serves another folder instead (a mutated copy of site/, or a checkout
// of main to compare with). It comes from whoever runs the tests, never from a request.
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SITE = process.env.SITE_DIR ? resolve(process.env.SITE_DIR) : join(ROOT, 'site');

// One port per worker, the same on every run: a failure names the address it
// was served from, and nothing else on the machine is asked for a free one.
// E2E_PORT_BASE moves the block, for two checkouts testing on one machine.
const BASE_PORT = Number(process.env.E2E_PORT_BASE) || 47300;

// The `/*` block of _headers.
function siteHeaders() {
  const out = {};
  let inBlock = false;
  for (const line of readFileSync(join(SITE, '_headers'), 'utf8').split('\n')) {
    if (/^\S/.test(line)) { inBlock = line.trim() === '/*'; continue; }
    const m = inBlock && line.match(/^\s+([A-Za-z-]+):\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  if (!out['Content-Security-Policy']) throw new Error(`no Content-Security-Policy under /* in ${join(SITE, '_headers')}`);
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8' };

// URL path -> { file, type }, every file under the folder listed once.
function siteFiles() {
  const map = new Map();
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), prefix + e.name + '/');
      else if (e.isFile() && e.name !== '_headers') {
        map.set(prefix + e.name, { file: join(dir, e.name), type: TYPES[extname(e.name)] || 'application/octet-stream' });
      }
    }
  };
  walk(SITE, '/');
  if (map.has('/index.html')) map.set('/', map.get('/index.html'));
  return map;
}

// The Worker's reads that go through the browser's HTTP cache, with the Worker's max-age
// (worker/index.mjs). Answered here, through the network, only while a test hands an answer
// (fixtures.mjs, `httpCache`): an answer the interception gives never enters the HTTP cache.
const CACHED_API = new Set(['/api/kills', '/api/relink']);
const CACHED_API_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };

// Starts the server for worker `index`; resolves to { url, close, answerApi }.
// answerApi(fn): fn(path with query) resolves to { status, type, body, date } or null (a 404); null stops.
export function startSite(index) {
  const headers = siteHeaders();
  const files = siteFiles();
  let api = null;
  const server = createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    if (api && CACHED_API.has(path) && req.method === 'GET') {
      const a = await api(req.url).catch(() => null);
      if (!a) { res.writeHead(404); return res.end(); }
      res.writeHead(a.status, { ...CACHED_API_HEADERS, 'Content-Type': a.type, Date: new Date(a.date).toUTCString() });
      return res.end(a.body);
    }
    const hit = files.get(path);
    if (!hit || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Type': hit.type });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(hit.file));
  });
  const port = BASE_PORT + index;
  return new Promise((ok, no) => {
    server.once('error', e => no(new Error(`site: cannot listen on 127.0.0.1:${port}: ${e.message}`)));
    server.listen(port, '127.0.0.1', () => ok({
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise(done => { server.close(() => done()); server.closeAllConnections(); }),
      answerApi: fn => { api = fn; },
      cachedApi: url => url.startsWith(`http://127.0.0.1:${port}/`) && CACHED_API.has(new URL(url).pathname),
    }));
  });
}
