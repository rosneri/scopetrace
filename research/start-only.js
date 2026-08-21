// Inspector enabled BEFORE any user module is parsed, with no transform at all.
// Question: does V8 allocate contexts more conservatively in "debug mode"?
import { start } from '../src/hybrid.js';
start();
