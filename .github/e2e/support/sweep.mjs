// The pure half of the coverage sweep (coverage.mjs says how it is used): joins N
// istanbul reports of one commit and lists what some runs covered and others did not.
// No dependency, so tests/ imports it without node_modules.
//
// "Line" here is a line where a statement starts (istanbul's s / statementMap), covered
// when any statement starting there ran; a branch is one arm of branchMap, as in b.

// Everything one report holds, as { key: { line, kind, type, hit } } per file.
function items(report) {
  const out = {};
  for (const [file, f] of Object.entries(report)) {
    const m = (out[file] = {});
    for (const [id, loc] of Object.entries(f.statementMap || {})) {
      const key = `line@${loc.start.line}`;
      m[key] = { line: loc.start.line, kind: 'line', type: 'statement', hit: !!(m[key]?.hit || f.s[id]) };
    }
    for (const [id, br] of Object.entries(f.branchMap || {})) {
      (f.b[id] || []).forEach((count, i) => {
        const line = br.locations?.[i]?.start.line ?? br.loc.start.line;
        m[`branch@${id}.${i}`] = { line, kind: 'branch', type: br.type, hit: !!count };
      });
    }
  }
  return out;
}

// reports: istanbul objects, one per run. read(file, line) gives the source text of a line.
// Per file: flaky = covered in some runs but not all, never = covered in none.
export function compareRuns(reports, read = () => '') {
  const runs = reports.map(items);
  const files = {};
  for (const file of new Set(runs.flatMap(r => Object.keys(r)))) {
    const keys = new Set(runs.flatMap(r => Object.keys(r[file] || {})));
    const flaky = [], never = { lines: 0, branches: 0 };
    for (const key of keys) {
      const seen = runs.map(r => r[file]?.[key]).filter(Boolean);
      const hits = seen.filter(i => i.hit).length;
      const { line, kind, type } = seen[0];
      if (hits === 0) never[kind === 'line' ? 'lines' : 'branches']++;
      else if (hits < reports.length) flaky.push({ line, kind, type, text: read(file, line).trim(), hits });
    }
    flaky.sort((a, b) => a.line - b.line || (a.kind < b.kind ? -1 : 1));
    files[file] = { flaky, never };
  }
  return { runs: reports.length, files };
}

// summaries: the { file: { lines, branches } } of each run. The lowest of each, per file and metric.
export function minimumOf(summaries) {
  const out = {};
  for (const s of summaries) {
    for (const [file, v] of Object.entries(s)) {
      const m = (out[file] ||= { lines: v.lines, branches: v.branches });
      m.lines = Math.min(m.lines, v.lines);
      m.branches = Math.min(m.branches, v.branches);
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// Source text as a markdown code span inside a table cell: cut first (so no escape is split),
// then the backslash before the pipe, and a backtick would close the span.
export const mdCode = s => s.slice(0, 100).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, "'");

export function sweepText({ runs, files }) {
  const out = [`${runs} runs.`, '', '| File | Flaky | Never covered (lines / branches) |', '|---|---:|---:|'];
  for (const [file, { flaky, never }] of Object.entries(files)) out.push(`| ${file} | ${flaky.length} | ${never.lines} / ${never.branches} |`);
  for (const [file, { flaky }] of Object.entries(files)) {
    if (!flaky.length) continue;
    out.push('', `**${file}**`, '', '| Line | Kind | Covered in | Code |', '|---:|---|---:|---|');
    for (const f of flaky) out.push(`| ${f.line} | ${f.kind === 'branch' ? `branch (${f.type})` : 'line'} | ${f.hits} of ${runs} | \`${mdCode(f.text)}\` |`);
  }
  return out.join('\n');
}

// ---- what a pull request added and no test ran ----

// Where the coverage measures; code outside it is not the card's concern. Only scripts: a .sql or .toml has no statements.
const WATCHED = /^(site\/js|worker|supabase)\/.+\.m?js$/;

// A `git diff --unified=0` as { path: [{ line, text }] }: the lines each file gained or changed.
// A deleted file (+++ /dev/null) and a hunk that only removes (+c,0) add none. The hunk header says how many
// lines follow, so an added line `++ i;` (shown as `+++ i;`) is content, not a file header.
export function addedLines(diff) {
  const out = {};
  let file = null, line = 0, oldLeft = 0, newLeft = 0;
  for (const raw of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith('+')) { newLeft--; if (file) (out[file] ||= []).push({ line: line++, text: raw.slice(1) }); }
      else if (raw.startsWith('-')) oldLeft--;
      continue;
    }
    if (raw.startsWith('+++ ')) { file = raw.startsWith('+++ b/') ? raw.slice(6) : null; continue; }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) { oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]); line = Number(hunk[2]); newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]); }
  }
  return out;
}

// Lines a statement starts on, true when one of them ran. istanbul names files by absolute path or relative to root.
function statementLines(report, root) {
  const out = {};
  for (const [name, f] of Object.entries(report)) {
    const rel = name.startsWith(root + '/') ? name.slice(root.length + 1) : name.replace(/^\.\//, '');
    const m = (out[rel] = {});
    for (const [id, loc] of Object.entries(f.statementMap || {})) m[loc.start.line] = !!(m[loc.start.line] || f.s[id]);
  }
  return out;
}

// The lines the diff added in a watched file where a statement starts and none ran. A new line with no statement
// (comment, blank, `}`) is not "untested"; a file the coverage does not measure is listed as notMeasured, not silenced.
export function untestedLines(diff, report, root = '') {
  const measured = statementLines(report, root);
  const files = {}, notMeasured = [];
  for (const [path, added] of Object.entries(addedLines(diff))) {
    if (!WATCHED.test(path)) continue;
    if (!measured[path]) { notMeasured.push(path); continue; }
    const lines = added.filter(a => measured[path][a.line] === false);
    if (lines.length) files[path] = lines;
  }
  return { files, notMeasured };
}

export function untestedText({ files, notMeasured }) {
  const out = [];
  for (const [path, lines] of Object.entries(files)) {
    out.push(`**\`${mdCode(path)}\`**`, '', '| Line | Code |', '|---:|---|');
    for (const l of lines) out.push(`| ${l.line} | \`${mdCode(l.text.trim())}\` |`);
    out.push('');
  }
  if (notMeasured.length) out.push('Not measured (the coverage does not read these, so no line can be said untested):', ...notMeasured.map(p => `- \`${mdCode(p)}\``), '');
  if (!out.length) return 'Nothing new without a test.';
  out.push('Not a failure: a line that guards against the impossible asks for no test. The reviewer decides.');
  return out.join('\n');
}
