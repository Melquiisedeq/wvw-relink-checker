// /api/ws and the Live object (worker/index.mjs): who may upgrade, the limits per
// socket and per address, the notices, and the ingest telling the object.
// Run: node --test "tests/unit/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Live } from '../../worker/index.mjs';
import { NA_WEEK, EU_WEEK, setup, SUPA_ENV, NA_DONE, pushV2, quiet, fakeLive, vname } from './worker-harness.mjs';

const wsRequest = (headers, method = 'GET') => new Request('https://wvwrelink.com/api/ws', { method, headers });

const SITE = { upgrade: 'websocket', origin: 'https://wvwrelink.com' };

// The runtime's side of the object: a socket pair, the auto-response pair, a 101, and its state.
// readyState: 1 open, 2 closing (a close sent, none back yet), as the runtime's.
class FakeSocket {
  constructor(tags = []) { this.sent = []; this.closed = null; this.accepted = false; this.tags = tags; this.readyState = 1; }
  accept() { this.accepted = true; }
  send(m) { if (this.closed) throw new Error('closed'); this.sent.push(m); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 2; }
}

function fakeState() {
  const store = new Map();
  return {
    sockets: [],
    auto: null,
    acceptWebSocket(ws, tags = []) { ws.tags = tags; this.sockets.push(ws); },
    getWebSockets(tag) { return this.sockets.filter((ws) => tag === undefined || ws.tags.includes(tag)); },
    setWebSocketAutoResponse(pair) { this.auto = pair; },
    storage: {
      get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : undefined),
      put: async (k, v) => { store.set(k, structuredClone(v)); }
    }
  };
}

async function withRuntime(fn) {
  const real = { Response: globalThis.Response, WebSocketPair: globalThis.WebSocketPair, Pair: globalThis.WebSocketRequestResponsePair };
  const RealResponse = real.Response;
  globalThis.Response = class extends RealResponse {
    constructor(body, init = {}) {
      super(body, init.status === 101 ? { ...init, status: 200 } : init);
      if (init.status === 101) Object.defineProperty(this, 'status', { value: 101 });
      this.webSocket = init.webSocket;
    }
  };
  globalThis.WebSocketPair = class { constructor() { this[0] = new FakeSocket(); this[1] = new FakeSocket(); } };
  globalThis.WebSocketRequestResponsePair = class { constructor(request, response) { this.request = request; this.response = response; } };
  try {
    return await fn();
  } finally {
    globalThis.Response = real.Response;
    globalThis.WebSocketPair = real.WebSocketPair;
    globalThis.WebSocketRequestResponsePair = real.Pair;
  }
}

const openWs = (live, peer) => live.fetch(new Request('https://live/ws', { headers: { upgrade: 'websocket', ...(peer ? { 'x-live-peer': peer } : {}) } }));

// The end the object would have kept, of the next pair it makes.
async function openedEnd(live, peer) {
  const RealPair = globalThis.WebSocketPair;
  let pair;
  globalThis.WebSocketPair = class extends RealPair { constructor() { super(); pair = this; } };
  try {
    const r = await openWs(live, peer);
    assert.equal(r.status, 101, 'the tab gets a socket, to read the close code on');
  } finally {
    globalThis.WebSocketPair = RealPair;
  }
  return pair[1];
}

const notifyLive = (live, matches) => live.fetch(new Request('https://live/notify', { method: 'POST', body: JSON.stringify({ matches }) }));

const PEER_A = 'aaaaaaaaaaaaaaaa';

const PEER_B = 'bbbbbbbbbbbbbbbb';

test('the socket: anything but a GET upgrade is 426, before the object is touched', async () => {
  const live = fakeLive();
  const w = setup({ env: { LIVE: live.ns } });
  for (const [headers, method] of [
    [{ origin: SITE.origin }, 'GET'], [{ ...SITE, upgrade: 'h2c' }, 'GET'], [{ ...SITE, upgrade: '' }, 'GET'],
    [SITE, 'POST'], [SITE, 'PUT'], [SITE, 'HEAD']
  ]) {
    const r = await w.fetch(wsRequest(headers, method));
    assert.equal(r.status, 426, method + ' ' + JSON.stringify(headers));
    assert.equal(r.headers.get('upgrade'), 'websocket');
  }
  assert.equal(live.got, 0, 'the object never reached');
  // The header's case is the client's.
  assert.equal((await w.fetch(wsRequest({ ...SITE, upgrade: 'WebSocket' }))).status, 200);
  assert.equal(live.got, 1);
});

test('the socket: an Origin that is not the site is 403, before the object; the object gets none of the visitor\'s headers', async () => {
  const live = fakeLive();
  const w = setup({ env: { LIVE: live.ns } });
  for (const origin of [null, 'null', 'http://wvwrelink.com', 'https://wvwrelink.com.example.net', 'https://www.wvwrelink.com',
    'https://wvwrelink.com/', 'https://example.net', 'https://x-wvwrelink.wvwgw2.workers.dev']) {
    const headers = origin === null ? { upgrade: 'websocket' } : { upgrade: 'websocket', origin };
    assert.equal((await w.fetch(wsRequest(headers))).status, 403, String(origin));
  }
  assert.equal(live.got, 0);
  const forged = '0123456789abcdef';
  assert.equal((await w.fetch(wsRequest({ ...SITE, cookie: 'a=1', 'x-forwarded-for': '1.2.3.4', 'x-live-peer': forged }))).status, 200);
  assert.deepEqual(live.names, ['live']);
  const [req] = live.requests;
  assert.equal(req.url, 'https://live/ws');
  assert.deepEqual([...req.headers.keys()], ['upgrade', 'x-live-peer']);
  assert.match(req.headers.get('x-live-peer'), /^[0-9a-f]{16}$/);
  assert.notEqual(req.headers.get('x-live-peer'), forged, 'the visitor\'s own is never passed on');
  // Without the binding: 503, and the page peeks as before.
  assert.equal((await setup().fetch(wsRequest(SITE))).status, 503);
});

test('the object: a socket is hibernatable, and "ping" is answered by the runtime, never by the object', async () => {
  await withRuntime(async () => {
    const state = fakeState();
    const live = new Live(state);
    assert.deepEqual({ ...state.auto }, { request: 'ping', response: 'pong' });
    const r = await openWs(live);
    assert.equal(r.status, 101);
    assert.equal(state.sockets.length, 1);
    assert.equal(state.sockets[0].accepted, false, 'acceptWebSocket, never ws.accept()');
    assert.ok(r.webSocket instanceof FakeSocket);
    assert.notEqual(r.webSocket, state.sockets[0], 'the tab gets the other end');
    assert.deepEqual(state.sockets[0].sent, [], 'nothing known yet, nothing sent');
  });
});

test('the object: any message from a tab closes it with 1008', async () => {
  await withRuntime(async () => {
    const state = fakeState();
    const live = new Live(state);
    await openWs(live);
    for (const m of ['hello', 'ping ', new ArrayBuffer(4), '']) {
      const ws = new FakeSocket();
      live.webSocketMessage(ws, m);
      assert.deepEqual(ws.closed, { code: 1008, reason: 'policy violation' });
    }
  });
});

test('the object: the version named by the ingest goes out with the notice and to new sockets; an older one never replaces it', async () => {
  await withRuntime(async () => {
    const state = fakeState();
    const live = new Live(state);
    const at = Math.floor(Date.now() / 1000);
    const m = (a) => ({ id: '1-1', start: NA_WEEK, score: 6000, at: a });
    const notice = (body) => live.fetch(new Request('https://live/notify', { method: 'POST', body: JSON.stringify(body) }));
    await openWs(live);
    assert.equal((await notice({ matches: [m(at)], version: vname(at) })).status, 200);
    assert.deepEqual(JSON.parse(state.sockets[0].sent[0]), { matches: [m(at)], version: vname(at) });
    // Crossed: the older notice comes second.
    await notice({ matches: [m(at + 2)], version: vname(at + 2) });
    await notice({ matches: [m(at + 1)], version: vname(at + 1) });
    // Not a version: left out of the message, the stored one kept.
    await notice({ matches: [m(at + 3)], version: '<b>' + at });
    assert.equal(state.sockets[0].sent.length, 3, 'the older notice sends nothing');
    assert.equal(JSON.parse(state.sockets[0].sent[2]).version, undefined);
    await openWs(live);
    assert.equal(JSON.parse(state.sockets[1].sent[0]).version, vname(at + 2));
  });
});

test('the object: of two crossed notices only the newer match and version are kept, and the older sends nothing', async () => {
  await withRuntime(async () => {
    const state = fakeState();
    const live = new Live(state);
    const at = Math.floor(Date.now() / 1000);
    const m = (a, score, id = '1-1') => ({ id, start: NA_WEEK, score, at: a });
    const notice = (body) => live.fetch(new Request('https://live/notify', { method: 'POST', body: JSON.stringify(body) }));
    await openWs(live);
    await notice({ matches: [m(at + 2, 6200)], version: vname(at + 2) });
    assert.equal((await notice({ matches: [m(at + 1, 6100)], version: vname(at + 1) })).status, 200);
    assert.deepEqual(state.sockets[0].sent.map((x) => JSON.parse(x)), [{ matches: [m(at + 2, 6200)], version: vname(at + 2) }]);
    assert.deepEqual((await state.storage.get('matches'))['1-1'], m(at + 2, 6200));
    assert.equal(await state.storage.get('version'), vname(at + 2));
    // The same `at` again is no newer; an older notice with one newer match sends that match alone.
    await notice({ matches: [m(at + 2, 6300)] });
    await notice({ matches: [m(at + 1, 6100), m(at + 1, 5000, '1-2')], version: vname(at + 1) });
    assert.deepEqual(state.sockets[0].sent.slice(1).map((x) => JSON.parse(x)), [{ matches: [m(at + 1, 5000, '1-2')], version: vname(at + 2) }]);
    assert.deepEqual((await state.storage.get('matches'))['1-1'], m(at + 2, 6200));
    // A newer version with no newer match: nothing sent, nor the matches written again; the
    // version is kept for the next socket.
    const put = state.storage.put;
    const wrote = [];
    state.storage.put = (k, v) => { wrote.push(k); return put(k, v); };
    await notice({ matches: [m(at + 2, 6200)], version: vname(at + 5) });
    assert.equal(state.sockets[0].sent.length, 2);
    assert.deepEqual(wrote, ['version']);
    await openWs(live);
    assert.equal(JSON.parse(state.sockets[1].sent[0]).version, vname(at + 5));
  });
});

test('the object: a request that is neither an upgrade nor a notice is 404', async () => {
  await withRuntime(async () => {
    const state = fakeState();
    const live = new Live(state);
    const r = await live.fetch(new Request('https://live/ws'));
    assert.equal(r.status, 404);
    assert.equal(state.sockets.length, 0);
  });
});

test('the object: past its ceiling of 300 a new socket is closed with 4013 and never joins the others', async () => {
  await withRuntime(async () => {
    const state = fakeState();
    const live = new Live(state);
    for (let i = 0; i < 299; i++) state.sockets.push(new FakeSocket([i.toString(16).padStart(16, '0')]));
    await openWs(live);
    assert.equal(state.sockets.length, 300, 'the 300th is taken');
    const refused = await openedEnd(live);
    assert.equal(state.sockets.length, 300);
    assert.deepEqual(refused.closed, { code: 4013, reason: 'try again later' });
    assert.equal(refused.accepted, true, 'accepted only to be closed, never hibernatable');
    assert.ok(state.sockets.every((ws) => ws.closed === null), 'the ones inside stay open');
    assert.equal(await notifyLive(live, [{ id: '1-1', start: NA_WEEK, score: 6000, at: 1790000000 }]).then((x) => x.status), 200);
    assert.ok(state.sockets.every((ws) => ws.sent.length === 1));
  });
});

test('the object: the 21st socket of one address is closed with 1013, and another address still enters', async () => {
  await withRuntime(async () => {
    const state = fakeState();
    const live = new Live(state);
    for (let i = 0; i < 20; i++) await openWs(live, PEER_A);
    assert.equal(state.sockets.length, 20);
    assert.ok(state.sockets.every((ws) => ws.tags.length === 1 && ws.tags[0] === PEER_A), 'tagged by its address');
    const refused = await openedEnd(live, PEER_A);
    assert.deepEqual(refused.closed, { code: 1013, reason: 'try again later' });
    assert.equal(state.sockets.length, 20);
    assert.equal((await openedEnd(live, PEER_B)).closed, null);
    assert.equal(state.getWebSockets(PEER_B).length, 1);
    // A header out of shape is not an address of its own: all such share one tag.
    for (let i = 0; i < 20; i++) await openWs(live, 'x' + i);
    assert.equal(state.getWebSockets('unknown').length, 20);
    assert.deepEqual((await openedEnd(live, 'y')).closed.code, 1013);
  });
});

test('the object: a socket still closing counts neither for its address nor for the ceiling', async () => {
  await withRuntime(async () => {
    const state = fakeState();
    const live = new Live(state);
    for (let i = 0; i < 20; i++) await openWs(live, PEER_A);
    state.sockets[0].close(1001, '');
    assert.equal((await openedEnd(live, PEER_A)).closed, null, 'the one closing left room');
    assert.equal(state.getWebSockets(PEER_A).length, 21);
    for (let i = 0; i < 280; i++) state.sockets.push(new FakeSocket([i.toString(16).padStart(16, '0')]));
    assert.equal((await openedEnd(live, PEER_B)).closed.code, 4013, '300 open, one closing');
    state.sockets[5].close(1000, '');
    assert.equal((await openedEnd(live, PEER_B)).closed, null);
  });
});

test('the socket: the address is a hash of CF-Connecting-IP, one for an IPv6 /64 however written, and one per IPv4', async () => {
  const live = fakeLive();
  const w = setup({ env: { LIVE: live.ns } });
  const peer = async (ip) => {
    const headers = { ...SITE, ...(ip === null ? {} : { 'cf-connecting-ip': ip }), 'x-forwarded-for': '9.9.9.9' };
    assert.equal((await w.fetch(wsRequest(headers))).status, 200);
    return live.requests.at(-1).headers.get('x-live-peer');
  };
  const same = ['2001:db8:0:1::1', '2001:0DB8:0000:0001:ffff:ffff:ffff:ffff', '2001:db8::1:0:0:0:2', '2001:db8:0:1:0:0:1.2.3.4',
    '2001:db8:0:01::'];
  const tags = [];
  for (const ip of same) tags.push(await peer(ip));
  for (const [i, t] of tags.entries()) {
    assert.match(t, /^[0-9a-f]{16}$/);
    assert.equal(t, tags[0], same[i]);
  }
  const all = [tags[0]];
  for (const ip of ['2001:db8:0:2::1', '2001:db8:1:1::1', '::1', '203.0.113.7', '203.0.113.8', '']) all.push(await peer(ip));
  assert.equal(new Set(all).size, all.length, 'another /64, or another IPv4, is another address');
  // No address (only off Cloudflare): one tag for all, not the forwarded one.
  assert.equal(await peer('::'), await peer('0:0:0:0:ffff::1'), 'the /64 of ::1');
  assert.equal(await peer(null), await peer(''));
  assert.notEqual(await peer(null), await peer('9.9.9.9'));
  // An IPv4 written as IPv6 is that IPv4: two of them are two addresses, not one shared /64.
  for (const ip of ['::ffff:203.0.113.7', '::FFFF:cb00:7107', '0:0:0:0:0:ffff:203.0.113.7']) {
    assert.equal(await peer(ip), await peer('203.0.113.7'), ip);
  }
  assert.notEqual(await peer('::ffff:203.0.113.7'), await peer('::ffff:203.0.113.8'));
});

test('the object: a tab\'s close is answered with its own code, 1000 for one that cannot be sent', async () => {
  await withRuntime(async () => {
    const live = new Live(fakeState());
    for (const [code, back] of [[1000, 1000], [1001, 1001], [4000, 4000], [1005, 1000], [1006, 1000]]) {
      const ws = new FakeSocket();
      live.webSocketClose(ws, code, '', code !== 1006);
      assert.deepEqual(ws.closed, { code: back, reason: 'closed' }, String(code));
    }
    const done = new FakeSocket();
    done.close = () => { throw new Error('already closed'); };
    assert.doesNotThrow(() => live.webSocketClose(done, 1001, '', true));
  });
});

test('the object: a notice goes to every socket as numbers, and a new socket gets what is known', async () => {
  await withRuntime(async () => {
    const real = Date.now;
    const now = Date.parse('2026-09-30T12:00:00Z');
    Date.now = () => now;
    try {
      const state = fakeState();
      const live = new Live(state);
      await openWs(live);
      await openWs(live);
      const at = Math.floor(now / 1000);
      const a = { id: '1-1', start: NA_WEEK, score: 6000, at };
      // Text, a forged id, a fraction and an old entry are dropped; only what is left is sent.
      const r = await notifyLive(live, [a, { id: '1-2', start: NA_WEEK, score: '<b>', at }, { id: '__proto__', start: 1, score: 1, at },
        { id: '1-3', start: NA_WEEK, score: 1.5, at }, { id: '2-1', start: EU_WEEK, score: 1, at, by: '<script>' }]);
      assert.equal(r.status, 200);
      const b = { id: '2-1', start: EU_WEEK, score: 1, at };
      for (const ws of state.sockets) assert.deepEqual(ws.sent.map((m) => JSON.parse(m)), [{ matches: [a, b] }]);
      assert.equal((await notifyLive(live, [{ id: 'x', start: 1, score: 1, at }])).status, 400);
      for (const body of ['null', '{"matches":5}', '[]']) {
        assert.equal((await live.fetch(new Request('https://live/notify', { method: 'POST', body }))).status, 400, body);
      }
      assert.ok(state.sockets.every((ws) => ws.sent.length === 1), 'nothing sent for nothing valid');
      // A socket that closed meanwhile does not stop the others.
      state.sockets[0].close(1000, '');
      const a2 = { ...a, score: 6100, at: at + 30 };
      await notifyLive(live, [a2]);
      assert.deepEqual(JSON.parse(state.sockets[1].sent.at(-1)), { matches: [a2] });
      const fresh = (await openWs(live), state.sockets.at(-1));
      assert.deepEqual(JSON.parse(fresh.sent[0]), { matches: [a2, b] });
      // Two hours on, with the readers stopped, a new socket is sent nothing old.
      Date.now = () => now + 2 * 3600e3 + 60e3;
      await openWs(live);
      assert.deepEqual(state.sockets.at(-1).sent, []);
      // And a notice of one match leaves the other out of what a new socket gets.
      Date.now = () => now + 2 * 3600e3 + 60e3;
      await notifyLive(live, [{ ...b, at: at + 7260 }]);
      await openWs(live);
      assert.deepEqual(JSON.parse(state.sockets.at(-1).sent[0]), { matches: [{ ...b, at: at + 7260 }] });
    } finally {
      Date.now = real;
    }
  });
});

test('the ingest tells the object after D1, outside the answer, only what was applied', async () => {
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  let rowAtNotice = null;
  let release;
  const held = new Promise((r) => { release = r; });
  let w;
  let writesAtNotice = null;
  const live = fakeLive(async (req) => {
    const one = (q) => ({ ...w.sql.prepare(q).get() });
    rowAtNotice = one("SELECT score, at FROM latest WHERE id = '1-1'");
    writesAtNotice = {
      board: one("SELECT count(*) n FROM board WHERE match = '1-1'").n,
      history: one("SELECT n FROM history WHERE match = '1-1'").n,
      kills: one('SELECT count(*) n FROM kills').n,
      recent: one('SELECT at FROM recent WHERE id = 1').at
    };
    await held;
    return new Response('ok');
  });
  w = setup({ env: { ...SUPA_ENV, LIVE: live.ns }, ctx });
  const board = { vp: [500, 400, 300], skirmishes: [[NA_DONE, 100, 200, 300], [NA_DONE + 1, 1, 2, 3]] };
  const { r, lines } = await quiet(() => pushV2(w, 'latest-supa-us', [{ id: '1-1', board, hist: { n: NA_DONE } }, { id: '1-2' }]));
  assert.equal(r, 200, 'answered while the notice is still held');
  assert.equal(waits.length, 1);
  await new Promise((res) => setImmediate(res));
  const at = Math.floor(w.now / 1000);
  assert.deepEqual(rowAtNotice, { score: 6000, at }, 'the row was in D1 when the object was told');
  assert.deepEqual(writesAtNotice, { board: 1, history: NA_DONE, kills: 2, recent: w.now }, 'and every other write of the message');
  assert.deepEqual(await live.requests[0].json(), { matches: [
    { id: '1-1', start: NA_WEEK, score: 6000, at }, { id: '1-2', start: NA_WEEK, score: 6000, at }] });
  assert.equal(live.requests[0].url, 'https://live/notify');
  release();
  await Promise.all(waits);
  assert.ok(!lines.some((l) => l.push));
  // A message that applied nothing (the same score again) tells nobody.
  assert.equal(await pushV2(w, 'latest-supa-eu', [{ id: '1-1' }]), 200);
  assert.equal(waits.length, 1);
});

test('the ingest: a notice that fails only logs, and the message is taken', async (sub) => {
  for (const [name, fetch] of [
    ['throws', async () => { throw new Error('quota'); }],
    ['answers 500', async () => new Response('x', { status: 500 })]
  ]) {
    await sub.test(name, async () => {
      const waits = [];
      const w = setup({ env: { ...SUPA_ENV, LIVE: fakeLive(fetch).ns }, ctx: { waitUntil: (p) => waits.push(p) } });
      const { r, lines } = await quiet(async () => { const s = await pushV2(w, 'latest-supa-us', [{ id: '1-1' }]); await Promise.all(waits); return s; });
      assert.equal(r, 200);
      assert.equal(w.sql.prepare("SELECT score FROM latest WHERE id = '1-1'").get().score, 6000);
      assert.equal(lines.filter((l) => l.push === 'failed').length, 1);
    });
  }
});
