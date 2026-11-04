// The push (js/api.js, wvwrelink.com/api/ws): with the tab visible on the site's
// own address, a socket tells the page of each newer copy, and the page reads that
// version, /api/latest?v=<at>.<tag>, after a random wait of up to 3 s, and
// draws it. While it is live the peek keeps the idle pace; dropped, refused or
// silent, the peek takes back its own until the socket is back. A hidden tab holds
// no socket, a page anywhere else opens none, and a message that is not the
// Worker's changes nothing.
import { test, expect } from './support/fixtures.mjs';
import { FOCUS, MIN, connectionDrops, hidden, livePush, playing, playingHalfMinutes, visible } from './support/scenarios.mjs';
import { versionName } from './support/gw2.mjs';
import { firstTier, load, openMap, play } from './support/steps.mjs';

const SITE = 'https://wvwrelink.com';
const SUMMARY = /\/api\/latest\/summary$/;
const VERSION = /\/api\/latest\?v=(\d+)\.[0-9a-f]{32}$/;
const COPY = /\/api\/latest$/;
// js/api.js: PUSH_SPREAD_MS, the latest a push read can come after the push.
const READ_BY = 3 * 1000;
// Math.random() at its middle: every wait the page draws is half its ceiling.
const HALF = 'Math.random = () => 0.5;';

// Reduced motion: the ember field stands still, so the minutes of clock below run fast.
test.use({ viewport: { width: 1280, height: 800 }, timeline: playing(), clock: 'playwright', origin: SITE, reducedMotion: 'reduce' });
test.describe.configure({ timeout: 120 * 1000 });

const scoreOf = (page, id) => page.evaluate(i => { const m = matchDataCache.get(i); return m ? colorSum(m.scores) : -1; }, id);

function reads(page) {
  const n = { summary: 0, copy: 0, versions: [] };
  page.on('request', r => {
    const u = r.url();
    if (SUMMARY.test(u)) n.summary++;
    else if (COPY.test(u)) n.copy++;
    else if (VERSION.test(u)) n.versions.push(Number(VERSION.exec(u)[1]));
  });
  return n;
}

// On to 10 s past one of the world's next writes, the version pushed and read:
// the push live (again). A fixed place in the minute: a jump that lands just
// before a write sees that write while its read waits, and the read asks for a
// version no longer the newest (the Worker's 404).
async function relive(page, wvw, push) {
  // On to a version this page holds neither by a push nor by another read.
  const known = await page.evaluate(() => Math.max(pushHeard, latestHeldAt));
  const newestOf = msg => Math.max(...msg.matches.map(m => m.at));
  let at = 0;
  for (let i = 0; i < 3 && at <= known; i++) {
    const now = await wvw.now();
    const grid = newestOf(await wvw.told()) * 1000 + 10 * 1000;
    await page.clock.setSystemTime(grid + Math.max(1, Math.ceil((now + 1 - grid) / MIN)) * MIN);
    at = newestOf(await wvw.told());
  }
  await push.sync();
  // The message on the page before the clock runs its wait.
  await expect.poll(() => page.evaluate(() => pushHeard), 'the version heard').toBe(at);
  await page.clock.runFor(1600);
  await expect.poll(() => page.evaluate(() => pushLive()), 'the push is live').toBe(true);
}

// The page loaded with its socket open, and live: a minute on, a version pushed and read.
async function live(page, wvw) {
  await page.addInitScript(HALF);
  const push = await livePush(page, wvw);
  await load(page, wvw);
  await expect.poll(() => push.open, 'the socket is open').toBe(1);
  expect(await page.evaluate(() => pushLive()), 'live on the connection\'s own message').toBe(false);
  await relive(page, wvw, push);
  return push;
}

test('a push is read by its version and on the list within 1-4 s of the message', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  // The first peek, armed before the push was live, out of the way.
  await play(page, 31 * 1000);
  await wvw.settle();
  const n = reads(page);
  const drawn = await scoreOf(page, FOCUS);
  // Two minutes of play, told as two ingests: only the newer version is read.
  await page.clock.setSystemTime(await wvw.now() + MIN);
  await push.tell();
  await page.clock.setSystemTime(await wvw.now() + MIN);
  const told = await wvw.told();
  const newest = Math.max(...told.matches.map(m => m.at));
  const want = told.matches.find(m => m.id === FOCUS).score;
  expect(want, 'the world moved on').toBeGreaterThan(drawn);
  await push.tell(told);
  // From the message: the wait (half of 3 s here), then the read and the paint, held to 1 s.
  await page.clock.runFor(1600);
  await expect.poll(() => n.versions, 'the version is read once its wait is up').toEqual([newest]);
  await expect.poll(() => scoreOf(page, FOCUS), { message: 'the pushed number on the list', timeout: 1000 }).toBe(want);
  expect(n.summary, 'summary reads after the push').toBe(0);
  expect(n.copy, 'reads of /api/latest by no version after the push').toBe(0);
  expect(push.misuse, 'messages from the page but ping').toBe(0);
});

test('an open map whose match a push read moved reads it at once', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  await play(page, 31 * 1000);
  const { button, id, url } = await firstTier(page);
  expect(id, 'the first tier is the match that plays').toBe(FOCUS);
  await openMap(page, wvw, button);
  const n = reads(page);
  let pulls = 0;
  page.on('request', r => { if (r.url() === url && n.versions.length) pulls++; });
  await page.clock.setSystemTime(await wvw.now() + 2 * MIN);
  await push.tell();
  for (let t = 0; t < READ_BY && !n.versions.length; t += 3000) await play(page, 3000);
  expect(n.versions, 'the version read').toHaveLength(1);
  // The clock held from here: the map's own poll cannot come.
  await expect.poll(() => pulls, 'map reads after the push read').toBe(1);
});

test('a read waits its random part of the spread, whatever the version\'s age', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  const n = reads(page);
  // A version 40 s old by the clock: the wait is from the message, not from `at`.
  await page.clock.setSystemTime(await wvw.now() + MIN);
  const told = await wvw.told();
  const at = Math.max(...told.matches.map(m => m.at));
  await page.clock.setSystemTime(Math.max(await wvw.now(), at * 1000 + 40 * 1000));
  await push.tell(told);
  // Half of PUSH_SPREAD_MS (3 s): 1.5 s.
  await page.clock.runFor(1300);
  expect(n.versions, 'a version read before its wait').toEqual([]);
  await page.clock.runFor(300);
  await expect.poll(() => n.versions).toEqual([at]);
});

test('with the socket live the peek reads one summary in two minutes; without, its own pace', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  const n = reads(page);
  await play(page, 10 * MIN, { using: true, push });
  const withSocket = n.summary;
  expect(withSocket, 'summary reads in 10 min, the socket live').toBeLessThanOrEqual(6);
  expect(push.pings, 'pings in 10 min (one each 45 s)').toBeGreaterThanOrEqual(12);
  // Dropped just after a peek: the next comes at the peek's own floor, not the idle pace.
  for (let i = 0; i < 60 && n.summary === withSocket; i++) await play(page, 3000, { using: true, push });
  const peeked = n.summary;
  push.refuse = true;
  await connectionDrops(push);
  // No input meanwhile: only the drop itself can bring the peek forward.
  await play(page, 31 * 1000);
  expect(n.summary - peeked, 'summary reads in the 31 s after the drop').toBeGreaterThanOrEqual(1);
  await play(page, 10 * MIN - 31 * 1000, { using: true });
  const without = n.summary - peeked;
  expect(without, 'summary reads in 10 min, the socket refused').toBeGreaterThanOrEqual(18);
  console.log(`e2e push: summary reads in 10 min ${withSocket} with the socket, ${without} without`);
});

test('a version that is not there gives the peek back its pace until the next push', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  await play(page, 31 * 1000);
  await wvw.settle();
  const n = reads(page);
  const told = await wvw.told();
  // One second past the timeline's newest: the Worker's 404, no copy.
  wvw.allowLog(VERSION);
  const ahead = told.matches.map(m => (m.id === FOCUS ? { ...m, at: m.at + 1 } : m));
  await push.tell({ matches: ahead, version: versionName(Math.max(...ahead.map(m => m.at))) });
  await play(page, READ_BY);
  await expect.poll(() => n.versions, 'the version asked').toHaveLength(1);
  expect(await page.evaluate(() => pushLive()), 'live after a failed read').toBe(false);
  // The peek's own 30 s from the last one, not the 2 min of a live push.
  await play(page, 70 * 1000, { using: true });
  expect(n.summary, 'summary reads in the 70 s after').toBeGreaterThanOrEqual(2);
  await relive(page, wvw, push);
});

test('a dropped socket comes back after a doubling wait, and the first after a message is short again', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  push.refuse = true;
  await connectionDrops(push);
  await play(page, 5 * MIN);
  const early = push.opened;
  await play(page, 5 * MIN);
  // Waits of half 1, 2, 4 ... 60 s: once at the ceiling, one try each 30 s.
  expect(push.opened - early, 'tries in the second five minutes').toBeLessThanOrEqual(11);
  expect(push.opened - early, 'tries in the second five minutes').toBeGreaterThanOrEqual(9);
  push.refuse = false;
  await play(page, 30 * 1000);
  await expect.poll(() => push.open, 'back').toBe(1);
  await relive(page, wvw, push);
  const before = push.opened;
  await connectionDrops(push);
  // Half of PUSH_RETRY_MS: the count of failures was zeroed by the message.
  await page.clock.runFor(600);
  await expect.poll(() => push.opened, 'the try after a message').toBe(before + 1);
});

test('a socket that stops answering is closed after the wait for its pong, and opened again', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  await connectionDrops(push, { silent: true });
  // The ping 45 s after the opening, its pong waited 10 s, the try again after 0.5 s.
  await play(page, 57 * 1000);
  await expect.poll(() => push.opened, 'opened again').toBe(2);
  await expect.poll(() => push.open, 'the new socket open').toBe(1);
  await relive(page, wvw, push);
});

test('a hidden tab closes its socket and opens none; shown, it opens one at once', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  await hidden(page, wvw, 0);
  await expect.poll(() => push.open, 'closed when hidden').toBe(0);
  await play(page, 5 * MIN);
  expect(push.opened, 'opened while hidden').toBe(1);
  await visible(page);
  await expect.poll(() => push.open, 'open again when shown').toBe(1);
  expect(push.opened).toBe(2);
});

test('a message that is not the Worker\'s asks nothing and changes nothing', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  const n = reads(page);
  await page.clock.setSystemTime(await wvw.now() + MIN);
  const told = await wvw.told();
  const m = told.matches.find(x => x.id === FOCUS);
  const drawn = await scoreOf(page, FOCUS);
  // The clock held, so the page's server time is what it was when `past` was named:
  // the first whole second over the page's 70 s past it.
  await page.clock.pauseAt(await wvw.now() + 1000);
  const past = await page.evaluate(() => Math.floor((Date.now() - ownClockLead) / 1000) + 71);
  for (const bad of [
    'not json', '[]', '{"matches":{}}', JSON.stringify({ matches: [{ ...m, id: '9-9' }] }),
    JSON.stringify({ matches: [{ ...m, at: String(m.at) }] }), JSON.stringify({ matches: [{ ...m, at: m.at + 0.5 }] }),
    JSON.stringify({ matches: [{ ...m, at: -1 }] }), JSON.stringify({ matches: [m], pad: ' '.repeat(9000) }),
    '<img src=x onerror=alert(1)>',
    // An hour past the clock: no version of anyone's.
    JSON.stringify({ matches: [{ ...m, at: m.at + 3600 }], version: versionName(m.at + 3600) }),
    JSON.stringify({ matches: [{ ...m, at: past }], version: versionName(past) }),
    JSON.stringify({ matches: [m], version: versionName(past) }),
    // A version that is not one, or none: nothing to read.
    JSON.stringify({ matches: [m] }), JSON.stringify({ matches: [m], version: m.at + '.' + 'Z'.repeat(32) }),
    JSON.stringify({ matches: [m], version: m.at + '.' + 'a'.repeat(32) + '&x=1' }), JSON.stringify({ matches: [m], version: m.at }),
    JSON.stringify({ matches: [m], version: versionName(m.at + 3600) }),
  ]) await push.tell(bad);
  await play(page, READ_BY);
  expect(n.versions, 'versions read').toEqual([]);
  expect(await scoreOf(page, FOCUS)).toBe(drawn);
  expect(push.open, 'the socket stays open').toBe(1);
  // Nothing of the above stands in the way of the real version.
  await push.tell(told);
  await page.clock.runFor(1600);
  await expect.poll(() => n.versions, 'the real version read').toEqual([Math.max(...told.matches.map(x => x.at))]);
});

test.describe('a game that moves each 30 s', () => {
  test.use({ timeline: playingHalfMinutes() });

  test('a socket that answers and tells nothing more: the peek sees the version missed and takes back its pace', async ({ page, wvw }) => {
    const push = await live(page, wvw);
    const n = reads(page);
    await connectionDrops(push, { quiet: true });
    // Each version the peek sees is under 30 s old; the next peek (2 min at most)
    // sees one over 30 s past the last the push named.
    await play(page, 3 * MIN, { using: true, push });
    expect(await page.evaluate(() => pushLive()), 'live with versions missed').toBe(false);
    const before = n.summary;
    await play(page, 3 * MIN, { using: true, push });
    expect(n.summary - before, 'summary reads in 3 min after').toBeGreaterThanOrEqual(5);
    expect(push.open, 'the socket stays open').toBe(1);
    // The push comes back with the next version it tells.
    push.quiet = false;
    await relive(page, wvw, push);
  });

  test('one write the push missed is 30 s of silence and keeps it live; two give the peek its pace back', async ({ page, wvw }) => {
    const push = await live(page, wvw);
    const n = reads(page);
    const heard = await page.evaluate(() => pushHeard);
    await connectionDrops(push, { quiet: true });
    // Past the next write, 10 s on from the one read, and before the one after.
    // The peek runs here, and its next is due a minute and more later.
    await play(page, 22 * 1000);
    await page.evaluate(() => { runPeek(); });
    await play(page, 3000);
    expect(await page.evaluate(() => pushLive()), 'live with one write missed').toBe(true);
    expect(n.versions, 'versions read').toEqual([]);
    // The peek read the copy that write made: that is the newest version known now.
    const known = await page.evaluate(() => Math.max(pushHeard, latestHeldAt));
    expect(known, 'the version the peek\'s copy brought').toBe(heard + 30);
    // Two writes more, neither pushed: 60 s past it.
    await play(page, 60 * 1000);
    await page.evaluate(() => { runPeek(); });
    await play(page, 3000);
    expect(await page.evaluate(() => pushLive()), 'live with two writes missed').toBe(false);
  });
});

test('a version another read brought before its push is known: the peek leaves the push live', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  const n = reads(page);
  await connectionDrops(push, { quiet: true });
  // Past the next write (a minute on), and before its push.
  await play(page, 55 * 1000);
  const next = Math.max(...(await wvw.told()).matches.map(m => m.at));
  await page.evaluate(() => startLatest().then(offerLate));
  expect(await page.evaluate(() => latestHeldAt), 'the version read').toBe(next);
  push.quiet = false;
  await push.sync();
  await play(page, READ_BY);
  expect(n.versions, 'versions read for a push of one already read').toEqual([]);
  await page.evaluate(() => { runPeek(); });
  await play(page, 3000);
  expect(await page.evaluate(() => pushLive()), 'live after the summary shows that version').toBe(true);
});

test('a server that says hello and hangs up is tried on a doubling wait, not every second', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  push.hangUp = true;
  push.drop();
  await play(page, 2 * MIN);
  // Waits of half 1, 2, 4 ... 60 s: about 8 in two minutes; zeroed by each hello, over 200.
  expect(push.opened, 'connections in two minutes').toBeLessThanOrEqual(12);
});

test('a tab hidden before its push read is due reads that version when it comes back', async ({ page, wvw }) => {
  const push = await live(page, wvw);
  const n = reads(page);
  await page.clock.setSystemTime(await wvw.now() + MIN);
  const told = await wvw.told();
  await push.tell(told);
  await page.clock.runFor(500);
  await hidden(page, wvw, 0);
  await expect.poll(() => push.open, 'closed when hidden').toBe(0);
  // Back in the same minute: the new socket's first message names the same version.
  await page.route(/\/api\/latest$/, route => route.fulfill({ status: 503, body: 'down' }));
  wvw.allowLog(/\/api\/latest$/);
  await visible(page);
  await expect.poll(() => push.open, 'open again').toBe(1);
  await page.clock.runFor(1600);
  await expect.poll(() => n.versions, 'the version read after the return').toEqual([Math.max(...told.matches.map(x => x.at))]);
});

test.describe('anywhere but wvwrelink.com', () => {
  test.use({ origin: null });

  test('the page opens no socket and peeks as it does without one', async ({ page, wvw }) => {
    const push = await livePush(page, wvw);
    const n = reads(page);
    await load(page, wvw);
    await play(page, 2 * MIN);
    expect(push.opened, 'sockets opened').toBe(0);
    expect(n.summary, 'summary reads in 2 min').toBeGreaterThanOrEqual(3);
  });
});
