// GitHub token storage + REST API helper.
const TOKEN_KEY = 'ps.gh.token';
const LOGIN_KEY = 'ps.gh.login';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const getLogin = () => localStorage.getItem(LOGIN_KEY) || '';
export function saveAuth(token, login) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(LOGIN_KEY, login);
}
export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LOGIN_KEY);
}

export class GitHubError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

export async function api(path, { method = 'GET', body, accept, signal, token = getToken(), raw = false } = {}) {
  const url = /^https?:\/\//.test(path) ? path : 'https://api.github.com/' + path.replace(/^\//, '');
  const headers = {
    Accept: accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  if (raw) return res;
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    let msg = (data && data.message) || res.statusText || 'request failed';
    if (data?.errors?.length) msg += ': ' + data.errors.map((e) => e.message || e.code || JSON.stringify(e)).join('; ');
    if (res.status === 401) msg += ' (run: gh auth login)';
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') msg = 'API rate limit exceeded' + (token ? '' : ' (log in with gh auth login for a much higher limit)');
    if (res.status === 404 && !token) msg += ' (private repos need: gh auth login)';
    throw new GitHubError(res.status, `HTTP ${res.status}: ${msg}`, data);
  }
  return data;
}

// Fetch every page of a list endpoint (up to `max` items).
export async function apiAll(path, { max = 1000, signal, filter = null } = {}) {
  const out = [];
  let url = path + (path.includes('?') ? '&' : '?') + 'per_page=100';
  while (url && out.length < max) {
    const res = await api(url, { raw: true, signal });
    if (!res.ok) return api(url, { signal });
    const page = await res.json();
    const items = Array.isArray(page) ? page : page.items || [];
    out.push(...(filter ? items.filter(filter) : items));
    const link = res.headers.get('link') || '';
    url = link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  return out.slice(0, max);
}

export function parseRepo(s) {
  if (!s) return null;
  const m = String(s).match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2], full: `${m[1]}/${m[2]}` } : null;
}
