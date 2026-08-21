/**
 * Zero-build entry point: `node --import scopetrace/register app.js`.
 *
 * Uses module.registerHooks (synchronous, same-thread) so the transform can run
 * inline for both ESM and CJS without a worker or an async loader chain.
 */
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import babel from '@babel/core';
import plugin from './babel-plugin.js';
import './runtime.js';

const OPTS = JSON.parse(process.env.SCOPETRACE_OPTIONS || '{}');
const EXTS = /\.(m|c)?[jt]sx?$/;

const shouldTransform = (file) =>
  EXTS.test(file) &&
  !file.includes('node_modules') &&
  !file.includes('/scopetrace/src/') &&
  (!OPTS.include || new RegExp(OPTS.include).test(file));

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:') || result.source == null) return result;
    const file = fileURLToPath(url);
    if (!shouldTransform(file)) return result;
    const code = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    try {
      const out = babel.transformSync(code, {
        filename: file,
        plugins: [[plugin, OPTS.plugin || {}]],
        configFile: false, babelrc: false, sourceMaps: 'inline',
        sourceType: result.format === 'commonjs' ? 'script' : 'module',
      });
      return { ...result, source: out.code };
    } catch (err) {
      // A file we cannot parse is a file we run uninstrumented. Never fatal.
      if (process.env.SCOPETRACE_DEBUG) console.error(`[scopetrace] skipped ${file}: ${err.message}`);
      return result;
    }
  },
});
