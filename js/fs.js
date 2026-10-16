// Persistent virtual filesystem (IndexedDB via LightningFS), shared with isomorphic-git.
export const fs = new globalThis.LightningFS('pocketshell');
export const pfs = fs.promises;
export const HOME = '/home/user';

export function normalize(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

// Accepts unix paths, Windows paths (C:\foo\bar), ~ and relative paths.
export function resolve(cwd, p) {
  if (p == null || p === '') return cwd;
  p = String(p).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '');
  if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
  if (p === '') p = '/';
  return normalize(p.startsWith('/') ? p : cwd + '/' + p);
}

export const dirname = (p) => normalize(p + '/..');
export const basename = (p) => p.split('/').filter(Boolean).pop() || '/';
export const join = (...ps) => normalize(ps.join('/'));
export const toWin = (p) => 'C:' + p.replace(/\//g, '\\');
export const tilde = (p) => (p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
export const relative = (from, to) => {
  const a = from.split('/').filter(Boolean), b = to.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') || '.';
};

export async function stat(p) {
  try { return await pfs.stat(p); } catch { return null; }
}
export async function exists(p) { return !!(await stat(p)); }
export async function isDir(p) { const s = await stat(p); return !!s && s.isDirectory(); }

export async function readdir(p) {
  return (await pfs.readdir(p)).sort((a, b) => a.localeCompare(b));
}
export async function readText(p) {
  const s = await stat(p);
  if (!s) throw new Error(`${p}: No such file or directory`);
  if (s.isDirectory()) throw new Error(`${p}: Is a directory`);
  return await pfs.readFile(p, 'utf8');
}
export async function readBytes(p) {
  const s = await stat(p);
  if (!s) throw new Error(`${p}: No such file or directory`);
  if (s.isDirectory()) throw new Error(`${p}: Is a directory`);
  return await pfs.readFile(p);
}
export async function writeFile(p, data) {
  await mkdirp(dirname(p));
  if (typeof data === 'string') await pfs.writeFile(p, data, 'utf8');
  else await pfs.writeFile(p, data, {});
}

export async function mkdirp(p) {
  let cur = '';
  for (const seg of p.split('/').filter(Boolean)) {
    cur += '/' + seg;
    const s = await stat(cur);
    if (s && !s.isDirectory()) throw new Error(`${cur}: Not a directory`);
    if (!s) {
      try { await pfs.mkdir(cur); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
  }
}

export async function rmrf(p) {
  let s;
  try { s = await pfs.lstat(p); } catch { return; }
  if (s.isDirectory()) {
    for (const name of await pfs.readdir(p)) await rmrf(join(p, name));
    if (p !== '/') await pfs.rmdir(p);
  } else {
    await pfs.unlink(p);
  }
}

export async function copy(src, dest) {
  const s = await stat(src);
  if (!s) throw new Error(`${src}: No such file or directory`);
  if (s.isDirectory()) {
    await mkdirp(dest);
    for (const name of await pfs.readdir(src)) await copy(join(src, name), join(dest, name));
  } else {
    await writeFile(dest, await pfs.readFile(src));
  }
}

export async function* walk(p) {
  const s = await stat(p);
  if (!s) return;
  yield { path: p, stat: s };
  if (s.isDirectory()) {
    for (const name of await readdir(p)) yield* walk(join(p, name));
  }
}

const WELCOME = `Welcome to PocketShell!

This is your home directory. Everything you create here is saved in your
browser (IndexedDB), so it survives page reloads.

Try:
  help                 list every command
  gh auth login        connect your GitHub account
  gh repo list         see your repos
  git clone owner/repo clone a repo into the browser
  edit notes.txt       open the built-in editor
  python               start a Python REPL
  connect              attach to a real shell through the PocketShell bridge
`;

export async function initFS() {
  await mkdirp(HOME);
  await mkdirp('/tmp');
  if (!localStorage.getItem('ps.fsInit')) {
    await writeFile(HOME + '/README.txt', WELCOME);
    await mkdirp(HOME + '/projects');
    localStorage.setItem('ps.fsInit', '1');
  }
}
