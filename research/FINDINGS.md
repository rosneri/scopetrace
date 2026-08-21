# Retention research

Every number here is reproducible from this directory on Node 25, M-series Mac,
best-of-N in a clean process per variant (JIT state does not survive between
runs, and polluting it was how I got a wrong answer the first time).

## 1. Debug mode does not change what V8 keeps — negative result

Hypothesis: if the inspector is attached *before* user modules are parsed, V8
might allocate contexts conservatively and expose everything, making the
transform unnecessary for dependencies.

```
inspector started after user modules parsed   closure vars: [policy]
inspector started before, no transform        closure vars: [policy]
same, plus --no-lazy (eager compile)          closure vars: [policy]
```

It does not. Context allocation is decided at parse time from the source text
alone, and nothing at runtime revisits it. **A source transform is unavoidable**
if you want closure variables — which is also why Sentry's integration is
`in_app`-only in practice: it has no way to see into code it did not transform.
To capture a dependency's closures you must hint that dependency.

`research/start-only.js`

## 2. Two hint forms, and they are not equivalent

```js
if (0) { policy; attempts; startedAt; }   // hint: 'names'
if (0) eval('');                          // hint: 'eval'
```

The eval form works because a direct `eval` forces **all variables in all
enclosing scopes** to be context-allocated — documented V8 behaviour since
[mrale.ph, 2012](https://mrale.ph/blog/2012/09/23/grokking-v8-closures-for-fun.html),
here used as an automatic compile-time hint rather than a thing to avoid.
(`with` does the same and is illegal in strict mode, so eval is the only option
in ESM.)

| | names | eval |
|---|---|---|
| retains named bindings | yes | yes |
| retains `arguments`, and names the plugin cannot enumerate | no | **yes** |
| reaches the whole enclosing chain from one hint | no — needs a hint per scope | **yes** |
| survives terser | only with `guard: 'flag'` | with `guard: 'flag'` |
| **names survive terser mangling** | **no** — `policy` becomes `o` | **yes** |
| cost, call storm | **0.99×** | 1.0×–1.8× |

Transitivity, hint in the innermost function only (`research/transitive.js`):

```
[["c",["C1","C2","arguments"]],["b",["B1","B2","arguments"]],["a",["A1","A2","arguments"]]]
```

## 3. Minification is where eval earns its keep

terser 5, `-c -m`, same source both ways:

```js
// names form  -> every name mangled, and `attempts` inlined out of existence
let t=1===globalThis.__SCOPETRACE_RETAIN__;export function makeValidator(o){
  const e=new Date(0);return function(r){t&&globalThis.__SCOPETRACE_SINK__(o,7,e);…}}

// eval form   -> policy, attempts, startedAt, order, total all preserved
let _stR=1===globalThis.__SCOPETRACE_RETAIN__;export function makeValidator(policy){
  const attempts=7,startedAt=new Date(0);return function validate(order){_stR&&eval("");…}}
```

A minifier will not mangle inside a scope containing direct eval, because eval
could name those bindings. Sentry documents the converse as an open limitation:
"minified variable names cannot currently be unminified". A capture reading
`o = {...}, e = Date` is not a capture worth shipping, so for a minified bundle
`hint: 'eval'` is the only form that produces readable output.

Also note the names form let terser **inline `attempts = 7` into the call**,
deleting the binding entirely. The hint has to keep the variable alive, not just
mention it.

## 4. What the eval hint actually costs, and what it does not

Wrong hypotheses, both disproved, both worth recording:

- *It blocks inlining.* `--trace-turbo-inlining` shows `add` inlined into
  `outer` in both variants. Not it.
- *It forces a per-call context for the hinted function's own locals.* A callee
  with locals and one without cost the same (28.1 vs 28.6 ms). Not it either.

What actually happens: on code V8 can optimize all the way down — the whole
`outer → inner → add` chain folding into the loop — an unreachable eval blocks
that collapse, and the benchmark goes 17.2 ms → 29.8 ms (1.8×) with the
inspector switched off entirely. On code that was never going to fold like that,
the same hint costs ~1%. So:

| workload | names | eval |
|---|---|---|
| call storm, fully foldable (`bench/workload.js`) | 0.99× | **1.80×** |
| call storm through wrappers, warmed | 1.00× | 1.01× |
| factory hot, 2M closures created | — | 1.08× |

`hint: 'names'` is therefore the default; `hint: 'eval'` is opt-in for minified
bundles and for maximum completeness.

## 5. Where this sits after the search

- **Sentry `localVariablesIntegration`** — same inspector mechanism, shipped,
  covers caught exceptions. Documented limits: top-level properties only,
  `in_app` frames only, no locals for unhandled errors under ESM, minified names
  not unminifiable, and it "can and will interfere with other debugger sessions".
  The retention hint is exactly what it lacks.
- **Datadog Exception Replay** — same idea productized, for Python/Java/.NET/PHP.
  Node is not on the list.
- **hud.io** — closest in spirit to the *delivery* model (auto-instrumented
  function-level sensor, ignores `node_modules`, claims 1–2% overhead, ships from
  a worker thread) but per its own docs it collects invocation counts, durations
  and exception metadata — type, message, stack, HTTP context. No variable
  values, and nothing about closures.
- **Rookout / Lightrun** — snapshots at points chosen in advance; opposite
  trigger model.
- **AppMap (`appmap-node`)** — wraps each body into an inner arrow passed to
  `record(fn, args, funInfo)`: arguments, return values and exceptions, never
  locals or closures.

Nobody in that list pairs a compile-time retention hint with the inspector.
That pairing is the contribution: it makes the free capture path complete.
