# Configuration

## Command-line flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `-p, --port <n>` | `5050` | Dashboard port (or the port in `--single`) |
| `--host <addr>` | `127.0.0.1` | Bind address |
| `--roots <a,b>` | home directory | Comma-separated storage roots to scan |
| `--root <dir>` | repo root | Directory served in `--single` mode |
| `--single` | off | Serve `--root` directly, no dashboard |
| `--vendor-root <d>` | `vendor` | Vendor cache directory |
| `--no-reload` | off | Disable SSE live reload |
| `--list` | — | Print discovered projects and ports, then exit |
| `-q, --quiet` | off | Suppress request logging |
| `-v, --verbose` | off | Log file-watch activity |
| `-h, --help` | — | Show usage |

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
