// The `wvw` fixture: the page served from site/ (support/site.mjs), its outside
// reads answered from the recording (support/recordings.mjs), its clock started
// at the recording's instant, and every exception, console error and Content
// Security Policy violation collected and failed at the end of the test - the
// same things, seen the same way (DevTools events), as the check-page.
//
//   import { test, expect } from './support/fixtures.mjs';
//   test('...', async ({ page, wvw }) => { await page.goto(wvw.url); ... });
//
// Two options, per file or describe block with test.use():
//   timeline  a timeline of support/gw2.mjs: the match URLs, /api/latest and
//             /api/kills answered from it at the page's own time, and the
//             page's clock started where it says the page opens. Default: the
//             recording as it is, /api/latest down.
//   clock     'shim' (default): the check-page's clock below, jumped with
//             wvw.skew(ms). 'playwright': no shim, page.clock installed at the
//             same instant, for tests that drive the timers (runFor,
//             fastForward); wvw.skew(ms) then jumps it with setSystemTime.
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
  timeline: [null, { option: true }],
  clock: ['shim', { option: true }],

  // One server per worker, on that worker's fixed port.
  site: [async ({}, use, workerInfo) => {
    const site = await startSite(workerInfo.parallelIndex);
    await use(site);
    await site.close();
  }, { scope: 'worker' }],

  wvw: async ({ page, context, site, timeline, clock }, use) => {
    const problems = [];
    // One line each, whitespace folded: page text must never start a line.
    const problem = text => {
      const line = String(text).replace(/\s+/g, ' ');
      if (!problems.includes(line)) problems.push(line);
    };
    const { recordedAt, guilds } = recording();
    // Declared before the log listener below reads it.
    const server = timeline ? timeline.serve(problem) : null;
    // Addresses a test makes fail on purpose (support/faults.mjs): the browser
    // logs each refused read as an error, and that one is expected.
    const allowed = [];

    const cdp = await context.newCDPSession(page);
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      problem('exception: ' + (d.exception?.description || d.text).split('\n')[0] + (d.url ? ` (${d.url}:${d.lineNumber + 1})` : ''));
    });
    cdp.on('Runtime.consoleAPICalled', p => {
      if (p.type === 'error') problem('console.error: ' + p.args.map(a => a.value ?? a.description).join(' '));
    });
    cdp.on('Log.entryAdded', ({ entry: e }) => {
      // The 503 /api/latest answers on purpose (support/recordings.mjs), or, with
      // a timeline, what it failed on purpose; and the analytics refused there.
      const expected = (!server && /\/api\/latest$/.test(e.url || '')) || (server && server.planted(e.url || ''))
        || allowed.some(re => re.test(e.url || '')) || BLOCKED.test(e.url || '') || BLOCKED.test(e.text);
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

    const opensAt = recordedAt + (timeline ? timeline.opensAt : 0);
    if (clock === 'playwright') await page.clock.install({ time: opensAt });
    else if (clock === 'shim') await page.addInitScript(clockShim(opensAt));
    else throw new Error(`wvw: clock '${clock}', wanted 'shim' or 'playwright'`);
    // The page's own time, asked of the page: the timeline answers at it. A
    // page between documents answers from the last offset it gave.
    let offset = opensAt - Date.now();
    const now = async () => {
      try {
        const t = await page.evaluate(() => Date.now());
        offset = t - Date.now();
        return t;
      } catch { return Date.now() + offset; }
    };
    const skew = async ms => {
      if (clock === 'shim') await page.evaluate(n => globalThis.__skewClock(n), ms);
      else await page.clock.setSystemTime(await now() + ms);
    };
    await page.route('**/*', answerFrom(site.url, problem, server && (async url => server.answer(url, await now()))));

    await use({ url: site.url + '/', recordedAt, opensAt, guilds, tiers: expectedTiers(), problems, problem, allowLog: re => allowed.push(re), settle, now, skew, timeline });

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    // The problems in the message's first line: the summary prints that line.
    expect(problems, `${problems.length} problem(s) on the page: ${problems.join(' | ')}`).toEqual([]);
  },
});

export { expect };
