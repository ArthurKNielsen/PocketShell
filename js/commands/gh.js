// A browser version of the GitHub CLI, built on the GitHub REST API.
import { def, parseArgs, UsageError, c, table, timeAgo } from './registry.js';
import { api, apiAll, getToken, getLogin, saveAuth, clearAuth, parseRepo } from '../github.js';
import { globalConfig, setGlobalConfig } from './git.js';
import { colorJson } from './text.js';
import * as fsx from '../fs.js';

const git = globalThis.git;
const CAT = 'Git & GitHub';
const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org,gist,workflow&description=PocketShell';

async function currentRepo(ctx, flag) {
  if (flag) {
    const r = parseRepo(flag.includes('/') ? flag : `${getLogin()}/${flag}`);
    if (!r) throw new Error(`invalid repository: ${flag}`);
    return r;
  }
  try {
    const dir = await git.findRoot({ fs: fsx.fs, filepath: ctx.cwd });
    const remotes = await git.listRemotes({ fs: fsx.fs, dir });
    const r = remotes.find((x) => x.remote === 'upstream') ?? remotes.find((x) => x.remote === 'origin') ?? remotes[0];
    const parsed = r && /github\.com/.test(r.url) && parseRepo(r.url);
    if (parsed) return parsed;
  } catch { /* not a repo */ }
  throw new Error('could not determine the repository. Run inside a cloned GitHub repo, or pass -R owner/repo');
}

function requireAuth() {
  if (!getToken()) throw new Error("You are not logged in. Run 'gh auth login' first.");
}

const stateColor = (s, draft) => (draft ? c.gray('draft') : s === 'open' ? c.green('open') : s === 'merged' ? c.magenta('merged') : c.red(s));

function body(ctx, text) {
  if (!text) return c.gray('No description provided.') + '\n';
  return text.replace(/\r\n/g, '\n').trim() + '\n';
}

async function readBody(ctx, a) {
  if (a['body-file']) return fsx.readText(ctx.resolve(a['body-file']));
  if (a.b !== undefined) return a.b;
  return (await ctx.session.question('Body (optional): ')) ?? '';
}

// ---------- gh auth ----------
async function auth(ctx, args) {
  const [action, ...rest] = args;
  const a = parseArgs(rest, { boolean: ['with-token', 'show-token'], alias: { t: 'show-token' } });
  if (action === 'login') {
    let token;
    if (a['with-token']) token = (ctx.stdin ?? '').trim();
    else {
      ctx.out(`${c.bold('Log in to GitHub with a personal access token.')}\n\n`);
      ctx.out(`1. Open ${c.cyan(TOKEN_URL)}\n`);
      ctx.out('   (classic token, scopes: repo, read:org, gist, workflow — add delete_repo only if you want gh repo delete)\n');
      ctx.out('   Fine-grained tokens work too: give them access to the repos you want.\n');
      ctx.out('2. Generate the token and copy it.\n3. Paste it below (input is hidden).\n\n');
      if (ctx.isTTY && rest.includes('--web')) window.open(TOKEN_URL, '_blank', 'noopener');
      token = (await ctx.session.question('? Paste your authentication token: ', true))?.trim();
    }
    if (!token) { ctx.err('No token given. Login canceled.\n'); return 1; }
    let user;
    try {
      user = await api('user', { token, signal: ctx.signal });
    } catch (e) {
      if (e.status === 401) { ctx.err('GitHub rejected that token (401). Make sure you copied the whole thing and it has not expired.\n'); return 1; }
      throw e;
    }
    saveAuth(token, user.login);
    ctx.shell.env.USER = ctx.shell.env.USERNAME = user.login;
    const cfg = globalConfig();
    if (!cfg['user.name']) setGlobalConfig('user.name', user.name || user.login);
    if (!cfg['user.email']) setGlobalConfig('user.email', `${user.id}+${user.login}@users.noreply.github.com`);
    ctx.out(`${c.green('✓')} Logged in as ${c.bold(user.login)}\n`);
    ctx.out(`${c.green('✓')} git is set up to use this token for github.com (clone, pull, push)\n`);
    ctx.out(c.gray('  The token is stored in this browser only (localStorage). Use gh auth logout to remove it.\n'));
    return;
  }
  if (action === 'logout') {
    clearAuth();
    ctx.out(`${c.green('✓')} Logged out of github.com\n`);
    return;
  }
  if (action === 'token') { requireAuth(); ctx.out(getToken() + '\n'); return; }
  if (action === 'status' || !action) {
    const token = getToken();
    if (!token) { ctx.out(`github.com\n  ${c.red('X')} Not logged in. Run gh auth login\n`); return 1; }
    const res = await api('user', { raw: true, signal: ctx.signal });
    if (!res.ok) { ctx.out(`github.com\n  ${c.red('X')} Token is invalid or expired (HTTP ${res.status}). Run gh auth login\n`); return 1; }
    const user = await res.json();
    const scopes = res.headers.get('x-oauth-scopes');
    const masked = token.slice(0, 4) + '*'.repeat(Math.max(0, token.length - 8)) + token.slice(-4);
    ctx.out(`github.com\n  ${c.green('✓')} Logged in to github.com account ${c.bold(user.login)}\n  - Token: ${a['show-token'] ? token : masked}\n`);
    if (scopes !== null) ctx.out(`  - Token scopes: ${scopes || 'none'}\n`);
    ctx.out(`  - Rate limit remaining: ${res.headers.get('x-ratelimit-remaining')}/${res.headers.get('x-ratelimit-limit')}\n`);
    return;
  }
  throw new UsageError('gh auth <login|logout|status|token>');
}

// ---------- gh repo ----------
async function repo(ctx, args) {
  const [action, ...rest] = args;
  const a = parseArgs(rest, {
    string: ['L', 'limit', 'd', 'description', 'R', 'repo', 'visibility', 'homepage'],
    boolean: ['public', 'private', 'internal', 'clone', 'web', 'yes', 'add-readme', 'source'],
    alias: { limit: 'L', description: 'd', repo: 'R', w: 'web', c: 'clone', y: 'yes' },
  });
  switch (action) {
    case 'list': case 'ls': {
      const owner = a._[0];
      const limit = parseInt(a.L ?? 30, 10);
      let repos;
      if (owner && owner !== getLogin()) repos = await apiAll(`users/${owner}/repos?sort=updated`, { max: limit, signal: ctx.signal });
      else { requireAuth(); repos = await apiAll('user/repos?sort=updated&affiliation=owner,collaborator,organization_member', { max: limit, signal: ctx.signal }); }
      if (a.visibility) repos = repos.filter((r) => r.visibility === a.visibility);
      if (!repos.length) { ctx.out('No repositories found.\n'); return; }
      ctx.out(`\nShowing ${repos.length} repositories\n\n`);
      ctx.out(table([[c.bold('NAME'), c.bold('DESCRIPTION'), c.bold('INFO'), c.bold('UPDATED')], ...repos.map((r) => [
        c.cyan(r.full_name),
        (r.description ?? '').slice(0, 48),
        r.private ? c.yellow('private') : 'public' + (r.fork ? ', fork' : ''),
        c.gray(timeAgo(r.pushed_at ?? r.updated_at)),
      ])]));
      return;
    }
    case 'view': {
      const r = await currentRepo(ctx, a._[0] ?? a.R);
      if (a.web) { window.open(`https://github.com/${r.full}`, '_blank', 'noopener'); return; }
      const info = await api(`repos/${r.full}`, { signal: ctx.signal });
      ctx.out(`${c.bold(info.full_name)}\n${info.description ?? c.gray('No description')}\n\n`);
      ctx.out(`${c.gray('★')} ${info.stargazers_count}  ${c.gray('forks')} ${info.forks_count}  ${c.gray('issues')} ${info.open_issues_count}  ${c.gray('lang')} ${info.language ?? '-'}  ${c.gray('branch')} ${info.default_branch}  ${info.private ? c.yellow('private') : 'public'}\n`);
      ctx.out(`${c.gray(info.html_url)}\n\n`);
      try {
        const readme = await api(`repos/${r.full}/readme`, { accept: 'application/vnd.github.raw+json', signal: ctx.signal });
        ctx.out(String(readme).slice(0, 6000) + '\n');
      } catch { ctx.out(c.gray('(no README)\n')); }
      return;
    }
    case 'create': case 'new': {
      requireAuth();
      let name = a._[0] ?? (await ctx.session.question('Repository name: '));
      if (!name) { ctx.err('name required\n'); return 1; }
      let org = null;
      if (name.includes('/')) { [org, name] = name.split('/'); if (org === getLogin()) org = null; }
      const isPrivate = a.private ? true : a.public ? false : !(await ctx.session.confirm('Make it public?'));
      const payload = { name, description: a.d, private: isPrivate, auto_init: !!a['add-readme'], homepage: a.homepage };
      const created = await api(org ? `orgs/${org}/repos` : 'user/repos', { method: 'POST', body: payload, signal: ctx.signal });
      ctx.out(`${c.green('✓')} Created repository ${c.bold(created.full_name)} on GitHub\n  ${created.html_url}\n`);
      const dir = await git.findRoot({ fs: fsx.fs, filepath: ctx.cwd }).catch(() => null);
      if (a.source && dir) {
        await git.addRemote({ fs: fsx.fs, dir, remote: 'origin', url: created.clone_url, force: true });
        ctx.out(`${c.green('✓')} Added remote origin → ${created.clone_url}\n  Push with: git push -u origin main\n`);
      } else if (a.clone) {
        return ctx.exec(['git', 'clone', created.clone_url]);
      }
      return;
    }
    case 'clone': {
      const [spec, dir] = a._;
      if (!spec) throw new UsageError('gh repo clone <owner/repo> [dir]');
      const r = parseRepo(spec.includes('/') ? spec : `${getLogin()}/${spec}`);
      return ctx.exec(['git', 'clone', `https://github.com/${r.full}.git`, ...(dir ? [dir] : [])]);
    }
    case 'fork': {
      requireAuth();
      const r = await currentRepo(ctx, a._[0] ?? a.R);
      const f = await api(`repos/${r.full}/forks`, { method: 'POST', body: {}, signal: ctx.signal });
      ctx.out(`${c.green('✓')} Created fork ${c.bold(f.full_name)}\n`);
      if (a.clone) return ctx.exec(['git', 'clone', f.clone_url]);
      return;
    }
    case 'delete': {
      requireAuth();
      const r = await currentRepo(ctx, a._[0] ?? a.R);
      if (!a.yes) {
        const typed = await ctx.session.question(`${c.red('!')} Type ${c.bold(r.full)} to confirm deletion: `);
        if (typed !== r.full) { ctx.err('Confirmation did not match. Nothing deleted.\n'); return 1; }
      }
      await api(`repos/${r.full}`, { method: 'DELETE', signal: ctx.signal });
      ctx.out(`${c.green('✓')} Deleted repository ${r.full}\n`);
      return;
    }
    case 'edit': {
      requireAuth();
      const r = await currentRepo(ctx, a._[0] ?? a.R);
      const patch = {};
      if (a.d !== undefined) patch.description = a.d;
      if (a.homepage !== undefined) patch.homepage = a.homepage;
      if (a.visibility) patch.visibility = a.visibility;
      await api(`repos/${r.full}`, { method: 'PATCH', body: patch, signal: ctx.signal });
      ctx.out(`${c.green('✓')} Edited repository ${r.full}\n`);
      return;
    }
  }
  ctx.out(`usage: gh repo <command>\n\n  list [owner]          list repositories\n  view [owner/repo]     show repo + README (--web opens it)\n  create [name]         create a repo (--public/--private, -d, --clone, --source, --add-readme)\n  clone <owner/repo>    clone a repo\n  fork [owner/repo]     fork a repo (--clone)\n  edit [repo]           edit description (-d), --homepage, --visibility\n  delete [owner/repo]   delete a repo (needs delete_repo scope)\n`);
}

// ---------- gh issue ----------
async function issue(ctx, args) {
  const [action, ...rest] = args;
  const a = parseArgs(rest, {
    string: ['R', 'repo', 's', 'state', 'L', 'limit', 't', 'title', 'b', 'body', 'body-file', 'l', 'label', 'a', 'assignee'],
    boolean: ['web'], alias: { repo: 'R', state: 's', limit: 'L', title: 't', body: 'b', label: 'l', assignee: 'a', w: 'web' },
  });
  const r = await currentRepo(ctx, a.R);
  switch (action) {
    case 'list': case 'ls': {
      const state = a.s ?? 'open';
      let q = `repos/${r.full}/issues?state=${state}`;
      if (a.l) q += `&labels=${encodeURIComponent(a.l)}`;
      if (a.a) q += `&assignee=${encodeURIComponent(a.a)}`;
      const items = await apiAll(q, { max: parseInt(a.L ?? 30, 10), signal: ctx.signal, filter: (i) => !i.pull_request });
      if (!items.length) { ctx.out(`No ${state} issues in ${r.full}\n`); return; }
      ctx.out(`\nShowing ${items.length} ${state} issues in ${r.full}\n\n`);
      ctx.out(table(items.map((i) => [c.green('#' + i.number), i.title.slice(0, 60), c.gray(i.labels.map((l) => l.name).join(', ')), c.gray(timeAgo(i.updated_at))])));
      return;
    }
    case 'view': {
      const n = a._[0];
      if (!n) throw new UsageError('gh issue view <number>');
      if (a.web) { window.open(`https://github.com/${r.full}/issues/${n}`, '_blank', 'noopener'); return; }
      const i = await api(`repos/${r.full}/issues/${n}`, { signal: ctx.signal });
      ctx.out(`${c.bold(i.title)} ${c.gray(r.full + '#' + i.number)}\n${stateColor(i.state)} • ${i.user.login} opened ${timeAgo(i.created_at)} • ${i.comments} comments\n\n`);
      ctx.out(body(ctx, i.body));
      if (i.comments) {
        const comments = await api(`repos/${r.full}/issues/${n}/comments`, { signal: ctx.signal });
        for (const cm of comments) ctx.out(`\n${c.bold(cm.user.login)} ${c.gray(timeAgo(cm.created_at))}\n${cm.body.trim()}\n`);
      }
      ctx.out(c.gray(`\nView this issue on GitHub: ${i.html_url}\n`));
      return;
    }
    case 'create': case 'new': {
      requireAuth();
      const title = a.t ?? (await ctx.session.question('Title: '));
      if (!title) { ctx.err('title required\n'); return 1; }
      const b = await readBody(ctx, a);
      const i = await api(`repos/${r.full}/issues`, { method: 'POST', body: { title, body: b, labels: a.l ? a.l.split(',') : undefined, assignees: a.a ? a.a.split(',') : undefined }, signal: ctx.signal });
      ctx.out(`${c.green('✓')} Created issue #${i.number}\n${i.html_url}\n`);
      return;
    }
    case 'close': case 'reopen': {
      requireAuth();
      const n = a._[0];
      await api(`repos/${r.full}/issues/${n}`, { method: 'PATCH', body: { state: action === 'close' ? 'closed' : 'open' }, signal: ctx.signal });
      ctx.out(`${c.green('✓')} ${action === 'close' ? 'Closed' : 'Reopened'} issue #${n}\n`);
      return;
    }
    case 'comment': {
      requireAuth();
      const n = a._[0];
      const b = a.b ?? (await ctx.session.question('Comment: '));
      if (!b) return 1;
      const cm = await api(`repos/${r.full}/issues/${n}/comments`, { method: 'POST', body: { body: b }, signal: ctx.signal });
      ctx.out(`${c.green('✓')} ${cm.html_url}\n`);
      return;
    }
  }
  ctx.out('usage: gh issue <list|view|create|close|reopen|comment> [-R owner/repo]\n');
}

// ---------- gh pr ----------
async function pr(ctx, args) {
  const [action, ...rest] = args;
  const a = parseArgs(rest, {
    string: ['R', 'repo', 's', 'state', 'L', 'limit', 't', 'title', 'b', 'body', 'body-file', 'B', 'base', 'H', 'head'],
    boolean: ['web', 'draft', 'squash', 'merge', 'rebase', 'delete-branch', 'fill'],
    alias: { repo: 'R', state: 's', limit: 'L', title: 't', body: 'b', base: 'B', head: 'H', w: 'web', d: 'draft', s: 's' },
  });
  const r = await currentRepo(ctx, a.R);
  switch (action) {
    case 'list': case 'ls': {
      const state = a.s ?? 'open';
      const items = await apiAll(`repos/${r.full}/pulls?state=${state === 'merged' ? 'closed' : state}`, { max: parseInt(a.L ?? 30, 10), signal: ctx.signal });
      const list = state === 'merged' ? items.filter((p) => p.merged_at) : items;
      if (!list.length) { ctx.out(`No ${state} pull requests in ${r.full}\n`); return; }
      ctx.out(`\nShowing ${list.length} ${state} pull requests in ${r.full}\n\n`);
      ctx.out(table(list.map((p) => [c.green('#' + p.number), p.title.slice(0, 55), c.cyan(p.head.label), p.draft ? c.gray('draft') : '', c.gray(timeAgo(p.updated_at))])));
      return;
    }
    case 'view': case 'diff': case 'checks': {
      let n = a._[0];
      if (!n) {
        const dir = await git.findRoot({ fs: fsx.fs, filepath: ctx.cwd });
        const branch = await git.currentBranch({ fs: fsx.fs, dir });
        const found = await api(`repos/${r.full}/pulls?head=${r.owner}:${branch}&state=all`, { signal: ctx.signal });
        if (!found.length) throw new Error(`no pull requests found for branch "${branch}"`);
        n = found[0].number;
      }
      if (a.web) { window.open(`https://github.com/${r.full}/pull/${n}`, '_blank', 'noopener'); return; }
      if (action === 'diff') {
        const res = await api(`repos/${r.full}/pulls/${n}`, { accept: 'application/vnd.github.diff', raw: true, signal: ctx.signal });
        const text = await res.text();
        ctx.out(ctx.isTTY ? text.split('\n').map((l) => (/^\+/.test(l) && !/^\+\+\+/.test(l) ? c.green(l) : /^-/.test(l) && !/^---/.test(l) ? c.red(l) : /^@@/.test(l) ? c.cyan(l) : /^diff /.test(l) ? c.bold(l) : l)).join('\n') : text);
        return;
      }
      const p = await api(`repos/${r.full}/pulls/${n}`, { signal: ctx.signal });
      if (action === 'checks') {
        const runs = await api(`repos/${r.full}/commits/${p.head.sha}/check-runs`, { signal: ctx.signal });
        if (!runs.check_runs.length) { ctx.out('no checks reported\n'); return; }
        ctx.out(table(runs.check_runs.map((cr) => [
          cr.status !== 'completed' ? c.yellow('*') : cr.conclusion === 'success' ? c.green('✓') : cr.conclusion === 'skipped' ? c.gray('-') : c.red('X'),
          cr.name, c.gray(cr.conclusion ?? cr.status), c.gray(cr.html_url),
        ])));
        return;
      }
      const st = p.merged_at ? 'merged' : p.state;
      ctx.out(`${c.bold(p.title)} ${c.gray(r.full + '#' + p.number)}\n${stateColor(st, p.draft)} • ${p.user.login} wants to merge ${p.commits} commit(s) into ${c.cyan(p.base.ref)} from ${c.cyan(p.head.label)}\n`);
      ctx.out(`${c.green('+' + p.additions)} ${c.red('-' + p.deletions)} • ${p.changed_files} files changed${p.mergeable_state ? ' • mergeable: ' + p.mergeable_state : ''}\n\n`);
      ctx.out(body(ctx, p.body));
      ctx.out(c.gray(`\nView this pull request on GitHub: ${p.html_url}\n`));
      return;
    }
    case 'create': case 'new': {
      requireAuth();
      let head = a.H;
      if (!head) {
        const dir = await git.findRoot({ fs: fsx.fs, filepath: ctx.cwd });
        head = await git.currentBranch({ fs: fsx.fs, dir });
      }
      const info = await api(`repos/${r.full}`, { signal: ctx.signal });
      const base = a.B ?? info.default_branch;
      let title = a.t, b = a.b;
      if (a.fill && !title) {
        try {
          const dir = await git.findRoot({ fs: fsx.fs, filepath: ctx.cwd });
          const [last] = await git.log({ fs: fsx.fs, dir, depth: 1 });
          [title, ...b] = last.commit.message.split('\n');
          b = b.join('\n').trim();
        } catch { /* ignore */ }
      }
      title = title ?? (await ctx.session.question('Title: '));
      if (!title) { ctx.err('title required\n'); return 1; }
      if (b === undefined) b = await readBody(ctx, a);
      ctx.out(`Creating pull request for ${c.cyan(head)} into ${c.cyan(base)} in ${r.full}\n`);
      const p = await api(`repos/${r.full}/pulls`, { method: 'POST', body: { title, body: b, head, base, draft: !!a.draft }, signal: ctx.signal });
      ctx.out(`${c.green('✓')} ${p.html_url}\n`);
      return;
    }
    case 'merge': {
      requireAuth();
      const n = a._[0];
      if (!n) throw new UsageError('gh pr merge <number> [--merge|--squash|--rebase]');
      const method = a.squash ? 'squash' : a.rebase ? 'rebase' : 'merge';
      const res = await api(`repos/${r.full}/pulls/${n}/merge`, { method: 'PUT', body: { merge_method: method }, signal: ctx.signal });
      ctx.out(`${c.green('✓')} ${res.message} (${method})\n`);
      if (a['delete-branch']) {
        const p = await api(`repos/${r.full}/pulls/${n}`, { signal: ctx.signal });
        if (p.head.repo?.full_name === r.full) {
          await api(`repos/${r.full}/git/refs/heads/${p.head.ref}`, { method: 'DELETE', signal: ctx.signal });
          ctx.out(`${c.green('✓')} Deleted branch ${p.head.ref}\n`);
        }
      }
      return;
    }
    case 'close': case 'reopen': {
      requireAuth();
      await api(`repos/${r.full}/pulls/${a._[0]}`, { method: 'PATCH', body: { state: action === 'close' ? 'closed' : 'open' }, signal: ctx.signal });
      ctx.out(`${c.green('✓')} ${action === 'close' ? 'Closed' : 'Reopened'} pull request #${a._[0]}\n`);
      return;
    }
    case 'comment': {
      requireAuth();
      const b = a.b ?? (await ctx.session.question('Comment: '));
      if (!b) return 1;
      const cm = await api(`repos/${r.full}/issues/${a._[0]}/comments`, { method: 'POST', body: { body: b }, signal: ctx.signal });
      ctx.out(`${c.green('✓')} ${cm.html_url}\n`);
      return;
    }
    case 'checkout': case 'co': {
      const n = a._[0];
      const p = await api(`repos/${r.full}/pulls/${n}`, { signal: ctx.signal });
      if (p.head.repo?.full_name !== r.full) throw new Error('checking out PRs from forks is not supported yet; clone the fork instead');
      await ctx.exec(['git', 'fetch', 'origin', p.head.ref]);
      return ctx.exec(['git', 'checkout', p.head.ref]);
    }
  }
  ctx.out('usage: gh pr <list|view|diff|checks|create|merge|close|reopen|comment|checkout> [-R owner/repo]\n');
}

// ---------- gh run / workflow ----------
async function run(ctx, args) {
  const [action, ...rest] = args;
  const a = parseArgs(rest, { string: ['R', 'repo', 'L', 'limit', 'w', 'workflow'], boolean: ['web'], alias: { repo: 'R', limit: 'L', workflow: 'w' } });
  const r = await currentRepo(ctx, a.R);
  const icon = (run) => run.status !== 'completed' ? c.yellow('*') : run.conclusion === 'success' ? c.green('✓') : run.conclusion === 'cancelled' || run.conclusion === 'skipped' ? c.gray('-') : c.red('X');
  if (!action || action === 'list' || action === 'ls') {
    const q = a.w ? `repos/${r.full}/actions/workflows/${a.w}/runs` : `repos/${r.full}/actions/runs`;
    const data = await api(`${q}?per_page=${parseInt(a.L ?? 20, 10)}`, { signal: ctx.signal });
    if (!data.workflow_runs.length) { ctx.out('No runs found\n'); return; }
    ctx.out(table([[c.bold('STATUS'), c.bold('TITLE'), c.bold('WORKFLOW'), c.bold('BRANCH'), c.bold('EVENT'), c.bold('ID'), c.bold('AGE')],
      ...data.workflow_runs.map((x) => [icon(x), (x.display_title ?? '').slice(0, 40), (x.name ?? '').slice(0, 24), c.cyan((x.head_branch ?? '').slice(0, 24)), x.event, String(x.id), c.gray(timeAgo(x.created_at))])]));
    return;
  }
  if (action === 'view') {
    const id = a._[0];
    if (!id) throw new UsageError('gh run view <run-id>');
    if (a.web) { window.open(`https://github.com/${r.full}/actions/runs/${id}`, '_blank', 'noopener'); return; }
    const x = await api(`repos/${r.full}/actions/runs/${id}`, { signal: ctx.signal });
    ctx.out(`${icon(x)} ${c.bold(x.display_title)} · ${x.name} · ${c.cyan(x.head_branch)} · ${x.event}\n${c.gray(x.html_url)}\n\n`);
    const jobs = await api(`repos/${r.full}/actions/runs/${id}/jobs`, { signal: ctx.signal });
    for (const j of jobs.jobs) {
      ctx.out(`${icon(j)} ${j.name}\n`);
      for (const s of j.steps ?? []) ctx.out(`   ${icon(s)} ${s.name}\n`);
    }
    return;
  }
  if (action === 'rerun') {
    requireAuth();
    await api(`repos/${r.full}/actions/runs/${a._[0]}/rerun`, { method: 'POST', signal: ctx.signal });
    ctx.out(`${c.green('✓')} Requested rerun of run ${a._[0]}\n`);
    return;
  }
  if (action === 'cancel') {
    requireAuth();
    await api(`repos/${r.full}/actions/runs/${a._[0]}/cancel`, { method: 'POST', signal: ctx.signal });
    ctx.out(`${c.green('✓')} Requested cancellation of run ${a._[0]}\n`);
    return;
  }
  ctx.out('usage: gh run <list|view|rerun|cancel> [-R owner/repo]\n');
}

async function workflow(ctx, args) {
  const [action, ...rest] = args;
  const a = parseArgs(rest, { string: ['R', 'repo', 'r', 'ref', 'f', 'field'], alias: { repo: 'R', ref: 'r', field: 'f' } });
  const r = await currentRepo(ctx, a.R);
  if (!action || action === 'list' || action === 'ls') {
    const data = await api(`repos/${r.full}/actions/workflows`, { signal: ctx.signal });
    if (!data.workflows.length) { ctx.out('No workflows found\n'); return; }
    ctx.out(table(data.workflows.map((w) => [w.name, w.state === 'active' ? c.green(w.state) : c.gray(w.state), c.gray(w.path.split('/').pop()), String(w.id)])));
    return;
  }
  if (action === 'run') {
    requireAuth();
    const wf = a._[0];
    if (!wf) throw new UsageError('gh workflow run <file.yml|id> [-r ref] [-f key=value]');
    const info = await api(`repos/${r.full}`, { signal: ctx.signal });
    const inputs = Object.fromEntries((a.fAll ?? []).map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
    await api(`repos/${r.full}/actions/workflows/${wf}/dispatches`, { method: 'POST', body: { ref: a.r ?? info.default_branch, inputs }, signal: ctx.signal });
    ctx.out(`${c.green('✓')} Created workflow_dispatch event for ${wf} at ${a.r ?? info.default_branch}\n  Watch it with: gh run list\n`);
    return;
  }
  ctx.out('usage: gh workflow <list|run> [-R owner/repo]\n');
}

// ---------- gh gist ----------
async function gist(ctx, args) {
  const [action, ...rest] = args;
  const a = parseArgs(rest, { string: ['d', 'desc', 'description', 'L', 'limit', 'f', 'filename'], boolean: ['public', 'p'], alias: { desc: 'd', description: 'd', limit: 'L', filename: 'f' } });
  requireAuth();
  if (!action || action === 'list' || action === 'ls') {
    const list = await apiAll('gists', { max: parseInt(a.L ?? 20, 10), signal: ctx.signal });
    ctx.out(table(list.map((g) => [c.cyan(g.id), (g.description || Object.keys(g.files)[0]).slice(0, 50), `${Object.keys(g.files).length} file(s)`, g.public ? 'public' : c.yellow('secret'), c.gray(timeAgo(g.updated_at))])));
    return;
  }
  if (action === 'create' || action === 'new') {
    const files = {};
    if (a._.length) for (const f of a._) files[fsx.basename(ctx.resolve(f))] = { content: await fsx.readText(ctx.resolve(f)) };
    else if (ctx.stdin) files[a.f ?? 'gistfile1.txt'] = { content: ctx.stdin };
    else throw new UsageError('gh gist create <files...> [-d desc] [--public]');
    const g = await api('gists', { method: 'POST', body: { description: a.d ?? '', public: !!(a.public || a.p), files }, signal: ctx.signal });
    ctx.out(`${c.green('✓')} Created ${g.public ? 'public' : 'secret'} gist\n${g.html_url}\n`);
    return;
  }
  if (action === 'view') {
    const g = await api(`gists/${a._[0]}`, { signal: ctx.signal });
    if (g.description) ctx.out(c.bold(g.description) + '\n\n');
    for (const [name, f] of Object.entries(g.files)) ctx.out(`${c.cyan(name)}\n\n${f.content}\n\n`);
    return;
  }
  if (action === 'delete') {
    await api(`gists/${a._[0]}`, { method: 'DELETE', signal: ctx.signal });
    ctx.out(`${c.green('✓')} Deleted gist ${a._[0]}\n`);
    return;
  }
  ctx.out('usage: gh gist <list|create|view|delete>\n');
}

// ---------- gh search / release / api / browse ----------
async function search(ctx, args) {
  const [kind, ...rest] = args;
  const a = parseArgs(rest, { string: ['L', 'limit', 'sort'], alias: { limit: 'L' } });
  const q = encodeURIComponent(a._.join(' '));
  if (!q) throw new UsageError('gh search <repos|issues|prs|code|users> <query>');
  const limit = parseInt(a.L ?? 20, 10);
  if (kind === 'repos') {
    const d = await api(`search/repositories?q=${q}&per_page=${limit}${a.sort ? '&sort=' + a.sort : ''}`, { signal: ctx.signal });
    ctx.out(`\nShowing ${d.items.length} of ${d.total_count} repositories\n\n`);
    ctx.out(table(d.items.map((r) => [c.cyan(r.full_name), (r.description ?? '').slice(0, 50), '★ ' + r.stargazers_count, c.gray(timeAgo(r.pushed_at))])));
  } else if (kind === 'issues' || kind === 'prs') {
    const d = await api(`search/issues?q=${q}+is:${kind === 'prs' ? 'pr' : 'issue'}&per_page=${limit}`, { signal: ctx.signal });
    ctx.out(table(d.items.map((i) => [c.cyan(i.repository_url.split('/').slice(-2).join('/')), c.green('#' + i.number), i.title.slice(0, 50), stateColor(i.state), c.gray(timeAgo(i.updated_at))])));
  } else if (kind === 'code') {
    requireAuth();
    const d = await api(`search/code?q=${q}&per_page=${limit}`, { signal: ctx.signal });
    ctx.out(table(d.items.map((i) => [c.cyan(i.repository.full_name), i.path])));
  } else if (kind === 'users') {
    const d = await api(`search/users?q=${q}&per_page=${limit}`, { signal: ctx.signal });
    ctx.out(table(d.items.map((u) => [c.cyan(u.login), u.type, c.gray(u.html_url)])));
  } else throw new UsageError('gh search <repos|issues|prs|code|users> <query>');
}

async function release(ctx, args) {
  const [action, ...rest] = args;
  const a = parseArgs(rest, { string: ['R', 'repo', 't', 'title', 'n', 'notes'], boolean: ['draft', 'prerelease', 'generate-notes'], alias: { repo: 'R', title: 't', notes: 'n' } });
  const r = await currentRepo(ctx, a.R);
  if (!action || action === 'list' || action === 'ls') {
    const list = await api(`repos/${r.full}/releases?per_page=20`, { signal: ctx.signal });
    if (!list.length) { ctx.out('no releases found\n'); return; }
    ctx.out(table(list.map((x) => [x.name || x.tag_name, x.draft ? c.gray('Draft') : x.prerelease ? c.yellow('Pre-release') : '', c.cyan(x.tag_name), c.gray(timeAgo(x.published_at ?? x.created_at))])));
    return;
  }
  if (action === 'view') {
    const x = await api(a._[0] ? `repos/${r.full}/releases/tags/${a._[0]}` : `repos/${r.full}/releases/latest`, { signal: ctx.signal });
    ctx.out(`${c.bold(x.name || x.tag_name)} ${c.gray(x.tag_name)}\n\n${x.body ?? ''}\n\n${c.gray(x.html_url)}\n`);
    for (const as of x.assets) ctx.out(`  ${as.name}  ${c.gray(as.browser_download_url)}\n`);
    return;
  }
  if (action === 'create') {
    requireAuth();
    const tag = a._[0];
    if (!tag) throw new UsageError('gh release create <tag> [-t title] [-n notes] [--generate-notes]');
    const x = await api(`repos/${r.full}/releases`, { method: 'POST', body: { tag_name: tag, name: a.t ?? tag, body: a.n, draft: !!a.draft, prerelease: !!a.prerelease, generate_release_notes: !!a['generate-notes'] }, signal: ctx.signal });
    ctx.out(`${c.green('✓')} ${x.html_url}\n`);
    return;
  }
  ctx.out('usage: gh release <list|view|create>\n');
}

async function apiCmd(ctx, args) {
  const a = parseArgs(args, { string: ['X', 'method', 'f', 'field', 'F', 'raw-field', 'H', 'header', 'input', 'q', 'jq'], boolean: ['paginate', 'include'], alias: { method: 'X', field: 'F', 'raw-field': 'f', header: 'H', i: 'include', jq: 'q' } });
  let endpoint = a._[0];
  if (!endpoint) throw new UsageError('gh api <endpoint> [-X METHOD] [-f key=value] [-F key=value] [--input file] [-q jqfilter]');
  if (endpoint === 'graphql') {
    const fields = Object.fromEntries([...(a.fAll ?? []), ...(a.FAll ?? [])].map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
    const { query, ...variables } = fields;
    const data = await api('graphql', { method: 'POST', body: { query, variables }, signal: ctx.signal });
    ctx.out(colorJson(data, ctx.isTTY) + '\n');
    return;
  }
  // {owner}/{repo} placeholders like the real gh
  if (endpoint.includes('{owner}') || endpoint.includes('{repo}')) {
    const r = await currentRepo(ctx);
    endpoint = endpoint.replace('{owner}', r.owner).replace('{repo}', r.repo);
  }
  const body = {};
  for (const kv of a.fAll ?? []) { const [k, v] = kv.split(/=(.*)/s); body[k] = v; }
  for (const kv of a.FAll ?? []) {
    const [k, v] = kv.split(/=(.*)/s);
    body[k] = v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v?.startsWith('@') ? await fsx.readText(ctx.resolve(v.slice(1))) : v;
  }
  let payload = Object.keys(body).length ? body : undefined;
  if (a.input) payload = JSON.parse(await fsx.readText(ctx.resolve(a.input)));
  const method = (a.X ?? (payload ? 'POST' : 'GET')).toUpperCase();
  let data;
  if (method === 'GET' && payload) {
    endpoint += (endpoint.includes('?') ? '&' : '?') + new URLSearchParams(body).toString();
    payload = undefined;
  }
  if (a.paginate && method === 'GET') data = await apiAll(endpoint, { max: 10000, signal: ctx.signal });
  else data = await api(endpoint, { method, body: payload, signal: ctx.signal });
  if (a.q) return ctx.exec(['jq', '-r', a.q], { stdin: JSON.stringify(data) });
  ctx.out(typeof data === 'string' ? data : colorJson(data, ctx.isTTY) + '\n');
}

async function browse(ctx, args) {
  const a = parseArgs(args, { string: ['R', 'repo', 'b', 'branch'], boolean: ['settings', 'issues', 'pulls', 'actions', 'wiki'], alias: { repo: 'R', branch: 'b' } });
  const r = await currentRepo(ctx, a.R);
  let url = `https://github.com/${r.full}`;
  if (a.settings) url += '/settings';
  else if (a.issues) url += '/issues';
  else if (a.pulls) url += '/pulls';
  else if (a.actions) url += '/actions';
  else if (a._[0]) url += /^\d+$/.test(a._[0]) ? `/issues/${a._[0]}` : `/blob/${a.b ?? 'HEAD'}/${a._[0]}`;
  window.open(url, '_blank', 'noopener');
  ctx.out(`Opening ${url} in your browser.\n`);
}

const SUBS = { auth, repo, issue, pr, run, workflow, gist, search, release, api: apiCmd, browse };

def('gh', async (ctx) => {
  const [cmd, ...args] = ctx.args;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    ctx.out(`${c.bold('gh')} — work with GitHub from PocketShell.

${c.yellow('CORE COMMANDS')}
  auth:       login, logout, status, token
  repo:       list, view, create, clone, fork, edit, delete
  issue:      list, view, create, close, reopen, comment
  pr:         list, view, diff, checks, create, merge, close, reopen, comment, checkout
  run:        list, view, rerun, cancel           (GitHub Actions)
  workflow:   list, run
  release:    list, view, create
  gist:       list, create, view, delete
  search:     repos, issues, prs, code, users
  browse:     open the repo in a browser tab
  api:        call any REST endpoint: gh api user  |  gh api repos/{owner}/{repo}/branches

${c.yellow('EXAMPLES')}
  gh auth login
  gh repo create my-app --public --add-readme --clone
  gh issue create -t "Bug" -b "It broke"
  gh pr create --fill
  gh api -X PATCH user -f bio="Coding from my phone"
`);
    return;
  }
  if (cmd === '--version') { ctx.out('gh (PocketShell browser edition) 1.0.0\n'); return; }
  const fn = SUBS[cmd];
  if (!fn) { ctx.err(`unknown command "${cmd}" for "gh"\nRun 'gh help' for usage.\n`); return 1; }
  return fn(ctx, args);
}, { help: 'GitHub CLI: auth, repos, issues, PRs, Actions, gists, releases, search, api. (gh help)', usage: 'gh <command> <subcommand> [flags]', category: CAT });
