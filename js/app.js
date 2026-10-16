// PocketShell UI: tabs, profiles, settings and the phone key bar.
import { initFS, tilde } from './fs.js';
import { TermSession } from './terminal.js';
import { Shell } from './shell.js';
import { themes } from './themes.js';
import { settings, saveSettings, onSettings } from './settings.js';
import './commands/core.js';
import './commands/files.js';
import './commands/text.js';
import './commands/git.js';
import './commands/gh.js';
import './commands/net.js';
import './commands/lang.js';

const $ = (id) => document.getElementById(id);
const PROFILES = {
  pwsh: { name: 'PowerShell', icon: '&gt;_', cls: 'ico-pwsh' },
  cmd: { name: 'Command Prompt', icon: 'C:\\', cls: 'ico-cmd' },
  bash: { name: 'Bash', icon: '$', cls: 'ico-bash' },
};

const tabs = [];
let active = null;
let nextId = 1;

function themeFor() { return themes[settings.theme] ?? themes.Campbell; }

function applyChrome() {
  const t = themeFor();
  document.documentElement.style.setProperty('--term-bg', t.background);
  document.querySelector('meta[name=theme-color]').content = '#202020';
  $('keybar').classList.toggle('show', !!settings.keybar);
}

function titleOf(tab) {
  if (tab.shell.customTitle) return tab.shell.customTitle;
  if (tab.profile === 'bash') return `${tab.shell.env.USER}@pocketshell: ${tilde(tab.shell.cwd)}`;
  return PROFILES[tab.profile].name;
}

function refreshTitle(tab) {
  tab.titleEl.textContent = titleOf(tab);
  tab.el.title = titleOf(tab);
  if (tab === active) document.title = `${titleOf(tab)} — PocketShell`;
}

function newTab(profile = settings.profile) {
  const id = nextId++;
  const pane = document.createElement('div');
  pane.className = 'pane';
  $('terminals').append(pane);

  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.innerHTML = `<span class="ico ${PROFILES[profile].cls}">${PROFILES[profile].icon}</span><span class="title"></span><button class="close" aria-label="Close tab">✕</button>`;
  $('tabs').append(el);

  const session = new TermSession(pane, { theme: themeFor(), fontSize: settings.fontSize });
  const tab = { id, profile, pane, el, titleEl: el.querySelector('.title'), session };
  tab.shell = new Shell(session, profile, {
    onExit: () => closeTab(tab),
    onTitle: () => refreshTitle(tab),
  });
  session.onCtrlLatch = (on) => document.querySelector('#keybar [data-key=ctrl]').classList.toggle('on', on);

  // Windows Terminal-style copy/paste: Ctrl+C copies when text is selected, Ctrl+Shift+C/V always.
  session.term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'c' && (e.shiftKey || session.term.hasSelection())) {
      navigator.clipboard?.writeText(session.term.getSelection());
      session.term.clearSelection();
      e.preventDefault();
      return false;
    }
    if (e.ctrlKey && e.shiftKey && k === 'v') {
      navigator.clipboard?.readText().then((t) => session.input(t));
      e.preventDefault();
      return false;
    }
    if (e.altKey && !e.ctrlKey && (k === 't' || k === 'w' || /^[1-9]$/.test(k))) return false;
    return true;
  });

  el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab); } });
  el.addEventListener('click', (e) => {
    if (e.target.closest('.close')) closeTab(tab);
    else activate(tab);
  });

  tabs.push(tab);
  activate(tab);
  refreshTitle(tab);
  tab.shell.start().catch((e) => session.write(`\r\n\x1b[31mshell crashed: ${e.stack || e}\x1b[0m\r\n`));
  return tab;
}

function activate(tab) {
  active = tab;
  for (const t of tabs) {
    const on = t === tab;
    t.el.classList.toggle('active', on);
    t.el.setAttribute('aria-selected', on);
    t.pane.classList.toggle('active', on);
  }
  requestAnimationFrame(() => {
    tab.session.resize();
    tab.session.focus();
  });
  document.title = `${titleOf(tab)} — PocketShell`;
  tab.el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tab.shell.closed = true;
  tab.session.abortCtl?.abort();
  tabs.splice(i, 1);
  tab.session.dispose();
  tab.pane.remove();
  tab.el.remove();
  if (!tabs.length) newTab();
  else if (active === tab) activate(tabs[Math.min(i, tabs.length - 1)]);
}

// ---------- menu ----------
const menu = $('profile-menu');
function toggleMenu(show = menu.hidden) {
  menu.hidden = !show;
  if (show) {
    const r = $('profile-menu-btn').getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - 256)) + 'px';
  }
}
$('profile-menu-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
$('new-tab').addEventListener('click', () => newTab());
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) toggleMenu(false); });
menu.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  toggleMenu(false);
  if (b.dataset.profile) newTab(b.dataset.profile);
  else if (b.dataset.action === 'settings') openSettings();
  else if (b.dataset.action === 'help') {
    active.session.input('\x15help\r');
    active.session.focus();
  }
});

// ---------- settings ----------
function openSettings() {
  const sel = $('set-theme');
  sel.innerHTML = Object.keys(themes).map((t) => `<option>${t}</option>`).join('');
  sel.value = settings.theme;
  $('set-font').value = settings.fontSize;
  $('set-profile').value = settings.profile;
  $('set-proxy').value = settings.corsProxy;
  $('set-keybar').checked = !!settings.keybar;
  $('settings').hidden = false;
}
$('set-theme').addEventListener('change', (e) => saveSettings({ theme: e.target.value }));
$('set-font').addEventListener('change', (e) => saveSettings({ fontSize: Math.min(40, Math.max(8, +e.target.value || 15)) }));
$('set-profile').addEventListener('change', (e) => saveSettings({ profile: e.target.value }));
$('set-proxy').addEventListener('change', (e) => saveSettings({ corsProxy: e.target.value.trim() }));
$('set-keybar').addEventListener('change', (e) => saveSettings({ keybar: e.target.checked }));
$('settings-close').addEventListener('click', () => { $('settings').hidden = true; active?.session.focus(); });
$('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('settings-close').click(); });

onSettings(() => {
  applyChrome();
  for (const t of tabs) {
    t.session.term.options.theme = themeFor();
    t.session.term.options.fontSize = settings.fontSize;
  }
  active?.session.resize();
});

// ---------- phone key bar ----------
const KEYS = {
  esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', ctrlc: '\x03',
};
$('keybar').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  const s = active?.session;
  if (!s) return;
  const k = b.dataset.key;
  if (k === 'ctrl') s.setCtrlLatch(!s.ctrlLatch);
  else s.input(KEYS[k] ?? k);
});

// ---------- global shortcuts ----------
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  if (k === 't') { e.preventDefault(); newTab(); }
  else if (k === 'w') { e.preventDefault(); if (active) closeTab(active); }
  else if (/^[1-9]$/.test(k) && tabs[+k - 1]) { e.preventDefault(); activate(tabs[+k - 1]); }
});

new ResizeObserver(() => active?.session.resize()).observe($('terminals'));
window.visualViewport?.addEventListener('resize', () => active?.session.resize());

// ---------- boot ----------
applyChrome();
await document.fonts?.ready;
try {
  await initFS();
} catch (e) {
  document.body.insertAdjacentHTML('afterbegin', `<p style="color:#f66;padding:8px">Storage unavailable (${e.message}). Private browsing mode can block IndexedDB.</p>`);
}
newTab();
