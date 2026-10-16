// Real git, running in the browser via isomorphic-git.
import { def, parseArgs, UsageError, c } from './registry.js';
import { settings } from '../settings.js';
import { getToken } from '../github.js';
import { unifiedDiff } from '../diff.js';
import * as fsx from '../fs.js';

const git = globalThis.git;
const http = globalThis.GitHttp;
const fs = fsx.fs;
const CAT = 'Git & GitHub';

// ---------- helpers ----------
const GLOBAL_KEY = 'ps.gitconfig';
export function globalConfig() {
  try { return JSON.parse(localStorage.getItem(GLOBAL_KEY)) || {}; } catch { return {}; }
}
export function setGlobalConfig(key, value) {
  const cfg = globalConfig();
  if (value === undefined) delete cfg[key]; else cfg[key] = value;
  localStorage.setItem(GLOBAL_KEY, JSON.stringify(cfg));
}

function corsProxy(ctx) {
  const v = ctx.shell.getVar('GIT_CORS_PROXY') ?? settings.corsProxy;
  return v ? v.replace(/\/$/, '') : undefined;
}

export function normalizeUrl(u) {
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) return `https://github.com/${u.replace(/\.git$/, '')}.git`;
  let m;
  if ((m = u.match(/^git@([^:]+):(.+)$/))) return `https://${m[1]}/${m[2]}`;
  if (/^[\w.-]+\.[a-z]{2,}\//i.test(u)) return 'https://' + u;
  return u;
}

async function findRoot(ctx) {
  try {
    return await git.findRoot({ fs, filepath: ctx.cwd });
  } catch {
    throw new Error('not a git repository (or any of the parent directories): .git');
  }
}

function rel(ctx, dir, p) {
  const r = fsx.relative(dir, ctx.resolve(p));
  if (r.startsWith('..')) throw new Error(`'${p}' is outside repository at '${dir}'`);
  return r;
}

function authHandlers(ctx) {
  let tries = 0;
  return {
    onAuth: async (url) => {
      tries++;
      const token = getToken();
      if (token && /github\.com/.test(url) && tries === 1) return { username: token, password: 'x-oauth-basic' };
      if (ctx.shell.getVar('GIT_TOKEN') && tries === 1) return { username: ctx.shell.getVar('GIT_TOKEN'), password: 'x-oauth-basic' };
      const host = new URL(url).host;
      ctx.session.ensureNewline();
      const username = await ctx.session.question(`Username for 'https://${host}': `);
      if (username === null) return { cancel: true };
      const password = await ctx.session.question(`Password (or token) for 'https://${username}@${host}': `, true);
      if (password === null) return { cancel: true };
      return { username, password };
    },
    onAuthFailure: () => {
      if (tries >= 2) return { cancel: true };
      return undefined;
    },
  };
}

function progress(ctx) {
  let last = 0;
  let shown = false;
  return {
    onProgress: (e) => {
      if (!ctx.isTTY) return;
      const now = Date.now();
      if (now - last < 80 && e.loaded !== e.total) return;
      last = now;
      const pct = e.total ? `${Math.round((e.loaded / e.total) * 100)}% (${e.loaded}/${e.total})` : `${e.loaded}`;
      ctx.session.write(`\r\x1b[K${e.phase}: ${pct}`);
      shown = true;
    },
    onMessage: (m) => {
      if (!ctx.isTTY) return;
      ctx.session.write(`\r\x1b[Kremote: ${m.trim()}\n`);
    },
    done: () => { if (shown) ctx.session.write('\r\x1b[K'); },
  };
}

async function author(dir, required = true) {
  const name = (await git.getConfig({ fs, dir, path: 'user.name' })) ?? globalConfig()['user.name'];
  const email = (await git.getConfig({ fs, dir, path: 'user.email' })) ?? globalConfig()['user.email'];
  if (name && email) return { name, email };
  if (!required) return undefined;
  throw new Error('Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n' +
    '  git config --global user.email "you@example.com"\n  git config --global user.name "Your Name"\n\n' +
    '(or log in with gh auth login and it gets set for you)');
}

function friendly(e) {
  const code = e?.code || e?.name;
  if (code === 'HttpError') {
    const s = e.data?.statusCode;
    if (s === 401 || s === 403) return `Authentication failed (HTTP ${s}). Run 'gh auth login' with a token that has the 'repo' scope.`;
    if (s === 404) return 'Repository not found (HTTP 404). If it is private, run gh auth login first.';
    return `HTTP error ${s}: ${e.data?.statusMessage ?? e.message}`;
  }
  if (e instanceof TypeError && /fetch/i.test(e.message)) {
    return `Network request failed. The CORS proxy (${settings.corsProxy || 'none'}) may be down or blocked.\n` +
      "Change it in Settings, or run: export GIT_CORS_PROXY=https://your-proxy (the PocketShell bridge includes one).";
  }
  if (code === 'UserCanceledError') return 'Authentication canceled.';
  if (code === 'PushRejectedError') return `Updates were rejected (${e.data?.reason ?? 'not fast-forward'}). Pull first (git pull), or use --force.`;
  if (code === 'CheckoutConflictError') return `Your local changes would be overwritten:\n  ${(e.data?.filepaths ?? []).join('\n  ')}\nCommit or stash them first.`;
  if (code === 'MergeConflictError') return `Merge conflict in:\n  ${(e.data?.filepaths ?? []).join('\n  ')}\nFix the files, then git add + git commit.`;
  if (code === 'MergeNotSupportedError') return 'This merge needs conflict resolution that the browser git cannot do automatically.';
  if (code === 'NotFoundError') return e.message.replace(/^Could not find /, 'not found: ');
  return e?.message ?? String(e);
}

const short = (oid) => oid?.slice(0, 7);

async function decorations(dir) {
  const map = new Map();
  const add = (oid, label) => { if (!oid) return; if (!map.has(oid)) map.set(oid, []); map.get(oid).push(label); };
  const head = await git.currentBranch({ fs, dir }).catch(() => null);
  for (const b of await git.listBranches({ fs, dir }).catch(() => [])) {
    const oid = await git.resolveRef({ fs, dir, ref: b }).catch(() => null);
    add(oid, b === head ? `\x1b[1;36mHEAD -> \x1b[1;32m${b}` : `\x1b[1;32m${b}`);
  }
  for (const r of await git.listRemotes({ fs, dir }).catch(() => [])) {
    for (const b of await git.listBranches({ fs, dir, remote: r.remote }).catch(() => [])) {
      if (b === 'HEAD') continue;
      add(await git.resolveRef({ fs, dir, ref: `refs/remotes/${r.remote}/${b}` }).catch(() => null), `\x1b[1;31m${r.remote}/${b}`);
    }
  }
  for (const t of await git.listTags({ fs, dir }).catch(() => [])) {
    let oid = await git.resolveRef({ fs, dir, ref: `refs/tags/${t}` }).catch(() => null);
    try { const o = await git.readTag({ fs, dir, oid }); oid = o.tag.object; } catch { /* lightweight */ }
    add(oid, `\x1b[1;33mtag: ${t}`);
  }
  return map;
}

function decode(bytes) {
  if (!bytes) return '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.subarray(0, 8000).includes(0)) return null;
  return new TextDecoder().decode(u8);
}

async function blobText(dir, oid) {
  if (!oid) return '';
  const { blob } = await git.readBlob({ fs, dir, oid });
  return decode(blob);
}

function renderFileDiff(ctx, filepath, a, b, aMissing, bMissing) {
  const col = (code, s) => (ctx.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
  let out = col('1', `diff --git a/${filepath} b/${filepath}`) + '\n';
  if (aMissing) out += col('1', 'new file mode 100644') + '\n';
  if (bMissing) out += col('1', 'deleted file mode 100644') + '\n';
  if (a === null || b === null) return out + `Binary files differ\n`;
  const body = unifiedDiff(a, b, aMissing ? '/dev/null' : `a/${filepath}`, bMissing ? '/dev/null' : `b/${filepath}`, ctx.isTTY);
  return out + body;
}

// diff between two walkers; mode: 'unstaged' | 'staged' | 'trees'
async function walkDiff(ctx, dir, trees, mode, paths) {
  const changes = [];
  await git.walk({
    fs, dir, trees,
    map: async (filepath, [A, B]) => {
      if (filepath === '.') return;
      if (paths?.length && !paths.some((p) => p === '.' || filepath === p || filepath.startsWith(p + '/') || p.startsWith(filepath + '/'))) return null;
      const ta = A ? await A.type() : null;
      const tb = B ? await B.type() : null;
      if (ta === 'tree' || tb === 'tree') {
        if (mode === 'unstaged' && !A) return null;
        return;
      }
      if (ta === 'commit' || tb === 'commit') return;
      if (mode === 'unstaged' && !A) return;
      const oa = A ? await A.oid() : null;
      const ob = B ? await B.oid() : null;
      if (oa === ob) return;
      changes.push({ filepath, A, B, oa, ob });
    },
  });
  let out = '';
  for (const ch of changes.sort((x, y) => x.filepath.localeCompare(y.filepath))) {
    const a = await blobText(dir, ch.oa);
    const b = mode === 'unstaged' ? (ch.B ? decode(await ch.B.content()) : '') : await blobText(dir, ch.ob);
    out += renderFileDiff(ctx, ch.filepath, a, b, !ch.A, !ch.B);
  }
  return { out, count: changes.length };
}

async function hasHead(dir) {
  try { await git.resolveRef({ fs, dir, ref: 'HEAD' }); return true; } catch { return false; }
}

function classify([, H, W, S]) {
  let staged = null, unstaged = null;
  if (H === 0 && S !== 0) staged = 'new file';
  else if (H === 1 && S === 0) staged = 'deleted';
  else if (H === 1 && (S === 2 || S === 3)) staged = 'modified';
  if (S === 0 && W === 2) unstaged = 'untracked';
  else if (S !== 0 && W === 0) unstaged = 'deleted';
  else if ((S === 1 && W === 2) || S === 3) unstaged = 'modified';
  return { staged, unstaged };
}

async function aheadBehind(dir, branch) {
  const remote = (await git.getConfig({ fs, dir, path: `branch.${branch}.remote` })) || 'origin';
  const merge = (await git.getConfig({ fs, dir, path: `branch.${branch}.merge` })) || `refs/heads/${branch}`;
  const remoteRef = `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//, '')}`;
  let local, upstream;
  try { local = await git.resolveRef({ fs, dir, ref: branch }); upstream = await git.resolveRef({ fs, dir, ref: remoteRef }); } catch { return null; }
  const name = remoteRef.replace('refs/remotes/', '');
  if (local === upstream) return `Your branch is up to date with '${name}'.`;
  const walkFrom = async (from, stop) => {
    try {
      const commits = await git.log({ fs, dir, ref: from, depth: 300 });
      const i = commits.findIndex((x) => x.oid === stop);
      return i;
    } catch { return -1; }
  };
  const ahead = await walkFrom(local, upstream);
  if (ahead > 0) return `Your branch is ahead of '${name}' by ${ahead} commit${ahead > 1 ? 's' : ''}.\n  (use "git push" to publish your local commits)`;
  const behind = await walkFrom(upstream, local);
  if (behind > 0) return `Your branch is behind '${name}' by ${behind} commit${behind > 1 ? 's' : ''}, and can be fast-forwarded.\n  (use "git pull" to update your local branch)`;
  return `Your branch and '${name}' have diverged.`;
}

// ---------- subcommands ----------
const sub = {};

sub.help = (ctx) => {
  ctx.out(`usage: git <command> [<args>]

PocketShell runs real git in your browser (isomorphic-git). Supported commands:

  ${c.cyan('start a working area')}   clone, init
  ${c.cyan('work on changes')}        add, mv, restore, rm, reset, stash
  ${c.cyan('examine history')}        diff, log, show, status, ls-files, rev-parse
  ${c.cyan('grow & tweak history')}   branch, checkout, switch, commit, merge, tag
  ${c.cyan('collaborate')}            fetch, pull, push, remote
  ${c.cyan('settings')}               config

Remote operations go through a CORS proxy (Settings → Git CORS proxy).
Authenticate once with ${c.green('gh auth login')} and pushes to GitHub just work.
`);
};

sub.init = async (ctx, args) => {
  const a = parseArgs(args, { string: ['b', 'initial-branch'] });
  const dir = ctx.resolve(a._[0] ?? '.');
  await fsx.mkdirp(dir);
  const existed = await fsx.exists(dir + '/.git');
  await git.init({ fs, dir, defaultBranch: a.b ?? a['initial-branch'] ?? 'main' });
  ctx.out(`${existed ? 'Reinitialized existing' : 'Initialized empty'} Git repository in ${ctx.shell.displayPath(dir + '/.git/')}\n`);
};

sub.clone = async (ctx, args) => {
  const a = parseArgs(args, { string: ['depth', 'b', 'branch'], boolean: ['single-branch', 'no-single-branch'] });
  const [src, target] = a._;
  if (!src) throw new UsageError('You must specify a repository to clone.');
  const url = normalizeUrl(src);
  const name = target ?? url.replace(/\/$/, '').split('/').pop().replace(/\.git$/, '');
  const dir = ctx.resolve(name);
  if (await fsx.exists(dir) && (await fsx.readdir(dir)).length) {
    throw new Error(`destination path '${name}' already exists and is not an empty directory.`);
  }
  ctx.out(`Cloning into '${name}'...\n`);
  const p = progress(ctx);
  try {
    await git.clone({
      fs, http, dir, url, corsProxy: corsProxy(ctx),
      ref: a.b ?? a.branch, singleBranch: !a['no-single-branch'], depth: a.depth ? parseInt(a.depth, 10) : undefined,
      ...authHandlers(ctx), onProgress: p.onProgress, onMessage: p.onMessage,
    });
    p.done();
  } catch (e) {
    p.done();
    await fsx.rmrf(dir);
    throw e;
  }
  const files = await git.listFiles({ fs, dir });
  ctx.out(`done. ${files.length} files checked out.\n`);
};

sub.status = async (ctx, args) => {
  const a = parseArgs(args, { boolean: ['short', 'porcelain'] });
  const dir = await findRoot(ctx);
  const branch = await git.currentBranch({ fs, dir });
  const matrix = await git.statusMatrix({ fs, dir });
  const staged = [], unstaged = [], untracked = [];
  for (const row of matrix) {
    const { staged: s, unstaged: u } = classify(row);
    if (s) staged.push([s, row[0]]);
    if (u === 'untracked') untracked.push(row[0]);
    else if (u) unstaged.push([u, row[0]]);
  }
  if (a.short || a.s || a.porcelain) {
    const code = { 'new file': 'A', modified: 'M', deleted: 'D' };
    const lines = new Map();
    for (const [s, f] of staged) lines.set(f, [code[s], ' ']);
    for (const [u, f] of unstaged) lines.set(f, [(lines.get(f) ?? [' '])[0], code[u]]);
    for (const [f, [x, y]] of [...lines].sort()) ctx.out(`${ctx.isTTY ? c.green(x) : x}${ctx.isTTY ? c.red(y) : y} ${f}\n`);
    for (const f of untracked) ctx.out(`${ctx.isTTY ? c.red('??') : '??'} ${f}\n`);
    return;
  }
  ctx.out(branch ? `On branch ${branch}\n` : 'HEAD detached\n');
  if (!(await hasHead(dir))) ctx.out('\nNo commits yet\n');
  else if (branch) { const ab = await aheadBehind(dir, branch); if (ab) ctx.out(ab + '\n'); }
  if (staged.length) {
    ctx.out('\nChanges to be committed:\n  (use "git restore --staged <file>..." to unstage)\n');
    for (const [s, f] of staged) ctx.out('\t' + c.green(`${(s + ':').padEnd(12)}${f}`) + '\n');
  }
  if (unstaged.length) {
    ctx.out('\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n');
    for (const [s, f] of unstaged) ctx.out('\t' + c.red(`${(s + ':').padEnd(12)}${f}`) + '\n');
  }
  if (untracked.length) {
    ctx.out('\nUntracked files:\n  (use "git add <file>..." to include in what will be committed)\n');
    for (const f of untracked) ctx.out('\t' + c.red(f) + '\n');
  }
  if (!staged.length && !unstaged.length && !untracked.length) ctx.out('\nnothing to commit, working tree clean\n');
  else if (!staged.length) ctx.out('\nno changes added to commit (use "git add" and/or "git commit -a")\n');
  else ctx.out('\n');
};

async function stagePaths(dir, paths, { all = false } = {}) {
  const matrix = await git.statusMatrix({ fs, dir, filepaths: paths.includes('.') ? undefined : paths });
  let n = 0;
  for (const [f, H, W, S] of matrix) {
    if (H === 1 && W === 1 && S === 1) continue;
    if (all && H === 0 && S === 0) continue; // commit -a skips untracked
    if (W === 0) { if (S !== 0) { await git.remove({ fs, dir, filepath: f }); n++; } }
    else if (W !== S || S === 3) { await git.add({ fs, dir, filepath: f }); n++; }
  }
  return n;
}

sub.add = async (ctx, args) => {
  const a = parseArgs(args, { boolean: ['all'], alias: { A: 'all' } });
  const dir = await findRoot(ctx);
  const paths = a.all ? ['.'] : a._.map((p) => rel(ctx, dir, p));
  if (!paths.length) { ctx.err('Nothing specified, nothing added.\nMaybe you wanted to say \'git add .\'?\n'); return 1; }
  for (const p of paths) {
    if (p !== '.' && !(await fsx.exists(fsx.join(dir, p)))) {
      const tracked = (await git.listFiles({ fs, dir })).some((f) => f === p || f.startsWith(p + '/'));
      if (!tracked) { ctx.err(`fatal: pathspec '${p}' did not match any files\n`); return 128; }
    }
  }
  await stagePaths(dir, paths);
  if (a.v) ctx.out('done\n');
};

sub.rm = async (ctx, args) => {
  const a = parseArgs(args, { boolean: ['cached'], alias: { r: 'r' } });
  const dir = await findRoot(ctx);
  const files = await git.listFiles({ fs, dir });
  for (const p of a._.map((x) => rel(ctx, dir, x))) {
    const hits = files.filter((f) => f === p || (a.r && (p === '.' || f.startsWith(p + '/'))));
    if (!hits.length) { ctx.err(`fatal: pathspec '${p}' did not match any files\n`); return 128; }
    for (const f of hits) {
      await git.remove({ fs, dir, filepath: f });
      if (!a.cached) await fsx.rmrf(fsx.join(dir, f));
      ctx.out(`rm '${f}'\n`);
    }
  }
};

sub.mv = async (ctx, args) => {
  const [from, to] = args;
  if (!from || !to) throw new UsageError();
  const dir = await findRoot(ctx);
  const src = ctx.resolve(from);
  let dest = ctx.resolve(to);
  if (await fsx.isDir(dest)) dest = fsx.join(dest, fsx.basename(src));
  await fsx.copy(src, dest);
  await fsx.rmrf(src);
  const files = await git.listFiles({ fs, dir });
  const r = fsx.relative(dir, src);
  for (const f of files.filter((x) => x === r || x.startsWith(r + '/'))) await git.remove({ fs, dir, filepath: f });
  await stagePaths(dir, [fsx.relative(dir, dest)]);
};

sub.commit = async (ctx, args) => {
  const a = parseArgs(args, { string: ['m', 'message', 'author'], boolean: ['all', 'amend', 'allow-empty'], alias: { a: 'all', message: 'm' } });
  const dir = await findRoot(ctx);
  if (a.all) await stagePaths(dir, ['.'], { all: true });
  let message = a.mAll ? a.mAll.join('\n\n') : a.m;
  const matrix = await git.statusMatrix({ fs, dir });
  const changed = matrix.filter((r) => classify(r).staged);
  if (!changed.length && !a.amend && !a['allow-empty']) {
    const untracked = matrix.some((r) => classify(r).unstaged);
    ctx.out(`On branch ${await git.currentBranch({ fs, dir })}\n${untracked ? 'no changes added to commit (use "git add")' : 'nothing to commit, working tree clean'}\n`);
    return 1;
  }
  if (!message && !a.amend) {
    message = await ctx.session.question('Commit message: ');
    if (!message?.trim()) { ctx.err('Aborting commit due to empty commit message.\n'); return 1; }
  }
  const who = await author(dir);
  const oid = await git.commit({ fs, dir, message: message ?? undefined, author: who, amend: !!a.amend });
  const branch = await git.currentBranch({ fs, dir }) ?? 'detached HEAD';
  const first = (message ?? (await git.readCommit({ fs, dir, oid })).commit.message).split('\n')[0];
  ctx.out(`[${branch} ${short(oid)}] ${first}\n ${changed.length} file${changed.length === 1 ? '' : 's'} changed\n`);
};

sub.log = async (ctx, args) => {
  const argv = args.map((x) => (/^-\d+$/.test(x) ? ['-n', x.slice(1)] : [x])).flat();
  const a = parseArgs(argv, { string: ['n', 'max-count', 'author'], boolean: ['oneline', 'all'] });
  const dir = await findRoot(ctx);
  if (!(await hasHead(dir))) { ctx.err(`fatal: your current branch '${await git.currentBranch({ fs, dir })}' does not have any commits yet\n`); return 128; }
  const depth = parseInt(a.n ?? a['max-count'] ?? 0, 10) || undefined;
  const ref = a._[0] ?? 'HEAD';
  let commits = await git.log({ fs, dir, ref, depth: depth && !a.author ? depth : undefined });
  if (a.author) commits = commits.filter((x) => `${x.commit.author.name} <${x.commit.author.email}>`.includes(a.author)).slice(0, depth);
  const deco = await decorations(dir);
  for (const { oid, commit } of commits) {
    const d = deco.get(oid);
    const ds = d ? ` \x1b[33m(${d.join('\x1b[33m, ')}\x1b[33m)\x1b[0m` : '';
    if (a.oneline) { ctx.out(`${c.yellow(short(oid))}${ds} ${commit.message.split('\n')[0]}\n`); continue; }
    const when = new Date(commit.author.timestamp * 1000);
    ctx.out(`${c.yellow('commit ' + oid)}${ds}\nAuthor: ${commit.author.name} <${commit.author.email}>\nDate:   ${when.toString()}\n\n`);
    ctx.out(commit.message.trimEnd().split('\n').map((l) => '    ' + l).join('\n') + '\n\n');
  }
};

sub.show = async (ctx, args) => {
  const dir = await findRoot(ctx);
  const ref = args.find((x) => !x.startsWith('-')) ?? 'HEAD';
  const oid = await git.expandRef({ fs, dir, ref }).then((r) => git.resolveRef({ fs, dir, ref: r })).catch(() => git.expandOid({ fs, dir, oid: ref }));
  const { commit } = await git.readCommit({ fs, dir, oid });
  const when = new Date(commit.author.timestamp * 1000);
  ctx.out(`${c.yellow('commit ' + oid)}\nAuthor: ${commit.author.name} <${commit.author.email}>\nDate:   ${when.toString()}\n\n`);
  ctx.out(commit.message.trimEnd().split('\n').map((l) => '    ' + l).join('\n') + '\n\n');
  const parent = commit.parent[0];
  const trees = parent ? [git.TREE({ ref: parent }), git.TREE({ ref: oid })] : [git.TREE({ ref: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }), git.TREE({ ref: oid })];
  if (!parent) {
    // root commit: show every file as added
    const files = await git.listFiles({ fs, dir, ref: oid });
    for (const f of files) {
      const { blob } = await git.readBlob({ fs, dir, oid, filepath: f });
      ctx.out(renderFileDiff(ctx, f, '', decode(blob), true, false));
    }
    return;
  }
  const { out } = await walkDiff(ctx, dir, trees, 'trees');
  ctx.out(out);
};

sub.diff = async (ctx, args) => {
  const a = parseArgs(args, { boolean: ['staged', 'cached', 'stat', 'name-only'] });
  const dir = await findRoot(ctx);
  const refs = [], paths = [];
  for (const x of a._) {
    if (paths.length || (await fsx.exists(ctx.resolve(x)))) paths.push(rel(ctx, dir, x));
    else refs.push(x);
  }
  let res;
  if (refs.length === 2) res = await walkDiff(ctx, dir, [git.TREE({ ref: refs[0] }), git.TREE({ ref: refs[1] })], 'trees', paths);
  else if (refs.length === 1) res = await walkDiff(ctx, dir, [git.TREE({ ref: refs[0] }), git.WORKDIR()], 'unstaged', paths);
  else if (a.staged || a.cached) {
    if (!(await hasHead(dir))) {
      const files = await git.listFiles({ fs, dir });
      let out = '';
      for (const f of files.filter((f) => !paths.length || paths.some((p) => f === p || f.startsWith(p + '/')))) {
        out += renderFileDiff(ctx, f, '', decode(await fsx.readBytes(fsx.join(dir, f))), true, false);
      }
      res = { out };
    } else res = await walkDiff(ctx, dir, [git.TREE({ ref: 'HEAD' }), git.STAGE()], 'staged', paths);
  } else res = await walkDiff(ctx, dir, [git.STAGE(), git.WORKDIR()], 'unstaged', paths);
  if (a['name-only'] || a.stat) {
    const names = [...res.out.matchAll(/diff --git a\/(\S+)/g)].map((m) => m[1]);
    ctx.out(names.join('\n') + (names.length ? '\n' : ''));
    return;
  }
  ctx.out(res.out);
};

sub.branch = async (ctx, args) => {
  const a = parseArgs(args, { string: ['d', 'D', 'm', 'M'], boolean: ['all', 'remotes', 'show-current'], alias: { a: 'all', r: 'remotes' } });
  const dir = await findRoot(ctx);
  const current = await git.currentBranch({ fs, dir });
  if (a['show-current']) { ctx.out((current ?? '') + '\n'); return; }
  if (a.d || a.D) {
    const name = a.d ?? a.D;
    if (name === current) throw new Error(`cannot delete branch '${name}' checked out`);
    const oid = await git.resolveRef({ fs, dir, ref: name });
    await git.deleteBranch({ fs, dir, ref: name });
    ctx.out(`Deleted branch ${name} (was ${short(oid)}).\n`);
    return;
  }
  if (a.m || a.M) {
    const [from, to] = a._.length ? [a.m ?? a.M, a._[0]] : [current, a.m ?? a.M];
    await git.renameBranch({ fs, dir, oldref: from, ref: to, checkout: from === current });
    return;
  }
  if (a._.length) {
    await git.branch({ fs, dir, ref: a._[0], object: a._[1] });
    return;
  }
  if (!a.remotes) {
    for (const b of (await git.listBranches({ fs, dir })).sort()) ctx.out(b === current ? `* ${c.green(b)}\n` : `  ${b}\n`);
  }
  if (a.all || a.remotes) {
    for (const r of await git.listRemotes({ fs, dir })) {
      for (const b of (await git.listBranches({ fs, dir, remote: r.remote })).sort()) {
        if (b === 'HEAD') continue;
        ctx.out(`  ${c.red((a.remotes ? '' : 'remotes/') + `${r.remote}/${b}`)}\n`);
      }
    }
  }
};

async function doCheckout(ctx, dir, ref, p) {
  await git.checkout({ fs, dir, ref, onProgress: p.onProgress });
  p.done();
}

sub.checkout = async (ctx, args, { isSwitch = false } = {}) => {
  const a = parseArgs(args, { string: ['b', 'B', 'c', 'C'], boolean: ['force'], alias: { f: 'force' } });
  const dir = await findRoot(ctx);
  const p = progress(ctx);
  const newName = a.b ?? a.B ?? a.c ?? a.C;
  if (newName) {
    await git.branch({ fs, dir, ref: newName, object: a._[0], force: !!(a.B || a.C) });
    await doCheckout(ctx, dir, newName, p);
    ctx.out(`Switched to a new branch '${newName}'\n`);
    return;
  }
  const dd = args.indexOf('--');
  const target = a._[0];
  if (!target) throw new UsageError();
  const branches = await git.listBranches({ fs, dir });
  let remoteBranches = [];
  for (const r of await git.listRemotes({ fs, dir })) remoteBranches.push(...(await git.listBranches({ fs, dir, remote: r.remote })));
  const isRef = dd < 0 && (branches.includes(target) || remoteBranches.includes(target) || /^[0-9a-f]{7,40}$/.test(target) || (await git.listTags({ fs, dir })).includes(target));
  if (!isRef && !isSwitch) {
    // restore files from HEAD
    const files = a._.map((x) => rel(ctx, dir, x));
    await git.checkout({ fs, dir, filepaths: files, force: true });
    ctx.out(`Updated ${files.length} path${files.length > 1 ? 's' : ''} from HEAD\n`);
    return;
  }
  if (!isRef) throw new Error(`invalid reference: ${target}`);
  if (a.force) { await git.checkout({ fs, dir, ref: target, force: true }); }
  else await doCheckout(ctx, dir, target, p);
  const now = await git.currentBranch({ fs, dir });
  ctx.out(now ? `Switched to branch '${now}'\n` : `HEAD is now at ${short(await git.resolveRef({ fs, dir, ref: 'HEAD' }))}\n`);
};

sub.switch = (ctx, args) => sub.checkout(ctx, args, { isSwitch: true });

sub.restore = async (ctx, args) => {
  const a = parseArgs(args, { boolean: ['staged', 'worktree'], alias: { S: 'staged', W: 'worktree' } });
  const dir = await findRoot(ctx);
  const files = a._.map((x) => rel(ctx, dir, x));
  if (!files.length) throw new UsageError('you must specify path(s) to restore');
  if (a.staged) {
    for (const f of files) {
      const matches = (await git.statusMatrix({ fs, dir, filepaths: f === '.' ? undefined : [f] })).map((r) => r[0]);
      for (const m of matches) await git.resetIndex({ fs, dir, filepath: m });
    }
  }
  if (!a.staged || a.worktree) await git.checkout({ fs, dir, filepaths: files, force: true });
};

sub.reset = async (ctx, args) => {
  const a = parseArgs(args, { boolean: ['hard', 'soft', 'mixed'] });
  const dir = await findRoot(ctx);
  const branch = await git.currentBranch({ fs, dir });
  const maybeRef = a._[0];
  let ref = null, paths = [];
  if (maybeRef) {
    try { await git.resolveRef({ fs, dir, ref: maybeRef.replace(/~(\d*)$/, '') }); ref = maybeRef; paths = a._.slice(1); }
    catch { paths = a._; }
  }
  if (ref || a.hard || a.soft) {
    let oid = await resolveRevision(dir, ref ?? 'HEAD');
    if (!branch) throw new Error('reset in detached HEAD is not supported');
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
    if (a.hard) {
      await git.checkout({ fs, dir, ref: branch, force: true });
      const { commit } = await git.readCommit({ fs, dir, oid });
      ctx.out(`HEAD is now at ${short(oid)} ${commit.message.split('\n')[0]}\n`);
      return;
    }
    if (a.soft) return;
  }
  const matrix = await git.statusMatrix({ fs, dir, filepaths: paths.length ? paths.map((x) => rel(ctx, dir, x)) : undefined });
  const unstaged = [];
  for (const row of matrix) {
    if (row[1] !== row[3] || row[3] === 3 || row[3] === 2) { await git.resetIndex({ fs, dir, filepath: row[0] }); }
    const after = await git.statusMatrix({ fs, dir, filepaths: [row[0]] });
    if (after[0] && classify(after[0]).unstaged && classify(after[0]).unstaged !== 'untracked') unstaged.push(row[0]);
  }
  if (unstaged.length) ctx.out('Unstaged changes after reset:\n' + unstaged.map((f) => `M\t${f}`).join('\n') + '\n');
};

async function resolveRevision(dir, rev) {
  const m = rev.match(/^(.*?)(?:~(\d*)|\^+)?$/);
  let base = m[1] || 'HEAD';
  let n = rev.includes('~') ? parseInt(m[2] || '1', 10) : (rev.match(/\^/g) || []).length;
  let oid;
  try { oid = await git.resolveRef({ fs, dir, ref: base }); } catch { oid = await git.expandOid({ fs, dir, oid: base }); }
  while (n-- > 0) {
    const { commit } = await git.readCommit({ fs, dir, oid });
    if (!commit.parent.length) throw new Error(`ambiguous argument '${rev}': unknown revision`);
    oid = commit.parent[0];
  }
  return oid;
}

sub.remote = async (ctx, args) => {
  const dir = await findRoot(ctx);
  const [action, name, url] = args.filter((x) => x !== '-v' && x !== '--verbose');
  const verbose = args.includes('-v');
  if (!action) {
    for (const r of await git.listRemotes({ fs, dir })) {
      ctx.out(verbose ? `${r.remote}\t${r.url} (fetch)\n${r.remote}\t${r.url} (push)\n` : `${r.remote}\n`);
    }
    return;
  }
  if (action === 'add') { if (!name || !url) throw new UsageError(); await git.addRemote({ fs, dir, remote: name, url: normalizeUrl(url) }); return; }
  if (action === 'remove' || action === 'rm') { await git.deleteRemote({ fs, dir, remote: name }); return; }
  if (action === 'set-url') { await git.addRemote({ fs, dir, remote: name, url: normalizeUrl(url), force: true }); return; }
  if (action === 'get-url') { const r = (await git.listRemotes({ fs, dir })).find((x) => x.remote === name); if (!r) throw new Error(`No such remote '${name}'`); ctx.out(r.url + '\n'); return; }
  throw new UsageError(`unknown subcommand: ${action}`);
};

sub.fetch = async (ctx, args) => {
  const a = parseArgs(args, { boolean: ['prune', 'tags', 'all'], string: ['depth'] });
  const dir = await findRoot(ctx);
  const remote = a._[0] ?? 'origin';
  const p = progress(ctx);
  const res = await git.fetch({
    fs, http, dir, remote, ref: a._[1], corsProxy: corsProxy(ctx), singleBranch: !!a._[1], tags: !!a.tags, prune: !!a.prune,
    depth: a.depth ? +a.depth : undefined, ...authHandlers(ctx), onProgress: p.onProgress, onMessage: p.onMessage,
  });
  p.done();
  const url = (await git.listRemotes({ fs, dir })).find((r) => r.remote === remote)?.url;
  ctx.out(`From ${url}\n${res.fetchHead ? ` * ${res.fetchHeadDescription || short(res.fetchHead)}\n` : ''}`);
};

sub.pull = async (ctx, args) => {
  const a = parseArgs(args, { boolean: ['ff-only', 'rebase'] });
  const dir = await findRoot(ctx);
  const branch = await git.currentBranch({ fs, dir });
  const before = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
  const p = progress(ctx);
  if (a.rebase) ctx.out(c.gray('note: --rebase is not supported in the browser; doing a merge instead\n'));
  await git.pull({
    fs, http, dir, remote: a._[0], remoteRef: a._[1], ref: branch, corsProxy: corsProxy(ctx), singleBranch: true,
    fastForwardOnly: !!a['ff-only'], author: (await author(dir, false)) ?? { name: 'PocketShell User', email: 'user@pocketshell.local' }, ...authHandlers(ctx), onProgress: p.onProgress, onMessage: p.onMessage,
  });
  p.done();
  const after = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  if (before === after) ctx.out('Already up to date.\n');
  else ctx.out(`Updating ${short(before)}..${short(after)}\nFast-forward\n`);
};

sub.push = async (ctx, args) => {
  const a = parseArgs(args, { boolean: ['force', 'set-upstream', 'delete', 'tags'], alias: { f: 'force', u: 'set-upstream', d: 'delete' } });
  const dir = await findRoot(ctx);
  const branch = await git.currentBranch({ fs, dir });
  const remote = a._[0] ?? (branch && (await git.getConfig({ fs, dir, path: `branch.${branch}.remote` }))) ?? 'origin';
  let [ref, remoteRef] = (a._[1] ?? branch ?? '').split(':');
  if (!ref) throw new Error('You are not currently on a branch.');
  if ((await git.listTags({ fs, dir })).includes(ref) && !(await git.listBranches({ fs, dir })).includes(ref)) ref = `refs/tags/${ref}`;
  const remotes = await git.listRemotes({ fs, dir });
  const r = remotes.find((x) => x.remote === remote);
  if (!r) throw new Error(`'${remote}' does not appear to be a git repository\n(add one with: git remote add origin https://github.com/you/repo.git)`);
  const p = progress(ctx);
  const res = await git.push({
    fs, http, dir, remote, ref, remoteRef, force: !!a.force, delete: !!a.delete, corsProxy: corsProxy(ctx),
    ...authHandlers(ctx), onProgress: p.onProgress, onMessage: p.onMessage,
  });
  p.done();
  if (!res.ok) throw new Error(`failed to push some refs to '${r.url}'\n${res.error ?? JSON.stringify(res.refs)}`);
  ctx.out(`To ${r.url}\n`);
  for (const [name, st] of Object.entries(res.refs)) {
    ctx.out(st.ok ? `   ${c.green('✓')} ${ref.replace('refs/tags/', '')} -> ${name.replace(/^refs\/(heads|tags)\//, '')}\n` : `   ${c.red('!')} [rejected] ${name} (${st.error})\n`);
  }
  if (a['set-upstream'] && branch && !ref.startsWith('refs/tags/')) {
    await git.setConfig({ fs, dir, path: `branch.${branch}.remote`, value: remote });
    await git.setConfig({ fs, dir, path: `branch.${branch}.merge`, value: `refs/heads/${remoteRef || branch}` });
    ctx.out(`branch '${branch}' set up to track '${remote}/${remoteRef || branch}'.\n`);
  }
};

sub.merge = async (ctx, args) => {
  const a = parseArgs(args, { string: ['m'], boolean: ['ff-only', 'no-ff', 'abort'] });
  const dir = await findRoot(ctx);
  if (a.abort) { await git.abortMerge({ fs, dir }); ctx.out('Merge aborted.\n'); return; }
  const theirs = a._[0];
  if (!theirs) throw new UsageError();
  const ours = await git.currentBranch({ fs, dir });
  const res = await git.merge({
    fs, dir, ours, theirs, fastForward: !a['no-ff'], fastForwardOnly: !!a['ff-only'], message: a.m, author: await author(dir), abortOnConflict: false,
  });
  if (res.alreadyMerged) { ctx.out('Already up to date.\n'); return; }
  await git.checkout({ fs, dir, ref: ours });
  ctx.out(res.fastForward ? `Fast-forward to ${short(res.oid)}\n` : `Merge made by the 'ort' strategy. (${short(res.oid)})\n`);
};

sub.tag = async (ctx, args) => {
  const a = parseArgs(args, { string: ['m', 'd'], boolean: ['annotate', 'list'], alias: { a: 'annotate', l: 'list' } });
  const dir = await findRoot(ctx);
  if (a.d) { await git.deleteTag({ fs, dir, ref: a.d }); ctx.out(`Deleted tag '${a.d}'\n`); return; }
  if (!a._.length || a.list) { for (const t of await git.listTags({ fs, dir })) ctx.out(t + '\n'); return; }
  const [name, object] = a._;
  if (a.annotate || a.m) {
    await git.annotatedTag({ fs, dir, ref: name, object, message: a.m ?? name, tagger: await author(dir) });
  } else await git.tag({ fs, dir, ref: name, object });
};

sub.stash = async (ctx, args) => {
  const dir = await findRoot(ctx);
  const op = args[0] && !args[0].startsWith('-') ? args[0] : 'push';
  const a = parseArgs(args.slice(op === args[0] ? 1 : 0), { string: ['m', 'message'], alias: { message: 'm' } });
  if (op === 'list') {
    const list = await git.stash({ fs, dir, op: 'list' });
    for (const [i, entry] of (list || []).entries()) ctx.out((typeof entry === 'string' && entry.startsWith('stash@') ? entry : `stash@{${i}}: ${typeof entry === 'string' ? entry : entry?.message ?? JSON.stringify(entry)}`) + '\n');
    return;
  }
  const refIdx = a._[0] ? parseInt(String(a._[0]).replace(/\D/g, ''), 10) : undefined;
  if (op === 'push' || op === 'save') {
    // isomorphic-git's stash reads the identity from the repo config, so copy the global one in
    const who = await author(dir);
    if (!(await git.getConfig({ fs, dir, path: 'user.name' }))) await git.setConfig({ fs, dir, path: 'user.name', value: who.name });
    if (!(await git.getConfig({ fs, dir, path: 'user.email' }))) await git.setConfig({ fs, dir, path: 'user.email', value: who.email });
    await git.stash({ fs, dir, op: 'push', message: a.m ?? (a._.join(' ') || undefined) });
    ctx.out(`Saved working directory and index state on ${await git.currentBranch({ fs, dir })}\n`);
    return;
  }
  await git.stash({ fs, dir, op, refIdx });
  if (op === 'pop' || op === 'apply') ctx.out('Restored stashed changes.\n');
};

sub.config = async (ctx, args) => {
  const a = parseArgs(args, { boolean: ['global', 'list', 'unset', 'get', 'local'], alias: { l: 'list' } });
  const dir = a.global ? null : await git.findRoot({ fs, filepath: ctx.cwd }).catch(() => null);
  if (a.list) {
    for (const [k, v] of Object.entries(globalConfig())) ctx.out(`${k}=${v}\n`);
    if (dir && !a.global) {
      const text = await fsx.readText(dir + '/.git/config').catch(() => '');
      let section = '';
      for (const line of text.split('\n')) {
        const s = line.match(/^\s*\[([^\s\]]+)(?:\s+"([^"]+)")?\]/);
        if (s) { section = s[2] ? `${s[1]}.${s[2]}` : s[1]; continue; }
        const kv = line.match(/^\s*([\w-]+)\s*=\s*(.*)$/);
        if (kv) ctx.out(`${section}.${kv[1]}=${kv[2]}\n`);
      }
    }
    return;
  }
  const [key, ...rest] = a._;
  if (!key) throw new UsageError();
  const value = rest.length ? rest.join(' ') : undefined;
  if (a.unset) {
    if (a.global || !dir) setGlobalConfig(key, undefined);
    else await git.setConfig({ fs, dir, path: key, value: undefined });
    return;
  }
  if (value === undefined) {
    const v = (dir && !a.global ? await git.getConfig({ fs, dir, path: key }) : undefined) ?? globalConfig()[key];
    if (v === undefined) return 1;
    ctx.out(v + '\n');
    return;
  }
  if (a.global || !dir) setGlobalConfig(key, value);
  else await git.setConfig({ fs, dir, path: key, value });
};

sub['ls-files'] = async (ctx) => {
  const dir = await findRoot(ctx);
  const prefix = fsx.relative(dir, ctx.cwd);
  for (const f of await git.listFiles({ fs, dir })) {
    if (prefix === '.') ctx.out(f + '\n');
    else if (f.startsWith(prefix + '/')) ctx.out(f.slice(prefix.length + 1) + '\n');
  }
};

sub['rev-parse'] = async (ctx, args) => {
  const dir = await findRoot(ctx);
  if (args.includes('--show-toplevel')) { ctx.out(dir + '\n'); return; }
  if (args.includes('--abbrev-ref')) { ctx.out((await git.currentBranch({ fs, dir })) + '\n'); return; }
  const shortFlag = args.includes('--short');
  for (const r of args.filter((x) => !x.startsWith('--'))) {
    const oid = await resolveRevision(dir, r);
    ctx.out((shortFlag ? short(oid) : oid) + '\n');
  }
};

const ALIASES = { ci: 'commit', co: 'checkout', st: 'status', br: 'branch' };

def('git', async (ctx) => {
  let [cmd, ...args] = ctx.args;
  if (!cmd || cmd === '--help' || cmd === '-h') return sub.help(ctx);
  if (cmd === '--version' || cmd === 'version') { ctx.out(`git version ${git.version()} (isomorphic-git, PocketShell)\n`); return; }
  cmd = ALIASES[cmd] ?? cmd;
  const fn = sub[cmd];
  if (!fn) { ctx.err(`git: '${cmd}' is not a git command (or not supported in the browser yet). See 'git help'.\n`); return 1; }
  try {
    return await fn(ctx, args);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    if (e?.name === 'AbortError') throw e;
    ctx.err(`${/^fatal|^error/.test(e.message) ? '' : 'fatal: '}${friendly(e)}\n`);
    return 128;
  }
}, { help: 'Real git: clone, add, commit, push, pull, branch, merge, diff, log, stash… (git help)', usage: 'git <command> [args]', category: CAT });
