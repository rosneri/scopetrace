/**
 * Bundler integration. unplugin gives us vite / webpack / rspack / rollup /
 * esbuild / farm from one implementation.
 *
 *   // vite.config.js
 *   import scopetrace from 'scopetrace/unplugin'
 *   export default { plugins: [scopetrace.vite({ include: /src\// })] }
 */
import { createUnplugin } from 'unplugin';
import babel from '@babel/core';
import plugin from './babel-plugin.js';
import retainPlugin from './retain-plugin.js';

const DEFAULT_EXT = /\.(m|c)?[jt]sx?($|\?)/;

export const unpluginFactory = (options = {}) => {
  // mode 'retain' emits only never-executed retention hints and pairs with the
  // inspector at runtime (scopetrace/hybrid). mode 'capture' is the full
  // wrapping transform, which carries its own call tree and timings.
  const { include, exclude = /node_modules/, sourceMaps = true, mode = 'capture', ...pluginOptions } = options;
  const chosen = mode === 'retain' ? retainPlugin : plugin;
  const test = (v, id) => (v instanceof RegExp ? v.test(id) : typeof v === 'function' ? v(id) : true);

  return {
    name: `scopetrace:${mode}`,
    enforce: 'pre',            // run before TS/JSX are compiled away and names are lost
    transformInclude: (id) => DEFAULT_EXT.test(id) && test(include, id) && !test(exclude, id),
    async transform(code, id) {
      const out = await babel.transformAsync(code, {
        filename: id.split('?')[0],
        plugins: [[chosen, pluginOptions]],
        configFile: false, babelrc: false, sourceMaps,
        retainLines: mode === 'retain',
        parserOpts: { plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'] },
      });
      return out ? { code: out.code, map: out.map } : null;
    },
  };
};

export default createUnplugin(unpluginFactory);
