/**
 * Transform-free engine: capture scopes via the V8 inspector.
 *
 * Trade-off vs the Babel transform:
 *   + no build step, works on dependencies and already-shipped code
 *   + sees *every* binding V8 knows about, including nested block scopes,
 *     without any static analysis
 *   - pauses the isolate on each matching throw (caught ones included), which
 *     is far too costly to leave on unconditionally in a hot path
 *   - unavailable where the inspector is disabled or already occupied
 *
 * They compose: the transform gives you the always-on call tree, this gives you
 * deep scope detail for the throws you care about.
 */
import { Session } from 'node:inspector';
import { snapshot } from './serialize.js';

let session = null;
let opts = null;
const pending = [];
// callFrame.url is empty for scripts V8 parsed before Debugger.enable, so URLs
// are resolved through the scriptParsed stream instead.
const scripts = new Map();

export function start({
  maxFrames = 12,
  maxProps = 48,
  filter = null,        // (description, callFrames) => boolean
  onCapture = null,
  includeGlobal = false,
} = {}) {
  if (session) return stop;
  opts = { maxFrames, maxProps, filter, onCapture, includeGlobal };
  session = new Session();
  session.connect();
  session.on('Debugger.scriptParsed', ({ params }) => scripts.set(params.scriptId, params.url));
  session.post('Debugger.enable');
  session.post('Debugger.setPauseOnExceptions', { state: 'all' });
  session.on('Debugger.paused', onPaused);
  return stop;
}

export function stop() {
  if (!session) return;
  try { session.post('Debugger.setPauseOnExceptions', { state: 'none' }); session.disconnect(); }
  finally { session = null; scripts.clear(); }
}

export const drain = () => pending.splice(0, pending.length);

function onPaused({ params }) {
  // Everything below runs while the isolate is paused. It must stay
  // synchronous: no promises can settle and no timers can fire until resume.
  try {
    if (params.reason !== 'exception' && params.reason !== 'promiseRejection') return;
    const description = params.data?.description || params.data?.value || '';
    if (opts.filter && !opts.filter(description, params.callFrames)) return;

    const frames = [];
    for (const cf of params.callFrames.slice(0, opts.maxFrames)) {
      const url = cf.url || scripts.get(cf.location.scriptId) || '';
      if (isInternal(url)) continue;
      frames.push({
        fn: cf.functionName || '(anonymous)',
        file: url.replace(/^file:\/\//, ''),
        line: (cf.location.lineNumber ?? 0) + 1,
        col: cf.location.columnNumber ?? 0,
        scopes: cf.scopeChain
          .filter((s) => s.type !== 'global' || opts.includeGlobal)
          .map(readScope)
          .filter(Boolean),
      });
    }
    const capture = { engine: 'inspector', error: { message: String(description).split('\n')[0] }, thrownAt: Date.now(), frames };
    pending.push(capture);
    if (pending.length > 200) pending.shift();
    opts.onCapture?.(capture);
  } catch { /* a failed capture must never break the program being observed */ }
  finally {
    session.post('Debugger.resume');
  }
}

function readScope(scope) {
  if (!scope.object?.objectId) return null;
  const vars = {};
  let done = false;
  // Same-thread inspector: the reply is delivered synchronously while paused.
  session.post('Runtime.getProperties',
    { objectId: scope.object.objectId, ownProperties: true, generatePreview: true },
    (err, res) => {
      done = true;
      if (err) return;
      for (const p of (res.result || []).slice(0, opts.maxProps)) {
        if (p.get && !p.value) { vars[p.name] = { __t: 'getter' }; continue; }
        vars[p.name] = fromRemote(p.value);
      }
    });
  if (!done) return { type: scope.type, name: scope.name, vars: { __t: 'unavailable' } };
  return { type: scope.type, name: scope.name, vars };
}

/** RemoteObject -> the same shape src/serialize.js produces, so both engines format alike. */
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

const isInternal = (url) => !url || url.startsWith('node:') || url.includes('node_modules') || url.includes('/scopetrace/src/');
