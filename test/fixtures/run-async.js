import { start, captureOf } from '../../src/hybrid.js';
import { makeProcessor } from './async-flow.js';

start();
const p = makeProcessor({ maxTotal: 1000 });
let cap = null;
try { await p.processOrder('ord_9'); } catch (err) { cap = captureOf(err); }
console.log(JSON.stringify(cap));
