import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HINTED = ['--import', './src/register-hybrid.js'];

const run = (args, file, env = {}) =>
  execFileSync(process.execPath, [...args, file], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
const capture = (args, file, env) => JSON.parse(run(args, file, env).trim().split('\n').pop());

test('retention hints recover closure variables the bare inspector cannot see', () => {
  const bare = capture([], 'test/fixtures/run-capture.js');
  const hinted = capture(HINTED, 'test/fixtures/run-capture.js');

  const bareVars = Object.keys(bare.frames[0].closure[0].vars);
  const hintedVars = Object.keys(hinted.frames[0].closure[0].vars);

  // V8 context-allocates only what an inner function textually names, so the
  // unhinted run sees the one variable `validate` happens to use.
  assert.deepEqual(bareVars, ['policy']);
  for (const name of ['policy', 'attempts', 'startedAt']) {
    assert.ok(hintedVars.includes(name), `${name} missing from ${hintedVars.join(',')}`);
  }
  assert.equal(hinted.frames[0].closure[0].vars.attempts, 7);
});

test('a caught and swallowed error still yields its full scope', () => {
  const cap = capture(HINTED, 'test/fixtures/run-capture.js');
  assert.equal(cap.error.name, 'RangeError');
  assert.equal(cap.frames[0].fn, 'validate');
  assert.equal(cap.frames[0].locals.total, 1200);       // live value at the throw
  assert.equal(cap.frames[0].locals.order.id, 'ord_42');
});

test('async frames are parented by their awaiter, with no runtime instrumentation', () => {
  const cap = capture(HINTED, 'test/fixtures/run-async.js');
  const names = [];
  for (let n = cap.tree; n; n = n.children?.[0]) names.push(n.fn);
  assert.ok(names.includes('processOrder'), names.join(' > '));
  assert.equal(names.at(-1), 'validate');
  assert.equal(cap.frames[0].locals.total, 1800);
  assert.equal(cap.frames[0].closure[0].vars.attempts, 3);   // hint reached across await
});

test('hints do not disturb the semantics of what they annotate', () => {
  const plain = run([], 'test/fixtures/run-semantics.js');
  const hinted = run(HINTED, 'test/fixtures/run-semantics.js');
  assert.equal(hinted, plain);
});

test('the error tag is non-enumerable and does not leak into serialization', () => {
  const out = run(HINTED, 'test/fixtures/run-tag.js').trim().split('\n').pop();
  assert.equal(out, JSON.stringify({ keys: [], json: '{}', hasCapture: true }));
});

for (const [hint, guard] of [['eval', 'zero'], ['eval', 'flag'], ['names', 'zero'], ['names', 'flag']]) {
  test(`hint '${hint}' with guard '${guard}' retains the pruned closure`, () => {
    const cap = capture(HINTED, 'test/fixtures/run-capture.js',
      { SCOPETRACE_OPTIONS: JSON.stringify({ plugin: { hint, guard } }) });
    const vars = Object.keys(cap.frames[0].closure[0].vars);
    for (const name of ['policy', 'attempts', 'startedAt']) assert.ok(vars.includes(name), name);
  });
}

test('one eval hint in the innermost function retains the entire chain', () => {
  const out = run([], 'research/transitive.js').trim().split('\n').pop();
  const chain = JSON.parse(out);
  assert.deepEqual(chain.map(([fn]) => fn), ['c', 'b', 'a']);
  for (const [fn, vars] of chain) {
    assert.ok(vars.includes(fn.toUpperCase() + '1'), `${fn} lost its param`);
    assert.ok(vars.includes(fn.toUpperCase() + '2'), `${fn} lost its local`);
  }
});

test('a function that shadows eval is left alone', () => {
  const out = run(HINTED, 'test/fixtures/run-shadowed-eval.cjs').trim().split('\n').pop();
  assert.equal(out, 'shadow-ok');
});

test('the circuit breaker bounds capture cost under a storm of throws', () => {
  const out = JSON.parse(run(HINTED, 'test/fixtures/run-storm.js', { N: '400' }).trim().split('\n').pop());
  assert.ok(out.captured > 0, 'captured nothing');
  assert.ok(out.captured <= 60, `breaker did not trip: ${out.captured} captures`);
  assert.equal(out.thrown, 400);       // every throw still happened, uninterrupted
});
