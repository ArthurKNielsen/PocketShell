// Language runtimes: Python (Pyodide, loaded on demand) and JavaScript.
import { def, parseArgs, c } from './registry.js';
import { EOF } from '../terminal.js';
import * as fsx from '../fs.js';

const CAT = 'Languages';
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full/';
let pyodidePromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: () => reject(new Error('failed to load ' + src)) });
    document.head.append(s);
  });
}

async function getPyodide(ctx) {
  if (!pyodidePromise) {
    ctx.session.write(c.gray('Loading Python (first time only, ~10 MB)…\n'));
    pyodidePromise = (async () => {
      if (!globalThis.loadPyodide) await loadScript(PYODIDE_URL + 'pyodide.js');
      const py = await globalThis.loadPyodide({ indexURL: PYODIDE_URL });
      await py.runPythonAsync(`
import codeop, sys, traceback
_ps_globals = {'__name__': '__main__'}
def _ps_push(src):
    try:
        code = codeop.compile_command(src, '<stdin>', 'single')
    except (SyntaxError, OverflowError, ValueError):
        traceback.print_exception(*sys.exc_info()[:2], None)
        return True
    if code is None:
        return False
    try:
        exec(code, _ps_globals)
    except SystemExit:
        raise
    except BaseException:
        t, v, tb = sys.exc_info()
        traceback.print_exception(t, v, tb.tb_next)
    return True
`);
      return py;
    })().catch((e) => { pyodidePromise = null; throw e; });
  }
  return pyodidePromise;
}

// Mirror the current directory (top-level files) into Pyodide's in-memory FS and back.
async function syncIn(py, dir) {
  py.FS.mkdirTree(dir);
  const before = new Map();
  for (const name of await fsx.readdir(dir)) {
    const p = fsx.join(dir, name);
    const st = await fsx.stat(p);
    if (!st || st.isDirectory() || st.size > 5e6) continue;
    const data = await fsx.readBytes(p);
    py.FS.writeFile(p, data);
    before.set(name, data.length + ':' + st.mtimeMs);
  }
  py.FS.chdir(dir);
  return before;
}
async function syncOut(py, dir) {
  for (const name of py.FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const p = fsx.join(dir, name);
    const st = py.FS.stat(p);
    if (py.FS.isDir(st.mode)) continue;
    const data = py.FS.readFile(p);
    const cur = await fsx.stat(p);
    if (cur && cur.size === data.length) {
      const old = await fsx.readBytes(p);
      if (old.every((b, i) => b === data[i])) continue;
    }
    await fsx.writeFile(p, data);
  }
}

def(['python', 'python3', 'py', 'pip', 'pip3'], async (ctx) => {
  const name = ctx.name.toLowerCase();
  const py = await getPyodide(ctx);
  const dec = new TextDecoder();
  py.setStdout({ write: (b) => { ctx.out(dec.decode(b)); return b.length; } });
  py.setStderr({ write: (b) => { ctx.err(dec.decode(b)); return b.length; } });
  py.setStdin({ stdin: () => window.prompt('Python input():') ?? '' });

  if (name.startsWith('pip') || (ctx.args[0] === '-m' && ctx.args[1]?.startsWith('pip'))) {
    const args = name.startsWith('pip') ? ctx.args : ctx.args.slice(2);
    if (args[0] !== 'install') { ctx.out('Only "pip install <package>" is supported (pure-Python wheels + Pyodide packages).\n'); return 1; }
    await py.loadPackage('micropip');
    const micropip = py.pyimport('micropip');
    for (const pkg of args.slice(1).filter((x) => !x.startsWith('-'))) {
      ctx.out(`Collecting ${pkg}\n`);
      await micropip.install(pkg);
      ctx.out(`Successfully installed ${pkg}\n`);
    }
    return;
  }

  await syncIn(py, ctx.cwd);
  const a = parseArgs(ctx.args, { string: ['c'] });
  try {
    if (a.c !== undefined || a._.length) {
      const code = a.c ?? await fsx.readText(ctx.resolve(a._[0]));
      py.globals.get('sys').argv = py.toPy(a.c !== undefined ? ['-c', ...a._] : a._);
      await py.loadPackagesFromImports(code, { messageCallback: (m) => ctx.out(c.gray(m) + '\n') }).catch(() => {});
      await py.runPythonAsync(code, { globals: py.toPy({ __name__: '__main__' }) });
      return 0;
    }
    if (ctx.stdin) {
      await py.runPythonAsync(ctx.stdin);
      return 0;
    }
    ctx.out(`Python ${py.runPython('import sys; sys.version.split()[0]')} (Pyodide) in PocketShell\nType "exit()" or press Ctrl+D to leave. Use pip install <pkg> from the shell for packages.\n`);
    const push = py.globals.get('_ps_push');
    let buf = [];
    for (;;) {
      const line = await ctx.session.readLine(buf.length ? '... ' : '>>> ', { history: ctx.shell.pyHistory ??= [] });
      if (line === EOF) break;
      if (line === null) { buf = []; ctx.out('KeyboardInterrupt\n'); continue; }
      buf.push(line);
      const src = buf.join('\n');
      try {
        await py.loadPackagesFromImports(src).catch(() => {});
        const done = push(src);
        if (done) buf = [];
      } catch (e) {
        if (/SystemExit/.test(String(e))) break;
        ctx.err(String(e.message ?? e) + '\n');
        buf = [];
      }
    }
  } catch (e) {
    const msg = String(e.message ?? e);
    if (/SystemExit/.test(msg)) return 0;
    ctx.err(msg.replace(/^PythonError: /, '') + '\n');
    return 1;
  } finally {
    await syncOut(py, ctx.cwd).catch(() => {});
  }
}, { help: 'Python 3 REPL or scripts (python file.py, python -c "..."), plus pip install. Runs locally via Pyodide.', usage: 'python [file.py | -c code]', category: CAT });

function inspect(v, depth = 0) {
  if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
  if (typeof v === 'function') return `[Function: ${v.name || 'anonymous'}]`;
  if (typeof v === 'undefined') return 'undefined';
  if (typeof v === 'bigint') return v + 'n';
  if (v instanceof Error) return v.stack || String(v);
  if (v && typeof v === 'object') {
    if (depth > 2) return Array.isArray(v) ? '[Array]' : '[Object]';
    try {
      if (Array.isArray(v)) return '[ ' + v.map((x) => inspect(x, depth + 1)).join(', ') + ' ]';
      if (v instanceof Map) return `Map(${v.size}) { ${[...v].map(([k, x]) => `${inspect(k, depth + 1)} => ${inspect(x, depth + 1)}`).join(', ')} }`;
      if (v instanceof Set) return `Set(${v.size}) { ${[...v].map((x) => inspect(x, depth + 1)).join(', ')} }`;
      const entries = Object.entries(v);
      const name = v.constructor && v.constructor !== Object ? v.constructor.name + ' ' : '';
      return name + '{ ' + entries.map(([k, x]) => `${k}: ${inspect(x, depth + 1)}`).join(', ') + ' }';
    } catch { return String(v); }
  }
  return String(v);
}

function makeConsole(ctx) {
  const fmt = (args) => args.map((x) => inspect(x)).join(' ') + '\n';
  return {
    log: (...x) => ctx.out(fmt(x)), info: (...x) => ctx.out(fmt(x)), debug: (...x) => ctx.out(fmt(x)),
    warn: (...x) => ctx.err(fmt(x)), error: (...x) => ctx.err(fmt(x)),
    table: (x) => ctx.out(inspect(x) + '\n'), dir: (x) => ctx.out(inspect(x) + '\n'),
    clear: () => ctx.session.write('\x1b[2J\x1b[H'),
  };
}

def(['node', 'js', 'deno'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['e', 'eval', 'p', 'print'], alias: { eval: 'e', print: 'p' } });
  const con = makeConsole(ctx);
  const AsyncFunction = (async () => {}).constructor;
  const shellApi = {
    readFile: (p) => fsx.readText(ctx.resolve(p)),
    writeFile: (p, d) => fsx.writeFile(ctx.resolve(p), d),
    run: (line) => ctx.run(line),
    cwd: () => ctx.cwd,
  };
  const runCode = async (code) => new AsyncFunction('console', 'pocketshell', 'process', code)(con, shellApi, { argv: ['node', ...a._], env: { ...ctx.env }, cwd: () => ctx.cwd });
  try {
    if (a.p !== undefined) { ctx.out(inspect(await runCode(`return (${a.p});`)) + '\n'); return; }
    if (a.e !== undefined) { await runCode(a.e); return; }
    if (a._.length) { await runCode(await fsx.readText(ctx.resolve(a._[0]))); return; }
    if (ctx.stdin) { await runCode(ctx.stdin); return; }
  } catch (e) {
    ctx.err((e?.stack || String(e)) + '\n');
    return 1;
  }
  ctx.out(`JavaScript REPL (your browser's engine). Ctrl+D to exit.\n${c.gray('Helpers: pocketshell.readFile(p), pocketshell.writeFile(p, data), pocketshell.run("ls")')}\n`);
  const saved = globalThis.console;
  globalThis.pocketshell = shellApi;
  for (;;) {
    const line = await ctx.session.readLine('> ', { history: ctx.shell.jsHistory ??= [] });
    if (line === EOF || line === '.exit') break;
    if (line === null || !line.trim()) continue;
    globalThis.console = { ...saved, ...con };
    try {
      let v;
      try { v = (0, eval)(`(async () => (${line}))()`); } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
        v = (0, eval)(line);
      }
      v = await v;
      ctx.out(c.gray(inspect(v, 1)) + '\n');
    } catch (e) {
      ctx.err(`Uncaught ${e?.stack?.split('\n')[0] ?? e}\n`);
    } finally {
      globalThis.console = saved;
    }
  }
}, { help: 'JavaScript REPL or scripts (node file.js, node -e "...", node -p "1+1").', usage: 'node [file.js | -e code | -p expr]', category: CAT });
