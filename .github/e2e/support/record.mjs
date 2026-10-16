// RECORD=1 npx playwright test: re-record recordings.json.gz from the real hosts.
// The specs run once against the live game with workers: 1 (the config), so
// every URL is fetched once, in order, by the one process that answers the page
// (support/recordings.mjs), and the world is frozen at first sight: a later
// answer would send the page asking for URLs the first never had. What the run
// asks for is what the recording holds. Whether the live tests pass means
// nothing; the verdict is the replay in the teardown: the whole suite, with no
// RECORD, against the new file, and only a green one replaces the old recording.
//
//   cd .github/e2e && RECORD=1 npx playwright test
//   RECORDINGS=/tmp/new.json.gz RECORD=1 npx playwright test   (writes there instead)
//
// Cloud sandbox: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
// Fetches go to the table below, never to an address the page built: its host
// picks the origin, its path and query are appended.
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const E2E = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RECORDING = process.env.RECORDINGS ? resolve(process.env.RECORDINGS) : join(E2E, 'recordings.json.gz');
export const RECORDING_ON = !!process.env.RECORD;

const GAME = 'https://api.guildwars2.com';
const ORIGINS = { 'api.guildwars2.com': GAME, 'docs.google.com': 'https://docs.google.com' };
// The only two routes the page reads from /api, each with its full address.
const OWN_API = ['https://wvwrelink.com/api/kills', 'https://wvwrelink.com/api/relink'];

const dir = () => process.env.RECORD_DIR;
const kept = () => join(dir(), 'entries.jsonl');

// What the worker and the teardown share: the instant of the recording and the
// guild names (meta.json), and one line per response kept (entries.jsonl).
export function heldRecording() {
  const meta = JSON.parse(readFileSync(join(dir(), 'meta.json'), 'utf8'));
  const entries = new Map();
  for (const line of readFileSync(kept(), 'utf8').split('\n')) {
    if (!line) continue;
    const [url, e] = JSON.parse(line);
    if (!entries.has(url)) entries.set(url, e);
  }
  return { recordedAt: meta.recordedAt, guilds: meta.guilds, entries };
}

const inFlight = new Map();
// Fetches `url` once, from Node, and keeps it in `entries` and in the file.
export function recordUrl(url, entries) {
  if (entries.has(url)) return Promise.resolve();
  if (!inFlight.has(url)) {
    let target = null;
    if (OWN_API.includes(url)) target = url;
    else {
      const u = new URL(url);
      if (Object.hasOwn(ORIGINS, u.host)) target = ORIGINS[u.host] + u.pathname + u.search;
    }
    if (!target) return Promise.reject(new Error(`record: host not allowed, not fetched: ${url}`));
    inFlight.set(url, fetch(target).then(async res => {
      const bytes = Buffer.from(await res.arrayBuffer());
      const text = bytes.toString('utf8');
      const plain = Buffer.from(text, 'utf8').equals(bytes);
      const e = [res.status, res.headers.get('content-type') || '', plain ? text : bytes.toString('base64'), !plain];
      entries.set(url, e);
      appendFileSync(kept(), JSON.stringify([url, e]) + '\n');
    }));
  }
  return inFlight.get(url);
}

// Playwright's globalSetup: with RECORD, the live reads every test needs at
// import time (the list of matches, the guild tables, a guild name per region
// and its search), the instant and the names; returns the teardown.
export default async function setup() {
  if (!RECORDING_ON) return;
  process.env.RECORD_DIR = mkdtempSync(join(tmpdir(), 'record-'));
  writeFileSync(kept(), '');
  const entries = new Map();
  const recordedAt = Date.now();
  const guilds = [];
  await recordUrl(`${GAME}/v2/wvw/matches?ids=all`, entries);
  for (const region of ['na', 'eu']) {
    const url = `${GAME}/v2/wvw/guilds/${region}`;
    await recordUrl(url, entries);
    const keys = Object.keys(JSON.parse(entries.get(url)[2])).sort(() => Math.random() - 0.5);
    for (const id of keys.slice(0, 20)) {
      const guild = `${GAME}/v2/guild/${id}`;
      await recordUrl(guild, entries);
      const g = entries.get(guild)[0] === 200 ? JSON.parse(entries.get(guild)[2]) : null;
      if (g && g.name && !/[\n\r]/.test(g.name)) {
        guilds.push(g.name);
        await recordUrl(`${GAME}/v2/guild/search?name=${encodeURIComponent(g.name)}`, entries);
        break;
      }
    }
  }
  if (guilds.length < 2) throw new Error(`record: found ${guilds.length} guild name(s) for NA and EU, wanted 2`);
  writeFileSync(join(dir(), 'meta.json'), JSON.stringify({ recordedAt, guilds }));
  return teardown;
}

function teardown() {
  const { recordedAt, guilds, entries } = heldRecording();
  const sorted = {};
  for (const url of [...entries.keys()].sort()) sorted[url] = entries.get(url);
  const candidate = join(dir(), 'candidate.json.gz');
  writeFileSync(candidate, gzipSync(JSON.stringify({ recordedAt, guilds, entries: sorted }), { level: 9 }));
  console.log(`recorded ${entries.size} responses (${readFileSync(candidate).length} bytes gzipped) at ${new Date(recordedAt).toISOString()}; guilds: ${guilds.join(' | ')}`);
  console.log('replaying the whole suite against it...');
  const env = { ...process.env, RECORDINGS: candidate };
  delete env.RECORD;
  // Node itself runs Playwright's CLI: no shell, so nothing differs on Windows.
  const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
  const replay = spawnSync(process.execPath, [cli, 'test'], { cwd: E2E, env, stdio: 'inherit' });
  if (replay.error) throw new Error(`could not run the replay: ${replay.error.message}`);
  if (replay.status !== 0) throw new Error(`the new recording does not replay (${RECORDING} unchanged); record again. Candidate kept at ${candidate}`);
  copyFileSync(candidate, RECORDING);
  console.log(`recorded: ${RECORDING}`);
}
