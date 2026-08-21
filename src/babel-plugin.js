/**
 * Babel plugin: wrap every function so its activation registers itself, and so
 * an escaping error records the scope on the way out.
 *
 * Emitted shape:
 *
 *   function foo(a, b) {
 *     const _f = _st.enter({f:"foo",s:"src/foo.js",l:3,c:9},
 *                          () => ({ a: _st.v(() => a), c: _st.v(() => c), this: _st.v(() => this) }),
 *                          _fOuter);
 *     try { ...original body... }
 *     catch (e) { _st.thrown(_f, e); throw e; }
 *     finally { _st.exit(_f); }
 *   }
 *
 * The scope thunk is never called on the happy path. `_st.v` wraps each read so
 * a binding still in its temporal dead zone reports as uninitialized instead of
 * blowing up the capture. `_fOuter` is the enclosing *lexical* function's frame
 * const, so a closure keeps a live handle on the activation that created it.
 */
const RUNTIME_KEY = '__SCOPETRACE__';

export default function scopetraceBabelPlugin(babel, options = {}) {
  const { types: t } = babel;
  const {
    arrows = true,
    include = null,          // (filename) => boolean
    captureThis = true,
    maxScopeVars = 64,
  } = options;

  const shim = (helper) => babel.template.expression.ast(
    `globalThis.${RUNTIME_KEY} ?? (globalThis.${RUNTIME_KEY} = {` +
      `enter(){return null},exit(){},thrown(){},v(f){try{return f()}catch(e){return undefined}}})`
  );

  return {
    name: 'scopetrace',
    visitor: {
      Program: {
        enter(path, state) {
          const file = state.filename || 'unknown';
          state.skip = file.includes('node_modules') ||
                       file.includes('scopetrace/src') ||
                       (include && !include(file));
          if (state.skip) return;
          state.rtId = path.scope.generateUidIdentifier('st');
          state.fnStack = [];
          state.used = false;
          state.file = shortPath(file, state.cwd || process.cwd());
        },
        exit(path, state) {
          if (state.skip || !state.used) return;
          state.skip = true; // the shim we are about to inject must not be instrumented
          path.unshiftContainer('body',
            t.variableDeclaration('const', [t.variableDeclarator(state.rtId, shim())]));
        },
      },

      Function: {
        enter(path, state) {
          if (state.skip) return;
          // Push on every entry (null when we skip) so exit() stays balanced.
          if (path.node.__scopetrace || !isInstrumentable(path, t, arrows)) {
            state.fnStack.push(null);
            return;
          }
          path.node.__scopetrace = true;
          const id = path.scope.generateUidIdentifier('stf');
          const outer = lastNonNull(state.fnStack);
          state.fnStack.push(id);
          state.used = true;

          if (!t.isBlockStatement(path.node.body)) {
            path.node.body = t.blockStatement([t.returnStatement(path.node.body)]);
          }

          const meta = t.objectExpression([
            prop(t, 'f', t.stringLiteral(functionName(path, t))),
            prop(t, 's', t.stringLiteral(state.file)),
            prop(t, 'l', t.numericLiteral(path.node.loc?.start.line ?? 0)),
            prop(t, 'c', t.numericLiteral(path.node.loc?.start.column ?? 0)),
          ]);

          const reader = (expr) => {
            const arrow = t.arrowFunctionExpression([], expr);
            arrow.__scopetrace = true; // generated: never instrument our own readers
            return t.callExpression(t.memberExpression(state.rtId, t.identifier('v')), [arrow]);
          };
          const names = scopeNames(path, t, maxScopeVars);
          const entries = names.map((n) => prop(t, n, reader(t.identifier(n))));
          if (captureThis && !t.isArrowFunctionExpression(path.node)) {
            entries.push(t.objectProperty(t.stringLiteral('this'), reader(t.thisExpression())));
          }
          // Arrow, so `this` inside resolves to the instrumented function's `this`.
          const thunk = t.arrowFunctionExpression([], t.objectExpression(entries));
          thunk.__scopetrace = true;

          const isAsync = !!path.node.async && !path.node.generator;
          const scId = path.scope.generateUidIdentifier('stsc');

          // The thunk must be *created inside* the try block: wrapping the body
          // in `try {}` introduces a block scope, and a thunk declared outside
          // it cannot see the body's let/const bindings at all — they would
          // read as undeclared rather than as their live values.
          const installScope = t.expressionStatement(
            t.assignmentExpression('=', t.cloneNode(scId), thunk));

          const decl = [
            t.variableDeclaration('let', [t.variableDeclarator(t.cloneNode(scId))]),
            t.variableDeclaration('const', [t.variableDeclarator(id,
              t.callExpression(t.memberExpression(state.rtId, t.identifier('enter')), [
                meta,
                lazy(t, t.logicalExpression('&&', t.cloneNode(scId),
                  t.callExpression(t.cloneNode(scId), []))),
                outer ? t.cloneNode(outer) : t.identifier('undefined'),
                t.booleanLiteral(isAsync),
              ]))]),
          ];

          const err = path.scope.generateUidIdentifier('ste');
          const original = path.node.body.body;

          let tryBlock;
          if (isAsync) {
            const inner = t.arrowFunctionExpression([], t.blockStatement([installScope, ...original]), true);
            inner.__scopetrace = true;
            tryBlock = t.blockStatement([t.returnStatement(t.awaitExpression(
              t.callExpression(t.memberExpression(state.rtId, t.identifier('run')),
                [t.cloneNode(id), inner])))]);
            path.node.body = t.blockStatement([...decl, wrapTry(t, tryBlock, err, state, id)]);
          } else {
            tryBlock = t.blockStatement([installScope, ...original]);
            path.node.body = t.blockStatement([...decl, wrapTry(t, tryBlock, err, state, id)]);
          }
        },
        exit(path, state) { if (!state.skip) state.fnStack.pop(); },
      },
    },
  };
}

function isInstrumentable(path, t, arrows) {
  const n = path.node;
  if (t.isArrowFunctionExpression(n) && !arrows) return false;
  // The async path relocates the body into an arrow function, which does not
  // bind `arguments`. Rather than change the meaning of the code, leave these
  // uninstrumented.
  if (n.async && !n.generator && usesArguments(path, t)) return false;
  // A derived constructor must run super() before anything touches `this`.
  if (t.isClassMethod(n) && n.kind === 'constructor') {
    const cls = path.findParent((p) => p.isClass());
    if (cls?.node.superClass) return false;
  }
  return true;
}

/**
 * Names in scope at the top of the function body: params plus body-level
 * declarations. Bindings introduced in nested blocks are deliberately excluded
 * — they are not in scope where the thunk is defined.
 */
function scopeNames(path, t, max) {
  const seen = new Set();
  for (const p of path.get('params')) {
    for (const name of Object.keys(t.getBindingIdentifiers(p.node))) seen.add(name);
  }
  const body = path.node.body;
  if (t.isBlockStatement(body)) {
    for (const stmt of body.body) {
      if (t.isVariableDeclaration(stmt) || t.isFunctionDeclaration(stmt) || t.isClassDeclaration(stmt)) {
        for (const name of Object.keys(t.getBindingIdentifiers(stmt))) seen.add(name);
      }
    }
  }
  return [...seen].filter((n) => n && !n.startsWith('_st')).slice(0, max);
}

function functionName(path, t) {
  const n = path.node;
  if (n.id?.name) return n.id.name;
  if (t.isClassMethod(n) || t.isObjectMethod(n)) {
    const owner = t.isClassMethod(n) ? path.findParent((p) => p.isClass())?.node.id?.name : null;
    const key = n.key.name ?? n.key.value ?? '(computed)';
    return owner ? `${owner}.${key}` : key;
  }
  const p = path.parent;
  if (t.isVariableDeclarator(p) && p.id.name) return p.id.name;
  if (t.isObjectProperty(p) && (p.key.name ?? p.key.value)) return String(p.key.name ?? p.key.value);
  if (t.isAssignmentExpression(p) && t.isIdentifier(p.left)) return p.left.name;
  return '(anonymous)';
}

function usesArguments(path, t) {
  let found = false;
  path.traverse({
    Function(p) { if (!t.isArrowFunctionExpression(p.node)) p.skip(); },
    Identifier(p) { if (p.node.name === 'arguments') { found = true; p.stop(); } },
  });
  return found;
}

function wrapTry(t, tryBlock, err, state, id) {
  return t.tryStatement(
    tryBlock,
    t.catchClause(err, t.blockStatement([
      t.expressionStatement(t.callExpression(
        t.memberExpression(state.rtId, t.identifier('thrown')),
        [t.cloneNode(id), t.cloneNode(err)])),
      t.throwStatement(t.cloneNode(err)),
    ])),
    t.blockStatement([
      t.expressionStatement(t.callExpression(
        t.memberExpression(state.rtId, t.identifier('exit')), [t.cloneNode(id)])),
    ]),
  );
}

function lazy(t, expr) {
  const a = t.arrowFunctionExpression([], expr);
  a.__scopetrace = true;
  return a;
}

const prop = (t, k, v) => t.objectProperty(t.stringLiteral(k), v);
const lastNonNull = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i]) return a[i]; return null; };
const shortPath = (f, cwd) => (f.startsWith(cwd) ? f.slice(cwd.length + 1) : f);
