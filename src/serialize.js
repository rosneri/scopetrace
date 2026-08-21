/**
 * Bounded, cycle-safe snapshotting of live values.
 *
 * Snapshots are EAGER: by the time a capture is inspected the program has moved
 * on, so we copy structure now and cap it hard. Everything here is designed to
 * never throw and never run user code (no getters, no toJSON).
 */

const DEFAULTS = {
  maxDepth: 4,
  maxProps: 32,
  maxArray: 32,
  maxString: 512,
  redact: /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credit|ssn/i,
};

const UNINIT = { __scopetrace: 'uninitialized' }; // TDZ / not yet assigned

export function safeRead(read) {
  try {
    return read();
  } catch (err) {
    // ReferenceError => the binding exists lexically but is in its TDZ, which is
    // itself information: the throw happened before this line ran.
    return err instanceof ReferenceError ? UNINIT : { __scopetrace: 'unreadable' };
  }
}

export function snapshot(value, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  return walk(value, 0, { map: new WeakMap(), n: 0 }, o, null);
}

function walk(value, depth, seen, o, key) {
  if (value === UNINIT) return { __t: 'uninitialized' };
  if (key != null && o.redact.test(key)) return { __t: 'redacted' };

  switch (typeof value) {
    case 'undefined': return { __t: 'undefined' };
    case 'boolean': case 'number': return value;
    case 'bigint': return { __t: 'bigint', v: String(value) };
    case 'symbol': return { __t: 'symbol', v: String(value) };
    case 'string':
      return value.length > o.maxString
        ? { __t: 'string', v: value.slice(0, o.maxString), truncated: value.length }
        : value;
    case 'function':
      return { __t: 'function', name: value.name || '(anonymous)', arity: value.length };
  }
  if (value === null) return null;

  if (seen.map.has(value)) return { __t: 'circular', ref: seen.map.get(value) };
  const ref = seen.n++;
  seen.map.set(value, ref);

  if (depth >= o.maxDepth) return { __t: 'truncated', ctor: ctorName(value) };

  if (value instanceof Error) {
    return {
      __t: 'error', name: value.name, message: value.message,
      stack: String(value.stack || '').split('\n').slice(0, 12).join('\n'),
      cause: value.cause === undefined ? undefined : walk(value.cause, depth + 1, seen, o, 'cause'),
    };
  }
  if (value instanceof Date) return { __t: 'date', v: value.toISOString() };
  if (value instanceof RegExp) return { __t: 'regexp', v: String(value) };
  if (value instanceof Promise) return { __t: 'promise' };
  if (value instanceof Map) return { __t: 'map', size: value.size, entries: capped([...value].slice(0, o.maxArray), depth, seen, o) };
  if (value instanceof Set) return { __t: 'set', size: value.size, values: capped([...value].slice(0, o.maxArray), depth, seen, o) };
  if (ArrayBuffer.isView(value)) return { __t: 'typedarray', ctor: ctorName(value), length: value.length };

  if (Array.isArray(value)) {
    const out = capped(value.slice(0, o.maxArray), depth, seen, o);
    if (value.length > o.maxArray) out.push({ __t: 'more', count: value.length - o.maxArray });
    return out;
  }

  const out = { __t: 'object', __id: ref };
  if (ctorName(value) !== 'Object') out.__ctor = ctorName(value);
  let n = 0;
  for (const k of Reflect.ownKeys(value)) {
    if (typeof k === 'symbol') continue;
    if (n++ >= o.maxProps) { out.__more = Reflect.ownKeys(value).length - o.maxProps; break; }
    const d = Reflect.getOwnPropertyDescriptor(value, k);
    // Never invoke a getter: it can mutate state or throw during a crash path.
    out[k] = d.get ? { __t: 'getter' } : walk(d.value, depth + 1, seen, o, k);
  }
  return out;
}

const capped = (arr, depth, seen, o) => arr.map((v) => walk(v, depth + 1, seen, o, null));
const ctorName = (v) => {
  try { return Object.getPrototypeOf(v)?.constructor?.name ?? 'null-proto'; }
  catch { return 'unknown'; }
};
