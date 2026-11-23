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
