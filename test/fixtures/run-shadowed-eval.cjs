// Shadowing `eval` is only legal in sloppy mode, so this fixture is CJS. If the
// plugin emitted eval('') here it would call *their* function; it must fall
// back to the name-list form instead of changing behaviour.
function outer(eval) {
  const secret = 1;
  return function inner() { return typeof eval === 'function' ? eval('shadow-ok') : 'wrong'; };
}
console.log(outer((s) => s)());
