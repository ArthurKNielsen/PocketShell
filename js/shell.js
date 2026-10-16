// Shell: parsing, expansion, pipelines, redirection, prompts and completion.
import * as fsx from './fs.js';
import { registry, UsageError, c } from './commands/registry.js';
import { EOF, stripAnsi } from './terminal.js';

const OPS = ['2>&1', '&&', '||', '2>>', '&>', '>>', '2>', '|', ';', '>', '<'];
const ESCAPABLE = ' "\'\\$|&;<>()#*?`';
const DISCARD = new Set(['/dev/null', '$null', 'nul', 'NUL']);

class ScriptExit extends Error {
  constructor(code) { super('exit'); this.code = code; }
}

const HISTORY_KEY = 'ps.history';
const history = (() => {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
})();
function saveHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-1000))); } catch { /* full */ }
}

export function loadAliases() {
  try { return JSON.parse(localStorage.getItem('ps.aliases')) || null; } catch { return null; }
}
export function saveAliases(a) { localStorage.setItem('ps.aliases', JSON.stringify(a)); }
const DEFAULT_ALIASES = { ll: 'ls -la', la: 'ls -a', '..': 'cd ..', g: 'git' };

export class Shell {
  constructor(session, profile, { onExit, onTitle } = {}) {
    this.session = session;
    this.profile = profile; // 'pwsh' | 'cmd' | 'bash'
    this.onExit = onExit;
    this.onTitle = onTitle;
    this.cwd = fsx.HOME;
    this.lastCode = 0;
    this.closed = false;
    this.scriptDepth = 0;
    this.history = history;
    this.aliases = loadAliases() || { ...DEFAULT_ALIASES };
    const user = localStorage.getItem('ps.gh.login') || 'user';
    this.env = {
      HOME: fsx.HOME, USER: user, USERNAME: user, HOSTNAME: 'pocketshell', COMPUTERNAME: 'POCKETSHELL',
      SHELL: { pwsh: 'powershell', cmd: 'cmd', bash: '/bin/bash' }[profile],
      PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
      PWD: this.cwd, OLDPWD: this.cwd, EDITOR: 'edit',
    };
  }

  get isWin() { return this.profile !== 'bash'; }

  // ---------- main loop ----------
  async start() {
    const s = this.session;
    const banners = {
      pwsh: 'PocketShell \x1b[90m— PowerShell profile\x1b[0m',
      cmd: 'PocketShell \x1b[90m— Command Prompt profile\x1b[0m',
      bash: 'PocketShell \x1b[90m— Bash profile\x1b[0m',
    };
    s.writeln(banners[this.profile]);
    s.writeln(`\x1b[90mType \x1b[0mhelp\x1b[90m for commands, \x1b[0mgh auth login\x1b[90m to connect GitHub.\x1b[0m`);
    s.writeln('');
    if (await fsx.exists(fsx.HOME + '/.pocketshellrc')) {
      await this.runScript(fsx.HOME + '/.pocketshellrc', true);
    }
    while (!this.closed) {
      const prompt = await this.prompt();
      const line = await s.readLine(prompt, { history: this.history, complete: (b) => this.complete(b) });
      if (line === null) continue;
      if (line === EOF) { if (this.profile === 'bash') { this.exit(0); break; } continue; }
      saveHistory();
      await this.runLine(line);
    }
  }

  exit(code = 0) {
    if (this.scriptDepth > 0) throw new ScriptExit(code);
    this.closed = true;
    this.onExit?.(code);
  }

  async gitBranch() {
    try {
      const dir = await globalThis.git.findRoot({ fs: fsx.fs, filepath: this.cwd });
      return await globalThis.git.currentBranch({ fs: fsx.fs, dir, fullname: false }) || 'HEAD';
    } catch { return null; }
  }

  async prompt() {
    const branch = await this.gitBranch();
    if (this.profile === 'pwsh') {
      return `PS ${fsx.toWin(this.cwd)}${branch ? ` \x1b[36m[${branch}]\x1b[0m` : ''}> `;
    }
    if (this.profile === 'cmd') return `${fsx.toWin(this.cwd)}>`;
    return `\x1b[1;32m${this.env.USER}@${this.env.HOSTNAME}\x1b[0m:\x1b[1;34m${fsx.tilde(this.cwd)}\x1b[0m` +
      (branch ? ` \x1b[33m(${branch})\x1b[0m` : '') + '$ ';
  }

  displayPath(p) { return this.isWin ? fsx.toWin(p) : fsx.tilde(p); }

  setCwd(p) {
    this.env.OLDPWD = this.cwd;
    this.cwd = p;
    this.env.PWD = p;
    this.onTitle?.();
  }

  // ---------- tokenizing / parsing ----------
  getVar(name) {
    if (name in this.env) return this.env[name];
    const k = Object.keys(this.env).find((x) => x.toLowerCase() === name.toLowerCase());
    return k ? this.env[k] : undefined;
  }

  expandVar(line, i) {
    const rest = line.slice(i);
    let m;
    if (rest.startsWith('$?')) return { value: String(this.lastCode), end: i + 2 };
    if ((m = rest.match(/^\$\{([^}]+)\}/))) return { value: this.getVar(m[1]) ?? '', end: i + m[0].length };
    if ((m = rest.match(/^\$env:([A-Za-z_][A-Za-z0-9_]*)/i))) return { value: this.getVar(m[1]) ?? '', end: i + m[0].length };
    if ((m = rest.match(/^\$null\b/i))) return { value: '$null', end: i + m[0].length };
    if ((m = rest.match(/^\$([A-Za-z_][A-Za-z0-9_]*)/))) return { value: this.getVar(m[1]) ?? '', end: i + m[0].length };
    return null;
  }

  tokenize(line, { dropEmpty = false } = {}) {
    const tokens = [];
    let cur = null;
    let wordStart = 0;
    const start = () => { if (!cur) { cur = { v: '', glob: false, quoted: false, hadVar: false }; wordStart = i; } };
    const end = () => {
      if (cur) {
        // an unquoted variable that expands to nothing disappears, like in bash
        if (!(dropEmpty && cur.v === '' && cur.hadVar && !cur.quoted)) tokens.push({ t: 'word', ...cur, raw: line.slice(wordStart, i) });
        cur = null;
      }
    };
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === ' ' || ch === '\t') { end(); i++; continue; }
      if (ch === '#' && !cur) break;
      let op = null;
      for (const o of OPS) {
        if (line.startsWith(o, i)) {
          if ((o[0] === '2' || o === '&>') && cur) continue;
          op = o; break;
        }
      }
      if (op) { end(); tokens.push({ t: 'op', v: op }); i += op.length; continue; }
      if (ch === "'") {
        start(); cur.quoted = true;
        const j = line.indexOf("'", i + 1);
        if (j < 0) throw new SyntaxError('unexpected end of input: missing closing \'');
        cur.v += line.slice(i + 1, j);
        i = j + 1; continue;
      }
      if (ch === '"') {
        start(); cur.quoted = true; i++;
        let s = '';
        while (i < line.length && line[i] !== '"') {
          if ((line[i] === '\\' || line[i] === '`') && '"\\$`'.includes(line[i + 1] ?? 'x')) { s += line[i + 1]; i += 2; continue; }
          if (line[i] === '$') { const r = this.expandVar(line, i); if (r) { s += r.value; i = r.end; continue; } }
          s += line[i++];
        }
        if (i >= line.length) throw new SyntaxError('unexpected end of input: missing closing "');
        i++; cur.v += s; continue;
      }
      if (ch === '\\' && i + 1 < line.length && ESCAPABLE.includes(line[i + 1]) && this.profile === 'bash') {
        start(); cur.v += line[i + 1]; i += 2; continue;
      }
      if (ch === '$') {
        const r = this.expandVar(line, i);
        if (r) { start(); cur.v += r.value; cur.hadVar = true; i = r.end; continue; }
      }
      if (ch === '%' && this.profile === 'cmd') {
        const m = line.slice(i).match(/^%([A-Za-z_][A-Za-z0-9_]*)%/);
        if (m && this.getVar(m[1]) !== undefined) { start(); cur.v += this.getVar(m[1]); cur.hadVar = true; i += m[0].length; continue; }
      }
      if (ch === '~' && !cur && (i + 1 >= line.length || ' /\\'.includes(line[i + 1]))) {
        start(); cur.v += fsx.HOME; i++; continue;
      }
      start();
      if (ch === '*' || ch === '?') cur.glob = true;
      cur.v += ch; i++;
    }
    end();
    return tokens;
  }

  parse(tokens) {
    const chain = [];
    let pipeline = [];
    let cmd = { words: [], redirs: [] };
    const endCmd = () => {
      if (cmd.words.length || cmd.redirs.length) pipeline.push(cmd);
      cmd = { words: [], redirs: [] };
    };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.t === 'word') { cmd.words.push(t); continue; }
      if (['>', '>>', '2>', '2>>', '&>', '<'].includes(t.v)) {
        const target = tokens[++i];
        if (!target || target.t !== 'word') throw new SyntaxError(`syntax error near unexpected token '${t.v}'`);
        cmd.redirs.push({ op: t.v, target: target.v, raw: target.raw });
        continue;
      }
      if (t.v === '2>&1') { cmd.redirs.push({ op: '2>&1' }); continue; }
      if (t.v === '|') {
        if (!cmd.words.length) throw new SyntaxError("syntax error near unexpected token '|'");
        endCmd(); continue;
      }
      endCmd();
      if (!pipeline.length) throw new SyntaxError(`syntax error near unexpected token '${t.v}'`);
      chain.push({ pipeline, next: t.v });
      pipeline = [];
    }
    endCmd();
    if (pipeline.length) chain.push({ pipeline, next: null });
    return chain;
  }

  async expandGlobs(words) {
    const out = [];
    for (const w of words) {
      if (!w.glob) { out.push(w.v); continue; }
      const p = w.v.replace(/\\/g, '/');
      const slash = p.lastIndexOf('/');
      const dirPart = slash >= 0 ? p.slice(0, slash + 1) : '';
      const pat = p.slice(slash + 1);
      if (/[*?]/.test(dirPart) || !pat) { out.push(w.v); continue; }
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', this.isWin ? 'i' : '');
      let names = [];
      try { names = await fsx.readdir(fsx.resolve(this.cwd, dirPart || '.')); } catch { /* no dir */ }
      const matches = names.filter((n) => re.test(n) && (pat.startsWith('.') || !n.startsWith('.')));
      if (matches.length) out.push(...matches.map((n) => dirPart + n));
      else out.push(w.v);
    }
    return out;
  }

  // ---------- execution ----------
  async runLine(line) {
    // PowerShell-style assignment: $name = value
    const assign = line.match(/^\s*\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/i);
    if (assign) {
      let v = assign[2].trim();
      if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      this.env[assign[1]] = v;
      this.lastCode = 0;
      return 0;
    }
    let chain;
    try {
      chain = this.parse(this.tokenize(line));
    } catch (e) {
      this.session.write(c.red(`${this.profile === 'bash' ? 'bash: ' : ''}${e.message}`) + '\n');
      this.lastCode = 2;
      return 2;
    }
    let code = this.lastCode;
    let prev = null;
    for (const item of chain) {
      if (this.closed) break;
      if (!(prev === '&&' && code !== 0) && !(prev === '||' && code === 0)) {
        code = await this.runPipeline(item.pipeline);
        this.lastCode = code;
      }
      prev = item.next;
    }
    return code;
  }

  async runPipeline(cmds) {
    const s = this.session;
    const ctl = new AbortController();
    s.abortCtl = ctl;
    let stdin = null;
    let code = 0;
    try {
      for (let k = 0; k < cmds.length; k++) {
        const cmd = cmds[k];
        const last = k === cmds.length - 1;
        // expand variables now (not at parse time) so `export X=1 && echo $X` works
        const reexpand = (w) => this.tokenize(w.raw, { dropEmpty: true }).filter((t) => t.t === 'word');
        let args = await this.expandGlobs(cmd.words.flatMap(reexpand));
        for (const r of cmd.redirs) if (r.raw !== undefined) r.target = reexpand({ raw: r.raw })[0]?.v ?? r.target;
        if (args.length && this.aliases[args[0]] !== undefined) {
          const expanded = this.tokenize(this.aliases[args[0]]).filter((t) => t.t === 'word').map((t) => t.v);
          args = [...expanded, ...args.slice(1)];
        }

        let outFile = null, errFile = null, mergeErr = false;
        for (const r of cmd.redirs) {
          if (r.op === '<') stdin = await fsx.readText(fsx.resolve(this.cwd, r.target));
          else if (r.op === '>' || r.op === '>>') outFile = r;
          else if (r.op === '2>' || r.op === '2>>') errFile = r;
          else if (r.op === '&>') { outFile = { op: '>', target: r.target }; mergeErr = true; }
          else if (r.op === '2>&1') mergeErr = true;
        }

        const capture = !last || !!outFile;
        let buf = '', errBuf = '';
        const out = capture ? (t) => { buf += t; } : (t) => s.write(t);
        const errTTY = (t) => s.write(c.red(stripAnsi(t)));
        const err = mergeErr ? out : errFile ? (t) => { errBuf += t; } : errTTY;

        code = await this.exec(args, { stdin, out, err, isTTY: !capture, signal: ctl.signal });

        if (outFile && !DISCARD.has(outFile.target)) await this.writeRedirect(outFile, buf);
        if (errFile && !DISCARD.has(errFile.target)) await this.writeRedirect(errFile, errBuf);
        stdin = stripAnsi(buf);
        if (ctl.signal.aborted) { code = 130; break; }
      }
    } catch (e) {
      if (e instanceof ScriptExit) throw e;
      s.write(c.red(e.message) + '\n');
      code = 1;
    } finally {
      if (s.abortCtl === ctl) s.abortCtl = null;
    }
    return code;
  }

  async writeRedirect(r, text) {
    const p = fsx.resolve(this.cwd, r.target);
    text = stripAnsi(text);
    if (r.op.endsWith('>>') && await fsx.exists(p)) text = (await fsx.readText(p)) + text;
    await fsx.writeFile(p, text);
  }

  makeCtx(name, args, io) {
    const shell = this;
    return {
      name, args,
      stdin: io.stdin,
      out: io.out,
      err: io.err,
      isTTY: io.isTTY,
      signal: io.signal,
      shell,
      session: this.session,
      env: this.env,
      fs: fsx,
      get cwd() { return shell.cwd; },
      resolve: (p) => fsx.resolve(shell.cwd, p),
      run: (line) => shell.runLine(line),
      exec: (argv, extra = {}) => shell.exec(argv, { ...io, ...extra }),
    };
  }

  async exec(args, io) {
    if (!args.length) return 0;
    const [name, ...rest] = args;
    const asg = name.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (asg && !rest.length) { this.env[asg[1]] = asg[2]; return 0; }

    let cmd = registry.get(name.toLowerCase());
    if (!cmd && /[\/\\]|\.(sh|ps1|bat|cmd|py|js|mjs)$/i.test(name)) {
      const p = fsx.resolve(this.cwd, name);
      if (await fsx.exists(p) && !(await fsx.isDir(p))) {
        if (/\.py$/i.test(p)) return this.exec(['python', p, ...rest], io);
        if (/\.m?js$/i.test(p)) return this.exec(['node', p, ...rest], io);
        return this.exec(['source', p, ...rest], io);
      }
    }
    if (!cmd) {
      if (this.profile === 'pwsh') {
        io.err(`${name} : The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program.\n` +
          `Check the spelling of the name, or run 'help' to see what PocketShell supports.\n`);
      } else if (this.profile === 'cmd') {
        io.err(`'${name}' is not recognized as an internal or external command,\noperable program or batch file.\n`);
      } else {
        io.err(`bash: ${name}: command not found\n`);
      }
      return 127;
    }
    const ctx = this.makeCtx(name, rest, io);
    try {
      const r = await cmd.fn(ctx);
      return typeof r === 'number' ? r : 0;
    } catch (e) {
      if (e instanceof ScriptExit) throw e;
      if (e?.name === 'AbortError' || io.signal?.aborted) { this.session.write('^C\n'); return 130; }
      if (e instanceof UsageError) {
        io.err(`${e.message ? e.message + '\n' : ''}usage: ${cmd.usage || cmd.name}\n`);
        return 2;
      }
      io.err(`${name}: ${e?.message ?? e}\n`);
      return 1;
    }
  }

  async runScript(path, quiet = false) {
    const text = await fsx.readText(path);
    this.scriptDepth++;
    let code = 0;
    try {
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('::') || /^rem\b/i.test(line) || /^@?echo off$/i.test(line)) continue;
        code = await this.runLine(line.replace(/^@/, ''));
        if (this.closed) break;
      }
    } catch (e) {
      if (!(e instanceof ScriptExit)) { if (!quiet) throw e; }
      else code = e.code;
    } finally {
      this.scriptDepth--;
    }
    return code;
  }

  // ---------- tab completion ----------
  async complete(before) {
    const start = Math.max(before.lastIndexOf(' '), before.lastIndexOf('|'), before.lastIndexOf(';'), before.lastIndexOf('&')) + 1;
    const word = before.slice(start);
    const preceding = before.slice(0, start).trim();
    const isCmd = preceding === '' || /[|;&]$/.test(preceding);
    const ci = this.isWin;
    const starts = (n, w) => (ci ? n.toLowerCase().startsWith(w.toLowerCase()) : n.startsWith(w));

    if (isCmd && !/[\/\\]/.test(word)) {
      const names = new Set([...registry.keys(), ...Object.keys(this.aliases)]);
      const pretty = new Map();
      for (const cmd of new Set(registry.values())) for (const n of cmd.names) pretty.set(n.toLowerCase(), n);
      const list = [...names].filter((n) => starts(n, word)).map((n) => pretty.get(n) || n).sort();
      return { start, candidates: list };
    }
    const words = preceding.split(/\s+/);
    if (words.length === 1 && SUBCOMMANDS[words[0]]) {
      const list = SUBCOMMANDS[words[0]].filter((n) => n.startsWith(word));
      if (list.length) return { start, candidates: list };
    }
    const w = word.replace(/\\/g, '/');
    const slash = w.lastIndexOf('/');
    const dirPart = slash >= 0 ? w.slice(0, slash + 1) : '';
    const base = w.slice(slash + 1);
    const dir = fsx.resolve(this.cwd, dirPart || '.');
    let names = [];
    try { names = await fsx.readdir(dir); } catch { return null; }
    const cands = [];
    for (const n of names) {
      if (!starts(n, base)) continue;
      if (n.startsWith('.') && !base.startsWith('.')) continue;
      cands.push(dirPart + n + ((await fsx.isDir(fsx.join(dir, n))) ? '/' : ''));
    }
    return { start, candidates: cands };
  }
}

const SUBCOMMANDS = {
  git: ['add', 'branch', 'checkout', 'clone', 'commit', 'config', 'diff', 'fetch', 'init', 'log', 'ls-files', 'merge',
    'pull', 'push', 'remote', 'reset', 'restore', 'rev-parse', 'rm', 'show', 'stash', 'status', 'switch', 'tag'],
  gh: ['alias', 'api', 'auth', 'browse', 'gist', 'issue', 'pr', 'release', 'repo', 'run', 'search', 'workflow'],
};

