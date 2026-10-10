// A Playwright reporter that says, in as few lines as it can, what the run
// needs from whoever reads it: one line per failed test (file:line, test,
// step, selector, the error's first line, the trace's path), one per skipped
// test, which fails the run - a skip or fixme left in is a test nobody runs -
// one per test that passed only on its retry, and a single line when all is
// green. The dot reporter beside it keeps the full errors.
//
// On GitHub Actions (GITHUB_ACTIONS=true) a test that passed on its retry is
// also a ::warning:: and a line in $GITHUB_STEP_SUMMARY. The workflow stops
// the runner's commands while the tests run, so nothing the page wrote can be
// read as one; E2E_RESUME is the token that turns them back on, printed here
// just before the warnings. Every line printed here starts with "e2e" or with
// a command this file wrote.
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';

// ANSI colour codes out, whitespace folded.
const one = text => String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
const firstLine = text => one(String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n').find(l => l.trim()) || '');
// Workflow command escaping (docs.github.com, "Workflow commands").
const data = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = s => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// The innermost step that failed.
function failedStep(steps) {
  for (const s of steps || []) {
    if (s.error) return failedStep(s.steps) || s.title;
  }
  return null;
}

export default class Summary {
  onBegin(config, suite) {
    this.suite = suite;
    this.root = config.rootDir;
  }

  printsToStdio() { return true; }

  where(location) {
    return location ? `${relative(process.cwd(), location.file)}:${location.line}` : '?';
  }

  title(test) {
    return test.titlePath().slice(3).join(' > ') || test.title;
  }

  onEnd(result) {
    const failed = [], skipped = [], flaky = [];
    let passed = 0;
    for (const test of this.suite.allTests()) {
      const outcome = test.outcome();
      if (outcome === 'unexpected') failed.push(test);
      else if (outcome === 'skipped') skipped.push(test);
      else if (outcome === 'flaky') flaky.push(test);
      else passed++;
    }

    for (const test of failed) {
      const last = test.results[test.results.length - 1];
      const error = last?.errors?.[0] || last?.error || {};
      const message = error.message || error.value || last?.status || 'failed';
      const selector = (one(message).match(/(?:locator|getBy\w+)\((?:'[^']*'|"[^"]*"|[^)'"])*\)/) || [])[0];
      const trace = test.results.flatMap(r => r.attachments).filter(a => a.name === 'trace' && a.path).pop();
      console.log(`e2e FAIL ${this.where(error.location || test.location)} | ${one(this.title(test))}`
        + ` | step: ${one(failedStep(last?.steps) || '-')}`
        + ` | selector: ${selector ? one(selector) : '-'}`
        + ` | ${firstLine(message)}`
        + ` | trace: ${trace ? relative(process.cwd(), trace.path) : 'none (kept on the first retry, CI only)'}`);
    }
    for (const test of skipped) {
      console.log(`e2e SKIPPED ${this.where(test.location)} | ${one(this.title(test))} | a skipped test fails the run: fix it or delete it`);
    }
    for (const test of flaky) {
      console.log(`e2e FLAKY ${this.where(test.location)} | ${one(this.title(test))} | failed, then passed on retry ${test.results.length - 1}`);
    }
    if (!failed.length && !skipped.length && result.status === 'passed') {
      console.log(`e2e: all ${passed + flaky.length} passed in ${(result.duration / 1000).toFixed(1)} s${flaky.length ? `, ${flaky.length} only on a retry` : ''}`);
    } else if (!failed.length && !skipped.length) {
      console.log(`e2e: run ${result.status}`);
    }

    if (process.env.GITHUB_ACTIONS === 'true' && flaky.length) {
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, flaky.map(t =>
          `- Passed only on a retry: \`${one(this.title(t)).replace(/`/g, "'")}\` (${this.where(t.location)})\n`).join(''));
      }
      if (process.env.E2E_RESUME) console.log(`::${process.env.E2E_RESUME}::`);
      for (const t of flaky) {
        console.log(`::warning file=${prop(relative(process.env.GITHUB_WORKSPACE || process.cwd(), t.location.file))},line=${t.location.line},title=${prop('Passed only on a retry')}::${data(one(this.title(t)))}`);
      }
    }

    if (skipped.length && result.status === 'passed') return { status: 'failed' };
  }
}
