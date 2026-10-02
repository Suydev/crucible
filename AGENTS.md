# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

A zero-dependency local host for HTML/JS simulations. It provides a control
dashboard that scans storage roots, starts a per-directory web server on a
deterministic port, injects a live-reload runtime into every document, and
vendors CDN dependencies (three.js and friends) into a local cache.

There is no build step and no npm install. Do not add one.

## Hard rules

1. **No runtime dependencies.** Only `node:` built-ins. This is the project's
   single most important property - it is why there is no lockfile. Adding a
   package for a five-line helper is a regression. Use `node:http`,
   `node:fs`, `node:crypto`, `node:child_process`.
2. **Never mutate a served file on disk.** Runtime injection and CDN rewriting
   happen in memory per request. A file on disk is a plain HTML file and must
   stay that way, or the user loses the ability to use it without this server.
3. **Never fetch an arbitrary URL.** `lib/vendor.mjs` holds an allowlist of CDN
   hosts. Adding a host widens the trust boundary - do it deliberately.
4. **Path traversal is a hard failure, not a fallback.** Every request path is
   resolved and checked with `isInside`. A request that escapes the root is a
   403. Never "clean up" the path and continue.
5. **Ports are derived, never random.** `preferredPortFor` hashes the absolute
   path. Same directory, same port, on every machine. Random ports make the
   dashboard useless as a bookmark.
6. **The editor writes to disk.** `lib/editor.mjs` is the most dangerous module
   here. Writes must pass all three gates: the directory is a known project, the
   name is a safe allowlisted filename, and no path segment is protected. Do not
   add a way around them, and do not widen the extension list casually.
7. **Never block a write on a rescan.** A full storage scan takes seconds. Use
   `controller.rescanSoon()` so the response goes out first.
8. **Every stream needs an error listener.** An unhandled `'error'` on a
   `createReadStream` kills the process. Use `sendFileStream`, which handles it.
9. **Never mutate a served file on disk.** Injection and CDN rewriting happen in
   memory per request, so a simulation stays a plain HTML file usable without
   this server. (Restates rule 2 because it is the easiest thing to break while
   adding a feature.)

## Environment gotchas on this machine

These cost real debugging time. They are properties of the sandbox, not the code.

- **There is no `ss`. `netstat` may exist but prints an empty table here.** Do not shell out to them.
- **`/proc/net/tcp` is not readable** (permission denied), so socket-to-pid
  mapping via `/proc` is impossible.
- **`lsof` and `fuser` fail** for the same reason - they read `/proc/net`.
- **`pgrep -f` works**, and `/proc/<pid>/cmdline` is readable for our own
  processes.
- Therefore "is the port free?" is answered by an actual TCP connect attempt in
  `lib/ports.mjs`, and "who owns it?" is answered by matching command lines.
  `scripts/kill-port.mjs` encapsulates this. Do not reintroduce `ss`.

## Layout

```
server.mjs              entry point; dashboard + single-project modes
lib/config.mjs          flag/env parsing and precedence
lib/ports.mjs           deterministic port derivation + instance registry
lib/workspace.mjs       multi-root storage scan and tree building
lib/dashboard.mjs       dashboard markup, styles, and client script
lib/index-page.mjs      classic simulation index page
lib/scanner.mjs         simulation discovery for single-project mode
lib/watcher.mjs         debounced fs.watch + mtime-poll fallback
lib/live-reload.mjs     SSE hub
lib/vendor.mjs          CDN allowlist, download, and URL rewriting
lib/editor.mjs          file CRUD for the dashboard editor (security boundary)
lib/editor-ui.mjs       editor markup, styles, and client behaviour
lib/settings.mjs        persisted roots/port in ~/.crucible/config.json
lib/html.mjs            escaping, metadata extraction, runtime injection
lib/mime.mjs            content types
public/runtime/         browser runtime injected into served pages
scripts/host.sh         the permanent `host` command
scripts/kill-port.mjs   port probing and process termination
scripts/run-background.mjs  true detach for long-lived processes
scripts/check-project.mjs    project lint (no ESLint here)
scripts/list-ports.mjs       port map for every project
test/                   node:test suites, including real HTTP checks
```

## Conventions

Match the existing files rather than importing habits from elsewhere.

- `.mjs` everywhere. ESM only, named imports, no `require`.
- 2-space indent, no tabs.
- kebab-case filenames; scripts are verb-first (`check-`, `capture-`,
  `kill-port`).
- Every script opens with a shebang and a comment block giving purpose,
  `Usage:`, and exit codes.
- Shell scripts use `set -euo pipefail` and resolve their own root with
  `ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"`.
- UPPER_SNAKE for constants and env-overridable knobs, lowercase for locals.
- npm scripts are `domain:action`.
- Comments explain *why*, especially for non-obvious sandbox behaviour. Do not
  narrate what the code plainly does.
- Dashboard scripts are ES5-flavoured on purpose (no arrow functions, no
  template literals): the client code is injected as a string into a page and
  is easier to reason about in a plain style.

## Testing

```bash
npm test        # node --test test/*.test.mjs
```

Tests must not require a network connection and must not depend on which ports
happen to be occupied. `test/ports.test.mjs` shows how to test port conflicts
without assuming a clean machine.

Two traps that have already bitten this suite:

- `fetch()` normalises `/..` out of a URL before sending it, so a traversal test
  written with `fetch` passes without ever reaching the handler. Use a raw socket
  when the un-normalised bytes are the thing under test.
- A test cannot assert "the process exits", because the test runner keeps the
  event loop alive itself. Assert on the specific resource instead, via
  `process.getActiveResourcesInfo()`.

When a refactor changes a function signature used by the request path, add a
real HTTP test. `test/serve.test.mjs` exists because a signature change once
made every static asset return HTTP 500 while all 100+ unit tests passed.
`test/api.test.mjs` exists for the same reason on the API side: deleting every
`assertKnownProject()` call in `handleFileApi` - opening arbitrary-directory
write, create, delete and rename - passed the whole suite.

Two more traps in this suite:

- Node's `fetch` (undici) silently ignores the `Host` header, so a DNS-rebinding
  test written with it proves nothing. Use a raw socket.
- `for await` over a request stream destroys the stream when the loop exits
  early, resetting the socket mid-upload. `readBody` is event-based and drains
  the remainder instead; do not reintroduce `for await` there.

## Verifying changes

After touching the server, exercise the real thing rather than assuming:

```bash
node server.mjs --roots ~/some-project --list     # discovery
host                                           # dashboard
curl -s localhost:5050/__simhost/api/state       # dashboard API
```

A change that passes unit tests but was never loaded in a browser is not
verified.
