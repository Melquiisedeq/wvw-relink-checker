// A signed POST to the Worker's entrance, as the Apps Scripts and the Supabase
// readers send it.
import { createHmac } from 'node:crypto';
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
