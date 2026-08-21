/**
 * scopetrace runtime.
 *
 * Two chains are tracked per activation, and they are NOT the same chain:
 *
 *   caller        - who called me. Follows execution and survives `await`,
 *                   because the current frame lives in an AsyncLocalStorage
 *                   store rather than on a shared stack.
 *   lexicalParent - the activation of the function I was *defined* inside.
 *                   This is what makes closure capture possible: a factory's
 *                   locals must stay readable when the function it returned
 *                   throws minutes later, from an unrelated call site.
 *
 * Lifetime rule that everything else follows from: a Frame is retained exactly
 * as long as some live closure lexically captures it. So the call tree stores
 * plain metadata nodes, never Frames — otherwise the tree would pin every
 * local variable of every call for the whole trace.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { snapshot, safeRead } from './serialize.js';

const als = new AsyncLocalStorage();
const captures = new WeakMap(); // Error -> Capture; one error unwinds many frames

let seq = 0;
let config = {
  enabled: true,
  maxFramesPerError: 32,   // stop recording once the unwind is this deep
  maxLexicalDepth: 8,      // how far up the closure chain to snapshot
  keepTree: true,
  maxChildren: 64,         // per node
  maxNodes: 5000,          // per trace
  onCapture: null,         // (capture) => void
  shouldTrace: null,       // () => boolean, consulted only at trace roots
  snapshot: {},            // serializer overrides
};

export function configure(patch) { config = { ...config, ...patch }; return config; }
export const getConfig = () => config;

class Frame {
  constructor(meta, scope, lexicalParent, caller, isAsync) {
    this.id = ++seq;
    this.meta = meta;                  // { f, s, l, c }
    this.scope = scope;                // () => ({ name: value }); lazy, only called on capture
    this.lexicalParent = lexicalParent || null;
    this.caller = caller;
    this.isAsync = !!isAsync;
    this.trace = caller ? caller.trace : { id: this.id, nodes: 0, root: null };
    this.node = { fn: meta.f, file: meta.s, line: meta.l, id: this.id, ms: 0, children: null };
    this.startedAt = performance.now();
    this.endedAt = null;

    if (config.keepTree && this.trace.nodes < config.maxNodes) {
      this.trace.nodes++;
      if (caller) {
        const c = (caller.node.children ??= []);
        if (c.length < config.maxChildren) c.push(this.node);
        else if (c.length === config.maxChildren) c.push({ elided: true });
      } else {
        this.trace.root = this.node;
      }
    }
  }
  get duration() { return (this.endedAt ?? performance.now()) - this.startedAt; }
}

export function enter(meta, scope, lexicalParent, isAsync) {
  if (!config.enabled) return null;
  const caller = als.getStore() || null;
  if (!caller && config.shouldTrace && !config.shouldTrace(meta)) return null;
  const frame = new Frame(meta, scope, lexicalParent, caller, isAsync);
  // Sync functions use enterWith so the body needs no callback wrapper, which
  // would break `arguments`, `new.target` and `super`. Async functions cannot:
  // enterWith would still be in effect when the function suspends at its first
  // await and control returns to the caller, so every later call in the caller
  // would be misparented under the callee. Those go through run() instead,
  // which restores the previous store the moment the body suspends.
  if (!frame.isAsync) als.enterWith(frame);
  return frame;
}

export const run = (frame, fn) => (frame ? als.run(frame, fn) : fn());

export function exit(frame) {
  if (!frame) return;
  frame.endedAt = performance.now();
  frame.node.ms = +frame.duration.toFixed(3);
  if (!frame.isAsync) als.enterWith(frame.caller);
  // Drop the dynamic link. A frame that outlives its call is one a closure
  // captured; keeping `caller` alive would drag the whole call chain's locals
  // along with it. The lexical chain is the one that stays meaningful.
  frame.caller = null;
}

/**
 * Called from every instrumented frame the error escapes, innermost first.
 * That ordering is the whole point: by the time a `catch` in some outer
 * function runs, the inner activation records are already gone.
 */
export function thrown(frame, error) {
  if (!config.enabled || !frame) return;
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return;
  let cap = captures.get(error);
  if (!cap) {
    cap = {
      error: describeError(error),
      thrownAt: Date.now(),
      traceId: frame.trace.id,
      frames: [],
      tree: frame.trace.root,
      sealed: false,
    };
    captures.set(error, cap);
  }
  if (cap.sealed || cap.frames.length >= config.maxFramesPerError) return;
  frame.node.threw = true;
  cap.frames.push(captureFrame(frame));
  config.onCapture?.(cap);
}

function captureFrame(frame) {
  const out = {
    fn: frame.meta.f, file: frame.meta.s, line: frame.meta.l, col: frame.meta.c,
    frameId: frame.id, durationMs: +frame.duration.toFixed(3),
    locals: readScope(frame),
    closure: [],
  };
  let lex = frame.lexicalParent, d = 0;
  while (lex && d++ < config.maxLexicalDepth) {
    out.closure.push({
      fn: lex.meta.f, file: lex.meta.s, line: lex.meta.l, frameId: lex.id,
      live: lex.endedAt === null,   // false => reading a returned factory's captured vars
      vars: readScope(lex),
    });
    lex = lex.lexicalParent;
  }
  return out;
}

function readScope(frame) {
  if (typeof frame.scope !== 'function') return { __t: 'released' };
  const raw = safeRead(frame.scope);
  // undefined => the frame threw before its scope thunk was installed, i.e. on
  // the very first statement of the body.
  return raw === undefined ? { __t: 'object' } : snapshot(raw, config.snapshot);
}

function describeError(e) {
  return {
    name: e?.name ?? typeof e,
    message: String(e?.message ?? e),
    stack: String(e?.stack ?? '').split('\n').slice(0, 20).join('\n'),
  };
}

/** Everything recorded while `error` unwound, or null if it never crossed instrumented code. */
export function captureOf(error) {
  const cap = captures.get(error);
  if (cap) cap.sealed = true;
  return cap ?? null;
}

export const currentFrame = () => als.getStore() ?? null;
export function currentStack() {
  const out = [];
  for (let f = als.getStore(); f; f = f.caller) out.push(`${f.meta.f} (${f.meta.s}:${f.meta.l})`);
  return out;
}

/** Snapshot the live scope chain with no error involved — a logpoint. */
export function captureHere(label = 'manual') {
  const f = als.getStore();
  if (!f) return null;
  return { label, traceId: f.trace.id, frames: [captureFrame(f)], tree: f.trace.root };
}

export { safeRead as v };

// Instrumented code reaches the runtime through a global so emitted code never
// has to resolve a module specifier — that survives bundling, minification and
// mixed CJS/ESM graphs.
const api = { enter, exit, run, thrown, v: safeRead, configure, getConfig, captureOf, captureHere, currentStack, currentFrame };
// Merge rather than replace: an instrumented module may be evaluated before
// this one and will have installed a no-op shim under the same key, holding a
// reference to that exact object. Upgrade it in place.
const installed = (globalThis.__SCOPETRACE__ ??= api);
if (installed !== api) Object.assign(installed, api);
export default installed;
