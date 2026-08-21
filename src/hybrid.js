/**
 * Hybrid engine: retention hints (compile time, free) + V8 inspector (capture
 * time, pay only on throw).
 *
 * The three engines and what each costs:
 *
 *   transform (runtime.js)  every call: try/catch + closure alloc + ALS write.
 *                           Always-on call tree with real timings. ~60x on a
 *                           call-saturated microbenchmark.
 *   inspector (inspector.js) zero call cost, but only sees variables V8 chose
 *                           to context-allocate — which for a factory's closure
 *                           is often nothing at all.
 *   hybrid (here)           zero call cost AND full closure visibility, because
 *                           retain-plugin forces the allocation V8 skipped.
 *                           Call tree comes from the paused stack instead of a
 *                           runtime-maintained one, so it has no timings.
 *
 * Emits the same capture shape as runtime.js, so format() renders all three.
 */
import { Session } from 'node:inspector';
import { snapshot } from './serialize.js';

let session = null;
let opts = null;
let seq = 0;
const scripts = new Map();      // scriptId -> url (callFrame.url is empty for pre-enable scripts)
const byId = new Map();         // capture id -> capture
const pending = [];
let windowStart = 0;
let windowCount = 0;
export let tripped = false;      // true while the circuit breaker is open

const ID_KEY = '__scopetrace_id';

export function start({
  maxFrames = 16,
  maxProps = 64,
  maxCaptures = 200,
  asyncStackDepth = 32,
  filter = null,               // (description, callFrames) => boolean
  maxPerSecond = 50,           // circuit breaker; 0 disables it
  cooldownMs = 5000,
  onCapture = null,
  includeGlobal = false,
  includeNodeModules = false,
} = {}) {
  if (session) return stop;
  opts = { maxFrames, maxProps, maxCaptures, filter, maxPerSecond, cooldownMs,
           onCapture, includeGlobal, includeNodeModules };
  session = new Session();
  session.connect();
  session.on('Debugger.scriptParsed', ({ params }) => scripts.set(params.scriptId, params.url));
  session.post('Debugger.enable');
  // Async parent frames come free from V8; no AsyncLocalStorage needed to keep
  // the tree connected across `await`.
  if (asyncStackDepth > 0) session.post('Debugger.setAsyncCallStackDepth', { maxDepth: asyncStackDepth });
  session.post('Debugger.setPauseOnExceptions', { state: 'all' });   // 'all' => caught ones too
  session.on('Debugger.paused', onPaused);
  return stop;
}

export function stop() {
  if (!session) return;
  try {
    session.post('Debugger.setPauseOnExceptions', { state: 'none' });
    session.post('Debugger.disable');
    session.disconnect();
  } finally { session = null; scripts.clear(); }
}

/** The capture recorded when this exact error object was thrown, or null. */
export function captureOf(error) {
  const id = error && (typeof error === 'object' || typeof error === 'function') ? error[ID_KEY] : null;
  return id == null ? null : byId.get(id) ?? null;
}

export const drain = () => pending.splice(0, pending.length);

function onPaused({ params }) {
  // Runs with the isolate paused: strictly synchronous, and it must never throw
  // — an exception here would escape into whatever code was unwinding.
  try {
    if (params.reason !== 'exception' && params.reason !== 'promiseRejection') return;
    const data = params.data || {};
    const description = data.description || data.value || '';
    if (opts.filter && !opts.filter(description, params.callFrames)) return;
    if (overBudget()) return;

    const frames = [];
    for (const cf of params.callFrames) {
      if (frames.length >= opts.maxFrames) break;
      const url = cf.url || scripts.get(cf.location.scriptId) || '';
      if (isInternal(url)) continue;
      frames.push(readFrame(cf, url));
    }
    if (!frames.length) return;

    const id = ++seq;
    const capture = {
      engine: 'hybrid',
      id,
      error: describe(description, data),
      thrownAt: Date.now(),
      frames,
      tree: treeFromFrames(frames, params.asyncStackTrace),
    };

    // Tag the live error object so captureOf(err) can find this again later,
    // from a catch block arbitrarily far up. Non-enumerable so it does not
    // show up in logs, JSON, or deep-equality assertions.
    if (data.objectId) tag(data.objectId, id);

    byId.set(id, capture);
    pending.push(capture);
    while (pending.length > opts.maxCaptures) byId.delete(pending.shift().id);
    opts.onCapture?.(capture);
  } catch { /* never break the program being observed */ }
  finally {
    session.post('Debugger.resume');
  }
}

/**
 * Pausing the isolate costs ~280us per throw. That is nothing for a service
 * that throws occasionally and ruinous for code that uses exceptions as control
 * flow, so the pause is disarmed once throws exceed a budget and re-armed after
 * a cooldown. Bounded worst case beats an unbounded one you find in production.
 */
function overBudget() {
  if (!opts.maxPerSecond) return false;
  const now = Date.now();
  if (now - windowStart >= 1000) { windowStart = now; windowCount = 0; }
  if (++windowCount <= opts.maxPerSecond) return false;

  tripped = true;
  session.post('Debugger.setPauseOnExceptions', { state: 'none' });
  const t = setTimeout(() => {
    tripped = false;
    windowStart = Date.now();
    windowCount = 0;
    session?.post('Debugger.setPauseOnExceptions', { state: 'all' });
  }, opts.cooldownMs);
  t.unref?.();
  return true;
}

function tag(objectId, id) {
  session.post('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration:
      `function(){try{Object.defineProperty(this,${JSON.stringify(ID_KEY)},` +
      `{value:${id},configurable:true,enumerable:false,writable:true})}catch(e){}}`,
    silent: true,
    returnByValue: true,
  }, () => {});
}

/**
 * One paused call frame -> the runtime.js frame shape.
 *
 * Scope-chain layout: everything before the first 'closure' entry belongs to
 * this activation (its Local plus any block/catch scopes it is standing in),
 * and each 'closure' entry after that is one step up the *lexical* chain —
 * which is precisely the factory chain the transform reconstructs by hand.
 */
function readFrame(cf, url) {
  const locals = {};
  const closure = [];
  let inLocals = true;

  for (const scope of cf.scopeChain) {
    if (scope.type === 'global') continue;
    if (!opts.includeGlobal && (scope.type === 'script' || scope.type === 'module')) continue;

    if (inLocals && (scope.type === 'local' || scope.type === 'block' ||
                     scope.type === 'catch' || scope.type === 'with')) {
      Object.assign(locals, readScope(scope));
      continue;
    }
    inLocals = false;
    if (scope.type !== 'closure') continue;
    const loc = scope.startLocation;
    closure.push({
      fn: scope.name || '(anonymous)',
      file: strip(loc ? scripts.get(loc.scriptId) || '' : url),
      line: (loc?.lineNumber ?? 0) + 1,
      // The inspector cannot tell us whether that activation is still on the
      // stack; what it can tell us is that the closure genuinely retains it.
      live: null,
      vars: readScope(scope),
    });
  }

  return {
    fn: cf.functionName || '(anonymous)',
    file: strip(url),
    line: (cf.location.lineNumber ?? 0) + 1,
    col: cf.location.columnNumber ?? 0,
    frameId: cf.callFrameId,
    durationMs: null,          // no runtime instrumentation => no timing
    locals,
    closure,
  };
}

function readScope(scope) {
  if (!scope.object?.objectId) return {};
  const vars = {};
  let done = false;
  // Same-thread session: the callback fires synchronously while paused.
  session.post('Runtime.getProperties',
    { objectId: scope.object.objectId, ownProperties: true, generatePreview: true },
    (err, res) => {
      done = true;
      if (err) return;
      let n = 0;
      for (const p of res.result || []) {
        if (n++ >= opts.maxProps) { vars.__more = true; break; }
        if (p.get && !p.value) { vars[p.name] = { __t: 'getter' }; continue; }
        vars[p.name] = fromRemote(p.value);
      }
    });
  return done ? vars : { __t: 'unavailable' };
}

/** Innermost-last stack -> the nested node shape format() prints. */
function treeFromFrames(frames, asyncStackTrace) {
  let root = null, cursor = null;
  const push = (fn, file, line, threw) => {
    const node = { fn, file, line, ms: null, children: null, threw };
    if (!cursor) { root = node; cursor = node; return; }
    (cursor.children ??= []).push(node);
    cursor = node;
  };
  for (const chunk of asyncChain(asyncStackTrace).reverse()) {
    for (const f of [...chunk].reverse()) push(f.fn, f.file, f.line, false);
  }
  for (const f of [...frames].reverse()) push(f.fn, f.file, f.line, false);
  if (cursor) cursor.threw = true;
  return root;
}

function asyncChain(trace) {
  const chunks = [];
  for (let t = trace, d = 0; t && d < 8; t = t.parent, d++) {
    const fs = (t.callFrames || [])
      .map((f) => ({ fn: f.functionName || '(anonymous)', file: strip(f.url), line: (f.lineNumber ?? 0) + 1 }))
      .filter((f) => !isInternal(f.file));
    if (fs.length) chunks.push(fs);
  }
  return chunks;
}

function describe(description, data) {
  const first = String(description).split('\n')[0];
  const m = /^([A-Za-z$_][\w$]*(?:Error|Exception))(?::\s*(.*))?$/.exec(first);
  return {
    name: m ? m[1] : (data.className ?? 'Error'),
    message: m ? (m[2] ?? '') : first,
    stack: String(description).split('\n').slice(0, 20).join('\n'),
  };
}

/** RemoteObject -> the shape src/serialize.js produces, so both engines format alike. */
function fromRemote(ro) {
  if (!ro) return { __t: 'undefined' };
  switch (ro.type) {
    case 'undefined': return { __t: 'undefined' };
    case 'boolean': case 'number': return ro.value;
    case 'string': return ro.value;
    case 'bigint': return { __t: 'bigint', v: ro.unserializableValue ?? String(ro.value) };
    case 'symbol': return { __t: 'symbol', v: ro.description };
    case 'function': return { __t: 'function', name: ro.description?.match(/^\w*\s*([\w$]*)/)?.[1] || '(anonymous)' };
  }
  if (ro.subtype === 'null') return null;
  if (ro.subtype === 'date') return { __t: 'date', v: ro.description };
  if (ro.subtype === 'regexp') return { __t: 'regexp', v: ro.description };
  if (ro.subtype === 'internal#error') return { __t: 'uninitialized' };
  if (ro.subtype === 'error') return { __t: 'error', name: 'Error', message: ro.description?.split('\n')[0] ?? '' };
  const preview = ro.preview;
  if (!preview) return { __t: 'truncated', ctor: ro.className };
  const out = { __t: ro.subtype === 'array' ? 'array' : 'object', __ctor: ro.className };
  for (const p of preview.properties ?? []) {
    out[p.name] = p.type === 'object' ? { __t: 'truncated', ctor: p.value ?? 'Object' } : coerce(p);
  }
  if (preview.overflow) out.__more = true;
  return snapshot(out, { maxDepth: 3 });
}

const coerce = (p) =>
  p.type === 'number' ? Number(p.value)
  : p.type === 'boolean' ? p.value === 'true'
  : p.type === 'undefined' ? { __t: 'undefined' }
  : p.value;

const CWD = process.cwd();
const strip = (u) => {
  const f = String(u || '').replace(/^file:\/\//, '');
  return f.startsWith(CWD) ? f.slice(CWD.length + 1) : f;
};
const isInternal = (url) =>
  !url || url.startsWith('node:') || url.includes('/internal/') ||
  (!opts?.includeNodeModules && url.includes('node_modules')) ||
  url.includes('/scopetrace/src/');
