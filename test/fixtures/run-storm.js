import { start, drain } from '../../src/hybrid.js';
start({ maxPerSecond: 50, cooldownMs: 60_000 });
function check(v) { const doubled = v * 2; if (doubled > 1) throw new RangeError('over ' + doubled); }
const N = Number(process.env.N || 400);
let thrown = 0;
for (let i = 0; i < N; i++) { try { check(i + 1); } catch { thrown++; } }
console.log(JSON.stringify({ thrown, captured: drain().length }));
