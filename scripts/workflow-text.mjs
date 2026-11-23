// Text for the log of a check, as GitHub Actions and the people reading it expect it.
//
// Text from the game's API or the spreadsheets is written by strangers: a newline
// followed by "::" in it would start a second command in the log, so everything that
// goes after "::error::" passes through escape(). The rest writes values the way the
// messages quote them: Python's type names, repr() and json.dumps().

export function escape(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

// The text of a value as `'%s' % value` wrote it, for what an answer might carry.
export function show(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'object') return repr(value);
  return String(value);
}

// Python's repr() of what JSON.parse gives.
export function repr(value) {
  if (typeof value === 'string') {
    const q = value.includes("'") && !value.includes('"') ? '"' : "'";
    const body = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q;
  }
  if (Array.isArray(value)) return `[${value.map(repr).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${repr(k)}: ${repr(v)}`).join(', ')}}`;
  }
  return show(value);
}

// json.dumps(): ", " and ": " between the parts, and everything past ASCII as \uXXXX.
export function dumps(value) {
  if (typeof value === 'string') {
    return JSON.stringify(value).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
  if (Array.isArray(value)) return `[${value.map(dumps).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${dumps(k)}: ${dumps(v)}`).join(', ')}}`;
  }
  return JSON.stringify(value);
}

// type(value).__name__ for what JSON.parse gives.
export function typeName(value) {
  if (value === null) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object') return 'dict';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  return Number.isInteger(value) ? 'int' : 'float';
}

// Python's truth of what JSON.parse gives: empty lists, objects and strings, 0 and null are false.
export function truthy(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

// len() of a list, a string or an object.
export function len(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : value.length;
}

// `key in value` for a parsed object: false for anything that is not one.
export function has(value, key) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key);
}

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// "TypeError: fetch failed (ENOTFOUND)": what went wrong, with the cause fetch hides in it.
export function describe(error) {
  const cause = error && error.cause;
  const why = cause && (cause.code || cause.message);
  return `${error && error.name}: ${error && error.message}${why ? ` (${why})` : ''}`;
}

// str.strip(): the whitespace is Python's, not JavaScript's (\x1c-\x1f and \x85 count, the BOM does not). Walked from both
// ends, no regex: a long run of spaces inside the text must not cost more than its length.
const PY_SPACE = new Set([
  ...Array.from({ length: 5 }, (_, i) => 9 + i), ...Array.from({ length: 4 }, (_, i) => 0x1c + i), 0x20, 0x85, 0xa0, 0x1680,
  ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);
export function strip(text) {
  const s = String(text);
  let start = 0;
  let end = s.length;
  while (start < end && PY_SPACE.has(s.charCodeAt(start))) start++;
  while (end > start && PY_SPACE.has(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}

// '%.{digits}f' % x: a value exactly halfway rounds to the even digit, where toFixed rounds away from zero.
export function fixed(x, digits) {
  if (!Number.isFinite(x)) return x.toFixed(digits);
  const exact = x.toFixed(digits + 60);
  if (!/^50*$/.test(exact.slice(-60))) return x.toFixed(digits);
  const kept = exact.slice(0, -60).replace(/\.$/, '');
  return Number(kept.slice(-1)) % 2 === 0 ? kept : x.toFixed(digits);
}

// The text of a body with a leading BOM kept and bad bytes replaced: the cells are judged as they came, and a BOM is not whitespace.
export const decode = (bytes) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

// GET a url as text, retried: [text, error], the error worded "HTTP 403 after 3 attempts".
export function makeFetchText({ fetchFn, sleep, userAgent }) {
  return async function fetchText(url) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(5);
      try {
        const res = await fetchFn(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(30000) });
        if (!res.ok) {
          last = `HTTP ${res.status}`;
          await res.body?.cancel();
          continue;
        }
        return [decode(await res.arrayBuffer()), null];
      } catch (error) { // timeout, DNS, truncated body
        last = describe(error);
      }
    }
    return [null, `${last} after 3 attempts`];
  };
}
