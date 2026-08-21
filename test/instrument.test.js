import { test } from 'node:test';
import assert from 'node:assert/strict';
import babel from '@babel/core';
import plugin from '../src/babel-plugin.js';
import runtime, { configure, captureOf } from '../src/runtime.js';

const compile = (src, opts = {}) => babel.transformSync(src, {
  filename: '/proj/test.js', plugins: [[plugin, opts]],
  configFile: false, babelrc: false, sourceType: 'module',
}).code;

/** Run instrumented source and return its default export. */
async function load(src, opts) {
  const code = compile(src, opts);
  const mod = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  return mod.default;
}

test('captures locals at the throw site, not the catch site', async () => {
  const run = await load(`
    function inner(a) { const doubled = a * 2; throw new Error('nope'); }
    export default function () {
      try { inner(21); } catch (e) { return e; }
    }`);
  const err = run();
  const cap = captureOf(err);
  assert.equal(cap.frames[0].fn, 'inner');
  assert.equal(cap.frames[0].locals.a, 21);
  assert.equal(cap.frames[0].locals.doubled, 42);
});

test('captures the closure chain of a returned factory', async () => {
  const run = await load(`
    function make(limit) {
      let seen = 0;
      return function check(n) { seen++; if (n > limit) throw new RangeError('big'); return n; };
    }
    export default function () {
      const check = make(5);
      check(1);
      try { check(9); } catch (e) { return e; }
    }`);
  const cap = captureOf(run());
  assert.equal(cap.frames[0].locals.n, 9);
  const factory = cap.frames[0].closure[0];
  assert.equal(factory.fn, 'make');
  assert.equal(factory.live, false, 'factory has already returned');
  assert.equal(factory.vars.limit, 5);
  assert.equal(factory.vars.seen, 2, 'closure variable reflects its current value');
});

test('a binding not yet initialized reads as TDZ, not as a crash', async () => {
  const run = await load(`
    export default function () {
      try { (function f(){ throw new Error('early'); const later = 1; })(); }
      catch (e) { return e; }
    }`);
  const cap = captureOf(run());
  assert.deepEqual(cap.frames[0].locals.later, { __t: 'uninitialized' });
});

test('async calls are parented by caller, not by the previously awaited callee', async () => {
  const run = await load(`
    async function a() { await null; return 1; }
    function b() { throw new Error('from b'); }
    export default async function top() {
      await a();
      try { b(); } catch (e) { return e; }
    }`);
  const cap = captureOf(await run());
  const top = cap.tree;
  assert.equal(top.fn, 'top');
  assert.deepEqual(top.children.map((c) => c.fn), ['a', 'b'], 'b is a sibling of a');
});

test('unwinding records every instrumented frame the error crosses', async () => {
  const run = await load(`
    function c() { const deep = 'x'; throw new Error('boom'); }
    function b() { const mid = 'y'; return c(); }
    function a() { const top = 'z'; return b(); }
    export default function () { try { a(); } catch (e) { return e; } }`);
  const cap = captureOf(run());
  assert.deepEqual(cap.frames.map((f) => f.fn), ['c', 'b', 'a']);
  assert.equal(cap.frames[1].locals.mid, 'y');
});

test('does not disturb the semantics of what it wraps', async () => {
  const run = await load(`
    class Base { constructor(v) { this.v = v; } }
    class Sub extends Base { constructor(v) { super(v * 2); } double() { return this.v * 2; } }
    function* gen() { yield 1; yield 2; }
    export default function () {
      const s = new Sub(3);
      const rest = ((...xs) => xs.reduce((a, b) => a + b, 0))(1, 2, 3);
      const args = (function () { return arguments.length; })(1, 2);
      return [s.v, s.double(), [...gen()], rest, args];
    }`);
  assert.deepEqual(run(), [6, 12, [1, 2], 6, 2]);
});

test('secrets are redacted and cycles survive', async () => {
  // The scope of interest must be one the error actually escapes: a frame that
  // catches its own error never unwinds, so it is never recorded.
  const run = await load(`
    function work() {
      const creds = { password: 'hunter2', user: 'ada' };
      const node = { name: 'n' }; node.self = node;
      (function boom(){ throw new Error('x'); })();
    }
    export default function () { try { work(); } catch (e) { return e; } }`);
  configure({ snapshot: {} });
  const cap = captureOf(run());
  const outer = cap.frames.find((f) => f.fn === 'work').locals;
  assert.deepEqual(outer.creds.password, { __t: 'redacted' });
  assert.equal(outer.creds.user, 'ada');
  assert.equal(outer.node.self.__t, 'circular');
});

test('errors thrown outside instrumented code yield no capture', () => {
  assert.equal(captureOf(new Error('never seen')), null);
});
