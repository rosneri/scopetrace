// `attempts` and `startedAt` are never mentioned by validate, so V8 leaves them
// off the context entirely — the bare inspector cannot see them at any price.
export function makeValidator(policy) {
  const attempts = 7;
  const startedAt = new Date(0);
  return function validate(order) {
    let total = 0;
    for (const item of order.items) total += item.price * item.qty;
    if (total > policy.maxTotal) throw new RangeError(`order total ${total} exceeds ${policy.maxTotal}`);
    return total;
  };
}
