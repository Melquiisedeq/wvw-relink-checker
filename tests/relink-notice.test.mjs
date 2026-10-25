// setup() of the Apps Script (apps-script/relink-notice/relink-notice.gs) against a fake spreadsheet:
// the state tab must come first, because the CSV export serves the first sheet when the named one is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../apps-script/relink-notice/relink-notice.gs', import.meta.url), 'utf8');

const range = () => ({ setNumberFormat() { return this; }, setValues() { return this; }, setValue() { return this; }, getDisplayValues: () => [['', ''], ['', '']] });
const sheet = (name, rows = 0) => ({ name, rows, setName(n) { this.name = n; return this; }, getLastRow() { return this.rows; }, getMaxRows: () => 1000,
  insertRowsAfter() {}, clear() {}, getRange() { this.rows = Math.max(this.rows, 1); return range(); } });

const table = JSON.stringify(Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`${String(i).padStart(8, '0')}-AAAA-BBBB-CCCC-DDDDDDDDDDDD`, '11005'])));
const res = body => ({ getResponseCode: () => 200, getContentText: () => body });

function tabsAfterSetup(sheets) {
  const doc = { getSheetByName: n => sheets.find(s => s.name === n) || null, getSheets: () => sheets.slice(), getNumSheets: () => sheets.length,
    insertSheet(n, i) { const s = sheet(n); sheets.splice(i, 0, s); return s; } };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => doc },
    UrlFetchApp: { fetchAll: reqs => reqs.map(r => res(/timers/.test(r.url) ? JSON.stringify({ na: '2026-11-03T07:59:00Z', eu: '2026-11-03T07:59:00Z' }) : table)) },
    Utilities: { sleep() {} }, Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, deleteProperty() {}, setProperty() {} }) },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;this.RN = RelinkNotice_;', ctx);
  ctx.RN.setup();
  return sheets.map(s => s.name);
}

test('setup() on a new spreadsheet renames the empty default tab to relink, in front of the baselines', () => {
  assert.deepEqual(tabsAfterSetup([sheet('Sheet1')]), ['relink', 'baseline-na', 'baseline-eu']);
});

test('setup() on a spreadsheet that already has relink leaves it where it is', () => {
  assert.deepEqual(tabsAfterSetup([sheet('notes', 3), sheet('relink', 1)]), ['notes', 'relink', 'baseline-na', 'baseline-eu']);
});
