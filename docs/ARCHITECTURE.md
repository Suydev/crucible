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

The dashboard tracks pids in `.sim-host/instances.json`, so it survives a
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

1. `findCdnUrls` extracts allowlisted URLs from the document.
2. `vendorAll` downloads anything not already cached, four at a time.
3. Writes are atomic (temp file plus rename) so a crash cannot leave a
   truncated file that later looks cached.
4. `rewriteCdnUrls` maps each URL to `/__simhost/vendor/<host>/<path>`.
5. `vendor/manifest.json` records SHA-256, byte size, and fetch time.

A cold request for a vendor path also fetches on demand, so a page that hardcodes
a local vendor path works even if the rewrite never ran.

## Security boundaries

- **Path traversal.** Every request path is resolved and checked with
  `isInside`. Escaping the root is a 403, never a sanitised fallback.
- **CDN allowlist.** Only listed hosts may be fetched. This prevents the server
  being used as a proxy for arbitrary addresses.
- **Asset names.** Runtime asset requests must match `^[\w.-]+$`.
- **Body size.** JSON request bodies are capped at 64 kB.
- **Scan bounds.** The workspace walk is limited by depth, directory count, file
  count, and HTML file size, so a pathological tree cannot hang the dashboard.
