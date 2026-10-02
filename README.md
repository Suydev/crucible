<p align="center">
  <img src="assets/logo.png" alt="crucible" width="520">
</p>

<p align="center">
  <b>Local host and control dashboard for HTML/JS simulations.</b><br>
  <sub>Zero dependencies. No build step. No <code>npm install</code>.</sub>
</p>

---

Running a local simulation usually means remembering a port, killing whatever
was there before, and hoping the CDN still resolves. **crucible** removes all
three.

- **A dashboard instead of ports.** It scans your storage and lists every folder
  containing HTML. Press **Host** on any of them.
- **Ports that never move.** Each folder's port is derived from its absolute
  path, so the same folder always lands on the same port. Bookmark it. Run
  twelve projects at once without thinking about it.
- **Dependencies that just work.** A page loading three.js from unpkg gets it
  downloaded once into a local cache and rewritten to a local path. Afterwards
  it works offline, with the version still pinned.
- **An editor in the browser.** Create, edit, rename, and delete files without
  leaving the dashboard, with a split preview against the live server.

<p align="center">
  <img src="assets/logo-mark-128.png" alt="" width="96">
</p>

## Install

```bash
git clone https://github.com/Suydev/crucible.git ~/crucible
```

Then add the command to `~/.bash_aliases` (which `~/.bashrc` already sources):

```bash
cat >> ~/.bash_aliases <<'EOF'
host() { bash "$HOME/crucible/scripts/host.sh" "$@"; }
hs()   { bash "$HOME/crucible/scripts/host.sh" --stop >/dev/null 2>&1; bash "$HOME/crucible/scripts/host.sh" "$@"; }
ha()   { bash "$HOME/crucible/scripts/host.sh" --stop-all; }
EOF

source ~/.bashrc
```

```bash
host          # dashboard on http://localhost:5050
```

## Commands

| Command | What it does |
| --- | --- |
| `host` | Start the dashboard on :5050 in the background |
| `host 8080` | ...on another port |
| `host --roots ~/projects,~/work` | Scan specific storage roots |
| `host --set-roots a,b` | Remember those roots for next time |
| `host <dir>` | Serve one directory directly on its own port |
| `host --list` | Print discovered projects with their ports |
| `host --status` | Show the dashboard and every hosted project |
| `host --stop` | Stop the dashboard |
| `host --stop-all` | Stop the dashboard and all hosted projects |
| `hs` | Restart the dashboard |
| `ha` | Stop everything |
| `npm run ports` | Port map for every project, and whether it is free |
| `npm run lint` | Project rules: syntax, scripts exist, no deps, strict mode |

## The dashboard

`http://localhost:5050` is the control panel. The sidebar is your filesystem.

- **Host** starts that folder on its port.
- **Open** opens it in the browser.
- **Stop** shuts it down.
- `h` hosts the selected folder, `Enter` opens the running one, `r` rescans,
  `n` creates a file.

Live hosts show a green label and their port, so you can see what is already
running before starting something else.

## The editor

Select a project and the editor appears: a file list on the left, a live
preview on the right when you host it.

| Action | How |
| --- | --- |
| New file | **New**, or `n` with a project selected |
| Choose a template | Canvas 2D, Three.js, or Empty |
| Save | **Save**, or `Ctrl+S` / `Cmd+S` |
| Split view | **Split**, or `Alt+S` in the editor |
| Rename / Delete | Buttons in the editor toolbar |

Editing an existing HTML file works too - pick it from the list. `Tab` inserts
two spaces instead of moving focus, and the buffer autosaves about a second
after you stop typing. Switching projects with unsaved work prompts first.

Preview shows the real hosted simulation, so what you see is what a visitor
gets. Files are written exactly as you typed them; the editor is a thin front
end over the filesystem, not a virtual layer.

## Ports

Each directory's port is `5050 + (sha256(abs_path) mod 150)`, giving a stable
range of 5050-5199. Deterministic means a folder is always reachable at the
same address.

| Situation | Result |
| --- | --- |
| Derived port is free | Folder uses its derived port |
| Derived port is taken | Next free port in range; the UI says "port N taken" |
| Range exhausted | The host request fails with a clear error |

```bash
npm run ports     # what is assigned, and what is currently occupied
```

## Live reload

Every served document gets a small runtime injected **in memory** - the file on
disk is never modified, so a simulation stays a plain HTML file you can use
without this server.

- **Reload on save.** HTML, CSS, and JS in the served directory.
- **CSS swaps in place.** Editing a stylesheet does *not* navigate. Animations,
  timers, and accumulated state all survive, and you reload only when a change
  actually needs it.
- **State survives reloads.** `simHost.state`, scroll position, and form values
  are restored, so a one-line edit does not cost you the camera position you had
  tuned to reproduce a bug.
- **Errors on the page.** An uncaught exception or rejected promise appears in a
  dismissible card. You do not need DevTools open to see that your physics loop
  is throwing.

```js
simHost.state.camera = { x: 3 };   // preserved across reloads
simHost.reload();
simHost.toast('saved');
simHost.warn('careful');
```

`fs.watch` drives reloads. A one-minute mtime poll is a fallback for filesystems
where inotify is unreliable - it only polls that fast when `fs.watch` could not
be armed at all, because re-walking the tree costs roughly a millisecond per
file and would otherwise dominate idle CPU.

Measured idle cost over a 200-file tree: **0.01% of a core**.

## Dependency vendoring

A page referencing an allowlisted CDN has that URL rewritten to a local cached
copy:

```html
<!-- what you write -->
<script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>

<!-- what you get -->
<script src="/__simhost/vendor/unpkg.com/three@0.128.0/build/three.min.js"></script>
```

Downloaded on first request and cached in `vendor/`, shared across every hosted
project so a library is stored once. `vendor/manifest.json` records the SHA-256
of each file, so you can tell exactly what is on disk.

Allowlisted: unpkg, jsDelivr, cdnjs, esm.sh, skypack. Anything else is refused -
this is a security boundary, not a proxy. Clear the cache with `rm -rf vendor/`.

## Settings

Roots and port persist in `~/.crucible/config.json`, so the dashboard shows the
same projects every session and ports stay bookmarkable.

```bash
host --set-roots ~/projects,~/work
host --show-settings
```

## Design notes

A few decisions that are load-bearing rather than incidental:

- **Child processes, not routes.** Each hosted folder runs as its own server.
  One project crashing cannot take down the dashboard or any other project, and
  stopping a project is just signalling one pid.
- **Writes never block on a scan.** A full storage scan takes seconds. Saving
  responds first and rescans in the background - that one change took a save
  from 7 seconds to 0.3.
- **The editor is mounted outside `#main`.** The project list re-renders on
  every state change; if the editor lived inside it, each re-render would
  destroy the open file and any unsaved buffer.
- **Binds `127.0.0.1` only.** It serves files from your home directory and can
  write to project folders. Tunnel it deliberately; do not bind it to
  `0.0.0.0`.

## Requirements

Node 20 or newer. That is the entire dependency list.

## Tests

```bash
npm test        # 119 tests, no network required
npm run lint
```

The suite makes real HTTP requests against a live server. Unit tests alone
missed a bug where every static asset returned HTTP 500 after a refactor while
all 100+ of them still passed.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - how the pieces fit
- [Configuration](docs/CONFIGURATION.md) - flags, env vars, ports
- [Troubleshooting](docs/TROUBLESHOOTING.md) - common failures
- [AGENTS.md](AGENTS.md) - conventions for contributors

## License

MIT