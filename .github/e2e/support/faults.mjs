// Reads a test makes fail on purpose, over the fixture's recording: every GET
// whose address matches answers `status` (with Retry-After: 1, as a busy API
// would) until off(), then the recording answers again. The address matched is
// the test's own constant pattern (a RegExp or an exact address), never a
// request's. For a RegExp the browser's log of each refused read is declared
// expected (wvw.allowLog); for an address the test does it. Anything else fails.
//
//   const down = fail(page, wvw, /^https:\/\/api\.guildwars2\.com\//);
//   ... down.reads; down.off();
export async function fail(page, wvw, re, status = 503) {
  const state = { reads: 0, on: true, off() { state.on = false; } };
  if (re instanceof RegExp) wvw.allowLog(re);
  await page.route(re, async route => {
    if (!state.on || route.request().method() !== 'GET') return route.fallback();
    state.reads++;
    await route.fulfill({
      status, body: '{"error":"on purpose"}',
      headers: { 'Content-Type': 'application/json', 'Retry-After': '1', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    });
  });
  return state;
}

// Holds every read of one address until the returned function is called, then the
// recording answers. release.reads counts the reads that reached it.
export async function hold(page, url) {
  let go;
  const gate = new Promise(ok => { go = ok; });
  const release = () => go();
  release.reads = 0;
  await page.route(url, async route => {
    release.reads++;
    await gate;
    await route.fallback();
  });
  return release;
}

// Answers `body` (JSON) to one address instead of the recording, counting the reads.
export async function answer(page, url, body) {
  const state = { reads: 0, on: true, off() { state.on = false; } };
  await page.route(url, async route => {
    if (!state.on || route.request().method() !== 'GET') return route.fallback();
    state.reads++;
    await route.fulfill({
      status: 200, body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    });
  });
  return state;
}
