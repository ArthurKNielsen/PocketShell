# PocketShell

A Windows Terminal–style terminal that runs entirely in your browser — with **real git**, a **GitHub CLI**, Python, JavaScript, and an optional bridge to a **real shell / SSH** on your own computer.

**Live:** https://arthurknielsen.github.io/PocketShell/

## What you get

| | |
|---|---|
| **Windows Terminal UI** | Tabs, PowerShell / Command Prompt / Bash profiles, color schemes (Campbell, One Half Dark, Dracula, Solarized…), copy/paste, a phone extra-keys bar (Esc, Tab, Ctrl, arrows) |
| **A real shell** | Pipes `\|`, `&&` / `\|\|` / `;`, redirects `>` `>>` `2>` `<`, `$VARS` / `$env:VAR` / `%VAR%`, globs `*.txt`, aliases, history (↑/↓), Tab completion, Ctrl+C, scripts (`.sh`, `.ps1`, `.bat`), `~/.pocketshellrc` |
| **Files that persist** | A full filesystem stored in your browser (IndexedDB). `ls/dir`, `cd`, `cat/type`, `cp`, `mv`, `rm`, `mkdir`, `tree`, `find`, `grep`, `head`, `tail`, `sort`, `jq`, `diff`… plus a built-in editor (`edit`, `nano`, `vim`, `code` all open it) and `upload` / `download` to move files to and from your device |
| **Real git** | `clone`, `status`, `add`, `commit`, `push`, `pull`, `fetch`, `branch`, `checkout/switch`, `merge`, `diff`, `log`, `show`, `stash`, `tag`, `reset`, `restore`, `remote`, `config` — powered by [isomorphic-git](https://isomorphic-git.org) |
| **GitHub CLI** | `gh auth login`, `gh repo list/view/create/clone/fork/delete`, `gh issue …`, `gh pr list/view/diff/checks/create/merge`, `gh run …` (Actions), `gh workflow run`, `gh release`, `gh gist`, `gh search`, `gh browse`, and `gh api` for any endpoint |
| **Connect to things** | `curl`, `wget`, `Invoke-RestMethod`, `ping`, `nslookup`, `myip`, `ws` (WebSocket client), and `connect` / `ssh` through the bridge |
| **Languages** | `python` (REPL, scripts, `pip install` — via Pyodide, loads on first use) and `node` (JS REPL / scripts) |

Type `help` for every command, or `help <command>` for one.

## Connect your GitHub

```
gh auth login
```

It walks you through making a [personal access token](https://github.com/settings/tokens/new?scopes=repo,read:org,gist,workflow&description=PocketShell) and pasting it in (hidden input). After that `gh` and `git push` just work, and your git name/email are set from your GitHub account.

```
gh repo create my-app --public --add-readme --clone
cd my-app
edit index.html
git add . && git commit -m "first page" && git push
```

The token is stored only in your browser's localStorage. `gh auth logout` removes it.

## How remote git works

Browsers can only talk to servers that allow cross-origin requests, and github.com's git endpoints don't. So clone/pull/push go through a **CORS proxy**. The default is the public `https://cors.isomorphic-git.org`. You can change it in **⌄ → Settings → Git CORS proxy**, or per session with `export GIT_CORS_PROXY=...`. The bridge (below) includes a private one.

## The bridge: a real shell, SSH, and private proxies

A web page can't run native programs or open raw TCP sockets. When you want *everything* (npm, docker, real git, ssh…), run the small bridge on a computer you control and attach to it:

```bash
cd bridge
npm install
npm start
```

It prints something like:

```
connect ws://127.0.0.1:8765 --token 3f9c…
```

Run that in PocketShell and the tab becomes a real terminal on that machine (PowerShell on Windows, your `$SHELL` elsewhere). Press **Ctrl+]** to disconnect. After the first time, `connect` alone reconnects, and `ssh user@host` works too.

- The bridge also prints a private **git CORS proxy** URL and a `CORS_PROXY` line that lets `curl` reach any site.
- To use it from your phone, expose it with a tunnel (Cloudflare Tunnel, ngrok, Tailscale…) and connect to the `wss://` URL. Anyone with the token gets a shell on that computer, so keep it secret. Set `BRIDGE_TOKEN` to keep the same token across restarts.
- `node-pty` gives a full TTY (vim, htop…). If it fails to install, the bridge still runs in a simpler line mode.

## Keyboard

| Keys | Action |
|---|---|
| Alt+T / Alt+W | New tab / close tab |
| Alt+1…9 | Switch tab |
| Ctrl+C | Copy if text is selected, otherwise interrupt |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy / paste |
| Ctrl+L | Clear screen |
| Ctrl+A / Ctrl+E / Ctrl+U / Ctrl+K / Ctrl+W | Line editing |
| Ctrl+D | Exit a REPL (or the Bash tab) |

## Deploying

The site is plain HTML/CSS/JS with vendored libraries — no build step.

- **GitHub Actions (set up):** `.github/workflows/deploy.yml` deploys on every push to `main`. In the repo go to **Settings → Pages → Build and deployment → Source** and pick **GitHub Actions** once.
- **Or deploy from a branch:** choose **Deploy from a branch → main → / (root)**. That works too (`.nojekyll` is included).

To run locally, serve the folder with any static server, e.g. `python3 -m http.server` and open http://localhost:8000.

## Project layout

```
index.html              page shell
css/style.css           Windows Terminal look
js/app.js               tabs, profiles, settings, phone key bar
js/terminal.js          xterm.js + line editor (history, completion, Ctrl keys)
js/shell.js             parser, pipes, redirects, variables, globs, scripts
js/fs.js                persistent filesystem (IndexedDB)
js/commands/*.js        every command (core, files, text, git, gh, net, lang)
vendor/                 xterm.js, isomorphic-git, LightningFS, buffer (MIT)
bridge/                 optional Node server: real shell, ssh, CORS proxies
```
