// The `wvw` fixture: the page served from site/ (support/site.mjs), its outside
// reads answered from the recording (support/recordings.mjs), its clock started
// at the recording's instant, and every exception, console error and Content
// Security Policy violation collected and failed at the end of the test - the
// same things, seen the same way (DevTools events), as the check-page.
//
//   import { test, expect } from './support/fixtures.mjs';
//   test('...', async ({ page, wvw }) => { await page.goto(wvw.url); ... });
import { test as base, expect } from '@playwright/test';
import { startSite } from './site.mjs';
import { BLOCKED, answerFrom, expectedTiers, recording } from './recordings.mjs';

// The check-page's clock, as an init script: "live", the relink banner and the
// stale-fight cutoff read Date.now(), and recorded matches age. The page's
// clock starts at the recording's instant and runs normally from there;
// window.__skewClock(ms) jumps it. Date.parse and new Date(x) stay real.
// page.clock replaces this only where a test asks for it.
const clockShim = anchor => `(() => {
  const Real = Date;
  let off = ${Number(anchor)} - Real.now();
  const now = () => Real.now() + off;
  globalThis.__skewClock = ms => { off += ms; };
  globalThis.Date = new Proxy(Real, {
    construct: (t, a, nt) => Reflect.construct(t, a.length ? a : [now()], nt),
    apply: () => new Real(now()).toString(),
    get: (t, p) => (p === 'now' ? now : Reflect.get(t, p, t)),
  });
})();`;

export const test = base.extend({
  // One server per worker, on that worker's fixed port.
  site: [async ({}, use, workerInfo) => {
    const site = await startSite(workerInfo.parallelIndex);
    await use(site);
    await site.close();
  }, { scope: 'worker' }],

  wvw: async ({ page, context, site }, use) => {
    const problems = [];
    // One line each, whitespace folded: page text must never start a line.
    const problem = text => {
      const line = String(text).replace(/\s+/g, ' ');
      if (!problems.includes(line)) problems.push(line);
    };
    const { recordedAt, guilds } = recording();

    const cdp = await context.newCDPSession(page);
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      problem('exception: ' + (d.exception?.description || d.text).split('\n')[0] + (d.url ? ` (${d.url}:${d.lineNumber + 1})` : ''));
    });
    cdp.on('Runtime.consoleAPICalled', p => {
      if (p.type === 'error') problem('console.error: ' + p.args.map(a => a.value ?? a.description).join(' '));
    });
    cdp.on('Log.entryAdded', ({ entry: e }) => {
      // The 503 /api/latest answers on purpose (support/recordings.mjs), and the
      // analytics refused there.
      const expected = /\/api\/latest$/.test(e.url || '') || BLOCKED.test(e.url || '') || BLOCKED.test(e.text);
      if (e.level === 'error' && !expected) problem(`log error (${e.source}): ${e.text}${e.url ? ' ' + e.url : ''}`);
    });
    cdp.on('Audits.issueAdded', ({ issue: i }) => {
      if (i.code === 'ContentSecurityPolicyIssue') {
        const d = i.details.contentSecurityPolicyIssueDetails;
        problem(`CSP violation: ${d.violatedDirective} blocked ${d.blockedURL || d.violatedDirective}`);
      }
    });
    for (const domain of ['Runtime', 'Log', 'Audits']) await cdp.send(domain + '.enable');

    // Requests in flight, for settle(): the check-page's "the page has gone
    // quiet". An error answer the page never reads (/api/latest's 503) is not
    // waiting on the network, and Chrome holds its end back.
    const inFlight = new Set();
    page.on('request', r => inFlight.add(r));
    page.on('response', r => { if (r.status() >= 400) inFlight.delete(r.request()); });
    page.on('requestfinished', r => inFlight.delete(r));
    page.on('requestfailed', r => inFlight.delete(r));
    // Nothing in flight on three looks in a row, 100 ms apart: late requests
    // and late exceptions get their chance to show.
    const settle = async (timeout = 15000) => {
      const t0 = Date.now();
      for (let quiet = 0; quiet < 3; quiet = inFlight.size ? 0 : quiet + 1) {
        if (Date.now() - t0 > timeout) throw new Error(`requests never settled: ${[...inFlight].map(r => r.url()).join(' ').slice(0, 300)}`);
        await page.waitForTimeout(100);
      }
    };

    await page.addInitScript(clockShim(recordedAt));
    await page.route('**/*', answerFrom(site.url, problem));

    await use({ url: site.url + '/', recordedAt, guilds, tiers: expectedTiers(), problems, problem, settle });

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    // The problems in the message's first line: the summary prints that line.
    expect(problems, `${problems.length} problem(s) on the page: ${problems.join(' | ')}`).toEqual([]);
  },
});

export { expect };
