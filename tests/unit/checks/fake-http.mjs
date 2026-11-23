// A fetch that answers from a function, for the checks that look outward: no socket opens.
// answer(url, init) returns { status, body, headers } (body: text or anything JSON) or throws.
export function fakeFetch(answer) {
  const asked = [];
  const fetchFn = async (url, init = {}) => {
    asked.push(`${init.method || 'GET'} ${url}`);
    const a = await answer(String(url), init);
    const body = a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
    return new Response(init.method === 'HEAD' ? null : body, { status: a.status ?? 200, headers: a.headers });
  };
  fetchFn.asked = asked;
  return fetchFn;
}

// A sleep that does not wait, and counts the pauses between attempts.
export function fakeSleep() {
  const sleep = async (seconds) => { sleep.slept.push(seconds); };
  sleep.slept = [];
  return sleep;
}

export const lines = (result) => result.out.join('\n');
export const errors = (result) => result.out.filter((l) => l.startsWith('::error::'));
