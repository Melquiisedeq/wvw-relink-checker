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

// A tab as a grid of values: what the scripts read and write, with the Sheets limits they guard against
// (getRange past the last row or column throws). `writes` logs each setValue/setValues as { r, c, values }.
// A range is (row, column, rows, columns) or A1 text ('A1', 'A1:A2').
export function fakeSheet(name, { maxRows = 1000, maxColumns = 8, rows = [] } = {}) {
  const s = { name, data: rows.map((r) => r.slice()), maxRows, maxColumns, writes: [] };
  const cell = (r, c) => (s.data[r - 1] || [])[c - 1] ?? '';
  s.getLastRow = () => s.data.length;
  s.getMaxRows = () => s.maxRows;
  s.getMaxColumns = () => s.maxColumns;
  s.setName = (n) => { s.name = n; return s; };
  s.clear = () => { s.data = []; return s; };
  s.insertRowsAfter = (_, n) => { s.maxRows += n; };
  s.insertColumnsAfter = (_, n) => { s.maxColumns += n; };
  s.deleteRows = (from, n) => { s.data.splice(from - 1, n); s.maxRows -= n; };
  s.getRange = (r, c, nr, nc) => {
    if (typeof r === 'string') {
      const m = /^([A-Z])(\d+)(?::([A-Z])(\d+))?$/.exec(r);
      [r, c] = [Number(m[2]), m[1].charCodeAt(0) - 64];
      [nr, nc] = [m[4] ? Number(m[4]) - r + 1 : 1, m[3] ? m[3].charCodeAt(0) - 64 - c + 1 : 1];
    }
    if (r + nr - 1 > s.maxRows || c + nc - 1 > s.maxColumns) throw new Error('range outside the sheet');
    const values = () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j)));
    return {
      getValues: values,
      getDisplayValues: () => values().map((row) => row.map(String)),
      getValue: () => cell(r, c),
      setNumberFormat() { return this; },
      setValue(v) { return this.setValues([[v]]); },
      setValues(v) {
        s.writes.push({ r, c, values: v.map((row) => row.slice()) });
        v.forEach((row, i) => {
          const at = (s.data[r - 1 + i] ||= []);
          row.forEach((x, j) => { at[c - 1 + j] = x; });
        });
        return this;
      }
    };
  };
  s.getDataRange = () => s.getRange(1, 1, Math.max(s.data.length, 1), Math.max(1, ...s.data.map((x) => x.length)));
  return s;
}

export function fakeSpreadsheetApp(sheets = []) {
  const doc = {
    sheets,
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    getSheets: () => sheets.slice(),
    getNumSheets: () => sheets.length,
    insertSheet: (n, i = sheets.length) => { const s = fakeSheet(n); sheets.splice(i, 0, s); return s; }
  };
  return { doc, getActive: () => doc, getActiveSpreadsheet: () => doc };
}

// The pushes a script recorded ({ at, url, opt, code, delivered }; the fake fetch is synchronous, the Worker is not),
// handed to the Worker at the script's own time, the ones recorded with code null: a test that forces a push's answer records the code instead, and the Worker never sees it. The statuses the Worker gave.
export function deliverer(w, pushes) {
  return async () => {
    const out = [];
    for (const push of pushes.filter((x) => x.code === null && !x.delivered)) {
      push.delivered = true;
      w.advance(push.at - w.now);
      const res = await w.fetch(new Request(push.url, { method: 'POST', body: push.opt.payload, headers: push.opt.headers }));
      out.push(res.status);
    }
    return out;
  };
}
