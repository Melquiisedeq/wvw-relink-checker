// A signed POST to the Worker's entrance, as the Apps Scripts and the Supabase
// readers send it, and the signature cases every signed route shares.
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import worker from '../../worker/index.mjs';

// The two headers the entrance checks: the time, and HMAC-SHA256 over time, path and body
// (text or bytes).
export function signHeaders(key, t, path, body) {
  const sig = createHmac('sha256', key).update(t + '\n' + path + '\n').update(body).digest('hex');
  return { 'x-wvw-time': String(t), 'x-wvw-sig': sig };
}

// The POST itself, with Date.now held at `now` while the Worker runs.
export async function postSigned(env, now, path, body, headers) {
  const real = Date.now;
  Date.now = () => now;
  try {
    return await worker.fetch(new Request('https://wvwrelink.com' + path, { method: 'POST', body, headers }), env, {});
  } finally {
    Date.now = real;
  }
}

// The signature cases every entrance route must refuse or hold, once, run against each route.
// A route: { name, source, envName, make(env) -> harness whose post(source, body, { headers, key, t,
// sigPath }) answers the status, body(w) -> a valid body, otherKey, otherPath, untouched(w) asserts
// that nothing refused was written }.
export function defineSignatureTests(test, routes) {
  for (const r of routes) {
    test(r.name + ': the entrance refuses what is not signed, fresh and for this route', async (t) => {
      const w = r.make();
      const good = r.body(w);
      const t0 = Math.floor(w.now / 1000);
      const cases = [
        ['no signature headers', () => w.post(r.source, good, { headers: {} }), 401],
        ['signed with another source\'s secret', () => w.post(r.source, good, { key: r.otherKey }), 401],
        // The right key and body, signed for another path: only the path in the signature can refuse it.
        ['signed for another path', () => w.post(r.source, good, { sigPath: r.otherPath }), 401],
        ['six minutes in the future', () => w.post(r.source, good, { t: t0 + 360 }), 401],
        ['six minutes old', () => w.post(r.source, good, { t: t0 - 360 }), 401]
      ];
      for (const [name, send, want] of cases) {
        await t.test(name, async () => assert.equal(await send(), want));
      }
      r.untouched(w);
    });

    test(r.name + ': a message signed at or before the last accepted one is a replay', async () => {
      const w = r.make();
      const good = r.body(w);
      const t = Math.floor(w.now / 1000);
      assert.equal(await w.post(r.source, good, { t }), 200);
      assert.equal(await w.post(r.source, good, { t }), 409);
      assert.equal(await w.post(r.source, good, { t: t - 1 }), 409);
    });

    test(r.name + ': a missing or short secret closes the source rather than weakening it', async () => {
      const none = r.make({ [r.envName]: undefined });
      assert.equal(await none.post(r.source, r.body(none)), 404);
      const k = 'k'.repeat(63);
      const half = r.make({ [r.envName]: k });
      assert.equal(await half.post(r.source, r.body(half), { key: k }), 404);
    });
  }
}
