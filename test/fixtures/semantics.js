// A grab-bag of the constructs an instrumenting transform is most likely to
// break. The hint transform must leave all of it observably identical.
export function run() {
  const out = [];
  const factor = 3;
  const double = (x) => x * 2;                       // concise arrow body
  const withDefault = (a, b = factor + 1) => a + b;  // default reading outer scope
  function usesArguments() { return arguments.length; }
  class Base { constructor(v) { this.v = v; } get twice() { return this.v * 2; } }
  class Derived extends Base { constructor(v) { super(v + 1); } }
  function* gen() { const a = 1; yield a; yield a + factor; }
  const { x, ...rest } = { x: 1, y: 2, z: 3 };

  out.push(double(4), withDefault(1), usesArguments(1, 2, 3));
  out.push(new Derived(1).twice, [...gen()].join(','), x, JSON.stringify(rest));
  out.push(new.target === undefined);
  try { null.f(); } catch (e) { out.push(e.constructor.name); }
  return out.join('|');
}
