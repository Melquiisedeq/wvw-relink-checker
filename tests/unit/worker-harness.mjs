// A Worker (worker/index.mjs) with its database and a clock the test moves:
// Date.now reads that clock only while a request is being handled.
import worker from '../../worker/index.mjs';
import { fakeD1 } from './fake-d1.mjs';

// start: the clock's first instant (ms); secrets: the env keys the Worker
// reads; env: overrides; ctx: the default execution context of a call; d1: options of fakeD1.
export function workerHarness({ start, secrets = {}, env: extra, ctx: defaultCtx, d1 } = {}) {
  const { sql, ran, DB } = fakeD1(d1);
  const env = { DB, ...secrets, ...extra };
  let clock = start;
  const call = async (req, ctx = defaultCtx) => {
    const real = Date.now;
    Date.now = () => clock;
    try {
      return await worker.fetch(req, env, ctx);
    } finally {
      Date.now = real;
    }
  };
  return {
    sql,
    ran,
    env,
    call,
    get now() { return clock; },
    advance(ms) { clock += ms; }
  };
}
