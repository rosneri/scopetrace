/**
 * Hybrid entry point: `node --import scopetrace/hybrid app.js`.
 *
 * Installs the retention-hint transform (compile time, no runtime cost) and
 * opens the inspector session that does the actual capture on throw.
 *
 * Env:
 *   SCOPETRACE_INCLUDE   regex a file path must match to be hinted
 *   SCOPETRACE_OPTIONS   JSON, merged into start() options
 *   SCOPETRACE_PRINT=1   print every capture as it happens
 */
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import babel from '@babel/core';
import retain from './retain-plugin.js';
import { start, captureOf, drain } from './hybrid.js';
import { format } from './format.js';

const OPTS = JSON.parse(process.env.SCOPETRACE_OPTIONS || '{}');
const INCLUDE = process.env.SCOPETRACE_INCLUDE ? new RegExp(process.env.SCOPETRACE_INCLUDE) : null;
const EXTS = /\.(m|c)?[jt]sx?$/;

const shouldTransform = (file) =>
  EXTS.test(file) &&
  !file.includes('node_modules') &&
  !file.includes('/scopetrace/src/') &&
  (!INCLUDE || INCLUDE.test(file));

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
        plugins: [[retain, OPTS.plugin || {}]],
        configFile: false, babelrc: false, sourceMaps: 'inline',
        // The hint is one statement at the top of each body; keeping original
        // line numbers means inspector locations still point at real source.
        retainLines: true,
        sourceType: result.format === 'commonjs' ? 'script' : 'module',
      });
      return { ...result, source: out.code };
    } catch (err) {
      if (process.env.SCOPETRACE_DEBUG) console.error(`[scopetrace] skipped ${file}: ${err.message}`);
      return result;
    }
  },
});

start({
  ...OPTS,
  onCapture: process.env.SCOPETRACE_PRINT ? (cap) => console.error(format(cap)) : OPTS.onCapture,
});

globalThis.__SCOPETRACE_HYBRID__ = { captureOf, drain, format };
