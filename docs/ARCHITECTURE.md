# Architecture

## Two modes

`server.mjs` runs in one of two modes.

**Dashboard mode** (default) is a control plane. It scans storage roots,
discovers folders containing HTML, and spawns a child process per hosted
folder. The dashboard itself serves no project files.

**Single-project mode** (`--single --root DIR`) is a plain static server for one
directory, with live reload and no dashboard.

Keeping these separate matters: the dashboard is a long-lived process managing
many children, while a single-project server is disposable and scoped to one
folder. Merging them would put project-serving concerns into the control plane.

## Why child processes

Each hosted folder runs as its own `node server.mjs --single --root DIR --port N`
process rather than as a route inside the dashboard. The consequences:

- A crash or an unhandled error in one project cannot take down the dashboard or
  any other project.
- Each child gets its own watcher, so editing a file only notifies the browsers
  looking at that project.
- Stopping a project is just signalling one pid.

The dashboard tracks pids in `.crucible/instances.json`, so it survives a
restart and can prune entries whose process died.

## Request flow

Dashboard mode:

```
GET /
  -> renderDashboard()  with tree + projects + live instances

GET /__simhost/api/state
  -> JSON of tree, projects, and instances with an aliveness flag

POST /__simhost/api/host  {dir}
  -> resolve dir against configured roots
  -> allocate a port deterministically
  -> spawn a child server
  -> wait until the port accepts
  -> register in instances.json
  -> broadcast an SSE 'instances' event so open dashboards refresh

GET /__simhost/live
  -> SSE stream for dashboard freshness
```

Single-project mode:

```
GET /some/file.html
  -> read from disk
  -> rewrite allowlisted CDN urls to /__simhost/vendor/...
  -> download any missing vendor files
  -> inject the dev runtime (css link, config script, module script)
  -> send with no-store so the reload is never stale

GET /__simhost/vendor/<host>/<path>
  -> serve from vendor/; if absent, fetch once, then serve

GET /some/file.css|.js|.png|...
  -> served straight off disk
```

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `lib/config.mjs` | Flag/env parsing, precedence, path normalisation |
| `lib/ports.mjs` | Port derivation, allocation, instance registry |
| `lib/workspace.mjs` | Multi-root scan, project descriptors, tree building |
| `lib/dashboard.mjs` | Dashboard markup, styles, client behaviour |
| `lib/index-page.mjs` | Classic single-folder simulation index |
| `lib/scanner.mjs` | Simulation discovery with `.meta.json` support |
| `lib/watcher.mjs` | Debounced change detection |
| `lib/live-reload.mjs` | SSE hub and client registry |
| `lib/vendor.mjs` | CDN allowlist, download, URL rewriting |
| `lib/html.mjs` | Escaping, metadata extraction, runtime injection |
| `lib/mime.mjs` | Content types |

## Deterministic ports

```
port = 5050 + (sha256(absolute_path)[0..3] as uint32 mod 150)
```

Stable across runs and machines. When the derived port is occupied, allocation
walks forward through the range rather than picking randomly, so the mapping
stays explainable. `allocatePort` returns `derived` and `drifted` so the UI can
tell the user when a folder did not get its expected port.

## Change detection

`lib/watcher.mjs` uses two mechanisms:

1. `fs.watch` with `recursive: true` for instant notification.
2. A one-second mtime poll of the whole tree as a safety net.

The poll exists because inotify is unreliable on some container and bind-mounted
filesystems. A silently missed reload is much worse than a slightly slower one,
so the cost of the poll (a few `readdir` calls per second on a small tree) buys
reliability. Events are debounced 120ms so a multi-file save fires once.

## HTML injection

`injectRuntime` adds three things to any served document:

```html
<link rel="stylesheet" href="/__simhost/runtime.css" data-sim-host-runtime>
<script data-sim-host-runtime>window.__SIM_HOST__ = {...};</script>
<script type="module" src="/__simhost/runtime.js" data-sim-host-runtime></script>
```

It is idempotent, guarded by the `data-sim-host-runtime` marker, because
documents are re-processed on every request and a naive implementation would
stack duplicate tags on each load.

It also handles documents with no `<head>`, no `<body>`, or neither. Files on
disk are never written.

## Vendor pipeline

The cache is a **faithful mirror of upstream** and every transform happens at
serve time. A cached file is byte-identical to what the CDN sent, which is what
makes the SHA-256 in `manifest.json` mean anything. The browser still receives a
document it can run, because the two things it needs - a correct MIME type and
rewritten specifiers - are applied on the way out.

On a request for an HTML document:

1. `findCdnUrls` extracts allowlisted URLs from the document, and from every
   project-local module it loads. A page's bare dependencies frequently live in
   a module the document handler would otherwise never read.
2. `crawlGraph` walks the reachable graph breadth-first, eight fetches in
   flight, downloading each file into the cache. Doing this *before* responding
   is what lets a page run with the server offline: fetching deeper modules
   lazily at browser-request time left the page dependent on the server.
3. `vendorOne` writes atomically (temp file plus rename), so a crash cannot
   leave a truncated file that later looks cached.
4. `buildImportMap` derives a single import map for bare specifiers across the
   whole graph, and `injectImportMap` merges it into the document - in place,
   if the author already wrote one.
5. `rewriteCdnUrls` maps each URL to `/__simhost/vendor/<host>/<path>`.
6. `vendor/manifest.json` records SHA-256, byte size, and fetch time.

On a request for a vendor path, `rewriteModuleSource` fixes the specifier forms
a browser cannot resolve on its own: root-absolute paths (which otherwise hit
your origin) and absolute CDN URLs. Relative paths need no rewrite because the
cache preserves upstream's directory layout.

Three details that each caused a real failure:

- **Extensionless URLs get a `.js` cache name.** An esm.sh entry caches as the
  file `three@0.128.0` while its child needs that name to be a directory, and a
  filesystem cannot be both. Naming it `three@0.128.0.js` removes the collision
  and makes content-type lookup work without a heuristic.
- **Query strings fold into a `__q<hash>` suffix.** A literal `?` in a filename
  starts a query string, so the rewritten path could never match the cache.
- **`remoteUrlFor` reads the manifest** to recover the original URL. Prefixing
  `https://` to a cache path is wrong exactly when a query was folded in.

A cold request for a vendor path still fetches on demand, so a page that
hardcodes a local vendor path works even if the rewrite never ran.

### Concurrency

`crawlGraph` walks one BFS level at a time but fetches within a level
concurrently. The traversal stays a true breadth-first walk, so the depth cap
stays meaningful and the output order is deterministic; only the round trips
overlap. Measured on a 44-file graph, this was the difference between 32.6s and
1.9s. The bound is deliberately low because the CDN, not the server, is the
bottleneck.

## The editor

The dashboard can create, read, write, rename, and delete files. That makes
`lib/editor.mjs` the most security-sensitive module in the repo.

Three independent gates must all pass before a byte reaches disk:

1. **Known project.** `assertKnownProject` checks the target directory is one
   the scanner discovered as a project. An arbitrary path - `/etc`, a home
   directory config - is rejected with 403 regardless of its filename.
2. **Valid name.** The filename must be a single segment with an allowlisted
   extension (`.html`, `.htm`, `.css`, `.js`, `.mjs`, `.json`, `.md`, `.txt`, `.svg`, `.xml`).
   Separators, `..`, dotfiles, and null bytes are rejected.
3. **Safe segment.** No path segment may be dot-prefixed or one of
   `node_modules`, `.git`, `vendor`, `.crucible`, `dist`, `build`, and friends.

Writes are atomic (temp file plus rename) and capped at 2 MB, so a crash cannot
leave a truncated simulation.

### Why writes do not wait for a rescan

A full storage scan takes seconds on a home directory. Awaiting it inside the
save handler turned a 10 ms write into a 7 s request, and the browser showed
the editor hanging. Writes now respond immediately and call
`controller.rescanSoon()`, which debounces a background scan and broadcasts the
result over SSE. The sidebar still updates; the editor does not wait for it.

### Why the editor lives outside `#main`

`renderMain()` replaces `#main`'s `innerHTML` on every state change. If the
editor were inside it, each re-render would destroy the open file, the caret
position, and any unsaved buffer. It is mounted as a sibling inside the
scrollable `.content` column and only toggled with the `hidden` attribute.

`sync()` deliberately does not clear an open file just because the project list
does not contain it. A rescan triggered by our own create can arrive with a
stale snapshot, and trusting it discarded the file that had just been opened.

## Security boundaries

- **Path traversal.** Every request path is resolved and checked with
  `isInside`. Escaping the root is a 403, never a sanitised fallback.
- **CDN allowlist.** Only listed hosts may be fetched. This prevents the server
  being used as a proxy for arbitrary addresses.
- **Asset names.** Runtime asset requests must match `^[\w.-]+$`.
- **Body size.** JSON request bodies are capped at 4 MB, and file content at 2 MB.
- **Editor scope.** Writes are limited to known projects and safe filenames.
- **Scan bounds.** The workspace walk is limited by depth, directory count, file
  count, and HTML file size, so a pathological tree cannot hang the dashboard.

### Binding

The dashboard binds to `127.0.0.1` only. It serves arbitrary files from your
home directory and can write to project folders, so it must not be exposed on a
network interface. If you need remote access, tunnel it deliberately rather
than changing `--host` to `0.0.0.0`.
