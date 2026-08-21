// Is the eval-hint cost a lost inlining opportunity? Same callee, called two
// ways: directly from the hot loop, and through a wrapper that V8 would
// normally inline it into.
function build(mode) {
  const base = 1, label = 'x';
  if (mode === 'eval')  return function add(x, y) { if (0) eval(''); return base + x + y; };
  if (mode === 'names') return function add(x, y) { if (0) { base; label; } return base + x + y; };
  return function add(x, y) { return base + x + y; };
}
const add = build(process.argv[2] || 'plain');
const wrap1 = (i) => add(i, 1);
const wrap2 = (i) => wrap1(i) + 1;

const N = 3_000_000;
const time = (f) => { let acc = 0; const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) acc += f(i);
  return { ms: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1), acc }; };
time((i) => add(i, 1)); time(wrap2);                       // warm up both shapes
console.log(JSON.stringify({ direct: time((i) => add(i, 1)).ms, viaWrappers: time(wrap2).ms }));
