// Command registry + small helpers shared by command modules.
export const registry = new Map();
export const categories = new Map();

/**
 * def(['ls', 'dir'], fn, { help, usage, category })
 * fn(ctx) -> exit code (number) or undefined (= 0). Throwing prints the error and returns 1.
 */
export function def(names, fn, { help = '', usage = '', category = 'Misc' } = {}) {
  names = [].concat(names);
  const cmd = { name: names[0], names, fn, help, usage, category };
  for (const n of names) registry.set(n.toLowerCase(), cmd);
  if (!categories.has(category)) categories.set(category, []);
  categories.get(category).push(cmd);
  return cmd;
}

export class UsageError extends Error {}

/**
 * Minimal flag parser. Handles -abc, --long, --long=value, -n 5 and PowerShell-style -Recurse.
 * opts.string: flags that take a value; opts.boolean: known boolean long flags; opts.alias: { short: long }.
 */
export function parseArgs(argv, { string = [], boolean = [], alias = {} } = {}) {
  const out = { _: [] };
  const canon = (k) => alias[k] ?? alias[k.toLowerCase()] ?? k;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      let k = canon(eq > 0 ? a.slice(2, eq) : a.slice(2));
      let v = eq > 0 ? a.slice(eq + 1) : undefined;
      if (v === undefined && string.includes(k)) v = argv[++i];
      push(out, k, v ?? true, string.includes(k));
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const body = a.slice(1);
      const lower = body.toLowerCase();
      if (body.length > 1 && (alias[lower] || string.includes(lower) || boolean.includes(lower))) {
        const k = canon(lower);
        push(out, k, string.includes(k) ? argv[++i] : true, string.includes(k));
        continue;
      }
      for (let j = 0; j < body.length; j++) {
        const k = canon(body[j]);
        if (string.includes(k)) { push(out, k, body.slice(j + 1) || argv[++i], true); break; }
        out[k] = true;
      }
      continue;
    }
    out._.push(a);
  }
  return out;
}
function push(out, k, v, multi) {
  if (multi && out[k] !== undefined) {
    out[k + 'All'] = [].concat(out[k + 'All'] ?? out[k], v);
    out[k] = v;
  } else {
    out[k] = v;
    if (multi) out[k + 'All'] = [v];
  }
}

export const c = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  bblue: (s) => `\x1b[1;34m${s}\x1b[0m`,
  bgreen: (s) => `\x1b[1;32m${s}\x1b[0m`,
};

export function table(rows, { gap = 2 } = {}) {
  if (!rows.length) return '';
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const widths = [];
  for (const r of rows) r.forEach((cell, i) => { widths[i] = Math.max(widths[i] || 0, strip(cell).length); });
  return rows.map((r) => r.map((cell, i) => i === r.length - 1 ? String(cell) : String(cell) + ' '.repeat(widths[i] - strip(cell).length + gap)).join('')).join('\n') + '\n';
}

export function timeAgo(date) {
  const s = (Date.now() - new Date(date).getTime()) / 1000;
  const units = [[31536000, 'year'], [2592000, 'month'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [n, u] of units) if (s >= n) { const v = Math.floor(s / n); return `${v} ${u}${v > 1 ? 's' : ''} ago`; }
  return 'just now';
}

export function humanSize(n) {
  const u = ['B', 'K', 'M', 'G'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + u[i];
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

// Read input either from file arguments or from piped stdin.
export async function readInputs(ctx, files) {
  if (!files.length) return [{ name: '(standard input)', text: ctx.stdin ?? '' }];
  const out = [];
  for (const f of files) out.push({ name: f, text: await ctx.fs.readText(ctx.resolve(f)) });
  return out;
}
