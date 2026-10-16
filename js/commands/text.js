// Text processing commands. They read from files or piped stdin.
import { def, parseArgs, UsageError, readInputs, c } from './registry.js';
import { unifiedDiff } from '../diff.js';

const CAT = 'Text';
const lines = (t) => { const l = t.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };

def(['grep', 'findstr', 'Select-String', 'sls'], async (ctx) => {
  const a = parseArgs(ctx.args, {
    string: ['pattern', 'path', 'e'],
    boolean: ['simplematch', 'casesensitive'],
    alias: { pattern: 'e', path: 'path', simplematch: 'F' },
  });
  const win = ['findstr', 'select-string', 'sls'].includes(ctx.name.toLowerCase());
  let pattern = a.e ?? a._.shift();
  if (pattern === undefined) throw new UsageError();
  const files = a.path ? [a.path, ...a._] : a._;
  const ignoreCase = a.i || a.I || (win && !a.casesensitive);
  const src = a.F ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
  const re = new RegExp(a.w ? `\\b(?:${src})\\b` : src, ignoreCase ? 'gi' : 'g');
  let targets = files;
  if (a.r || a.R || a.s) {
    targets = [];
    for (const f of files.length ? files : ['.']) {
      for await (const { path, stat } of ctx.fs.walk(ctx.resolve(f))) {
        if (!stat.isDirectory() && !path.includes('/.git/')) targets.push(path);
      }
    }
  }
  const inputs = await readInputs(ctx, targets);
  const multi = inputs.length > 1 || a.r || a.R;
  let found = 0;
  for (const { name, text } of inputs) {
    if (text.includes('\0')) continue;
    let count = 0;
    lines(text).forEach((line, i) => {
      re.lastIndex = 0;
      const hit = re.test(line);
      if (hit === !!a.v) return;
      count++;
      found++;
      if (a.c || a.l) return;
      re.lastIndex = 0;
      const shown = ctx.isTTY && !a.v ? line.replace(re, (m) => `\x1b[1;31m${m}\x1b[0m`) : line;
      const prefix = (multi ? c.magenta(ctx.fs.relative(ctx.cwd, name)) + c.cyan(':') : '') + (a.n ? c.green(i + 1) + c.cyan(':') : '');
      ctx.out(prefix + shown + '\n');
    });
    if (a.c) ctx.out((multi ? name + ':' : '') + count + '\n');
    else if (a.l && count) ctx.out(name + '\n');
  }
  return found ? 0 : 1;
}, { help: 'Search text with a regular expression (-i -v -n -c -r -w -F -l).', usage: 'grep [-ivncrwFl] <pattern> [files...]', category: CAT });

def(['head'], async (ctx) => {
  const argv = ctx.args.map((x) => (/^-\d+$/.test(x) ? ['-n', x.slice(1)] : [x])).flat();
  const a = parseArgs(argv, { string: ['n', 'c'] });
  const n = parseInt(a.n ?? 10, 10);
  for (const { text } of await readInputs(ctx, a._)) {
    if (a.c) ctx.out(text.slice(0, parseInt(a.c, 10)));
    else { const l = lines(text).slice(0, n); if (l.length) ctx.out(l.join('\n') + '\n'); }
  }
}, { help: 'Print the first lines of input.', usage: 'head [-n N] [files...]', category: CAT });

def(['tail'], async (ctx) => {
  const argv = ctx.args.map((x) => (/^-\d+$/.test(x) ? ['-n', x.slice(1)] : [x])).flat();
  const a = parseArgs(argv, { string: ['n'] });
  const n = parseInt(a.n ?? 10, 10);
  for (const { text } of await readInputs(ctx, a._)) {
    const l = lines(text);
    const sel = String(a.n ?? '').startsWith('+') ? l.slice(n - 1) : l.slice(-n);
    if (sel.length) ctx.out(sel.join('\n') + '\n');
  }
}, { help: 'Print the last lines of input.', usage: 'tail [-n N] [files...]', category: CAT });

def(['wc', 'Measure-Object'], async (ctx) => {
  const a = parseArgs(ctx.args, { alias: { line: 'l', word: 'w', character: 'c' } });
  const all = !a.l && !a.w && !a.c && !a.m;
  for (const { name, text } of await readInputs(ctx, a._)) {
    const parts = [];
    if (all || a.l) parts.push(String(text.split('\n').length - 1).padStart(7));
    if (all || a.w) parts.push(String((text.match(/\S+/g) || []).length).padStart(7));
    if (all || a.c || a.m) parts.push(String(new TextEncoder().encode(text).length).padStart(7));
    ctx.out(parts.join(' ') + (a._.length ? ' ' + name : '') + '\n');
  }
}, { help: 'Count lines, words and bytes.', usage: 'wc [-lwc] [files...]', category: CAT });

def(['sort', 'Sort-Object'], async (ctx) => {
  const a = parseArgs(ctx.args, { boolean: ['descending', 'unique'], alias: { descending: 'r', unique: 'u' } });
  let l = (await readInputs(ctx, a._)).flatMap((x) => lines(x.text));
  if (a.n) l.sort((x, y) => parseFloat(x) - parseFloat(y));
  else if (a.f) l.sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
  else l.sort();
  if (a.r) l.reverse();
  if (a.u) l = [...new Set(l)];
  if (l.length) ctx.out(l.join('\n') + '\n');
}, { help: 'Sort lines (-r reverse, -n numeric, -u unique, -f ignore case).', usage: 'sort [-rnuf] [files...]', category: CAT });

def(['uniq', 'Get-Unique'], async (ctx) => {
  const a = parseArgs(ctx.args);
  const out = [];
  for (const line of (await readInputs(ctx, a._)).flatMap((x) => lines(x.text))) {
    const last = out[out.length - 1];
    if (last && last.line === line) last.n++;
    else out.push({ line, n: 1 });
  }
  const sel = out.filter((x) => (a.d ? x.n > 1 : a.u ? x.n === 1 : true));
  if (sel.length) ctx.out(sel.map((x) => (a.c ? String(x.n).padStart(7) + ' ' : '') + x.line).join('\n') + '\n');
}, { help: 'Collapse adjacent duplicate lines (-c count, -d dupes only, -u uniques only).', usage: 'uniq [-cdu] [file]', category: CAT });

def(['cut'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['d', 'f', 'c'] });
  const delim = a.d ?? '\t';
  const pick = (spec, max) => {
    const idx = new Set();
    for (const part of String(spec).split(',')) {
      const [s, e] = part.split('-');
      const from = s ? parseInt(s, 10) : 1;
      const to = part.includes('-') ? (e ? parseInt(e, 10) : max) : from;
      for (let i = from; i <= to; i++) idx.add(i - 1);
    }
    return [...idx].sort((x, y) => x - y);
  };
  if (!a.f && !a.c) throw new UsageError();
  const out = [];
  for (const line of (await readInputs(ctx, a._)).flatMap((x) => lines(x.text))) {
    if (a.c) { const ch = [...line]; out.push(pick(a.c, ch.length).map((i) => ch[i] ?? '').join('')); }
    else { const f = line.split(delim); out.push(pick(a.f, f.length).filter((i) => i < f.length).map((i) => f[i]).join(delim)); }
  }
  if (out.length) ctx.out(out.join('\n') + '\n');
}, { help: 'Cut fields (-d delim -f 1,3) or characters (-c 1-5) from lines.', usage: 'cut -d , -f 1,2 [file]', category: CAT });

def(['tr'], async (ctx) => {
  const [from, to = ''] = ctx.args.filter((x) => !x.startsWith('-'));
  const del = ctx.args.includes('-d');
  if (from === undefined) throw new UsageError();
  const expand = (s) => s.replace(/(.)-(.)/g, (_, x, y) => { let r = ''; for (let i = x.charCodeAt(0); i <= y.charCodeAt(0); i++) r += String.fromCharCode(i); return r; });
  const f = expand(from), t = expand(to);
  let out = '';
  for (const ch of ctx.stdin ?? '') {
    const i = f.indexOf(ch);
    if (i < 0) out += ch;
    else if (!del) out += t[Math.min(i, t.length - 1)] ?? '';
  }
  ctx.out(out);
}, { help: 'Translate or delete characters from stdin.', usage: "tr 'a-z' 'A-Z'  |  tr -d 'x'", category: CAT });

def(['rev'], async (ctx) => {
  const l = (await readInputs(ctx, ctx.args)).flatMap((x) => lines(x.text)).map((x) => [...x].reverse().join(''));
  if (l.length) ctx.out(l.join('\n') + '\n');
}, { help: 'Reverse each line.', category: CAT });

def(['tee', 'Tee-Object'], async (ctx) => {
  const a = parseArgs(ctx.args);
  const text = ctx.stdin ?? '';
  for (const f of a._) {
    const p = ctx.resolve(f);
    const prev = a.a && (await ctx.fs.exists(p)) ? await ctx.fs.readText(p) : '';
    await ctx.fs.writeFile(p, prev + text);
  }
  ctx.out(text);
}, { help: 'Copy stdin to files and stdout (-a to append).', usage: 'tee [-a] files...', category: CAT });

def(['diff', 'Compare-Object', 'fc'], async (ctx) => {
  const [x, y] = ctx.args.filter((s) => !s.startsWith('-'));
  if (!x || !y) throw new UsageError();
  const ta = await ctx.fs.readText(ctx.resolve(x));
  const tb = await ctx.fs.readText(ctx.resolve(y));
  if (ta === tb) return 0;
  ctx.out(unifiedDiff(ta, tb, x, y, ctx.isTTY));
  return 1;
}, { help: 'Show differences between two files.', usage: 'diff <file1> <file2>', category: CAT });

def(['base64'], async (ctx) => {
  const a = parseArgs(ctx.args);
  const [inp] = await readInputs(ctx, a._);
  if (a.d) {
    const bin = atob(inp.text.replace(/\s+/g, ''));
    ctx.out(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
  } else {
    const bytes = new TextEncoder().encode(inp.text);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    ctx.out(btoa(s).replace(/.{76}/g, '$&\n') + '\n');
  }
}, { help: 'Base64 encode (or -d decode) input.', usage: 'base64 [-d] [file]', category: CAT });

def(['sha256sum', 'sha1sum', 'Get-FileHash'], async (ctx) => {
  const algo = ctx.name.toLowerCase() === 'sha1sum' ? 'SHA-1' : 'SHA-256';
  const files = ctx.args.filter((x) => !x.startsWith('-'));
  const inputs = files.length
    ? await Promise.all(files.map(async (f) => ({ name: f, data: await ctx.fs.readBytes(ctx.resolve(f)) })))
    : [{ name: '-', data: new TextEncoder().encode(ctx.stdin ?? '') }];
  for (const { name, data } of inputs) {
    const h = new Uint8Array(await crypto.subtle.digest(algo, data));
    ctx.out([...h].map((b) => b.toString(16).padStart(2, '0')).join('') + '  ' + name + '\n');
  }
}, { help: 'Print SHA-256 (or SHA-1) checksums.', usage: 'sha256sum [files...]', category: CAT });

// jq-lite: .a.b, .[0], .[], .["key"], keys, length, piping with |
def(['jq', 'ConvertFrom-Json'], async (ctx) => {
  const a = parseArgs(ctx.args);
  const filter = (ctx.name.toLowerCase() === 'jq' ? a._.shift() : '.') ?? '.';
  const [inp] = await readInputs(ctx, a._);
  let data;
  try { data = JSON.parse(inp.text); } catch (e) { throw new Error('invalid JSON input: ' + e.message); }
  const results = jqEval(filter, [data]);
  for (const r of results) {
    if (a.r && typeof r === 'string') ctx.out(r + '\n');
    else ctx.out(colorJson(r, ctx.isTTY && !a.M, a.c ? 0 : 2) + '\n');
  }
}, { help: 'Filter/pretty-print JSON (subset of jq: .a.b .[0] .[] keys length map(.x) select(.a==1)).', usage: "jq [-r] '.items[] | .name' [file]", category: CAT });

function jqEval(filter, inputs) {
  const stages = splitTop(filter.trim(), '|');
  let cur = inputs;
  for (const st of stages) cur = cur.flatMap((v) => jqStage(st.trim(), v));
  return cur;
}
function splitTop(s, sep) {
  const out = []; let depth = 0, q = false, last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== '\\') q = !q;
    if (q) continue;
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === sep && depth === 0) { out.push(s.slice(last, i)); last = i + 1; }
  }
  out.push(s.slice(last));
  return out;
}
function jqStage(st, v) {
  if (st === '.' || st === '') return [v];
  if (st === 'keys') return [Object.keys(v ?? {}).sort()];
  if (st === 'length') return [Array.isArray(v) || typeof v === 'string' ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0];
  if (st === 'type') return [Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v];
  let m;
  if ((m = st.match(/^map\((.*)\)$/))) return [(v || []).flatMap((x) => jqEval(m[1], [x]))];
  if ((m = st.match(/^select\((.*?)\s*(==|!=|>=|<=|>|<)\s*(.*)\)$/))) {
    const lhs = jqEval(m[1], [v])[0];
    let rhs;
    try { rhs = JSON.parse(m[3]); } catch { rhs = jqEval(m[3], [v])[0]; }
    const ok = { '==': lhs === rhs, '!=': lhs !== rhs, '>': lhs > rhs, '<': lhs < rhs, '>=': lhs >= rhs, '<=': lhs <= rhs }[m[2]];
    return ok ? [v] : [];
  }
  if ((m = st.match(/^\{(.*)\}$/))) {
    const obj = {};
    for (const part of splitTop(m[1], ',')) {
      const [k, expr] = part.split(':').map((x) => x.trim());
      obj[k.replace(/^"|"$/g, '')] = jqEval(expr ?? '.' + k, [v])[0];
    }
    return [obj];
  }
  if (!st.startsWith('.')) throw new Error(`jq: unsupported filter '${st}'`);
  // path walk
  let vals = [v];
  const re = /\.([A-Za-z_][\w-]*)|\[\s*(-?\d+)?\s*(?::\s*(-?\d+)?)?\s*\]|\["([^"]+)"\]|\.\["([^"]+)"\]/gy;
  let pos = st === '.' ? 1 : 0;
  if (st.startsWith('.[')) pos = 1;
  re.lastIndex = pos;
  while (re.lastIndex < st.length) {
    const start = re.lastIndex;
    const mm = re.exec(st);
    if (!mm || mm.index !== start) throw new Error(`jq: cannot parse '${st}'`);
    const [whole, key, idx, end, qk1, qk2] = mm;
    const k = key ?? qk1 ?? qk2;
    if (k !== undefined) vals = vals.map((x) => (x == null ? null : x[k] ?? null));
    else if (whole.includes(':')) vals = vals.map((x) => x?.slice(idx ? +idx : 0, end ? +end : undefined));
    else if (idx !== undefined) vals = vals.map((x) => (x == null ? null : x.at ? x.at(+idx) ?? null : null));
    else vals = vals.flatMap((x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []));
  }
  return vals;
}
export function colorJson(v, color = true, indent = 2) {
  const s = JSON.stringify(v, null, indent || undefined);
  if (!color || s === undefined) return String(s);
  return s.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi, (m, str, colon, lit, num) => {
    if (str) return colon ? `\x1b[34;1m${str}\x1b[0m${colon}` : `\x1b[32m${str}\x1b[0m`;
    if (lit) return `\x1b[90m${lit}\x1b[0m`;
    return num ?? m;
  });
}
