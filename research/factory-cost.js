// The cost of the hint lands on the ENCLOSING scope: its variables move from
// stack to a heap context. Measured where the factory itself is hot.
function mk(mode, i) {
  const a = i, b = i + 1, c = i + 2, d = i + 3, e = i + 4;
  if (mode === 'eval') return () => { if (0) eval(''); return a + b; };
  return () => a + b;
}
const N = 2_000_000;
let acc = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) acc += mk(process.argv[2], i)();
console.log(JSON.stringify({ ms: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1), acc }));
