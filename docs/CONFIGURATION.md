# Configuration

## Command-line flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `-p, --port <n>` | `5050` | Dashboard port (or the port in `--single`) |
| `--host <addr>` | `127.0.0.1` | Bind address |
| `--roots <a,b>` | home directory | Comma-separated storage roots to scan |
| `--root <dir>` | repo root | Directory served in `--single` mode |
| `--single` | off | Serve `--root` directly, no dashboard |
| `--vendor-root <d>` | `vendor` | Vendor cache directory (must be absolute, or relative to the repo) |
| `--no-reload` | off | Disable SSE live reload |
| `--list` | — | Print discovered projects and ports, then exit |
| `-q, --quiet` | off | Suppress request logging |
| `-v, --verbose` | off | Log file-watch activity |
| `--help` | — | Show usage |

Flags accept both `--port 8080` and `--port=8080`.

## Environment variables

| Variable | Equivalent |
| --- | --- |
| `SIM_HOST_PORT` | `--port` |
| `SIM_HOST_HOST` | `--host` |
| `SIM_HOST_ROOT` | `--root` |
| `SIM_HOST_ROOTS` | `--roots` |
| `SIM_HOST_DIR` | Where `host.sh` looks for `server.mjs` |

## Precedence

CLI flag beats environment variable beats built-in default. `--verbose` combined
with `--quiet` yields quiet; quiet wins.

## Ports

- **Dashboard:** `5050`, or whatever `--port` says.
- **Hosted projects:** `5050-5199`, derived from the absolute path so a folder
  always gets the same port.

| Situation | Result |
| --- | --- |
| Derived port free | Folder uses its derived port |
| Derived port taken by another project | Next free port in range; UI shows "port N taken" |
| Derived port taken by an unrelated process | Same walk-forward behaviour |
| Range exhausted | Host request fails with a clear error |

To serve a folder on a specific port, use `host <dir> <port>` or
`node server.mjs --single --root DIR --port N`.

## Storage roots

The dashboard scans, by default, your home directory. It treats a folder as a
project when that folder directly contains at least one `.html` file.

Always skipped: `node_modules`, `.git`, `dist`, `build`, `target`, `vendor`,
`__pycache__`, `.next`, `.nuxt`, `.venv`, `.gradle`, and any dot-directory.

Scan bounds, to keep a large tree responsive:

| Bound | Value |
| --- | --- |
| Max depth | 4 levels below each root |
| Max directories | 4000 |
| Max files | 12000 |
| Max HTML file parsed | 512 kB |

Narrow the scope when scanning a big home directory:

```bash
host --roots ~/projects,~/work
```

## Vendor cache

Lives in the crucible repo (`vendor/`) and is shared by all hosted projects, so
a library is stored once rather than once per folder.

```bash
rm -rf vendor/            # clear; refetched on next request
```

`vendor/manifest.json` records, per dependency: file path, SHA-256, byte size,
resolved URL, and fetch timestamp. Useful for confirming what is actually on
disk, or checking a file has not changed between runs.

To pin a dependency, use a versioned CDN URL in the source document
(`three@0.128.0`, not `three`). An unversioned URL resolves to whatever the CDN
serves that day, and the cache will keep the first result until cleared.

## Runtime injection

Every served HTML document receives, in memory:

- `<link>` to `/__simhost/runtime.css`
- `<script>` setting `window.__SIM_HOST__` to `{ name, path, liveReload, index }`
- `<script type="module">` loading `/__simhost/runtime.js`

Use these from a simulation:

```js
simHost.toast('Simulation complete');   // transient top-centre toast
simHost.status('running');               // text in the HUD pill
simHost.reload();                        // reload programmatically
simHost.onBeforeReload(() => saveState()); // run before an automatic reload
```

## Editor shortcuts

| Key | Action |
| --- | --- |
| `n` | New file (when a project is selected) |
| `Ctrl+S` / `Cmd+S` | Save the open file |
| `Alt+S` | Toggle split editor and preview |
| `Tab` | Insert two spaces |
| `r` | Rescan storage |

## CDN allowlist

Only these hosts may be vendored, and only over HTTPS:

| Host | Used for | Shape it serves |
| --- | --- | --- |
| `unpkg.com` | npm packages | raw file, keeps bare specifiers |
| `cdn.jsdelivr.net` | npm packages | `/npm/...` raw, `/+esm` re-export stub |
| `cdnjs.cloudflare.com` | cdnjs libraries | raw file |
| `esm.sh`, `esm.run` | ES module builds | tiny entry that re-exports origin-relative paths |
| `skypack.dev`, `cdn.skypack.dev`, `cdn.skypack.io` | ES module builds | re-export stub |
| `ga.jspm.io` | npm packages | raw ESM, keeps bare specifiers |

Anything else is refused. This is a security boundary rather than a proxy: an
unrestricted fetcher could be pointed at internal addresses. Redirects are
followed manually and re-validated against this list at every hop, so an
allowlisted host cannot bounce the fetcher somewhere else.

There are three CDN shapes in the wild and each is handled differently:

- **Raw file CDNs** (unpkg, jsDelivr `/npm/`, cdnjs, jspm) serve the package as
  published. Bare specifiers such as `from 'three'` survive, and an import map
  resolves them.
- **Re-export stubs** (esm.sh, skypack, jsDelivr `/+esm`) serve a tiny entry that
  re-exports origin-relative paths, e.g. `export * from '/npm/d3-array@3/+esm'`.
  Served from your own origin those would resolve to your root and 404, so they
  are rewritten to carry the vendor prefix.
- **Extensionless URLs** (`esm.sh/three@0.128.0`, `/+esm`) have no file
  extension. Chromium strict-checks MIME on module scripts, so they are served
  as `text/javascript` regardless of their name.

## What gets downloaded

The whole reachable graph, not just the URLs the document names:

1. CDN URLs are collected from the document **and** from every project-local
   `<script type="module" src="...">` it loads, since a page's bare dependencies
   often live in a module the document never reads.
2. The graph is crawled breadth-first and each file is cached before the
   document is served, so the page does not depend on the server being online
   for the deeper modules.
3. One import map is injected into the document covering bare specifiers across
   the HTML and all local modules.

Bounds, so a pathological dependency cannot hang a request:

| Bound | Value |
| --- | --- |
| Files per graph | 600 |
| Depth | 8 |
| Parallel fetches | 8 |

A walk that hits a bound logs which imports may have stayed remote.

**Cold starts are not free.** A first load of a large graph pays for the whole
download before the page is served - measured at roughly 4-9s for d3's 44-file
graph depending on CDN response. Subsequent loads read from the cache.

### Bare specifiers need an anchor

`import * as THREE from 'three'` is resolved by the import map, which means the
package must already be in the graph. A package enters the graph when some CDN
URL for it appears in the document or a local module, for example:

```html
<script type="module" src="https://unpkg.com/three@0.128.0/build/three.module.js"></script>
```

A module that uses a bare specifier with no such URL anywhere is reported as an
unmapped import rather than being guessed at. Naming the version explicitly is
always safer than letting a resolver pick one.

## Editor file rules

The editor can only touch these extensions:

```
.html .htm .css .js .mjs .json .md .txt .svg .xml
```

It refuses dotfiles, anything with a path separator, and anything inside
`node_modules`, `.git`, `vendor`, `.crucible`, `dist`, or `build`. Files are
capped at 2 MB. The target folder must be one the dashboard discovered as a
project, so pointing the editor at an arbitrary directory returns 403.

To edit something outside that set - a shell script, a Python file - use your
normal editor. The dashboard editor is for the HTML/JS simulations it serves.

## HTTP API

Everything under `/__simhost/api/` is same-origin only. Requests are refused
unless the `Host` header names loopback, the `Origin` matches, and a body is
sent as `Content-Type: application/json`. A plain `text/plain` POST from another
web page needs no CORS preflight and would otherwise be able to write files.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/state` | GET | Tree, projects, and live instances |
| `/api/rescan` | POST | Rescan storage now |
| `/api/host` | POST | Start a host: `{dir, port?}` |
| `/api/stop` | POST | Stop a host: `{dir}` |
| `/api/file/list` | GET | Editable files in a project: `?dir=` |
| `/api/file/read` | GET | One file: `?dir=&name=` |
| `/api/file/save` | POST | Write: `{dir, name, content}` |
| `/api/file/create` | POST | Create: `{dir, name, template?}` |
| `/api/file/delete` | POST | Delete: `{dir, name}` |
| `/api/file/rename` | POST | Rename: `{dir, from, to}` |

Errors are always `{"error": "<reason>"}`. Status codes: `400` invalid request,
`403` refused by a gate, `404` absent, `405` wrong method (with `Allow`),
`409` rename collision, `413` too large, `500` fault.

`port` is ignored unless it falls inside 5050-5199, so the API cannot make a
host squat on an arbitrary local port.

## Browser behaviour

| Key | Action |
| --- | --- |
| `r` | Reload |
| `i` | Go to the index / dashboard |
| `h` | Host the selected folder (dashboard) |
| `Enter` | Open the running host (dashboard) |

The HUD pill sits bottom-right, half-transparent, and brightens on hover. It
shows connection state (green live, amber connecting, red reconnecting) and the
number of open tabs when more than one.

## Logs

Background hosts write to `/tmp/crucible-<port>.log`, and `host --single` uses
`/tmp/crucible-<dirname>.log`.

```bash
tail -f /tmp/crucible-5050.log
```
