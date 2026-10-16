// Networking: HTTP clients, DNS, ping, websockets and the PocketShell bridge (real shells / SSH).
import { def, parseArgs, UsageError, c, humanSize, sleep } from './registry.js';
import { colorJson } from './text.js';
import { stripAnsi } from '../terminal.js';

const CAT = 'Network';
const BRIDGE_KEY = 'ps.bridge';

function proxied(ctx, url) {
  const p = ctx.shell.getVar('CORS_PROXY');
  if (!p) return url;
  return p.includes('{url}') ? p.replace('{url}', encodeURIComponent(url)) : p + url;
}

function fetchError(ctx, e, url) {
  if (e?.name === 'AbortError') throw e;
  return `Failed to reach ${url}\n` +
    c.gray('  Browsers block cross-origin requests unless the server allows CORS. Options:\n') +
    c.gray('  • export CORS_PROXY="https://your-proxy/?url={url}"\n') +
    c.gray('  • run the PocketShell bridge (see: help connect) and use its /proxy\n');
}

const isText = (type) => !type || /text|json|xml|javascript|html|csv|yaml|svg|x-www-form-urlencoded/i.test(type);

def(['curl'], async (ctx) => {
  const a = parseArgs(ctx.args, {
    string: ['X', 'request', 'H', 'header', 'd', 'data', 'data-raw', 'json', 'o', 'output', 'u', 'user', 'A', 'user-agent'],
    boolean: ['include', 'head', 'silent', 'location', 'remote-name', 'verbose', 'fail'],
    alias: { request: 'X', header: 'H', data: 'd', output: 'o', user: 'u', i: 'include', I: 'head', s: 'silent', L: 'location', O: 'remote-name', v: 'verbose', f: 'fail', 'user-agent': 'A' },
  });
  let url = a._[0];
  if (!url) throw new UsageError('curl: try \'curl https://api.github.com\'');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const headers = new Headers();
  for (const h of a.HAll ?? []) { const i = h.indexOf(':'); if (i > 0) headers.set(h.slice(0, i).trim(), h.slice(i + 1).trim()); }
  if (a.u) headers.set('Authorization', 'Basic ' + btoa(a.u));
  let body = a.json ?? a['data-raw'] ?? (a.dAll ? a.dAll.join('&') : undefined);
  if (body?.startsWith('@')) body = await ctx.fs.readText(ctx.resolve(body.slice(1)));
  if (a.json) { headers.set('Content-Type', 'application/json'); headers.set('Accept', 'application/json'); }
  else if (body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/x-www-form-urlencoded');
  const method = a.X ?? (a.head ? 'HEAD' : body !== undefined ? 'POST' : 'GET');
  if (a.v) ctx.err(`> ${method} ${url}\n${[...headers].map(([k, v]) => `> ${k}: ${v}`).join('\n')}${headers.keys().next().done ? '' : '\n'}`);
  let res;
  try {
    res = await fetch(proxied(ctx, url), { method, headers, body, signal: ctx.signal });
  } catch (e) {
    ctx.err(`curl: (7) ${fetchError(ctx, e, url)}`);
    return 7;
  }
  if (a.include || a.head || a.v) {
    const head = `HTTP/1.1 ${res.status} ${res.statusText}\n` + [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n';
    a.v ? ctx.err(head.replace(/^/gm, '< ')) : ctx.out(head);
  }
  if (a.fail && !res.ok) { ctx.err(`curl: (22) The requested URL returned error: ${res.status}\n`); return 22; }
  if (method === 'HEAD') return;
  const outFile = a.o ?? (a['remote-name'] ? decodeURIComponent(new URL(url).pathname.split('/').pop() || 'index.html') : null);
  if (outFile) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    await ctx.fs.writeFile(ctx.resolve(outFile), bytes);
    if (!a.silent) ctx.err(`  saved ${humanSize(bytes.length)} to ${outFile}\n`);
    return;
  }
  const type = res.headers.get('content-type');
  if (!isText(type)) {
    ctx.err(`curl: binary output (${type}) — use -o <file> to save it\n`);
    return;
  }
  const text = await res.text();
  ctx.out(text + (text.endsWith('\n') || !ctx.isTTY ? '' : '\n'));
  return res.ok ? 0 : 22;
}, { help: 'HTTP requests: -X -H -d --json -o -O -i -I -u. Cross-origin limits apply (CORS).', usage: 'curl [options] <url>', category: CAT });

def(['wget'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['O', 'output-document'], boolean: ['quiet'], alias: { 'output-document': 'O', q: 'quiet' } });
  let url = a._[0];
  if (!url) throw new UsageError();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const name = a.O ?? (decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'index.html');
  if (!a.quiet) ctx.out(`--${new Date().toISOString().replace('T', ' ').slice(0, 19)}--  ${url}\n`);
  let res;
  try { res = await fetch(proxied(ctx, url), { signal: ctx.signal }); }
  catch (e) { ctx.err(`wget: ${fetchError(ctx, e, url)}`); return 4; }
  if (!res.ok) { ctx.err(`ERROR ${res.status}: ${res.statusText}.\n`); return 8; }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await ctx.fs.writeFile(ctx.resolve(name), bytes);
  if (!a.quiet) ctx.out(`Saving to: '${name}'\n\n'${name}' saved [${bytes.length}]\n`);
}, { help: 'Download a URL into a file.', usage: 'wget [-O file] <url>', category: CAT });

def(['Invoke-WebRequest', 'iwr', 'Invoke-RestMethod', 'irm'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['uri', 'method', 'body', 'contenttype', 'outfile', 'headers', 'usebasicparsing'], alias: {} });
  let url = a.uri ?? a._[0];
  if (!url) throw new UsageError();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const rest = /restmethod|irm/i.test(ctx.name);
  const headers = {};
  if (a.contenttype) headers['Content-Type'] = a.contenttype;
  if (a.headers) {
    for (const m of a.headers.matchAll(/["']?([\w-]+)["']?\s*=\s*["']([^"']*)["']/g)) headers[m[1]] = m[2];
  }
  let res;
  try { res = await fetch(proxied(ctx, url), { method: (a.method ?? (a.body ? 'POST' : 'GET')).toUpperCase(), headers, body: a.body, signal: ctx.signal }); }
  catch (e) { ctx.err(`${ctx.name}: ${fetchError(ctx, e, url)}`); return 1; }
  if (a.outfile) { await ctx.fs.writeFile(ctx.resolve(a.outfile), new Uint8Array(await res.arrayBuffer())); return; }
  const text = await res.text();
  if (rest) {
    try { ctx.out(colorJson(JSON.parse(text), ctx.isTTY) + '\n'); } catch { ctx.out(text + '\n'); }
    return res.ok ? 0 : 1;
  }
  const hdrs = [...res.headers].map(([k, v]) => `[${k}, ${v}]`).join(', ');
  ctx.out(`\nStatusCode        : ${res.status}\nStatusDescription : ${res.statusText}\nContent           : ${stripAnsi(text.slice(0, 400)).replace(/\n/g, '\n                    ')}${text.length > 400 ? '...' : ''}\nHeaders           : {${hdrs.slice(0, 300)}}\nRawContentLength  : ${text.length}\n\n`);
  return res.ok ? 0 : 1;
}, { help: 'PowerShell HTTP requests (-Uri -Method -Body -Headers -OutFile). irm parses JSON.', usage: 'irm <url> [-Method POST] [-Body text]', category: CAT });

def(['ping', 'Test-Connection'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['c', 'n', 'count'], alias: { count: 'c' } });
  const host = a._[0]?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!host) throw new UsageError();
  const n = parseInt(a.c ?? a.n ?? 4, 10);
  const win = ctx.shell.isWin;
  ctx.out(win ? `\nPinging ${host} over HTTPS:\n` : `PING ${host} (https): HTTP round-trip time\n`);
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try {
      await Promise.race([
        fetch(`https://${host}/favicon.ico?_=${Math.random()}`, { mode: 'no-cors', cache: 'no-store', signal: ctx.signal }),
        sleep(5000).then(() => { throw new Error('timeout'); }),
      ]);
      const ms = Math.round(performance.now() - t0);
      times.push(ms);
      ctx.out(win ? `Reply from ${host}: time=${ms}ms\n` : `reply from ${host}: seq=${i} time=${ms} ms\n`);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      ctx.out(win ? 'Request timed out.\n' : `no reply from ${host}: seq=${i}\n`);
    }
    if (i < n - 1) await sleep(700, ctx.signal);
  }
  const loss = Math.round(((n - times.length) / n) * 100);
  if (times.length) {
    const min = Math.min(...times), max = Math.max(...times), avg = Math.round(times.reduce((x, y) => x + y, 0) / times.length);
    ctx.out(win ? `\nPing statistics for ${host}:\n    Sent = ${n}, Received = ${times.length}, Lost = ${n - times.length} (${loss}% loss)\nApproximate round trip times:\n    Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg}ms\n`
      : `\n--- ${host} ping statistics ---\n${n} sent, ${times.length} received, ${loss}% loss\nrtt min/avg/max = ${min}/${avg}/${max} ms\n`);
  }
  return times.length ? 0 : 1;
}, { help: 'Check if a host is reachable (HTTPS round-trip; browsers cannot send ICMP).', usage: 'ping [-c n] <host>', category: CAT });

const DNS_TYPES = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 65: 'HTTPS', 257: 'CAA' };
def(['nslookup', 'dig', 'host', 'Resolve-DnsName'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['type', 't'], alias: { t: 'type' } });
  const name = a._.find((x) => !/^[A-Z]+$/.test(x) && !x.startsWith('@'));
  const type = (a.type ?? a._.find((x) => /^[A-Z]+$/.test(x)) ?? 'A').toUpperCase();
  if (!name) throw new UsageError();
  let res;
  try {
    res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: ctx.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    ctx.err(`${ctx.name}: could not reach the DNS-over-HTTPS resolver (cloudflare-dns.com)\n`);
    return 1;
  }
  const d = await res.json();
  ctx.out(`Server:  cloudflare-dns.com (DNS over HTTPS)\n\n`);
  if (!d.Answer?.length) { ctx.out(`** No ${type} records for ${name} (status ${d.Status})\n`); return 1; }
  for (const r of d.Answer) ctx.out(`${r.name.padEnd(30)} ${String(r.TTL).padStart(6)}  ${(DNS_TYPES[r.type] ?? r.type).padEnd(6)} ${r.data}\n`);
}, { help: 'DNS lookup via DNS-over-HTTPS (A, AAAA, MX, TXT, CNAME, NS…).', usage: 'nslookup <name> [TYPE]', category: CAT });

def(['myip', 'ipconfig', 'ifconfig', 'ip'], async (ctx) => {
  let ip = '?';
  try { ip = (await (await fetch('https://api.ipify.org?format=json', { signal: ctx.signal })).json()).ip; } catch (e) { if (e.name === 'AbortError') throw e; }
  const conn = navigator.connection;
  ctx.out(`Public IP address . . . : ${ip}\nOnline . . . . . . . . : ${navigator.onLine ? 'yes' : 'no'}\n`);
  if (conn) ctx.out(`Connection type . . . . : ${conn.effectiveType ?? '?'}${conn.downlink ? ` (~${conn.downlink} Mbps)` : ''}\n`);
  ctx.out(c.gray('(Browsers cannot see local network interfaces.)\n'));
}, { help: 'Show your public IP and connection info.', category: CAT });

// ---------- raw websocket client ----------
def(['ws', 'websocat', 'wscat'], async (ctx) => {
  const url = ctx.args.find((x) => !x.startsWith('-'));
  if (!url) throw new UsageError();
  const s = ctx.session;
  const ws = new WebSocket(url);
  let closed = false;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`could not connect to ${url}`));
  });
  ctx.out(c.green(`Connected to ${url}`) + c.gray('  (type messages and press Enter; Ctrl+C or Ctrl+D to quit)\n'));
  ws.onmessage = async (e) => {
    const text = typeof e.data === 'string' ? e.data : `<binary ${e.data.size ?? e.data.byteLength} bytes>`;
    s.printAbove(c.cyan('< ') + text);
  };
  ws.onclose = (e) => { closed = true; s.printAbove(c.gray(`connection closed (${e.code}${e.reason ? ' ' + e.reason : ''})`)); };
  while (!closed) {
    const line = await s.readLine(c.gray('> '));
    if (typeof line !== 'string' || closed) break;
    ws.send(line);
  }
  ws.close();
}, { help: 'Interactive WebSocket client: send lines, see messages.', usage: 'ws <wss://url>', category: CAT });

// ---------- PocketShell bridge: real shells and SSH ----------
function bridgeConfig() {
  try { return JSON.parse(localStorage.getItem(BRIDGE_KEY)) || {}; } catch { return {}; }
}

async function attach(ctx, { url, token, cmd, args = [] }) {
  const s = ctx.session;
  const term = s.term;
  const u = new URL(url);
  if (token) u.searchParams.set('token', token);
  u.searchParams.set('cols', term.cols);
  u.searchParams.set('rows', term.rows);
  if (cmd) { u.searchParams.set('cmd', cmd); u.searchParams.set('args', JSON.stringify(args)); }
  const ws = new WebSocket(u.toString());
  ws.binaryType = 'arraybuffer';
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('could not connect'));
      ws.onclose = (e) => reject(new Error(e.reason || `connection refused (${e.code})`));
      ctx.signal.addEventListener('abort', () => { ws.close(); reject(new DOMException('Aborted', 'AbortError')); });
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    ctx.err(`connect: ${e.message} — ${u.origin}${u.pathname}\n`);
    ctx.err(c.gray('Is the bridge running? On your computer: cd bridge && npm install && npm start\n'));
    return 1;
  }
  s.ensureNewline();
  s.write(c.gray(`Connected to ${u.host}. Press Ctrl+] to disconnect.\r\n`));
  term.options.convertEol = false;
  const decoder = new TextDecoder();
  const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  const resizeSub = term.onResize(({ cols, rows }) => send({ t: 'r', c: cols, r: rows }));
  return new Promise((resolve) => {
    s.rawHandler = (d) => {
      if (d === '\x1d') { ws.close(); return; }
      send({ t: 'i', d });
    };
    ws.onmessage = (e) => term.write(typeof e.data === 'string' ? e.data : decoder.decode(e.data, { stream: true }));
    ws.onclose = (e) => {
      s.rawHandler = null;
      resizeSub.dispose();
      term.options.convertEol = true;
      s.atLineStart = false;
      s.ensureNewline();
      s.write(c.gray(`Connection to ${u.host} closed${e.reason ? ': ' + e.reason : ''}.\n`));
      resolve(/exit (\d+)/.test(e.reason) ? parseInt(e.reason.match(/exit (\d+)/)[1], 10) : 0);
    };
  });
}

def(['connect', 'bridge'], async (ctx) => {
  const a = parseArgs(ctx.args, { string: ['token', 't'], boolean: ['forget'], alias: { t: 'token' } });
  if (a.forget) { localStorage.removeItem(BRIDGE_KEY); ctx.out('Forgot saved bridge.\n'); return; }
  const saved = bridgeConfig();
  let url = a._[0] ?? saved.url;
  if (!url) {
    ctx.out(`${c.bold('connect')} attaches this tab to a REAL shell (PowerShell, cmd, bash, zsh…) running on a computer you control.

  1. On that computer, grab this repo and run the bridge:
       ${c.cyan('cd bridge && npm install && npm start')}
  2. It prints a URL and a token, e.g.
       ${c.cyan('ws://localhost:8765')}   token: ${c.cyan('3f9c…')}
  3. Here, run:
       ${c.cyan('connect ws://localhost:8765 --token 3f9c…')}

  Then everything works: npm, python, docker, real git, ssh — it is your machine.
  Phone + home PC? Expose the bridge with a tunnel (e.g. cloudflared, ngrok, tailscale) and use its wss:// URL.
  The URL and token are remembered; later just type ${c.cyan('connect')}. ${c.gray('(connect --forget to clear)')}
`);
    return;
  }
  if (!/^wss?:\/\//.test(url)) url = (/^(localhost|127\.)/.test(url) ? 'ws://' : 'wss://') + url;
  const token = a.token ?? (url === saved.url ? saved.token : undefined) ?? (await ctx.session.question('Bridge token: ', true));
  localStorage.setItem(BRIDGE_KEY, JSON.stringify({ url, token }));
  return attach(ctx, { url, token });
}, { help: 'Attach to a real shell on your computer via the PocketShell bridge (connect with no args for setup).', usage: 'connect [ws://host:port] [--token T]', category: CAT });

def(['ssh'], async (ctx) => {
  if (!ctx.args.length) throw new UsageError('ssh [-p port] user@host [command]');
  const saved = bridgeConfig();
  if (!saved.url) {
    ctx.err('ssh: browsers cannot open raw TCP connections, so SSH goes through the PocketShell bridge.\n');
    ctx.err(c.gray("Set it up once with 'connect' (run it with no arguments for instructions), then ssh works.\n"));
    return 255;
  }
  return attach(ctx, { url: saved.url, token: saved.token, cmd: 'ssh', args: ctx.args });
}, { help: 'SSH into a server (via the PocketShell bridge).', usage: 'ssh [-p port] user@host', category: CAT });
