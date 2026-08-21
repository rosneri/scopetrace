import { start, captureOf } from '../../src/hybrid.js';
import { makeValidator } from './factory.js';

start({ includeNodeModules: false });
const validate = makeValidator({ maxTotal: 1000, currency: 'USD' });

let cap = null;
try {
  validate({ id: 'ord_42', items: [{ price: 600, qty: 2 }] });
} catch (err) {
  cap = captureOf(err);            // caught and swallowed — the whole point
}
console.log(JSON.stringify(cap));
