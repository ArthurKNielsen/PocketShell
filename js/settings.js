// User settings, persisted in localStorage.
const KEY = 'ps.settings';
const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const defaults = {
  theme: 'Campbell',
  fontSize: touch ? 13 : 15,
  profile: 'pwsh',
  corsProxy: 'https://cors.isomorphic-git.org',
  keybar: touch,
};

let stored = {};
try { stored = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* corrupt */ }

export const settings = { ...defaults, ...stored };
const listeners = new Set();

export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  localStorage.setItem(KEY, JSON.stringify(settings));
  for (const fn of listeners) fn(settings);
}
export function onSettings(fn) { listeners.add(fn); }
