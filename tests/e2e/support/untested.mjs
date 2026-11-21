// What a pull request added in the measured code and no test ran (coverage.mjs untested).
// No dependency, so tests/ imports it without node_modules.

// Source text as a markdown code span inside a table cell: cut first (so no escape is split),
// then the backslash before the pipe, and a backtick would close the span.
export const mdCode = s => s.slice(0, 100).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, "'");

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
