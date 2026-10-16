// Core shell builtins.
import { def, categories, registry, parseArgs, UsageError, c, table, sleep } from './registry.js';
import { saveAliases } from '../shell.js';
import { themes } from '../themes.js';
import { settings, saveSettings } from '../settings.js';

const CAT = 'Shell';
const BOOT = Date.now();

def('help', async (ctx) => {
  const [topic] = ctx.args;
  if (topic) {
    const cmd = registry.get(topic.toLowerCase());
    if (!cmd) { ctx.err(`help: no help topics match '${topic}'\n`); return 1; }
    ctx.out(`${c.bold(cmd.names.join(', '))}\n  ${cmd.help}\n${cmd.usage ? `\n  usage: ${cmd.usage}\n` : ''}`);
    return 0;
  }
  ctx.out(c.bold('PocketShell') + ' — a terminal in your browser with real git + GitHub.\n');
  ctx.out(c.gray("Run 'help <command>' for details. Windows and Unix names both work (dir/ls, type/cat, cls/clear…).\n\n"));
  for (const [cat, cmds] of categories) {
    ctx.out(c.yellow(cat) + '\n');
    const rows = cmds.map((cmd) => [
      '  ' + c.cyan(cmd.names.slice(0, 3).join(', ')),
      cmd.help.length > 70 ? cmd.help.slice(0, 67) + '…' : cmd.help,
    ]);
    ctx.out(table(rows));
    ctx.out('\n');
  }
}, { help: 'Show available commands, or help for one command.', usage: 'help [command]', category: CAT });

def(['clear', 'cls', 'Clear-Host'], (ctx) => {
  ctx.session.write('\x1b[2J\x1b[3J\x1b[H');
}, { help: 'Clear the screen.', category: CAT });

def(['echo', 'Write-Output', 'Write-Host', 'print'], (ctx) => {
  let args = ctx.args;
  let newline = true;
  if (args[0] === '-n') { newline = false; args = args.slice(1); }
  if (args[0] === '-e') args = args.slice(1).map((a) => a.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
  if (ctx.name.toLowerCase() === 'echo' && ctx.shell.profile === 'cmd' && !args.length) { ctx.out('ECHO is on.\n'); return; }
  ctx.out(args.join(' ') + (newline ? '\n' : ''));
}, { help: 'Print text.', usage: 'echo [-n] [-e] text...', category: CAT });

def('printf', (ctx) => {
  const [fmt = '', ...rest] = ctx.args;
  let i = 0;
  const unesc = (x) => x.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
  let out = unesc(fmt).replace(/%(-?\d*)(?:\.(\d+))?([sdfx%])/g, (m, w, prec, t) => {
    if (t === '%') return '%';
    const v = rest[i++] ?? '';
    let s = t === 'd' ? String(parseInt(v, 10) || 0) : t === 'f' ? (parseFloat(v) || 0).toFixed(prec ? +prec : 6) : t === 'x' ? (parseInt(v, 10) || 0).toString(16) : v;
    const width = Math.abs(parseInt(w, 10) || 0);
    return w.startsWith('-') ? s.padEnd(width) : s.padStart(width);
  });
  ctx.out(out);
}, { help: 'Formatted output (%s %d %f %x, \\n).', usage: 'printf "format" args...', category: CAT });

def(['env', 'printenv'], (ctx) => {
  if (ctx.args[0]) { const v = ctx.shell.getVar(ctx.args[0]); if (v === undefined) return 1; ctx.out(v + '\n'); return; }
  ctx.out(Object.entries(ctx.env).sort().map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}, { help: 'Print environment variables.', usage: 'env [NAME]', category: CAT });

def(['export', 'set', 'setx'], (ctx) => {
  if (!ctx.args.length) {
    ctx.out(Object.entries(ctx.env).sort().map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    return;
  }
  const joined = ctx.name.toLowerCase() === 'setx' ? [`${ctx.args[0]}=${ctx.args.slice(1).join(' ')}`] : ctx.args;
  for (const a of joined) {
    const m = a.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (m) ctx.env[m[1]] = m[2];
    else if (ctx.name.toLowerCase() === 'set') {
      const hits = Object.entries(ctx.env).filter(([k]) => k.toLowerCase().startsWith(a.toLowerCase()));
      if (!hits.length) { ctx.err(`Environment variable ${a} not defined\n`); return 1; }
      ctx.out(hits.map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    }
  }
}, { help: 'Set environment variables (NAME=value).', usage: 'export NAME=value ...', category: CAT });

def(['unset', 'Remove-Variable'], (ctx) => {
  for (const a of ctx.args) delete ctx.env[a];
}, { help: 'Remove environment variables.', usage: 'unset NAME...', category: CAT });

def(['alias', 'Set-Alias'], (ctx) => {
  const a = ctx.shell.aliases;
  if (!ctx.args.length) {
    ctx.out(Object.entries(a).map(([k, v]) => `alias ${k}='${v}'`).join('\n') + '\n');
    return;
  }
  let arg = ctx.args.join(' ');
  if (ctx.name.toLowerCase() === 'set-alias' && ctx.args.length >= 2) arg = `${ctx.args[0]}=${ctx.args.slice(1).join(' ')}`;
  const m = arg.match(/^([^=\s]+)=(.*)$/s);
  if (!m) {
    if (a[arg] === undefined) { ctx.err(`alias: ${arg}: not found\n`); return 1; }
    ctx.out(`alias ${arg}='${a[arg]}'\n`);
    return;
  }
  a[m[1]] = m[2];
  saveAliases(a);
}, { help: 'Create or list aliases (saved across sessions).', usage: "alias name='command args'", category: CAT });

def('unalias', (ctx) => {
  for (const n of ctx.args) delete ctx.shell.aliases[n];
  saveAliases(ctx.shell.aliases);
}, { help: 'Remove an alias.', usage: 'unalias name', category: CAT });

def(['history', 'Get-History', 'doskey'], (ctx) => {
  const h = ctx.shell.history;
  if (ctx.args[0] === '-c' || ctx.args[0] === '--clear') { h.length = 0; localStorage.removeItem('ps.history'); return; }
  const n = parseInt(ctx.args[0], 10) || h.length;
  ctx.out(h.slice(-n).map((l, i) => `${String(h.length - Math.min(n, h.length) + i + 1).padStart(5)}  ${l}`).join('\n') + '\n');
}, { help: 'Show command history (history -c to clear).', usage: 'history [n] [-c]', category: CAT });

def('whoami', (ctx) => {
  const gh = localStorage.getItem('ps.gh.login');
  ctx.out((ctx.shell.isWin ? `pocketshell\\${ctx.env.USER}` : ctx.env.USER) + '\n');
  if (gh && ctx.isTTY) ctx.out(c.gray(`(GitHub: ${gh})`) + '\n');
}, { help: 'Print the current user.', category: CAT });

def('hostname', (ctx) => ctx.out(ctx.env.HOSTNAME + '\n'), { help: 'Print the host name.', category: CAT });

def(['uname', 'ver'], (ctx) => {
  if (ctx.name.toLowerCase() === 'ver') { ctx.out('\nPocketShell [Version 1.0.0]\n'); return; }
  if (ctx.args.includes('-a')) ctx.out(`PocketShell pocketshell 1.0.0 ${navigator.platform || 'web'} browser\n`);
  else ctx.out('PocketShell\n');
}, { help: 'Print system information.', category: CAT });

def(['date', 'Get-Date'], (ctx) => {
  const d = new Date();
  ctx.out((ctx.args.includes('-u') ? d.toUTCString() : ctx.args.includes('--iso') || ctx.args.includes('-I') ? d.toISOString() : d.toString()) + '\n');
}, { help: 'Print the date and time.', usage: 'date [-u] [--iso]', category: CAT });

def('uptime', (ctx) => {
  const s = Math.floor((Date.now() - BOOT) / 1000);
  ctx.out(`up ${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m ${s % 60}s\n`);
}, { help: 'How long this page has been open.', category: CAT });

def(['sleep', 'Start-Sleep', 'timeout'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['seconds', 'milliseconds', 't'], alias: { s: 'seconds', m: 'milliseconds', t: 'seconds' } });
  const sec = parseFloat(a.seconds ?? a._[0] ?? 1);
  const ms = a.milliseconds ? parseFloat(a.milliseconds) : sec * 1000;
  await sleep(ms, ctx.signal);
}, { help: 'Wait for a number of seconds.', usage: 'sleep <seconds>', category: CAT });

def('exit', (ctx) => ctx.shell.exit(parseInt(ctx.args[0], 10) || 0), { help: 'Close this tab.', category: CAT });

def('title', (ctx) => {
  ctx.shell.customTitle = ctx.args.join(' ') || null;
  ctx.shell.onTitle?.();
}, { help: 'Set the tab title.', usage: 'title <text>', category: CAT });

def('theme', (ctx) => {
  const name = ctx.args.join(' ');
  if (!name) {
    for (const t of Object.keys(themes)) ctx.out(`${t === settings.theme ? c.green('*') : ' '} ${t}\n`);
    ctx.out(c.gray("Use: theme <name>\n"));
    return;
  }
  const match = Object.keys(themes).find((t) => t.toLowerCase() === name.toLowerCase());
  if (!match) { ctx.err(`theme: unknown theme '${name}'\n`); return 1; }
  saveSettings({ theme: match });
}, { help: 'List or switch color schemes.', usage: 'theme [name]', category: CAT });

def('font', (ctx) => {
  const n = parseInt(ctx.args[0], 10);
  if (!n) { ctx.out(`font size: ${settings.fontSize}\n`); return; }
  saveSettings({ fontSize: Math.min(40, Math.max(8, n)) });
}, { help: 'Show or set the font size.', usage: 'font [size]', category: CAT });

def(['which', 'where', 'Get-Command', 'gcm', 'command'], (ctx) => {
  let code = 0;
  for (const n of ctx.args.filter((a) => !a.startsWith('-'))) {
    if (ctx.shell.aliases[n] !== undefined) ctx.out(`${n}: aliased to ${ctx.shell.aliases[n]}\n`);
    else if (registry.has(n.toLowerCase())) ctx.out(`${n}: shell builtin\n`);
    else { ctx.err(`${n} not found\n`); code = 1; }
  }
  return code;
}, { help: 'Find out what a command is.', usage: 'which <name>', category: CAT });

def('true', () => 0, { help: 'Do nothing, successfully.', category: CAT });
def('false', () => 1, { help: 'Do nothing, unsuccessfully.', category: CAT });

def(['source', '.', 'sh', 'bash', 'pwsh', 'powershell', 'cmd'], async (ctx) => {
  const file = ctx.args.find((a) => !a.startsWith('-'));
  const cIdx = ctx.args.findIndex((a) => ['-c', '-command', '/c', '/k'].includes(a.toLowerCase()));
  if (cIdx >= 0) return ctx.run(ctx.args.slice(cIdx + 1).join(' '));
  if (!file) { ctx.out(c.gray('Already in a shell. Open a new profile from the ⌄ menu, or pass a script file.\n')); return 0; }
  return ctx.shell.runScript(ctx.resolve(file));
}, { help: 'Run a script file (.sh, .ps1, .bat) in this shell, or -c "command".', usage: 'source <file> | sh -c "cmd"', category: CAT });

def(['calc', 'expr', 'bc'], (ctx) => {
  let expr = ctx.args.join(' ') || (ctx.stdin ?? '');
  expr = expr.trim();
  if (!expr) throw new UsageError();
  if (!/^[\d\s+\-*/%().,^a-z_]*$/i.test(expr)) throw new Error('invalid characters in expression');
  const allowed = new Set(['abs', 'ceil', 'floor', 'round', 'sqrt', 'cbrt', 'pow', 'min', 'max', 'log', 'log2', 'log10', 'exp', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'PI', 'E', 'random', 'sign', 'trunc', 'hypot']);
  for (const id of expr.match(/[a-z_]+/gi) || []) if (!allowed.has(id)) throw new Error(`unknown name '${id}'`);
  const js = expr.replace(/\^/g, '**').replace(/[a-z_]+/gi, (m) => `Math.${m}`);
  // eslint-disable-next-line no-new-func
  const v = Function(`"use strict"; return (${js});`)();
  ctx.out(String(v) + '\n');
}, { help: 'Evaluate a math expression, e.g. calc "2^10 + sqrt(9)".', usage: 'calc <expression>', category: CAT });

def(['open', 'start', 'Start-Process', 'xdg-open', 'explorer'], async (ctx) => {
  const target = ctx.args.find((a) => !a.startsWith('-'));
  if (!target) throw new UsageError();
  if (/^https?:\/\//i.test(target) || /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(target)) {
    window.open(/^https?:/i.test(target) ? target : 'https://' + target, '_blank', 'noopener');
    return;
  }
  const p = ctx.resolve(target);
  if (await ctx.fs.isDir(p)) { ctx.shell.setCwd(p); return; }
  return ctx.exec(['edit', target]);
}, { help: 'Open a URL in a new browser tab (or a file in the editor).', usage: 'open <url|file>', category: CAT });

def('seq', (ctx) => {
  const n = ctx.args.map(Number);
  let [a, step, b] = n.length === 1 ? [1, 1, n[0]] : n.length === 2 ? [n[0], 1, n[1]] : n;
  if ([a, step, b].some(Number.isNaN) || step === 0) throw new UsageError();
  const out = [];
  for (let i = a; step > 0 ? i <= b : i >= b; i += step) { out.push(i); if (out.length > 100000) break; }
  ctx.out(out.join('\n') + '\n');
}, { help: 'Print a sequence of numbers.', usage: 'seq [first [step]] last', category: CAT });

def(['uuid', 'uuidgen', 'New-Guid'], (ctx) => ctx.out(crypto.randomUUID() + '\n'), { help: 'Generate a random UUID.', category: CAT });

def(['reload', 'reboot'], () => { location.reload(); }, { help: 'Reload PocketShell.', category: CAT });

def(['neofetch', 'fastfetch', 'about', 'systeminfo'], async (ctx) => {
  const gh = localStorage.getItem('ps.gh.login');
  let used = '?';
  try { const e = await navigator.storage.estimate(); used = `${(e.usage / 1048576).toFixed(1)} MiB / ${(e.quota / 1073741824).toFixed(1)} GiB`; } catch { /* unsupported */ }
  const logo = [
    '\x1b[34m  ____            _        _   \x1b[0m',
    '\x1b[34m |  _ \\ ___   ___| | _____| |_ \x1b[0m',
    '\x1b[34m | |_) / _ \\ / __| |/ / _ \\ __|\x1b[0m',
    '\x1b[34m |  __/ (_) | (__|   <  __/ |_ \x1b[0m',
    '\x1b[34m |_|   \\___/ \\___|_|\\_\\___|\\__|\x1b[0m',
    '\x1b[36m      ____  _          _ _     \x1b[0m',
    '\x1b[36m     / ___|| |__   ___| | |    \x1b[0m',
    '\x1b[36m     \\___ \\| \'_ \\ / _ \\ | |    \x1b[0m',
    '\x1b[36m      ___) | | | |  __/ | |    \x1b[0m',
    '\x1b[36m     |____/|_| |_|\\___|_|_|    \x1b[0m',
  ];
  const info = [
    `${c.bgreen(ctx.env.USER)}@${c.bgreen(ctx.env.HOSTNAME)}`,
    '-----------------',
    `${c.yellow('OS')}: PocketShell 1.0 (browser)`,
    `${c.yellow('Host')}: ${navigator.userAgent.match(/(Firefox|Edg|Chrome|Safari)\/[\d.]+/)?.[0] ?? 'browser'}`,
    `${c.yellow('Shell')}: ${{ pwsh: 'PowerShell profile', cmd: 'Command Prompt profile', bash: 'Bash profile' }[ctx.shell.profile]}`,
    `${c.yellow('Terminal')}: xterm.js ${ctx.session.term.cols}x${ctx.session.term.rows}`,
    `${c.yellow('Theme')}: ${settings.theme}`,
    `${c.yellow('CPU')}: ${navigator.hardwareConcurrency ?? '?'} threads`,
    `${c.yellow('Storage')}: ${used}`,
    `${c.yellow('GitHub')}: ${gh ?? 'not logged in'}`,
  ];
  for (let i = 0; i < Math.max(logo.length, info.length); i++) ctx.out(`${logo[i] ?? ' '.repeat(31)}  ${info[i] ?? ''}\n`);
}, { help: 'Show system info with style.', category: CAT });
