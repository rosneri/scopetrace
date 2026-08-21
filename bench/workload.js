// Call-saturated: nearly all the time is function entry/exit, which is the
// worst case for any per-call instrumentation.
function makeAdder(base) {
  const label = 'adder';
  const created = 1;
  return function add(x, y) {
    const s = base + x + y;
    return s;
  };
}
const add = makeAdder(1);
function inner(i) { const a = add(i, 1); return a; }
function outer(i) { const b = inner(i); return b + 1; }

const N = 3_000_000;
let acc = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) acc += outer(i);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(JSON.stringify({ ms: +ms.toFixed(1), acc }));
