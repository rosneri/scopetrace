// Worst case for any per-call hint: nothing but calls.
function build(mode) {
  const base = 1, label = 'x', created = 2;
  if (mode === 'eval')  return function add(x, y) { if (0) eval(''); return base + x + y; };
  if (mode === 'names') return function add(x, y) { if (0) { base; label; created; } return base + x + y; };
  return function add(x, y) { return base + x + y; };
}
const add = build(process.argv[2] || 'plain');
const N = 3_000_000;
let acc = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) acc += add(i, 1);
console.log(JSON.stringify({ ms: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1), acc }));
