/**
 * Retention-hint plugin: the cheap half of the hybrid engine.
 *
 * It does NOT wrap anything. It emits, at the top of every function body, a
 * never-executed reference to each binding of every enclosing scope:
 *
 *   function validate(order) {
 *     if (0) { policy; attempts; startedAt; }   // <- the whole hint
 *     ...
 *   }
 *
 * Why this works: V8 decides at *parse* time which of a function's variables
 * get context-allocated, purely from whether some inner function mentions them
 * textually. Anything no inner function names is stack-allocated and is gone —
 * and invisible to the inspector — the moment the frame is discarded. A dead
 * reference is enough to flip that decision, and measured overhead is zero
 * (33.1ms with and without, 30M calls) because the branch never runs.
 *
 * So this restores exactly what `src/inspector.js` was silently missing —
 * closure variables V8 pruned — without the try/catch wrapping, the per-call
 * closure allocation or the AsyncLocalStorage traffic of the full transform.
 *
 * Caveat worth knowing: a minifier deletes `if (0) {}` as dead code, and drops
 * bare `x;` statements as side-effect-free even when the branch survives. Run
 * this after minification, or use `{ guard: 'flag' }`, which emits a call it
 * cannot prove pure behind a flag it cannot fold.
 */
export default function scopetraceRetainPlugin(babel, options = {}) {
  const { types: t } = babel;
  const {
    hint = 'names',              // 'names' -> if (…) {a; b; c;}  |  'eval' -> if (…) eval('')
    guard = 'zero',              // 'zero' -> if (0) …        |  'flag' -> if (_stR) …
    maxNames = 128,              // per function
    includeModuleScope = false,  // module/script scope is always visible to the inspector
    include = null,              // (filename) => boolean
    skip = /^_/,                 // never hint names matching this
  } = options;

  const FLAG = '__SCOPETRACE_RETAIN__';
  const SINK = '__SCOPETRACE_SINK__';

  return {
    name: 'scopetrace-retain',
    visitor: {
      Program: {
        enter(path, state) {
          const file = state.filename || 'unknown';
          state.skip = file.includes('node_modules') ||
                       file.includes('scopetrace/src') ||
                       (include && !include(file));
          state.used = false;
          state.flagId = path.scope.generateUidIdentifier('stR');
        },
        exit(path, state) {
          if (state.skip || !state.used || guard !== 'flag') return;
          // `let`, not `const`: a minifier can constant-fold a const and delete
          // the branch again. A mutable binding read from globalThis cannot be
          // proven false, so the hint survives.
          path.unshiftContainer('body', t.variableDeclaration('let', [
            t.variableDeclarator(state.flagId,
              t.binaryExpression('===',
                t.memberExpression(t.identifier('globalThis'), t.identifier(FLAG)),
                t.numericLiteral(1))),
          ]));
        },
      },

      Function(path, state) {
        if (state.skip || path.node.__scopetraceRetain) return;
        path.node.__scopetraceRetain = true;

        // Both forms need something enclosing to retain; a function whose only
        // outer scope is the module gets nothing, since module scope is always
        // visible to the inspector anyway.
        const useEval = hint === 'eval' && !path.scope.hasBinding('eval', { noGlobals: true });
        const names = useEval ? null : enclosingNames(path, state, includeModuleScope, skip, maxNames);
        if (useEval ? !hasEnclosingFunction(path) : !names.length) return;

        if (!t.isBlockStatement(path.node.body)) {
          path.node.body = t.blockStatement([t.returnStatement(path.node.body)]);
        }

        // Two emitted forms, and the difference matters only under a minifier:
        //   zero: if (0) { base; label; }              smallest, but terser deletes it
        //   flag: if (_stR) { __sink(base, label); }   a call it cannot prove pure,
        //                                             behind a flag it cannot fold
        // A bare `base;` statement is side-effect-free, so terser drops it even
        // when the branch survives — hence the call in the flag form.
        const test = guard === 'flag' ? t.cloneNode(state.flagId) : t.numericLiteral(0);
        const consequent = useEval
          // A *direct* call to eval — the identifier must be exactly `eval` —
          // makes V8 give up on pruning: anything eval could name has to remain
          // reachable, so the whole enclosing chain is materialized.
          ? t.expressionStatement(t.callExpression(t.identifier('eval'), [t.stringLiteral('')]))
          : t.blockStatement(guard === 'flag'
            ? [t.expressionStatement(t.callExpression(
                t.memberExpression(t.identifier('globalThis'), t.identifier(SINK)),
                names.map((n) => t.identifier(n))))]
            : names.map((n) => t.expressionStatement(t.identifier(n))));
        const stmt = t.ifStatement(test, consequent);
        stmt.__scopetraceRetain = true;
        path.get('body').unshiftContainer('body', stmt);
        state.used = true;
      },
    },
  };
}

const hasEnclosingFunction = (path) => !!path.getFunctionParent();

/**
 * Every binding visible from inside this function that lives in an *enclosing*
 * scope, minus the ones this function shadows. Shadowed names are dropped
 * because referencing one retains the inner binding, not the outer one we are
 * actually after.
 */
function enclosingNames(path, state, includeModuleScope, skip, max) {
  // A function's own scope holds its params and its body-level declarations —
  // exactly the set that shadows the enclosing scopes at the top of the body.
  const own = new Set(Object.keys(path.scope.bindings));
  const out = [];
  const seen = new Set();
  for (let scope = path.scope.parent; scope; scope = scope.parent) {
    if (!includeModuleScope && scope.path.isProgram()) break;
    for (const name of Object.keys(scope.bindings)) {
      if (own.has(name) || seen.has(name) || skip.test(name)) continue;
      // A binding declared *after* this function in the same scope is still
      // hoisted into the same context, so ordering does not matter here.
      seen.add(name);
      out.push(name);
      if (out.length >= max) return out;
    }
  }
  return out;
}
