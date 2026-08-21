// Cost of the part that is NOT free: pausing the isolate on every throw.
function makeChecker(limit) {
  const created = Date.now();
  const label = 'checker';
  return function check(v) {
    const doubled = v * 2;
    if (doubled > limit) throw new RangeError(`${doubled} > ${limit}`);
    return doubled;
  };
}
const check = makeChecker(10);
const N = Number(process.env.N || 2000);
let caught = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  try { check(100); } catch { caught++; }   // caught and swallowed
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(JSON.stringify({ ms: +ms.toFixed(1), caught, perThrowUs: +((ms * 1000) / N).toFixed(1) }));
