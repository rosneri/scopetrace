import { start, captureOf } from '../src/hybrid.js';
import { makeValidator } from './eval-hint-fixture.js';
start();
const validate = makeValidator({ maxTotal: 1000 });
try { validate({ items: [{ price: 600, qty: 2 }] }); }
catch (err) { console.log(JSON.stringify(captureOf(err))); }
