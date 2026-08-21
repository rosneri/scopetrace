# scopetrace

Auto-instrument Node.js so that at any moment you know the live call tree, and
when an error is thrown — **even if it is caught and swallowed** — you can read
every variable that was in scope at the throw site and all the way up the
closure chain to the factory that created the function.

```
RangeError: order total 1200 exceeds 1000
  at validate examples/demo.js:11:9 (0.7ms)
    locals:
      order = { id: "ord_42", customer: { name: "ada", token: <redacted> }, items: [Object {…}] }
      total = 1200
    ↑ closure, returned: makeValidator examples/demo.js:7
        policy = { maxTotal: 1000, currency: "USD" }
        attempts = 1
        startedAt = 1970-01-01T00:00:00.000Z
  at processOrder examples/demo.js:26 (5.4ms)
    locals:
      order = { id: "ord_42", … }
      receipt = <uninitialized (TDZ)>
  call tree:
    handleRequest 0ms
      makeValidator 3.9ms
      processOrder ✗ 5.6ms
        loadOrder 1.4ms
        validate ✗ 3.9ms
```

## Quick start

```bash
node --import scopetrace/hybrid-register app.js   # recommended: no per-call cost
node --import scopetrace/register app.js          # full transform: adds call-tree timings
```

```js
import { captureOf } from 'scopetrace/hybrid';
import { format } from 'scopetrace';

try { await processOrder(id); }
catch (err) { console.log(format(captureOf(err))); }
```

Bundlers, via unplugin:

```js
import scopetrace from 'scopetrace/unplugin';
export default { plugins: [scopetrace.vite({ mode: 'retain', include: /src\// })] };
// mode: 'capture' for the full transform
// .webpack() .rollup() .esbuild() .rspack() .farm() also available
```

## The two ideas that make it work

**1. Capture on the way out, not at the catch.** By the time your `catch` runs,
the throwing function's activation record is gone — its locals are
unrecoverable. So every function is wrapped:

```js
function validate(order) {
  let _sc;
  const _f = _st.enter(meta, () => _sc && _sc(), _outerFrame, false);
  try {
    _sc = () => ({ order: _st.v(() => order), total: _st.v(() => total) });
    /* original body */
  } catch (e) { _st.thrown(_f, e); throw e; }
  finally { _st.exit(_f); }
}
```

The error passes through each frame's `catch` innermost-first while those frames
are still live, so `thrown()` gets a genuine snapshot of each one before it is
discarded. The thunk is never called on the happy path.

Two details that are easy to get wrong, and cost me a debugging round each:

- The thunk is assigned **inside** the `try`. Wrapping a body in `try {}`
  introduces a block scope; a thunk declared outside it cannot see the body's
  `let`/`const` at all — they read as undeclared rather than as their values.
- Every read is wrapped in `_st.v(() => x)`, so a binding still in its temporal
  dead zone reports as `<uninitialized>` instead of throwing during capture.
  That is real information: the error beat that line.

**2. Two chains, not one.** `caller` follows execution; `lexicalParent` is the
activation the function was *defined* in. Only the second gets you a factory's
closure minutes after it returned, from an unrelated call site. Each function's
frame const is captured lexically by the functions it defines, so a returned
closure keeps a live handle on the activation that created it — and the values
it reports are the current ones (`attempts = 1` above, not `0`).

**AsyncLocalStorage, carefully.** Sync frames use `enterWith`, which needs no
callback wrapper and so preserves `arguments`, `new.target` and `super`. Async
functions **cannot** use it: `enterWith` is still in effect when the function
suspends at its first `await` and control returns to the caller, so every later
call in the caller gets misparented under the callee. Those route through
`als.run()` around a relocated body instead, which restores the previous store
the instant the body suspends. (Cost: async functions that reference
`arguments` are left uninstrumented rather than silently changed.)

## Three engines

Every number in this section is best-of-5 in a clean process, Node 25 on an
M-series Mac, from `npm run bench` — reproduce it before trusting it. The
call-storm workload is a deliberate worst case: nothing but function calls, so
per-call costs show up at their most brutal. Real code with real work in it sits
much closer to 1×, and the per-throw costs are hardware-independent enough to
trust as orders of magnitude rather than exact figures.

| | transform (`scopetrace/register`) | inspector (`scopetrace/inspector`) | **hybrid (`scopetrace/hybrid-register`)** |
|---|---|---|---|
| build step | yes (or the loader hook) | none | hints only (or the loader hook) |
| per-call cost | ~190× on a call storm | none | **none (0.99× measured)** |
| per-throw cost | ~free | ~280 µs (isolate pause) | ~280 µs, rate-limited |
| sees pruned closure vars | yes | **no** | **yes** |
| nested block scopes | no | yes | yes |
| call tree | yes, with timings | no | yes, from the paused stack, no timings |
| covers dependencies | no | yes | yes (capture side) |

**The hybrid is the recommended engine.** It came out of one measurement: the
inspector is free per call but half-blind, because V8 decides at *parse* time
which variables get context-allocated, based purely on whether some inner
function names them textually. A factory local no closure mentions is
stack-allocated and gone the instant the frame pops — no amount of debugging
protocol can recover it.

A never-executed reference flips that decision:

```js
function validate(order) {
  if (0) { policy; attempts; startedAt; }   // <- the entire mechanism
  ...
}
```

Measured, 3M calls through a 3-deep chain: 17.2 ms without the hint, 17.1 ms
with it — the difference is inside run-to-run noise. The branch never
runs, so it costs nothing at runtime; it only changes what V8 decided to keep.
That buys the inspector exactly the visibility the wrapping transform had, at
none of its per-call price:

```
$ node test/fixtures/run-capture.js                          # inspector alone
closure vars: [ 'policy' ]

$ node --import ./src/register-hybrid.js test/fixtures/run-capture.js
closure vars: [ 'policy', 'attempts', 'startedAt' ]
```

```bash
node --import scopetrace/hybrid-register app.js
```

```js
import scopetrace from 'scopetrace/unplugin';
export default { plugins: [scopetrace.vite({ mode: 'retain', include: /src\// })] };
```

**Async parenting comes free too.** `Debugger.setAsyncCallStackDepth` makes V8
hand back the async parent frames at the pause, so the hybrid reconstructs
`validate` under `processOrder` across two `await`s with no AsyncLocalStorage,
no relocated function bodies, and none of the `enterWith` hazards the transform
had to work around.

**What it gives up:** per-frame timings (nothing is measuring), and
`live: true/false` on closure scopes — the inspector can say a closure retains a
scope, not whether that activation is still on the stack.

### The one real cost, and the guard on it

Pausing the isolate is ~280 µs per throw. Irrelevant at 10 throws/sec; ruinous
for code using exceptions as control flow. So captures are budgeted: past
`maxPerSecond` (default 50) the pause is disarmed and re-armed after a cooldown.
2000 caught throws in a loop: 448 ms unbudgeted, **16 ms** with the breaker, and
every throw still behaves identically — only the recording stops.

```js
import { start, captureOf } from 'scopetrace/hybrid';
start({
  maxPerSecond: 50, cooldownMs: 5000,
  filter: (description) => description.includes('PaymentError'),
  onCapture: (cap) => shipToBackend(cap),
});
```

Captures are found again by tagging the live error object with a
non-enumerable id from inside the pause (`Runtime.callFunctionOn`), so
`captureOf(err)` works in a `catch` arbitrarily far up, and the tag never shows
up in `Object.keys`, `JSON.stringify` or a deep-equal assertion.

### Hint forms

`hint: 'names'` (default) emits the dead reference list. `hint: 'eval'` emits
`if (0) eval('')` instead: a direct eval forces **every** enclosing scope to be
context-allocated, so one hint in the innermost function retains the whole
chain, including bindings the plugin cannot enumerate (`arguments`, anything a
later transform adds). It costs nothing on ordinary code and up to 1.8x where V8
could otherwise fold a call chain away entirely. Full measurements and the two
disproved explanations for that cost are in `research/FINDINGS.md`.

### Minifiers

A minifier deletes `if (0) {}` as dead code — and drops bare `x;` statements as
side-effect-free even when the branch survives. Either run the retain transform
**after** minification (it is a plain source transform; a bundle is fine), or
use `{ guard: 'flag' }`, which emits a call it cannot prove pure behind a flag
it cannot fold:

```js
if (_stR) { globalThis.__SCOPETRACE_SINK__(base, label, created); }
```

Verified against terser 5: the `if (0)` form is stripped, the flag form
survives. It is not free, though — the branch is evaluated per call, 30.3 ms vs
17.3 ms on the call-storm benchmark. Post-minification is the better option.

**If you must hint an already-minified bundle, use `hint: 'eval'`.** terser
mangles `policy` to `o` and even inlines `attempts = 7` out of existence in the
names form, which makes the resulting capture useless; it will not mangle inside
a scope containing a direct eval. (Sentry documents the same problem from the
other side: minified variable names cannot be unminified.)

## Prior art, and where this sits

- **Sentry `localVariablesIntegration`** is essentially `src/inspector.js`:
  same mechanism, shipped, on by default in the Node SDK, and it covers caught
  exceptions. Same blind spot — it reads what V8 retained. Its documented limits
  (top-level properties only, `in_app` frames only, no locals for unhandled
  errors under ESM) are the ones you inherit on that route.
- **Datadog Exception Replay** productizes the idea — locals for every frame at
  throw time. It lists Python, Java, .NET, PHP. **Node is not on that list.**
- **Rookout / Lightrun** do non-breaking breakpoints: snapshots at points *you
  choose in advance*, which is the opposite trigger.
- **AppMap (`appmap-node`)** is the closest transform-side comparison, and
  reading its source sharpens the difference: it moves each body into an inner
  arrow passed to `record(fn, args, funInfo)`, so it records **arguments,
  return values and exceptions — never locals, never closures**. Worth stealing
  from it: per-function metadata lives in one module-level
  `__appmapFunctionRegistry` array, so a call site carries an index rather than
  an object literal.

The gap this fills: nobody pairs a compile-time retention hint with the
inspector. Sentry pays nothing per call and misses pruned variables; the
wrapping transforms (AppMap, and this repo's own) pay per call and still miss
closures. The hint is what makes the free option complete.

## Cost

Measured on Node 25, M-series Mac. The first row is a deliberate worst case:
recursive `fib`, which is nothing but function calls.

| workload | baseline | instrumented | |
|---|---|---|---|
| call storm (`fib(12)` × 200) | 0.73 ms | 45.9 ms | ~60× |
| same, `configure({ enabled: false })` | 0.73 ms | 1.85 ms | ~2.5× |
| async handler + I/O × 2000 | 28.3 ms | 37.4 ms | ~1.3× |

Read that as: **do not instrument everything in production.** Scope it with
`include` to the code you actually debug, and note the runtime kill switch is
cheap enough to leave compiled in.

```js
configure({
  enabled: true,
  shouldTrace: () => Math.random() < 0.01,  // consulted only at trace roots
  maxLexicalDepth: 8,
  keepTree: true,
  snapshot: { maxDepth: 4, maxProps: 32, redact: /password|token|secret/i },
  onCapture: (cap) => shipToBackend(cap),
});
```

Snapshots are eager and hard-capped: cycle-safe, depth- and breadth-limited,
key-redacted, and getters are never invoked (a getter on a crash path can throw
or mutate). Frames are retained only while a live closure captures them; the
call tree stores plain metadata nodes precisely so it does not pin every local
of every call for the life of the trace.

## Known gaps

- **Nested block scopes** are not captured by the transform (`const x` inside an
  `if`). The thunk sits at the top of the body and can only see what is in scope
  there. Fix: emit a per-block thunk and chain it. The inspector engine has no
  such limit.
- **Generators** use the `enterWith` path, so a generator that yields across
  other instrumented calls can misparent the tree.
- **Derived-class constructors** are skipped (`super()` must come first).
- Sourcemaps are emitted, but frames are reported against the transformed file's
  original line numbers, not remapped through an upstream sourcemap chain.
- No sampling of *individual* frames yet — `shouldTrace` gates whole traces.
- The hybrid reports no per-frame timings and cannot tell a live closure scope
  from a returned one; both need a runtime that the hybrid deliberately omits.
- The inspector reports a binding still in its TDZ as plain `undefined`, so the
  hybrid loses the `<uninitialized>` signal the transform gives you.
- Retention hints cost memory, not time: hinted variables are context-allocated
  and live as long as the closure does. Bound it with `maxNames`.

## Layout

```
src/runtime.js       frames, the two chains, ALS, capture on unwind
src/babel-plugin.js  the transform
src/serialize.js     bounded, cycle-safe, redacting snapshots
src/inspector.js     transform-free engine via node:inspector
src/retain-plugin.js retention hints — the compile-time half of the hybrid
src/hybrid.js        hints + inspector: the recommended engine
src/register-hybrid.js  --import entry for the hybrid
research/FINDINGS.md    retention experiments, numbers, and dead ends
src/register.js      module.registerHooks loader — no build step
src/unplugin.js      vite/webpack/rollup/esbuild/rspack
src/format.js        human-readable rendering
```

`npm test` · `npm run bench` · `node --import ./src/register-hybrid.js examples/demo.js`
