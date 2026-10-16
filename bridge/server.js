#!/usr/bin/env node
// PocketShell bridge: gives the browser terminal a REAL shell on this computer.
//
//   npm install && npm start
//
// Endpoints (all require the token):
//   ws://HOST:PORT/?token=T            interactive shell (or ssh with &cmd=ssh&args=[...])
//   http://HOST:PORT/git/T/<url>       CORS proxy for git (paste http://HOST:PORT/git/T into PocketShell settings)
//   http://HOST:PORT/proxy?token=T&url=<url>   generic CORS proxy (export CORS_PROXY="http://HOST:PORT/proxy?token=T&url={url}")
//
// Environment: PORT (8765), HOST (127.0.0.1), BRIDGE_TOKEN (random by default), BRIDGE_SHELL (your shell).

import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { WebSocketServer } from 'ws';

const PORT = parseInt(process.env.PORT || '8765', 10);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.BRIDGE_TOKEN || crypto.randomBytes(16).toString('hex');
const SHELL = process.env.BRIDGE_SHELL || (os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash');
const ALLOWED_COMMANDS = new Set(['ssh']);

let pty = null;
try { pty = (await import('node-pty')).default; } catch { /* optional */ }

const tokenOk = (t) => {
  if (typeof t !== 'string') return false;
  const a = Buffer.from(t), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

const HOP = new Set(['host', 'connection', 'origin', 'referer', 'cookie', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authorization', 'te', 'trailer', 'accept-encoding']);

async function forward(req, res, target) {
  let url;
  try { url = new URL(target); } catch { res.writeHead(400); res.end('bad url'); return; }
  if (!/^https?:$/.test(url.protocol)) { res.writeHead(400); res.end('only http(s) urls'); return; }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('sec-') && !k.startsWith('access-control-')) headers[k] = v;
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  try {
    const up = await fetch(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'follow' });
    const out = {};
    up.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v; });
    res.writeHead(up.status, out);
    if (up.body) Readable.fromWeb(up.body).pipe(res);
    else res.end();
  } catch (e) {
    res.writeHead(502);
    res.end('proxy error: ' + e.message);
  }
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const u = new URL(req.url, `http://${req.headers.host}`);

  // /git/<token>/<host>/<path...>  — isomorphic-git CORS proxy format
  const g = u.pathname.match(/^\/git\/([^/]+)\/(.+)$/);
  if (g) {
    if (!tokenOk(g[1])) { res.writeHead(401); res.end('bad token'); return; }
    const rest = g[2] + u.search;
    if (!/\/(info\/refs|git-upload-pack|git-receive-pack)/.test(rest)) { res.writeHead(403); res.end('only git smart-http paths'); return; }
    return forward(req, res, 'https://' + rest);
  }
  if (u.pathname === '/proxy') {
    if (!tokenOk(u.searchParams.get('token') ?? req.headers['x-bridge-token'])) { res.writeHead(401); res.end('bad token'); return; }
    return forward(req, res, u.searchParams.get('url'));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('PocketShell bridge is running. Connect from PocketShell with: connect ws://' + req.headers.host + ' --token <token>\n');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (!tokenOk(u.searchParams.get('token'))) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => session(ws, u.searchParams));
});

function session(ws, params) {
  const cols = parseInt(params.get('cols') || '80', 10);
  const rows = parseInt(params.get('rows') || '24', 10);
  let file = SHELL, args = [];
  const cmd = params.get('cmd');
  if (cmd) {
    if (!ALLOWED_COMMANDS.has(cmd)) { ws.close(1008, 'command not allowed'); return; }
    file = cmd;
    try { args = JSON.parse(params.get('args') || '[]').map(String); } catch { args = []; }
  }
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  const cwd = os.homedir();
  console.log(`[bridge] session: ${file} ${args.join(' ')}`);

  let write, resize, kill;
  if (pty) {
    const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
    p.onData((d) => ws.readyState === 1 && ws.send(d));
    p.onExit(({ exitCode }) => ws.close(1000, `exit ${exitCode}`));
    write = (d) => p.write(d);
    resize = (c, r) => { try { p.resize(c, r); } catch { /* exited */ } };
    kill = () => { try { p.kill(); } catch { /* gone */ } };
  } else {
    // Fallback without a pseudo-terminal: works for simple commands, not full-screen apps.
    ws.send('\x1b[33m[bridge] node-pty is not installed, running without a TTY (no vim/htop, no line editing).\x1b[0m\r\n');
    const p = spawn(file, args.length ? args : (os.platform() === 'win32' ? [] : ['-i']), { cwd, env, shell: false });
    const send = (d) => ws.readyState === 1 && ws.send(d.toString().replace(/\r?\n/g, '\r\n'));
    p.stdout.on('data', send);
    p.stderr.on('data', send);
    p.on('exit', (code) => ws.close(1000, `exit ${code ?? 0}`));
    let line = '';
    write = (d) => {
      for (const ch of d) {
        if (ch === '\r') { ws.send('\r\n'); p.stdin.write(line + '\n'); line = ''; }
        else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); ws.send('\b \b'); } }
        else if (ch === '\x03') p.kill('SIGINT');
        else if (ch >= ' ') { line += ch; ws.send(ch); }
      }
    };
    resize = () => {};
    kill = () => p.kill();
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'i' && typeof msg.d === 'string') write(msg.d);
    else if (msg.t === 'r') resize(Math.max(2, msg.c | 0), Math.max(2, msg.r | 0));
  });
  ws.on('close', kill);
}

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'YOUR-IP' : HOST;
  console.log(`
PocketShell bridge is running  (shell: ${SHELL}${pty ? '' : ', no node-pty: limited mode'})

  In PocketShell, run:
    connect ws://${shown}:${PORT} --token ${TOKEN}

  Optional — faster/private git CORS proxy (PocketShell → Settings → Git CORS proxy):
    http://${shown}:${PORT}/git/${TOKEN}

  Optional — let curl reach any site:
    export CORS_PROXY="http://${shown}:${PORT}/proxy?token=${TOKEN}&url={url}"

  Anyone with the token gets a shell on this machine. Keep it secret.
  Set BRIDGE_TOKEN to keep the same token between restarts.
`);
});
