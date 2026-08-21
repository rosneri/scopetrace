/** Human-readable rendering of a capture. */
export function format(cap, { colors = process.stdout.isTTY } = {}) {
  if (!cap) return '(no scopetrace capture for this error)';
  const c = colors
    ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` }
    : { dim: (s) => s, b: (s) => s, r: (s) => s, y: (s) => s };

  const out = [`${c.r(cap.error.name + ': ' + cap.error.message)}`];
  for (const f of cap.frames) {
    const ms = f.durationMs == null ? '' : ` ${c.dim(`(${f.durationMs}ms)`)}`;
    out.push(`  ${c.b('at ' + f.fn)} ${c.dim(`${f.file}:${f.line}:${f.col}`)}${ms}`);
    out.push(...vars('locals', f.locals, '    ', c));
    for (const s of f.closure) {
      // live === null: the inspector knows the closure retains this scope but
      // not whether its activation is still on the stack.
      const tag = s.live == null ? 'closure' : s.live ? 'closure' : 'closure, returned';
      out.push(`    ${c.y(`↑ ${tag}: ${s.fn}`)} ${c.dim(`${s.file}:${s.line}`)}`);
      out.push(...vars(null, s.vars, '      ', c));
    }
  }
  if (cap.tree) { out.push(c.b('  call tree:')); out.push(...tree(cap.tree, '    ', c)); }
  return out.join('\n');
}

function vars(label, scope, pad, c) {
  if (!scope || scope.__t === 'released') return [`${pad}${c.dim('(scope released)')}`];
  const keys = Object.keys(scope).filter((k) => !k.startsWith('__'));
  if (!keys.length) return [];
  const head = label ? [`${pad}${c.dim(label + ':')}`] : [];
  return head.concat(keys.map((k) => `${pad}  ${k} = ${render(scope[k])}`));
}

function render(v, depth = 0) {
  if (v === null) return 'null';
  if (typeof v !== 'object') return typeof v === 'string' ? JSON.stringify(v) : String(v);
  if (Array.isArray(v)) return depth > 1 ? `[…${v.length}]` : `[${v.map((x) => render(x, depth + 1)).join(', ')}]`;
  switch (v.__t) {
    case 'undefined': return 'undefined';
    case 'uninitialized': return '<uninitialized (TDZ)>';
    case 'redacted': return '<redacted>';
    case 'released': return '<scope released>';
    case 'circular': return `<circular #${v.ref}>`;
    case 'truncated': return `${v.ctor} {…}`;
    case 'function': return `ƒ ${v.name}`;
    case 'error': return `${v.name}(${JSON.stringify(v.message)})`;
    case 'date': return v.v;
    case 'string': return `${JSON.stringify(v.v)}… (${v.truncated} chars)`;
    case 'bigint': case 'symbol': case 'regexp': return v.v;
    case 'map': case 'set': return `${v.__t.toUpperCase()}(${v.size})`;
    case 'promise': return 'Promise';
    case 'getter': return '<getter, not invoked>';
    case 'more': return `…${v.count} more`;
  }
  if (depth > 1) return '{…}';
  const inner = Object.keys(v).filter((k) => !k.startsWith('__'))
    .map((k) => `${k}: ${render(v[k], depth + 1)}`).join(', ');
  return `${v.__ctor ? v.__ctor + ' ' : ''}{ ${inner} }`;
}

function tree(node, pad, c) {
  if (!node) return [];
  if (node.elided) return [`${pad}…`];
  const mark = node.threw ? c.r(' ✗') : '';
  const ms = node.ms == null ? '' : `${node.ms}ms  `;
  const lines = [`${pad}${node.fn}${mark} ${c.dim(`${ms}${node.file}:${node.line}`)}`];
  for (const ch of node.children ?? []) lines.push(...tree(ch, pad + '  ', c));
  return lines;
}
