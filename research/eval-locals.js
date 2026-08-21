// Hypothesis: the eval hint's cost is a per-call context allocation for the
// hinted function's OWN locals — eval could name them, so they cannot stay on
// the stack. A function with no locals should therefore pay nothing.
function build(mode, locals) {
  const base = 1;
  if (locals) {
    if (mode === 'eval')  return function add(x, y) { if (0) eval(''); const s = base + x + y; return s; };
    if (mode === 'names') return function add(x, y) { if (0) { base; } const s = base + x + y; return s; };
    return function add(x, y) { const s = base + x + y; return s; };
  }
  if (mode === 'eval')  return function add(x, y) { if (0) eval(''); return base + x + y; };
  if (mode === 'names') return function add(x, y) { if (0) { base; } return base + x + y; };
  return function add(x, y) { return base + x + y; };
}
const add = build(process.argv[2], process.argv[3] === 'locals');
function inner(i) { return add(i, 1); }
function outer(i) { return inner(i) + 1; }
const N = 3_000_000;
let acc = 0;
for (let i = 0; i < 100_000; i++) acc += outer(i);
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) acc += outer(i);
console.log(JSON.stringify({ ms: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1), acc }));
