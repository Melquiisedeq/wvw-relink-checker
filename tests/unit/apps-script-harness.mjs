// The Google side of an Apps Script (apps-script/*/*.gs), faked, so a script runs in a node:vm.
// Each script is loaded into its own context holding only what the test hands it, as Apps Script does.
import vm from 'node:vm';
import fs from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';

export const readScript = (rel) => fs.readFileSync(new URL('../../apps-script/' + rel, import.meta.url), 'utf8');

// Runs `src` in a new context with `globals`; `expose` (an expression) is what comes back, as ctx.out.
// `const` and `function` of a script are not properties of the context, hence the expression.
export function loadScript(src, globals, expose = 'undefined') {
  const ctx = { ...globals };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;this.out = ' + expose + ';', ctx);
  return ctx;
}

// A clock the test moves, and the Date a script sees: the real one but for now().
export function fakeClock(start) {
  const clock = { now: start, advance(ms) { clock.now += ms; } };
  clock.Date = new Proxy(Date, { get: (t, k) => (k === 'now' ? () => clock.now : t[k]) });
  return clock;
}

// getScriptProperties(): string values only, as the real ones.
export function fakeProps(init = {}) {
  const map = new Map(Object.entries(init));
  return {
    map,
    getProperty: (k) => (map.has(k) ? map.get(k) : null),
    setProperty(k, v) { map.set(k, String(v)); },
    deleteProperty(k) { map.delete(k); }
  };
}

export function fakeLogger() {
  const lines = [];
  return { lines, log: (x) => lines.push(String(x)) };
}

// Signed bytes (-128..127) in and out, as Apps Script's are; the HMAC and the digest are the real ones.
const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const unsigned = (bytes) => Buffer.from(bytes.map((b) => b & 0xff));

export function fakeUtilities({ sleeps = [] } = {}) {
  return {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    sleeps,
    sleep: (ms) => { sleeps.push(ms); },
    getUuid: () => randomUUID(),
    newBlob: (s) => ({ getBytes: () => signed(Buffer.from(s, 'utf8')) }),
    computeDigest: (alg, s) => signed(createHash('sha256').update(typeof s === 'string' ? s : unsigned(s)).digest()),
    computeHmacSha256Signature: (value, key) => signed(createHmac('sha256', unsigned(key)).update(unsigned(value)).digest())
  };
}

export function fakeLock({ free = true } = {}) {
  const lock = { held: false, tries: 0, tryLock: () => { lock.tries++; lock.held = free; return free; }, releaseLock: () => { lock.held = false; } };
  return { getScriptLock: () => lock, lock };
}

export const httpResponse = (code, body = '') => ({ getResponseCode: () => code, getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// A tab as a grid of values: what kills.gs reads and writes, with the Sheets limits it guards against
// (getRange past the last row or column throws).
export function fakeSheet(name, { maxRows = 1000, maxColumns = 8, rows = [] } = {}) {
  const s = { name, data: rows.map((r) => r.slice()), maxRows, maxColumns };
  s.getLastRow = () => s.data.length;
  s.getMaxRows = () => s.maxRows;
  s.getMaxColumns = () => s.maxColumns;
  s.insertRowsAfter = (_, n) => { s.maxRows += n; };
  s.insertColumnsAfter = (_, n) => { s.maxColumns += n; };
  s.deleteRows = (from, n) => { s.data.splice(from - 1, n); s.maxRows -= n; };
  s.getRange = (r, c, nr, nc) => {
    if (r + nr - 1 > s.maxRows || c + nc - 1 > s.maxColumns) throw new Error('range outside the sheet');
    return {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (s.data[r - 1 + i] || [])[c - 1 + j] ?? '')),
      setValues(v) { v.forEach((row, i) => { s.data[r - 1 + i] = row.slice(); }); return this; }
    };
  };
  return s;
}

export function fakeSpreadsheetApp(sheets = []) {
  const doc = {
    sheets,
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    insertSheet: (n) => { const s = fakeSheet(n); sheets.push(s); return s; }
  };
  return { doc, getActive: () => doc, getActiveSpreadsheet: () => doc };
}
