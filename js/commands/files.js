// Filesystem commands (Unix and Windows names).
import { def, parseArgs, UsageError, c, humanSize } from './registry.js';
import { openEditor } from '../editor.js';

const CAT = 'Files';

function fmtWinDate(ms) {
  const d = new Date(ms);
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${date.padStart(10)} ${String(h).padStart(2)}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}
function fmtUnixDate(ms) {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  const recent = Date.now() - ms < 180 * 86400e3;
  return `${mon} ${String(d.getDate()).padStart(2)} ${recent ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ' ' + d.getFullYear()}`;
}

def(['ls', 'dir', 'Get-ChildItem', 'gci', 'll'], async (ctx) => {
  const a = parseArgs(ctx.args, { boolean: ['force', 'recurse', 'name'], alias: { force: 'a', recurse: 'R' } });
  if (ctx.name.toLowerCase() === 'll') a.l = true;
  const winStyle = ctx.shell.isWin && !a.l && ctx.name.toLowerCase() !== 'll';
  const targets = a._.length ? a._ : ['.'];
  let code = 0;
  for (const t of targets) {
    const p = ctx.resolve(t);
    const st = await ctx.fs.stat(p);
    if (!st) { ctx.err(`${ctx.name}: cannot access '${t}': No such file or directory\n`); code = 2; continue; }
    let entries;
    if (st.isDirectory()) {
      const names = (await ctx.fs.readdir(p)).filter((n) => a.a || a.A || !n.startsWith('.'));
      entries = await Promise.all(names.map(async (n) => ({ name: n, stat: await ctx.fs.stat(ctx.fs.join(p, n)) })));
    } else entries = [{ name: t, stat: st }];
    entries = entries.filter((e) => e.stat);
    if (a.t) entries.sort((x, y) => y.stat.mtimeMs - x.stat.mtimeMs);
    if (a.S) entries.sort((x, y) => y.stat.size - x.stat.size);
    if (a.r) entries.reverse();

    if (winStyle && ctx.shell.profile === 'cmd') {
      ctx.out(`\n Directory of ${ctx.fs.toWin(st.isDirectory() ? p : ctx.fs.dirname(p))}\n\n`);
      let files = 0, dirs = 0, bytes = 0;
      for (const e of entries) {
        const dir = e.stat.isDirectory();
        dir ? dirs++ : (files++, bytes += e.stat.size);
        ctx.out(`${fmtWinDate(e.stat.mtimeMs)}    ${dir ? '<DIR>         ' : String(e.stat.size).padStart(14)} ${e.name}\n`);
      }
      ctx.out(`${String(files).padStart(16)} File(s) ${String(bytes).padStart(14)} bytes\n${String(dirs).padStart(16)} Dir(s)\n`);
      continue;
    }
    if (winStyle) {
      if (a.name) { ctx.out(entries.map((e) => e.name).join('\n') + (entries.length ? '\n' : '')); continue; }
      ctx.out(`\n    Directory: ${ctx.fs.toWin(st.isDirectory() ? p : ctx.fs.dirname(p))}\n\n`);
      if (!entries.length) continue;
      ctx.out('Mode                 LastWriteTime         Length Name\n----                 -------------         ------ ----\n');
      for (const e of entries) {
        const dir = e.stat.isDirectory();
        ctx.out(`${dir ? 'd----' : '-a---'}        ${fmtWinDate(e.stat.mtimeMs)}  ${dir ? ''.padStart(14) : String(e.stat.size).padStart(14)} ${dir && ctx.isTTY ? c.bblue(e.name) : e.name}\n`);
      }
      ctx.out('\n');
      continue;
    }
    if (targets.length > 1 && st.isDirectory()) ctx.out(`${t}:\n`);
    const colorName = (e) => (!ctx.isTTY ? e.name : e.stat.isDirectory() ? c.bblue(e.name) : /\.(sh|py|js|ps1|bat)$/.test(e.name) ? c.bgreen(e.name) : e.name);
    if (a.l) {
      const total = entries.reduce((s, e) => s + Math.ceil(e.stat.size / 1024), 0);
      ctx.out(`total ${total}\n`);
      for (const e of entries) {
        const dir = e.stat.isDirectory();
        const size = a.h ? humanSize(e.stat.size) : String(e.stat.size);
        ctx.out(`${dir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 ${ctx.env.USER} ${ctx.env.USER} ${size.padStart(8)} ${fmtUnixDate(e.stat.mtimeMs)} ${colorName(e)}${dir && a.F ? '/' : ''}\n`);
      }
    } else if (!ctx.isTTY || a['1']) {
      if (entries.length) ctx.out(entries.map((e) => e.name).join('\n') + '\n');
    } else if (entries.length) {
      const w = Math.max(...entries.map((e) => e.name.length)) + 2;
      const per = Math.max(1, Math.floor(ctx.session.term.cols / w));
      let line = '';
      entries.forEach((e, i) => {
        line += colorName(e) + ' '.repeat(w - e.name.length);
        if ((i + 1) % per === 0) { ctx.out(line.trimEnd() + '\n'); line = ''; }
      });
      if (line) ctx.out(line.trimEnd() + '\n');
    }
  }
  return code;
}, { help: 'List directory contents (-l long, -a hidden, -h human sizes, -t by time).', usage: 'ls [-lah1tr] [paths...]', category: CAT });

def(['cd', 'chdir', 'Set-Location', 'sl'], async (ctx) => {
  let t = ctx.args.find((x) => !x.startsWith('-') || x === '-');
  if (t === undefined) {
    if (ctx.shell.profile === 'cmd') { ctx.out(ctx.fs.toWin(ctx.cwd) + '\n'); return; }
    t = '~';
  }
  if (t === '-') t = ctx.env.OLDPWD;
  if (/^[a-zA-Z]:$/.test(t)) t = '/';
  const p = ctx.resolve(t);
  const st = await ctx.fs.stat(p);
  if (!st) { ctx.err(ctx.shell.profile === 'cmd' ? 'The system cannot find the path specified.\n' : `cd: ${t}: No such file or directory\n`); return 1; }
  if (!st.isDirectory()) { ctx.err(`cd: ${t}: Not a directory\n`); return 1; }
  ctx.shell.setCwd(p);
}, { help: 'Change directory (cd - goes back, cd ~ goes home).', usage: 'cd [dir]', category: CAT });

def(['pwd', 'Get-Location', 'gl'], (ctx) => {
  if (ctx.shell.profile === 'pwsh' && ctx.isTTY) ctx.out(`\nPath\n----\n${ctx.fs.toWin(ctx.cwd)}\n\n`);
  else ctx.out((ctx.shell.isWin ? ctx.fs.toWin(ctx.cwd) : ctx.cwd) + '\n');
}, { help: 'Print the working directory.', category: CAT });

def(['cat', 'type', 'Get-Content', 'gc', 'more', 'less'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['path', 'tail', 'totalcount'] });
  const files = a.path ? [a.path, ...a._] : a._;
  if (!files.length) { ctx.out(ctx.stdin ?? ''); return; }
  let code = 0;
  for (const f of files) {
    try {
      let text = await ctx.fs.readText(ctx.resolve(f));
      if (a.tail) text = text.split('\n').slice(-(+a.tail) - 1).join('\n');
      if (a.totalcount) text = text.split('\n').slice(0, +a.totalcount).join('\n') + '\n';
      if (a.n) text = text.split('\n').map((l, i, arr) => (i === arr.length - 1 && l === '' ? '' : `${String(i + 1).padStart(6)}\t${l}`)).join('\n');
      ctx.out(text);
    } catch (e) {
      ctx.err(`${ctx.name}: ${f}: ${e.message.replace(/^.*?: /, '')}\n`);
      code = 1;
    }
  }
  return code;
}, { help: 'Print file contents (-n numbers lines).', usage: 'cat [-n] files...', category: CAT });

def(['mkdir', 'md'], async (ctx) => {
  const a = parseArgs(ctx.args);
  if (!a._.length) throw new UsageError();
  for (const d of a._) {
    const p = ctx.resolve(d);
    if (await ctx.fs.exists(p)) {
      if (a.p) continue;
      ctx.err(`${ctx.name}: cannot create directory '${d}': File exists\n`);
      return 1;
    }
    if (!a.p && !ctx.shell.isWin && !(await ctx.fs.isDir(ctx.fs.dirname(p)))) {
      ctx.err(`mkdir: cannot create directory '${d}': No such file or directory\n`);
      return 1;
    }
    await ctx.fs.mkdirp(p);
    if (a.v) ctx.out(`mkdir: created directory '${d}'\n`);
  }
}, { help: 'Create directories (-p creates parents).', usage: 'mkdir [-p] dirs...', category: CAT });

def(['New-Item', 'ni'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['itemtype', 'path', 'name', 'value', 'type'], boolean: ['force'] });
  const kind = String(a.itemtype ?? a.type ?? 'file').toLowerCase();
  const base = a.path ?? a._[0] ?? '.';
  const p = ctx.resolve(a.name ? `${base}/${a.name}` : base);
  if (kind.startsWith('d')) await ctx.fs.mkdirp(p);
  else {
    if ((await ctx.fs.exists(p)) && !a.force) { ctx.err(`New-Item: The file '${ctx.fs.toWin(p)}' already exists.\n`); return 1; }
    await ctx.fs.writeFile(p, a.value ?? '');
  }
}, { help: 'PowerShell: create a file or directory (-ItemType Directory).', usage: 'New-Item [-ItemType File|Directory] <path> [-Value text]', category: CAT });

def(['touch'], async (ctx) => {
  if (!ctx.args.length) throw new UsageError();
  for (const f of ctx.args.filter((x) => !x.startsWith('-'))) {
    const p = ctx.resolve(f);
    if (await ctx.fs.exists(p)) await ctx.fs.writeFile(p, await ctx.fs.readBytes(p));
    else await ctx.fs.writeFile(p, '');
  }
}, { help: 'Create empty files or update timestamps.', usage: 'touch files...', category: CAT });

def(['rm', 'del', 'erase', 'Remove-Item', 'ri', 'rmdir', 'rd'], async (ctx) => {
  const a = parseArgs(ctx.args, { boolean: ['recurse', 'force'], alias: { recurse: 'r', force: 'f', s: 'r', q: 'f', R: 'r' } });
  const name = ctx.name.toLowerCase();
  if (!a._.length) throw new UsageError();
  let code = 0;
  for (const f of a._) {
    const p = ctx.resolve(f);
    const st = await ctx.fs.stat(p);
    if (!st) { if (!a.f) { ctx.err(`${ctx.name}: cannot remove '${f}': No such file or directory\n`); code = 1; } continue; }
    if (p === '/' || p === ctx.fs.HOME) { ctx.err(`${ctx.name}: refusing to remove '${f}'\n`); code = 1; continue; }
    if (st.isDirectory()) {
      const empty = (await ctx.fs.readdir(p)).length === 0;
      const recursive = a.r || name === 'remove-item' && a.recurse || ((name === 'rmdir' || name === 'rd') && (a.r || empty));
      if (!recursive && !(empty && (name === 'rmdir' || name === 'rd' || a.d))) {
        ctx.err(`${ctx.name}: cannot remove '${f}': Is a directory${empty ? '' : ' (use -r)'}\n`);
        code = 1; continue;
      }
    }
    await ctx.fs.rmrf(p);
    if (a.v) ctx.out(`removed '${f}'\n`);
  }
  return code;
}, { help: 'Remove files or directories (-r recursive, -f force).', usage: 'rm [-rf] paths...', category: CAT });

def(['cp', 'copy', 'Copy-Item', 'cpi'], async (ctx) => {
  const a = parseArgs(ctx.args, { boolean: ['recurse', 'force'], alias: { recurse: 'r', R: 'r', force: 'f' } });
  if (a._.length < 2) throw new UsageError();
  const dest = ctx.resolve(a._.pop());
  const destIsDir = await ctx.fs.isDir(dest);
  if (a._.length > 1 && !destIsDir) { ctx.err(`cp: target '${dest}' is not a directory\n`); return 1; }
  for (const s of a._) {
    const src = ctx.resolve(s);
    const st = await ctx.fs.stat(src);
    if (!st) { ctx.err(`cp: cannot stat '${s}': No such file or directory\n`); return 1; }
    if (st.isDirectory() && !a.r && !ctx.shell.isWin) { ctx.err(`cp: -r not specified; omitting directory '${s}'\n`); return 1; }
    const target = destIsDir ? ctx.fs.join(dest, ctx.fs.basename(src)) : dest;
    if (target === src || target.startsWith(src + '/')) { ctx.err(`cp: cannot copy '${s}' into itself\n`); return 1; }
    await ctx.fs.copy(src, target);
  }
}, { help: 'Copy files or directories (-r for directories).', usage: 'cp [-r] src... dest', category: CAT });

def(['mv', 'move', 'Move-Item', 'mi', 'ren', 'rename', 'Rename-Item'], async (ctx) => {
  const a = parseArgs(ctx.args, { boolean: ['force'], alias: { force: 'f' } });
  if (a._.length < 2) throw new UsageError();
  const rawDest = a._.pop();
  const isRen = ['ren', 'rename', 'rename-item'].includes(ctx.name.toLowerCase());
  for (const s of a._) {
    const src = ctx.resolve(s);
    if (!(await ctx.fs.exists(src))) { ctx.err(`${ctx.name}: cannot stat '${s}': No such file or directory\n`); return 1; }
    let dest = isRen ? ctx.fs.join(ctx.fs.dirname(src), rawDest) : ctx.resolve(rawDest);
    if (await ctx.fs.isDir(dest)) dest = ctx.fs.join(dest, ctx.fs.basename(src));
    if (dest === src) continue;
    if (dest.startsWith(src + '/')) { ctx.err(`${ctx.name}: cannot move '${s}' into itself\n`); return 1; }
    await ctx.fs.rmrf(dest);
    await ctx.fs.copy(src, dest);
    await ctx.fs.rmrf(src);
  }
}, { help: 'Move or rename files.', usage: 'mv src... dest', category: CAT });

def(['tree'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['L'] });
  const root = ctx.resolve(a._[0] ?? '.');
  const max = a.L ? parseInt(a.L, 10) : Infinity;
  let dirs = 0, files = 0;
  ctx.out((a._[0] ?? '.') + '\n');
  const rec = async (p, prefix, depth) => {
    if (depth > max) return;
    const names = (await ctx.fs.readdir(p)).filter((n) => (a.a || !n.startsWith('.')) && n !== '.git');
    for (let i = 0; i < names.length; i++) {
      const last = i === names.length - 1;
      const full = ctx.fs.join(p, names[i]);
      const isD = await ctx.fs.isDir(full);
      isD ? dirs++ : files++;
      ctx.out(`${prefix}${last ? '└── ' : '├── '}${isD && ctx.isTTY ? c.bblue(names[i]) : names[i]}\n`);
      if (isD) await rec(full, prefix + (last ? '    ' : '│   '), depth + 1);
    }
  };
  await rec(root, '', 1);
  ctx.out(`\n${dirs} directories, ${files} files\n`);
}, { help: 'Show a directory tree (-L depth, -a hidden).', usage: 'tree [-a] [-L n] [dir]', category: CAT });

def(['find'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['name', 'iname', 'type', 'maxdepth'] });
  const root = a._[0] ?? '.';
  const base = ctx.resolve(root);
  const pat = a.name ?? a.iname;
  const re = pat ? new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', a.iname ? 'i' : '') : null;
  const maxDepth = a.maxdepth ? +a.maxdepth : Infinity;
  for await (const { path, stat } of ctx.fs.walk(base)) {
    const rel = path === base ? '' : path.slice(base === '/' ? 1 : base.length + 1);
    if (rel.split('/').length > maxDepth && rel) continue;
    if (a.type === 'f' && stat.isDirectory()) continue;
    if (a.type === 'd' && !stat.isDirectory()) continue;
    if (re && !re.test(ctx.fs.basename(path))) continue;
    ctx.out((rel ? (root === '.' ? './' : root.replace(/\/$/, '') + '/') + rel : root) + '\n');
  }
}, { help: 'Find files (-name "*.js", -type f|d, -maxdepth n).', usage: 'find [dir] [-name pattern] [-type f|d]', category: CAT });

def(['stat', 'Get-Item', 'gi'], async (ctx) => {
  for (const f of ctx.args) {
    const st = await ctx.fs.stat(ctx.resolve(f));
    if (!st) { ctx.err(`stat: cannot stat '${f}': No such file or directory\n`); return 1; }
    ctx.out(`  File: ${f}\n  Size: ${st.size}\t${st.isDirectory() ? 'directory' : 'regular file'}\nModify: ${new Date(st.mtimeMs).toString()}\n`);
  }
}, { help: 'Show file details.', usage: 'stat files...', category: CAT });

def(['du'], async (ctx) => {
  const root = ctx.resolve(ctx.args.find((x) => !x.startsWith('-')) ?? '.');
  let total = 0;
  for await (const { stat } of ctx.fs.walk(root)) if (!stat.isDirectory()) total += stat.size;
  ctx.out(`${humanSize(total)}\t${ctx.args.find((x) => !x.startsWith('-')) ?? '.'}\n`);
}, { help: 'Total size of a directory.', usage: 'du [dir]', category: CAT });

def(['edit', 'nano', 'vim', 'vi', 'nvim', 'notepad', 'code', 'emacs', 'micro'], async (ctx) => {
  const f = ctx.args.find((x) => !x.startsWith('-'));
  if (!f) throw new UsageError('give me a file name');
  const p = ctx.resolve(f);
  if (await ctx.fs.isDir(p)) { ctx.err(`${ctx.name}: ${f} is a directory\n`); return 1; }
  const exists = await ctx.fs.exists(p);
  const text = exists ? await ctx.fs.readText(p) : '';
  await openEditor(ctx.shell.displayPath(p), text, async (content) => { await ctx.fs.writeFile(p, content); });
  ctx.session.focus();
}, { help: 'Edit a file in the built-in editor (nano/vim/code all open it).', usage: 'edit <file>', category: CAT });

def(['download', 'Export-File'], async (ctx) => {
  const files = ctx.args.filter((x) => !x.startsWith('-'));
  if (!files.length) throw new UsageError();
  for (const f of files) {
    const p = ctx.resolve(f);
    const data = await ctx.fs.readBytes(p);
    const url = URL.createObjectURL(new Blob([data]));
    const link = Object.assign(document.createElement('a'), { href: url, download: ctx.fs.basename(p) });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    ctx.out(`Downloading ${ctx.fs.basename(p)} (${humanSize(data.length)})\n`);
  }
}, { help: 'Save a file from PocketShell to your device.', usage: 'download <file>', category: CAT });

def(['upload', 'Import-File'], async (ctx) => {
  const dir = ctx.resolve(ctx.args[0] ?? '.');
  ctx.out(c.gray('Pick file(s) to upload… (Ctrl+C to cancel)\n'));
  const files = await new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true });
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    ctx.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    input.click();
  });
  for (const f of files) {
    await ctx.fs.writeFile(ctx.fs.join(dir, f.name), new Uint8Array(await f.arrayBuffer()));
    ctx.out(`Uploaded ${f.name} (${humanSize(f.size)})\n`);
  }
  if (!files.length) ctx.out('No files selected.\n');
}, { help: 'Upload files from your device into PocketShell.', usage: 'upload [dir]', category: CAT });

def(['reset-fs', 'format'], async (ctx) => {
  if (!(await ctx.session.confirm(c.red('This deletes EVERY file in PocketShell storage. Continue?')))) return 1;
  for (const n of await ctx.fs.readdir('/')) await ctx.fs.rmrf('/' + n);
  localStorage.removeItem('ps.fsInit');
  ctx.out('Storage wiped. Reloading…\n');
  setTimeout(() => location.reload(), 600);
}, { help: 'Wipe the whole virtual filesystem.', category: CAT });
