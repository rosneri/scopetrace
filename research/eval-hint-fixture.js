// Same shape as test/fixtures/factory.js, but the hint names nothing: a direct
// (unreachable) eval is enough to stop V8 pruning the enclosing scope.
export function makeValidator(policy) {
  const attempts = 7;
  const startedAt = new Date(0);
  let laterAssigned;
  function helper() { return 1; }
  return function validate(order) {
    if (0) eval('');
    let total = 0;
    for (const item of order.items) total += item.price * item.qty;
    if (total > policy.maxTotal) throw new RangeError(`order total ${total} exceeds ${policy.maxTotal}`);
    return total;
  };
}
