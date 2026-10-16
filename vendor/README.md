Third-party libraries, vendored so the site works without a build step:

| File | Package | License |
| --- | --- | --- |
| xterm.mjs, xterm.css | @xterm/xterm 6.0.0 | MIT |
| addon-fit.mjs | @xterm/addon-fit 0.11.0 | MIT |
| addon-web-links.mjs | @xterm/addon-web-links 0.12.0 | MIT |
| isomorphic-git.umd.min.js | isomorphic-git 1.44.2 | MIT |
| isomorphic-git-http.umd.js | isomorphic-git/http/web 1.44.2 | MIT |
| lightning-fs.min.js | @isomorphic-git/lightning-fs 4.6.2 | MIT |
| buffer.min.js | buffer 6.0.3 (bundled with esbuild) | MIT |

Python is loaded on demand from the Pyodide CDN (MPL-2.0).
