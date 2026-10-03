# Troubleshooting

## `host --stop` says the port is still in use

The server only terminates processes whose command line looks like a crucible
server. It will not kill an unrelated service that grabbed the port, because
doing so could take down something you care about.

Find out who owns it:

```bash
pgrep -af -- "--port 5050"
```

If it is a stale crucible that escaped the registry, kill it by pid. If it is
something else, either stop that service or start crucible on a different port
with `host 8080`.

## A project shows a port but nothing loads

Check the child process is alive:

```bash
host --status
curl -s localhost:5050/__simhost/api/state | head -c 2000
```

Each instance carries an `alive` flag. If it is `false`, the registry has a
stale entry; press **Rescan** in the dashboard or run `host --stop-all` and
start again.

If it is alive but the page 404s, the folder has no `index.html`. The child
server falls back to a directory listing, so `/` should show links. If it 404s
anyway, you are probably on the dashboard port rather than the project port.

## Live reload does not fire

In order of likelihood:

1. **You are editing a file outside the served root.** Children watch only their
   own directory. Serving `~/project` does not watch `~/project/vendor/lib`.
2. **The project was started before the file existed.** In dashboard mode, press
   **Rescan** or press `r`.
3. **The editor writes atomically** via rename. The mtime poll covers this, but
   only within one second. Wait a beat and reload manually with `r`.
4. **A caching proxy.** Served documents use `no-store`; a corporate proxy can
   override that.

Verify the stream is alive: the HUD pill should be green. If it is red, the SSE
connection dropped and the runtime is retrying with backoff.

## A page loads but its CDN library is missing

Check whether the URL was rewritten:

```bash
curl -s localhost:PORT/the-page.html | grep -oE '<script[^>]*src="[^"]*"'
```

Rewritten paths begin `/__simhost/vendor/`. If the original `https://` URL is
still there, the host was not on the allowlist - see the list in
[CONFIGURATION.md](CONFIGURATION.md).

Then check the cache:

```bash
ls -R vendor | head -30
cat vendor/manifest.json
```

A `502 vendor fetch failed` response means the download was attempted and failed,
usually a network problem or a version that no longer exists. Pin an existing
version and reload.

## Two folders show the same port

They should not: ports are derived from absolute paths. If it happens, the two
paths hash into a collision within the 150-port range, and the second folder was
allocated the next free port instead. The dashboard marks this with "port N
taken". Force a specific port with `host <dir> <port>`.

## The dashboard finds nothing

```bash
host --list
```

If that is empty, the roots do not contain your files. The default root is your
home directory; pass others explicitly:

```bash
host --roots ~/projects,~/Documents
```

Remember a folder only counts if it *directly* contains an `.html` file. A
folder holding only subfolders is a container, not a project.

## The scan is slow

A home directory with many large trees will take a few seconds on first scan.
Narrow it:

```bash
host --roots ~/projects
```

Hard skips (never descended into) include `node_modules`, `.git`, `dist`,
`build`, `target`, `.next`, `.nuxt`, and all dot-directories.

## A library loads but nothing renders, with no error

Check the Content-Type the vendored file is served with:

```bash
curl -sD- -o/dev/null "http://localhost:PORT/__simhost/vendor/<host>/<path>" | grep -i content-type
```

Anything that is not `text/javascript` fails module loading in Chromium before
a single line of the library runs, and the browser reports it as a MIME error
rather than a dependency problem. An extensionless CDN URL
(`esm.sh/three@0.128.0`, jsdelivr `/+esm`) is the usual culprit - it has no file
extension, so extension-based lookup returns `application/octet-stream`.

## "Failed to resolve module specifier"

The vendored module imports a bare specifier the import map does not cover.
Usually this means the package entered the graph only as a dependency of
something else, and its own entry was never referenced by URL.

The console lists which imports went unmapped. Anchor the package by naming its
URL somewhere in the page:

```html
<script type="module" src="https://unpkg.com/three@0.128.0/build/three.module.js"></script>
```

## Only the first file of a library works; the rest 404

The page is loading a library whose modules reference each other by relative or
root-absolute path. Both are handled: the cache preserves upstream's directory
layout, and root-absolute paths are rewritten at serve time. If sub-resources
still 404, clear the cache and reload - a stale cache can hold a file cached
before a path scheme changed:

```bash
rm -rf vendor/
```

## The first load takes several seconds, then it is instant

Expected on a cold cache. The whole graph is downloaded before the document is
served, which is what makes the page work offline. A large graph - d3 pulls
around 44 files - measures roughly 4-9s on a decent connection. Later loads
read from cache.

## A dependency stays online and the page needs the network

Either the download failed, or the host is not allowlisted. Both are reported on
the server console when not quiet: `vendor failed: <url> - <reason>` and
`N dependency/dependencies unavailable; left as remote URLs`. A URL left remote
is deliberately not rewritten, so the page keeps loading but falls back to the
CDN.

## Port probing fails in this sandbox

This machine has no `ss` and no `netstat`, and `/proc/net/tcp` is not readable,
so socket-to-pid mapping is impossible. `scripts/kill-port.mjs` therefore uses a
real TCP connect attempt to answer "is it free?" and `pgrep -f` to answer "who
owns it?". If you write new tooling here, do not reach for `ss` - it is absent.
See [AGENTS.md](../AGENTS.md).

## A port is stuck but nothing is listening

An orphaned child can hold a port briefly while shutting down. Check:

```bash
pgrep -af "server.mjs"
```

`host --stop-all` signals every registered child and waits up to 2.5 seconds
before escalating to SIGKILL.

## Changing the served file does nothing

Files on disk are never written, by design. Injection happens per request in
memory. If you were expecting the dev runtime to be added to your file, it is
not - check that the page is being served through a host rather than opened as
`file://`.

Opening the HTML directly from disk bypasses the server entirely: no live
reload, no vendoring, no runtime. Always go through the hosted URL.

## Port 5050 is taken by something else

```bash
pgrep -af -- "--port 5050"
```

Or move the dashboard: `host 8080`. Project ports are allocated from 5050-5199,
so an occupied 5050 does not block them unless it is a project port.

## The editor will not save or create a file

Check the console or the toast for the exact reason. The usual causes:

- **"not an editable project"** - the folder was never discovered, because it
  has no `.html` file directly inside it. Add one, press `r`, then try again.
- **"cannot edit .sh files"** - only `.html`, `.css`, `.js`, `.json`, `.md`,
  `.txt`, `.svg`, and `.xml` are editable by design.
- **"refusing to touch a protected location"** - the path resolves inside
  `node_modules`, `.git`, `vendor`, or `.crucible`.

## The preview pane is blank

The preview needs a running host. Press **Host** on the project first; the pane
otherwise shows "Host this folder to preview changes here."

If it is hosted and still blank, the folder has no `index.html` and no file is
open. Pick a file from the list.

## The editor disappears when I click another folder

That was a real bug, fixed by moving the editor out of `#main`. If you see it
again after pulling, check that `renderEditorPanel()` is inside `.content` in
`lib/dashboard.mjs` rather than inside `<main>`.

## Saving feels slow

Writes no longer wait for a storage rescan; they should return in well under a
second. If a save takes seconds, an older server is still running. Stop it with
`host --stop-all` and start again.

## Two dashboards are fighting over the port

Only one can own the dashboard port. Run `host --stop` before starting another,
or use `host 8080` to run a second one on a different port.
