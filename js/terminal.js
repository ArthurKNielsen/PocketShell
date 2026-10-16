// xterm.js wrapper with a readline-style line editor.
import { Terminal } from '../vendor/xterm.mjs';
import { FitAddon } from '../vendor/addon-fit.mjs';
import { WebLinksAddon } from '../vendor/addon-web-links.mjs';

export const EOF = Symbol('EOF');
export const stripAnsi = (s) =>
  String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');

const KEYSEQ = /^\x1b(\[[0-9;]*[A-Za-z~]|O[A-Za-z]|.)?/;

export class TermSession {
  constructor(container, { theme, fontSize }) {
    this.term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Courier New", monospace',
      fontSize,
      theme,
      scrollback: 10000,
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((e, uri) => window.open(uri, '_blank', 'noopener')));
    this.term.open(container);

    this.queue = '';          // typed-ahead input waiting for the next reader
    this.reader = null;       // active line reader
    this.rawHandler = null;   // set while a program (ssh, websocket) owns the keyboard
    this.ctrlLatch = false;   // on-screen Ctrl key
    this.abortCtl = null;     // aborted by Ctrl+C while a command runs
    this.atLineStart = true;
    this.onCtrlLatch = null;

    this.term.onData((d) => this.input(d));
  }

  write(s) {
    s = String(s);
    if (!s) return;
    this.term.write(s);
    this.atLineStart = /\n$/.test(s) || (this.atLineStart && /^(\x1b\[[0-9;]*[A-Za-z])*$/.test(s));
  }
  writeln(s = '') { this.write(s + '\n'); }

  ensureNewline() { if (!this.atLineStart) this.write('\r\n'); }

  setCtrlLatch(on) {
    this.ctrlLatch = on;
    this.onCtrlLatch?.(on);
  }

  input(d) {
    if (this.ctrlLatch && d.length === 1) {
      const c = d.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) d = String.fromCharCode(c - 96);
      this.setCtrlLatch(false);
    }
    if (this.rawHandler) return this.rawHandler(d);
    if (this.reader) return this.feed(d);
    if (d.includes('\x03')) { this.abortCtl?.abort(); this.queue = ''; return; }
    this.queue += d;
  }

  /** Read one line. Resolves to the string, null on Ctrl+C, or EOF on Ctrl+D (empty line). */
  readLine(prompt = '', { hidden = false, history = null, complete = null } = {}) {
    return new Promise((resolve) => {
      this.ensureNewline();
      this.reader = {
        prompt, promptLen: stripAnsi(prompt).length, buf: '', pos: 0, lastCursor: 0,
        hidden, history, histIdx: history ? history.length : 0, draft: '', complete, resolve,
      };
      this.write(prompt);
      this.reader.lastCursor = this.reader.promptLen;
      if (this.queue) { const q = this.queue; this.queue = ''; this.feed(q); }
    });
  }

  feed(data) {
    let i = 0;
    while (i < data.length && this.reader) {
      const ch = data[i];
      if (ch === '\x1b') {
        const m = data.slice(i).match(KEYSEQ);
        const seq = m[0];
        i += seq.length;
        this.key(seq);
        continue;
      }
      const run = data.slice(i).match(/^[^\x00-\x1f\x7f\x1b]+/);
      if (run) {
        const r = this.reader;
        r.buf = r.buf.slice(0, r.pos) + run[0] + r.buf.slice(r.pos);
        r.pos += run[0].length;
        this.render();
        i += run[0].length;
        continue;
      }
      i++;
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && data[i] === '\n') i++;
        const rest = data.slice(i);
        this.submit();
        if (rest) this.queue = rest + this.queue;
        return;
      }
      this.key(ch);
    }
  }

  submit(value) {
    const r = this.reader;
    r.pos = r.buf.length;
    this.render();
    this.write('\r\n');
    this.reader = null;
    if (value === undefined) {
      value = r.buf;
      if (r.history && value.trim() && r.history[r.history.length - 1] !== value) r.history.push(value);
    }
    r.resolve(value);
  }

  key(k) {
    const r = this.reader;
    const set = (buf, pos) => { r.buf = buf; r.pos = pos; this.render(); };
    switch (k) {
      case '\x7f': case '\b':
        if (r.pos > 0) set(r.buf.slice(0, r.pos - 1) + r.buf.slice(r.pos), r.pos - 1);
        return;
      case '\x1b[3~':
        if (r.pos < r.buf.length) set(r.buf.slice(0, r.pos) + r.buf.slice(r.pos + 1), r.pos);
        return;
      case '\x1b[D': case '\x02':
        if (r.pos > 0) set(r.buf, r.pos - 1);
        return;
      case '\x1b[C': case '\x06':
        if (r.pos < r.buf.length) set(r.buf, r.pos + 1);
        return;
      case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x01':
        set(r.buf, 0); return;
      case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x05':
        set(r.buf, r.buf.length); return;
      case '\x1b[1;5D': case '\x1bb': {
        let p = r.pos;
        while (p > 0 && r.buf[p - 1] === ' ') p--;
        while (p > 0 && r.buf[p - 1] !== ' ') p--;
        set(r.buf, p); return;
      }
      case '\x1b[1;5C': case '\x1bf': {
        let p = r.pos;
        while (p < r.buf.length && r.buf[p] === ' ') p++;
        while (p < r.buf.length && r.buf[p] !== ' ') p++;
        set(r.buf, p); return;
      }
      case '\x1b[A': case '\x10':
        if (r.history && r.histIdx > 0) {
          if (r.histIdx === r.history.length) r.draft = r.buf;
          r.histIdx--;
          set(r.history[r.histIdx], r.history[r.histIdx].length);
        }
        return;
      case '\x1b[B': case '\x0e':
        if (r.history && r.histIdx < r.history.length) {
          r.histIdx++;
          const v = r.histIdx === r.history.length ? r.draft : r.history[r.histIdx];
          set(v, v.length);
        }
        return;
      case '\x15': set(r.buf.slice(r.pos), 0); return;
      case '\x0b': set(r.buf.slice(0, r.pos), r.pos); return;
      case '\x17': {
        let p = r.pos;
        while (p > 0 && r.buf[p - 1] === ' ') p--;
        while (p > 0 && r.buf[p - 1] !== ' ') p--;
        set(r.buf.slice(0, p) + r.buf.slice(r.pos), p); return;
      }
      case '\x0c':
        this.term.write('\x1b[2J\x1b[3J\x1b[H');
        r.lastCursor = 0;
        this.render();
        return;
      case '\x03':
        r.pos = r.buf.length;
        this.render();
        this.write('^C');
        this.write('\r\n');
        this.reader = null;
        r.resolve(null);
        return;
      case '\x04':
        if (!r.buf) { this.write('\r\n'); this.reader = null; r.resolve(EOF); }
        else if (r.pos < r.buf.length) set(r.buf.slice(0, r.pos) + r.buf.slice(r.pos + 1), r.pos);
        return;
      case '\t':
        this.tab();
        return;
    }
    if (k.length === 1 && k >= ' ') set(r.buf.slice(0, r.pos) + k + r.buf.slice(r.pos), r.pos + 1);
    else if (k.length > 1 && k[0] !== '\x1b') {
      const clean = k.replace(/[\x00-\x1f]/g, '');
      set(r.buf.slice(0, r.pos) + clean + r.buf.slice(r.pos), r.pos + clean.length);
    }
  }

  async tab() {
    const r = this.reader;
    if (!r.complete) return;
    const before = r.buf.slice(0, r.pos);
    let res;
    try { res = await r.complete(before); } catch { return; }
    if (this.reader !== r || !res || !res.candidates.length) return;
    const { start, candidates } = res;
    const word = before.slice(start);
    let common = candidates[0];
    for (const c of candidates) {
      let j = 0;
      while (j < common.length && j < c.length && common[j].toLowerCase() === c[j].toLowerCase()) j++;
      common = common.slice(0, j);
    }
    if (candidates.length === 1) {
      const c = candidates[0];
      const ins = c + (c.endsWith('/') ? '' : ' ');
      r.buf = r.buf.slice(0, start) + ins + r.buf.slice(r.pos);
      r.pos = start + ins.length;
      this.render();
    } else if (common.length > word.length) {
      r.buf = r.buf.slice(0, start) + common + r.buf.slice(r.pos);
      r.pos = start + common.length;
      this.render();
    } else {
      // print the options, then redraw the prompt below them
      const names = candidates.map((c) => c.replace(/\/$/, '').split('/').pop() + (c.endsWith('/') ? '/' : ''));
      const w = Math.max(...names.map((n) => n.length)) + 2;
      const per = Math.max(1, Math.floor(this.term.cols / w));
      let out = '';
      names.forEach((n, i) => { out += n.padEnd(w); if ((i + 1) % per === 0) out += '\r\n'; });
      r.pos = r.buf.length;
      this.render();
      this.term.write('\r\n' + out.trimEnd() + '\r\n');
      r.lastCursor = 0;
      this.render();
    }
  }

  render() {
    const r = this.reader;
    if (!r) return;
    const cols = this.term.cols;
    const shown = r.hidden ? '' : r.buf;
    const shownPos = r.hidden ? 0 : r.pos;
    const up = Math.floor(r.lastCursor / cols);
    let s = up ? `\x1b[${up}A` : '';
    s += '\r\x1b[J' + r.prompt + shown;
    const end = r.promptLen + shown.length;
    if (end > 0 && end % cols === 0) s += ' \r';
    const target = r.promptLen + shownPos;
    const rowsBack = Math.floor(end / cols) - Math.floor(target / cols);
    if (rowsBack > 0) s += `\x1b[${rowsBack}A`;
    s += '\r';
    if (target % cols) s += `\x1b[${target % cols}C`;
    r.lastCursor = target;
    this.term.write(s);
  }

  // Print text above an active prompt (for async messages) without breaking the line being typed.
  printAbove(s) {
    const r = this.reader;
    if (!r) { this.write(s); return; }
    const up = Math.floor(r.lastCursor / this.term.cols);
    this.term.write((up ? `\x1b[${up}A` : '') + '\r\x1b[J' + s + (s.endsWith('\n') ? '' : '\n'));
    r.lastCursor = 0;
    this.render();
  }

  // Simple helpers for commands
  async question(prompt, hidden = false) {
    const v = await this.readLine(prompt, { hidden });
    return typeof v === 'string' ? v : null;
  }
  async confirm(prompt) {
    const v = await this.question(prompt + ' [y/N] ');
    return !!v && /^y(es)?$/i.test(v.trim());
  }

  focus() { this.term.focus(); }
  resize() { try { this.fit.fit(); } catch { /* not visible yet */ } }
  dispose() { this.term.dispose(); }
}
