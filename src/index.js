export { default, configure, getConfig, captureHere, currentStack, currentFrame, enter, exit, thrown } from './runtime.js';

import { captureOf as fromTransform } from './runtime.js';
import { captureOf as fromHybrid } from './hybrid.js';

/** Whichever engine recorded this error. Lets calling code stay engine-agnostic. */
export const captureOf = (error) => fromTransform(error) ?? fromHybrid(error);
export { default as babelPlugin } from './babel-plugin.js';
export { default as retainPlugin } from './retain-plugin.js';
export * as hybrid from './hybrid.js';
export * as inspector from './inspector.js';
export { snapshot } from './serialize.js';
export { format } from './format.js';
