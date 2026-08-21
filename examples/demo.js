import { captureOf, format, configure } from '../src/index.js';

configure({ snapshot: { maxDepth: 3 } });

// A factory: `policy` and `attempts` live only in this activation's closure.
// When the returned validator throws, that scope is what you actually need.
function makeValidator(policy) {
  let attempts = 0;
  const startedAt = new Date(0);

  return function validate(order) {
    attempts++;
    const total = order.items.reduce((s, i) => s + i.price * i.qty, 0);
    if (total > policy.maxTotal) {
      throw new RangeError(`order total ${total} exceeds ${policy.maxTotal}`);
    }
    return { total, attempts, startedAt };
  };
}

async function loadOrder(id) {
  await new Promise((r) => setTimeout(r, 1));
  return { id, customer: { name: 'ada', token: 'sk-live-secret' }, items: [{ price: 400, qty: 3 }] };
}

async function processOrder(id, validate) {
  const order = await loadOrder(id);
  const receipt = validate(order);      // throws in here
  return receipt;
}

async function handleRequest(id) {
  const validate = makeValidator({ maxTotal: 1000, currency: 'USD' });
  try {
    return await processOrder(id, validate);
  } catch (err) {
    // Caught — the stack is already unwound, but the capture is not.
    console.log(format(captureOf(err)));
    return { error: err.message };
  }
}

console.log('result:', await handleRequest('ord_42'));
