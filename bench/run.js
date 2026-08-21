import { execFileSync } from 'node:child_process';
const variants = {
  plain:     [],
  hybrid:    ['--import', './src/register-hybrid.js'],
  transform: ['--import', './src/register.js'],
};
const ROUNDS = 5;
const out = {};
for (const [name, args] of Object.entries(variants)) {
  const times = [];
  for (let i = 0; i < ROUNDS; i++) {
    const res = execFileSync(process.execPath, [...args, 'bench/workload.js'], { encoding: 'utf8' });
    times.push(JSON.parse(res.trim().split('\n').pop()).ms);
  }
  out[name] = Math.min(...times);
  console.log(`${name.padEnd(10)} best of ${ROUNDS}: ${out[name]} ms`);
}
console.log(`\nhybrid    ${(out.hybrid / out.plain).toFixed(2)}x plain`);
console.log(`transform ${(out.transform / out.plain).toFixed(2)}x plain`);
