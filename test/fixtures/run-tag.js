import { start, captureOf } from '../../src/hybrid.js';
start();
function boom() { const secretish = 1; throw new Error('tagged ' + secretish); }
let err;
try { boom(); } catch (e) { err = e; }
console.log(JSON.stringify({
  keys: Object.keys(err),
  json: JSON.stringify(err),
  hasCapture: captureOf(err) !== null,
}));
