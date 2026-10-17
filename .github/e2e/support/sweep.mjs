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
