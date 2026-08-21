import { start, captureOf } from '../src/hybrid.js';
start();
function a(A1) {
  const A2 = 'a2';
  return function b(B1) {
    const B2 = 'b2';
    return function c(C1) {
      const C2 = 'c2';
      return function d(D1) {
        if (0) eval('');            // hint only in the innermost function
        throw new Error('boom');
      };
    };
  };
}
try { a(1)(2)(3)(4); } catch (e) {
  const cap = captureOf(e);
  console.log(JSON.stringify(cap.frames[0].closure.map(c => [c.fn, Object.keys(c.vars)])));
}
