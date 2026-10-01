# sim-host

A local host for HTML/JS simulations with live reload, a control dashboard, and
automatic dependency vendoring. Zero dependencies - no `npm install`, no
lockfile.

```bash
host              # dashboard on http://localhost:5050
```

## Why

Running a local simulation normally means remembering a port, killing whatever
was there before, and hoping the CDN still resolves. This removes all three:

- **Dashboard instead of ports.** It scans your storage and lists every folder
  containing HTML. Press Host on any of them.
- **Smart ports.** Each folder's port is derived from its absolute path, so the
  same folder always lands on the same port. Run six projects at once without
  thinking about it.
- **Deps that just work.** A page that loads three.js from unpkg gets it
  downloaded once into a local cache and rewritten to a local path. Afterwards
  it works offline, and the exact version stays pinned.
- **Built-in editor.** Create, edit, rename, and delete files without leaving
  the dashboard, with a split preview against the live server.

## Install

```bash
git clone <this repo> ~/sim-host
```

`host` is defined in `~/.bash_aliases`, which `~/.bashrc` already sources. To
install it on a new machine:

```bash
cat >> ~/.bash_aliases <<'EOF'
host() { bash "$HOME/sim-host/scripts/host.sh" "$@"; }
hs()   { bash "$HOME/sim-host/scripts/host.sh" --stop >/dev/null 2>&1; bash "$HOME/sim-host/scripts/host.sh" "$@"; }
ha()   { bash "$HOME/sim-host/scripts/host.sh" --stop-all; }
EOF'
source ~/.bashrc
```

Then `hash -r` if the shell had already resolved the name.

## Commands

| Command | What it does |
| --- | --- |
| `host` | Start the dashboard on :5050 in the background |
| `host 8080` | ...on another port |
| `host --roots ~/projects,~/work` | Scan specific storage roots |
| `host --list` | Print discovered projects and their ports, then exit |
| `host ~/some/dir` | Serve one directory directly on its own derived port |
| `host --status` | Show the dashboard and every hosted project |
| `host --stop` | Stop the dashboard |
| `host --stop-all` | Stop the dashboard and all hosted projects |
| `hs` | Restart the dashboard |
| `ha` | Stop everything |

## Dashboard

`http://localhost:5050` is the control panel. The sidebar is your filesystem;
select a folder to see its HTML files, then press **Host**.

- **Host** starts that folder on its port.
- **Open** opens it in the browser.
- **Stop** shuts it down.
- `h` hosts the selected folder, `Enter` opens the running one, `r` rescans.

Live hosts show a green label and their port in the tree, so you can see what is
already up before starting something else.

## Editor

Select a project and the editor appears: a file list on the left, a live
preview on the right when you host it.

| Action | How |
| --- | --- |
| New file | **New**, or press `n` with a project selected |
| Choose a template | Canvas 2D, Three.js, or Empty |
| Save | **Save**, or `Ctrl+S` / `Cmd+S` |
| Split view | **Split**, or `Alt+S` in the editor |
| Rename / Delete | Buttons in the editor toolbar |

Editing an existing HTML file works too - pick it from the list. Tab inserts
two spaces instead of moving focus, and the buffer autosaves about a second
after you stop typing.

Preview shows the real hosted simulation, so what you see is what a visitor
gets. Host the folder first; the preview picks up the port automatically.

Files are saved to disk exactly as written - the dashboard editor is a thin
front end over the filesystem, not a virtual layer.

## Ports

Each directory's port is `5050 + (sha256(abs_path) mod 150)`, giving a stable
range of 5050-5199. Deterministic means a folder is always reachable at the
same address, so it can be bookmarked.

If the derived port is taken, the next free port in the range is used and the
dashboard says so. Nothing random is ever assigned.

The dashboard itself is always 5050 unless you pass another port.

## Serving a single project

To skip the dashboard entirely and serve one folder:

```bash
node server.mjs --single --root ~/path/to/project
```

That serves the directory directly, with live reload, and prints the URL.

## Live reload

Every served HTML document gets a small runtime injected in memory:

- **SSE reload.** Save a file, the browser reloads. Works for HTML, CSS, and JS
  in the served directory.
- **HUD.** Bottom-right pill showing connection state and open tab count.
- **Shortcuts.** `r` reloads, `i` returns to the index.
- **API.** `window.simHost.reload()`, `window.simHost.toast('message')`,
  `window.simHost.status('running')` for use inside a simulation.

Files on disk are never modified. Injection happens per request.

If your editor writes files in a way that misses filesystem events, the watcher
also polls modification times once a second, so a missed event is not a missed
reload.

## Dependency vendoring

A page referencing an allowlisted CDN automatically has that URL rewritten to a
local cached copy:

```html
<!-- what you write -->
<script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>

<!-- what you get -->
<script src="/__simhost/vendor/unpkg.com/three@0.128.0/build/three.min.js"></script>
```

The file is downloaded on first request and cached under `vendor/`, shared
across every hosted project. `vendor/manifest.json` records the SHA-256 of each
file so you can tell what is actually on disk.

Allowlisted hosts: unpkg, jsDelivr, cdnjs, esm.sh, skypack, raw.githubusercontent.
Anything else is refused - this is a security boundary, not a proxy.

Clear the cache with `rm -rf vendor/`; the next request re-downloads.

## Requirements

Node 20 or newer. That is the entire dependency list.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - how the pieces fit
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) - flags, env vars, ports
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) - common failures
- [AGENTS.md](AGENTS.md) - conventions for agents and contributors

## Tests

```bash
npm test
```

47 tests, no network required.
