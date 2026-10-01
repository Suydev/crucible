#!/usr/bin/env node
// server.mjs
// Zero-dependency local host and control dashboard for HTML/JS simulations.
//
// Usage:
//   node server.mjs [--port 5050] [--root DIR] [--roots a,b] [--no-reload]
//
// Responsibilities:
//   1. Serve the dashboard at / - browse storage, start/stop hosts per folder.
//   2. Spawn a child sim-host process per hosted directory, each on its own
//      port derived deterministically from its absolute path.
//   3. Serve single-project mode directly when --root points at a simulations
//      folder (the original, simpler behaviour).
//   4. Inject the dev runtime into every HTML document it serves.
//   5. Rewrite CDN references to a local vendor cache so sims work offline.
//
// Design notes:
//   - Only node: built-ins. No npm install, no lockfile, no supply chain.
//   - Serving never mutates files on disk; injection happens in memory.
//   - Unknown paths 404 instead of falling back to the dashboard, so a typo is
//     visible rather than silently rendering the index.
//   - CDN fetching is restricted to an allowlist of hosts (see lib/vendor.mjs).

import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadConfig, USAGE, ROOT } from './lib/config.mjs';
import { contentTypeFor, isReloadSensitive } from './lib/mime.mjs';
import { escapeHtml, injectRuntime } from './lib/html.mjs';
import { scanSimulations } from './lib/scanner.mjs';
import { renderDashboard } from './lib/dashboard.mjs';
import { startWatching } from './lib/watcher.mjs';
import { LiveReloadHub, SSE_PATH } from './lib/live-reload.mjs';
import {
  VENDOR_PREFIX,
  rewriteCdnUrls,
  vendorOne,
  findCdnUrls,
  isVendorable,
} from './lib/vendor.mjs';
import {
  InstanceRegistry,
  allocatePort,
  isPortFree,
  preferredPortFor,
} from './lib/ports.mjs';
import { scanWorkspace } from './lib/workspace.mjs';
import {
  EditorError,
  deleteFile,
  listEditable,
  readFile,
  renameFile,
  templateFor,
  writeFile,
} from './lib/editor.mjs';

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------- log

const useColor = process.stdout.isTTY;
const C = {
  reset: useColor ? '\x1b[0m' : '',
  dim: useColor ? '\x1b[2m' : '',
  bold: useColor ? '\x1b[1m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  red: useColor ? '\x1b[31m' : '',
};
const ok = (m) => console.log(`${C.green}ok${C.reset}   ${m}`);
const warn = (m) => console.log(`${C.yellow}warn${C.reset} ${m}`);
const err = (m) => console.log(`${C.red}err${C.reset}  ${m}`);
const info = (m) => console.log(`${C.dim}info${C.reset} ${m}`);

// ---------------------------------------------------------------- helpers

function safeDecode(urlPath) {
  try {
    return decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(payload);
}

function sendJson(res, status, data) {
  sendText(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

/**
 * Streams a file to the response.
 *
 * Every stream needs an error listener. Without one, any read failure after
 * the stat succeeds - EIO, the file being unlinked mid-stream, a directory
 * (EISDIR), or the editor's atomic rename swapping the inode underneath us -
 * emits an unhandled 'error' event and takes the whole process down. A single
 * request should never be able to kill the server.
 */
function sendFileStream(req, res, absPath, stat) {
  if (!stat.isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }

  const stream = createReadStream(absPath);
  let failed = false;

  const onError = (err) => {
    failed = true;
    if (!res.headersSent) {
      sendText(res, 404, `Not found: ${err.code ?? err.message}`);
    } else {
      // Headers already promised a body we cannot deliver. Destroying the
      // response is the only way to avoid a truncated transfer hanging the
      // client until it times out.
      res.destroy(err);
    }
  };

  stream.on('error', onError);
  res.on('error', () => stream.destroy());

  if (res.headersSent) {
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentTypeFor(absPath),
    'Content-Length': stat.size,
    'Cache-Control': isReloadSensitive(absPath) ? 'no-store' : 'no-cache',
  });
  stream.pipe(res);
  if (!failed) stream.on('end', () => { /* nothing to do; pipe ends the response */ });
}

/** Accepts an absolute dir or a path relative to any configured root. */
/**
 * Resolves a caller-supplied directory and requires it to sit inside one of
 * the configured storage roots.
 *
 * The previous containment check was isInside('/', abs), which is true for
 * EVERY absolute path on the machine - path.relative('/', '/etc') is 'etc'.
 * That let the host API be pointed at any directory on the box, including /etc.
 * Checking against the configured roots, and requiring an exact project match
 * in HostController, closes that off.
 */
function resolveDir(candidate, roots) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;

  const abs = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(roots[0] ?? ROOT, candidate);

  // Allow the root itself and anything beneath one of the configured roots.
  const within = roots.some((root) => abs === path.resolve(root) || isInside(root, abs));
  return within ? abs : null;
}

// ---------------------------------------------------------------- controller

export class HostController {
  constructor(config) {
    this.config = config;
    this.roots = config.roots;
    this.registry = new InstanceRegistry(config.registryPath, { host: config.host });
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.children = new Map();
    this.projects = [];
    this.tree = { name: 'storage', type: 'dir', path: '/', children: [] };
    this.bus = new LiveReloadHub();
    this.watcher = null;
  }

  async init() {
    await this.registry.load();
    await this.rescan();
    // Drop entries whose process died while we were away.
    await this.registry.prune();
    return this;
  }

  async rescan() {
    const { buildTree } = await import('./lib/workspace.mjs');
    this.projects = await scanWorkspace(this.roots, {
      portFor: preferredPortFor,
    });
    this.tree = buildTree(this.projects, { roots: this.roots });
    this.bus.broadcast('instances', { changed: true });
    return this.projects;
  }

  /**
   * Schedules a rescan without waiting for it. A full scan of a home directory
   * takes seconds; making a file write block on that turned a 10 ms save into a
   * 7 s wait. The scan still runs so the sidebar picks the new file up, but the
   * response goes out first and repeated edits coalesce into one scan.
   */
  rescanSoon(delayMs = 50) {
    if (this.rescanTimer) return this.rescanTimer;
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      this.rescan().catch(() => {});
    }, delayMs);
    this.rescanTimer.unref?.();
    return this.rescanTimer;
  }

  /** Live instances keyed by directory, with an aliveness flag. */
  async instanceMap() {
    const out = {};
    for (const record of this.registry.list()) {
      const alive = await this.registry.isAlive(record);
      out[record.dir] = {
        port: record.port,
        pid: record.pid,
        derived: preferredPortFor(record.dir),
        alive,
        url: record.url,
        startedAt: record.startedAt,
        label: record.label,
      };
    }
    return out;
  }

  async dashboardState() {
    return {
      tree: this.tree,
      projects: this.projects.map((p) => ({
        dir: p.dir,
        label: p.label,
        fileCount: p.fileCount,
        entryUrl: p.entryUrl,
        preferredPort: p.preferredPort,
        updated: p.updated,
        truncated: Boolean(p.truncated),
        files: (p.files || []).map((f) => ({ name: f.name, title: f.title, size: f.size })),
      })),
      instances: await this.instanceMap(),
    };
  }

  /** Starts a child host for a directory, unless one is already running. */
  /**
   * True when this directory was discovered as a hostable project.
   * Host and stop both require it: without this check any directory on the
   * machine could be served, because resolveDir only constrains the path to a
   * configured root, and a root may legitimately contain unrelated folders.
   */
  isKnownProject(dir) {
    const abs = path.resolve(String(dir ?? ''));
    return this.projects.some((p) => p.dir === abs);
  }

  async hostDir(dir, { preferredPort = null } = {}) {
    const abs = resolveDir(dir, this.roots);
    if (!abs) throw new Error('invalid directory');
    if (!this.isKnownProject(abs)) {
      throw new Error(`not a hostable project: ${abs}`);
    }

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new Error(`no such directory: ${abs}`);
    }
    if (!stat.isDirectory()) throw new Error(`not a directory: ${abs}`);

    const existing = this.registry.get(abs);
    if (existing && (await this.registry.isAlive(existing))) {
      return { ...existing, alreadyRunning: true };
    }

    const { port, derived, drifted } = await allocatePort(abs, {
      host: this.config.host,
      preferred: preferredPort,
    });

    const logPath = path.join(this.config.logDir, `host-${port}.log`);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const log = await fs.open(logPath, 'a');

    const child = spawn(process.execPath, [
      SELF,
      '--single',
      '--root', abs,
      '--port', String(port),
      // Children inherit the parent's verbosity. Without this they defaulted to
      // logging every request, and a synchronous console.log to a file-backed fd
      // made each response cost ~19ms instead of ~3.7ms - a measured 5x.
      ...(this.config.quiet ? ['--quiet'] : []),
      ...(this.config.noReload ? ['--no-reload'] : []),
    ], {
      detached: true,
      // Pipes rather than the raw fd: Node makes fd-backed stdio synchronous
      // and pipe stdio async, so the log content survives without the per-write
      // stall. The streams are drained into the same file.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SIM_HOST_CHILD: '1' },
    });

    // Drain the child's output into its log file. Streamed writes keep this
    // off the request path; a failing log must never take the host down.
    const appendToLog = (stream) => {
      if (!stream) return;
      stream.on('data', (chunk) => {
        fs.appendFile(logPath, chunk).catch(() => {});
      });
      stream.on('error', () => {});
    };
    appendToLog(child.stdout);
    appendToLog(child.stderr);

    child.unref();
    await log.close().catch(() => {});

    const record = await this.registry.register(abs, {
      port,
      pid: child.pid,
      label: path.basename(abs),
      entryUrl: 'index.html',
    });

    this.children.set(abs, child);

    // Wait for the port to accept so the dashboard never shows a dead host.
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (!(await isPortFree(port, this.config.host))) break;
      await new Promise((r) => setTimeout(r, 120));
    }

    this.bus.broadcast('instances', { dir: abs });
    return { ...record, derived, drifted };
  }

  /** Stops a hosted directory, preferring a graceful SIGTERM then SIGKILL. */
  async stopDir(dir) {
    const abs = resolveDir(dir, this.roots);
    if (!abs) throw new Error('invalid directory');

    const record = this.registry.get(abs);
    const child = this.children.get(abs);

    // Nothing of ours owns this directory. Returning early avoids waiting on a
    // port we never started and, more importantly, avoids signalling a pid
    // that a stale registry entry may have left pointing at a recycled process.
    if (!record && !child) {
      return { dir: abs, stopped: false, signalled: false };
    }

    const pid = child?.pid ?? record?.pid ?? null;

    let signalled = false;
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        signalled = true;
      } catch {
        signalled = false;
      }
    }

    if (record?.port) {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if (await isPortFree(record.port, this.config.host)) break;
        await new Promise((r) => setTimeout(r, 120));
      }

      // Escalate only when we still hold a live registry record for this
      // directory, so we can never SIGKILL an unrelated process.
      if (!(await isPortFree(record.port, this.config.host))) {
        if (await this.registry.isAlive(record)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    }

    this.children.delete(abs);
    await this.registry.unregister(abs);
    this.bus.broadcast('instances', { dir: abs });
    return { dir: abs, stopped: true, signalled };
  }

  async stopAll() {
    for (const record of this.registry.list()) {
      await this.stopDir(record.dir).catch(() => {});
    }
    await this.registry.clear();
  }

  watch() {
    if (this.watcher || this.config.noReload) return;
    this.watcher = startWatching(this.roots, {
      onChange: async () => {
        const before = this.projects.length;
        await this.rescan();
        if (this.projects.length !== before) {
          this.bus.reloadAll('storage changed');
        }
      },
      onError: () => {},
      verbose: this.config.verbose,
    });
  }
}

// ---------------------------------------------------------------- static serving

/**
 * Builds a request handler that serves one directory (single-project mode).
 * This is what the dashboard spawns as a child process.
 */
export function createStaticHandler({ root, liveReload, vendorRoot, onVendor }) {
  const hub = liveReload ? new LiveReloadHub() : null;

  async function serveHtml(res, htmlPath, urlPath) {
    const raw = await fs.readFile(htmlPath, 'utf8');

    // Pull CDN deps into the local cache, then point the document at them.
    const found = findCdnUrls(raw);
    let working = raw;
    if (found.length && vendorRoot) {
      await onVendor?.(found, htmlPath);
      working = rewriteCdnUrls(working).html;
    }

    const html = injectRuntime(working, {
      cssHref: '/__simhost/runtime.css',
      jsSrc: '/__simhost/runtime.js',
      config: {
        name: path.basename(htmlPath),
        path: urlPath,
        liveReload: Boolean(liveReload),
        index: false,
      },
    });
    sendText(res, 200, html, 'text/html; charset=utf-8');
  }

  async function serveFile(req, res, absPath) {
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      sendText(res, 404, 'Not found');
      return;
    }
    sendFileStream(req, res, absPath, stat);
  }

  const handler = async (req, res) => {
    const urlPath = safeDecode(req.url ?? '/') ?? '/';

    if (urlPath === SSE_PATH) {
      if (hub) {
        hub.attach(req, res, urlPath);
      } else {
        // With live reload disabled there is no stream to attach. Returning
        // without responding left the browser waiting on a socket that would
        // never produce headers, so the request hung until it timed out.
        sendText(res, 503, 'live reload is disabled');
      }
      return;
    }

    // Vendor cache
    if (urlPath.startsWith(VENDOR_PREFIX)) {
      const rel = urlPath.slice(VENDOR_PREFIX.length);
      const abs = path.resolve(vendorRoot, rel);
      if (!isInside(vendorRoot, abs)) {
        sendText(res, 403, 'Forbidden');
        return;
      }
      try {
        await fs.access(abs);
      } catch {
        // Not cached yet: fetch it now so a cold start still works.
        const remote = `https://${rel}`;
        if (isVendorable(remote)) {
          try {
            await vendorOne(remote, vendorRoot);
            await serveFile(req, res, abs);
            return;
          } catch (error) {
            sendText(res, 502, `vendor fetch failed: ${error.message}`);
            return;
          }
        }
        sendText(res, 404, 'Not vendored');
        return;
      }
      await serveFile(req, res, abs);
      return;
    }

    // Runtime assets.
    // The name pattern alone is not enough: it accepts "..", which resolves to
    // a directory and made createReadStream emit EISDIR, killing the process.
    if (urlPath.startsWith('/__simhost/')) {
      const name = urlPath.slice('/__simhost/'.length);
      if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') {
        sendText(res, 400, 'Bad asset name');
        return;
      }
      const runtimeDir = path.join(ROOT, 'public', 'runtime');
      const abs = path.resolve(runtimeDir, name);
      if (abs !== runtimeDir && !isInside(runtimeDir, abs)) {
        sendText(res, 403, 'Forbidden');
        return;
      }
      await serveFile(req, res, abs);
      return;
    }

    // Resolve the URL to a filesystem path. A trailing slash (or "/") means
    // "this directory", so the directory-listing branch stays reachable when a
    // folder has no index.html.
    const rel = urlPath.replace(/^\/+/, '').replace(/\/+$/, '');
    const abs = path.resolve(root, rel);

    if (!isInside(root, abs) && abs !== root) {
      sendText(res, 403, 'Forbidden');
      return;
    }

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      sendText(res, 404, `404 Not found: ${escapeHtml(urlPath)}`);
      return;
    }

    if (stat.isDirectory()) {
      const index = path.join(abs, 'index.html');
      try {
        await fs.access(index);
        await serveHtml(res, index, urlPath.endsWith('/') ? urlPath : `${urlPath}/`);
      } catch {
        // No index: list the directory so it is still browsable.
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const rows = entries
          .filter((e) => !e.name.startsWith('.'))
          .map((e) => {
            const href = `${urlPath.replace(/\/$/, '')}/${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}`;
            return `<li><a href="${escapeHtml(href)}">${escapeHtml(e.name)}${e.isDirectory() ? '/' : ''}</a></li>`;
          })
          .join('');
        sendText(res, 200, `<!DOCTYPE html><meta charset="utf-8"><title>${escapeHtml(path.basename(abs))}</title>`
          + '<style>body{font:14px ui-monospace,monospace;background:#0f1115;color:#e6e9ef;padding:28px}'
          + 'li{margin:4px 0}a{color:#4fc3f7}</style>'
          + `<h2>${escapeHtml(path.basename(abs))}</h2><ul>${rows}</ul>`, 'text/html; charset=utf-8');
      }
      return;
    }

    if (/\.html?$/i.test(abs)) {
      await serveHtml(res, abs, urlPath);
      return;
    }

    await serveFile(req, res, abs);
  };

  handler.hub = hub;
  handler.close = () => hub?.closeAll();
  return handler;
}

// ---------------------------------------------------------------- main server

export function createServer(config) {
  const controller = new HostController(config);
  let simCache = [];

  const handler = async (req, res) => {
    const started = Date.now();
    const urlPath = safeDecode(req.url ?? '/') ?? '/';
    const log = (status) => {
      if (config.quiet) return;
      const tag = status >= 400 ? C.yellow : C.dim;
      console.log(`${tag}${status}${C.reset} ${urlPath} ${C.dim}${Date.now() - started}ms${C.reset}`);
    };

    try {
      // ---- single project mode
      if (config.single) {
        await staticHandler(req, res, urlPath);
        log(res.statusCode);
        return;
      }

      // ---- live reload stream (dashboard)
      if (urlPath === SSE_PATH) {
        controller.bus.attach(req, res, urlPath);
        log(200);
        return;
      }

      // ---- API
      if (urlPath.startsWith('/__simhost/api/')) {
        const action = urlPath.slice('/__simhost/api/'.length);

        if (action === 'state' && req.method === 'GET') {
          sendJson(res, 200, await controller.dashboardState());
          log(200);
          return;
        }

        if (action === 'rescan' && req.method === 'POST') {
          const projects = await controller.rescan();
          sendJson(res, 200, { ok: true, count: projects.length });
          log(200);
          return;
        }

        if (action === 'host' && req.method === 'POST') {
          const body = await readBody(req);
          let result;
          try {
            result = await controller.hostDir(body.dir, { preferredPort: body.port ?? null });
          } catch (err) {
            // A rejected directory is a client error, not a server fault.
            // Reporting 500 made a rejected request look like a crash.
            const code = /not a hostable project/.test(err.message) ? 403 : 400;
            sendJson(res, code, { error: err.message });
            log(code);
            return;
          }
          sendJson(res, 200, {
            ok: true,
            dir: result.dir,
            port: result.port,
            pid: result.pid,
            url: result.url ?? `http://${config.host}:${result.port}/`,
            derived: preferredPortFor(result.dir),
            alreadyRunning: Boolean(result.alreadyRunning),
          });
          log(200);
          return;
        }

        if (action === 'stop' && req.method === 'POST') {
          const body = await readBody(req);
          try {
            sendJson(res, 200, await controller.stopDir(body.dir));
          } catch (err) {
            const code = /invalid directory/.test(err.message) ? 400 : 500;
            sendJson(res, code, { error: err.message });
            log(code);
            return;
          }
          log(200);
          return;
        }

        // ---- editor
        if (action.startsWith('file/')) {
          await handleFileApi(action.slice('file/'.length), req, res, log, controller);
          return;
        }

        sendJson(res, 404, { error: 'unknown action' });
        log(404);
        return;
      }

      // ---- simulations index (classic mode, still available)
      if (urlPath === '/sims/' || urlPath === '/sims') {
        simCache = await scanSimulations(config.simulationsPath);
        const { renderIndex } = await import('./lib/index-page.mjs');
        sendText(res, 200, renderIndex(simCache, { port: config.port, liveReload: !config.noReload }), 'text/html; charset=utf-8');
        log(200);
        return;
      }

      if (urlPath.startsWith('/sims/')) {
        const abs = path.resolve(config.simulationsPath, urlPath.slice('/sims/'.length));
        if (!isInside(config.simulationsPath, abs)) {
          sendText(res, 403, 'Forbidden');
          log(403);
          return;
        }
        try {
          const stat = await fs.stat(abs);
          if (stat.isFile()) {
            const raw = await fs.readFile(abs, 'utf8');
            const found = /\.html?$/i.test(abs) ? findCdnUrls(raw) : [];
            let body = raw;
            if (found.length) {
              await vendorAllFor(found, abs);
              body = rewriteCdnUrls(body).html;
            }
            const html = injectRuntime(body, {
              cssHref: '/__simhost/runtime.css',
              jsSrc: '/__simhost/runtime.js',
              config: { name: path.basename(abs), path: urlPath, liveReload: !config.noReload, index: false },
            });
            sendText(res, 200, html, 'text/html; charset=utf-8');
            log(200);
            return;
          }
        } catch {
          sendText(res, 404, 'Not found');
          log(404);
          return;
        }
      }

      // ---- dashboard
      if (urlPath === '/' || urlPath === '/index.html' || urlPath === '/dashboard') {
        const html = renderDashboard({
          ...(await controller.dashboardState()),
          liveReload: !config.noReload,
          port: config.port,
        });
        sendText(res, 200, html, 'text/html; charset=utf-8');
        log(200);
        return;
      }

      // ---- runtime assets at top level
      if (urlPath.startsWith('/__simhost/')) {
        const name = urlPath.slice('/__simhost/'.length);
        if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') {
          sendText(res, 400, 'Bad asset name');
          log(400);
          return;
        }
        const runtimeDir = path.join(ROOT, 'public', 'runtime');
        const abs = path.resolve(runtimeDir, name);
        if (abs !== runtimeDir && !isInside(runtimeDir, abs)) {
          sendText(res, 403, 'Forbidden');
          log(403);
          return;
        }
        try {
          const stat = await fs.stat(abs);
          if (!stat.isFile()) {
            sendText(res, 404, 'Not found');
            log(404);
            return;
          }
          sendFileStream(req, res, abs, stat);
          log(200);
        } catch {
          sendText(res, 404, 'Not found');
          log(404);
        }
        return;
      }

      sendText(res, 404, `404 Not found: ${escapeHtml(urlPath)}\n\nThe dashboard is at /\n`);
      log(404);
    } catch (error) {
      err(`${urlPath}: ${error.message}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: error.message });
      }
      log(500);
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      if (!res.headersSent) sendText(res, 500, error.message);
    });
  });

  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  // Single mode serves a single directory directly.
  let staticHandler = null;
  if (config.single) {
    staticHandler = createStaticHandler({
      root: config.root,
      liveReload: config.noReload ? null : new LiveReloadHub(),
      vendorRoot: config.vendorPath,
      onVendor: async (urls) => {
        const { vendorAll } = await import('./lib/vendor.mjs');
        await vendorAll(urls, config.vendorPath, {
          log: (m) => { if (!config.quiet) info(m); },
        });
      },
    });
    // Routes a change to the cheapest thing that makes the browser correct.
    // CSS gets an in-place stylesheet swap so animations and accumulated state
    // survive; everything else needs a real reload.
    const toUrlPath = (absFile) => `/${path.relative(config.root, absFile).split(path.sep).join('/')}`;

    server.watchDir = () => startWatching([config.root], {
      onChange: ({ added, removed, modified }) => {
        const files = [...added, ...removed, ...modified];
        if (!files.length) return;

        const hub = staticHandler.hub;
        if (!hub) return;

        // The first stylesheet is the common case; if several changed, fall
        // back to a reload rather than swapping only one of them.
        if (files.length === 1 && /\.css$/i.test(files[0])) {
          hub.broadcast('css', { href: toUrlPath(files[0]) });
          return;
        }

        hub.reloadAll(files.length === 1 ? path.basename(files[0]) : `${files.length} files`);
      },
      onError: () => {},
      verbose: config.verbose,
    });
  }

  server.controller = controller;
  server.stop = async () => {
    controller.watcher?.close();
    controller.bus.closeAll();
    staticHandler?.close?.();
    await new Promise((resolve) => server.close(resolve));
  };
  return server;
}

/** Reads and parses a JSON request body, bounded to avoid abuse. */
async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new EditorError('request body too large', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new EditorError('invalid JSON body', 400);
  }
}

/**
 * Editor API. Writes are the dangerous operation here, so the target directory
 * must be a directory this dashboard actually discovered as a project - not
 * merely a path that resolves to something. That prevents the editor from being
 * pointed at an arbitrary directory such as /etc or a home directory config.
 */
async function handleFileApi(action, req, res, log, controller) {
  const status = (code) => log(code);

  try {
    if (action === 'list' && req.method === 'GET') {
      const dir = new URL(req.url, 'http://x').searchParams.get('dir') ?? '';
      assertKnownProject(controller, dir);
      const files = await listEditable(dir);
      status(200);
      sendJson(res, 200, { dir, files });
      return;
    }

    if (action === 'read' && req.method === 'GET') {
      const params = new URL(req.url, 'http://x').searchParams;
      const dir = params.get('dir') ?? '';
      assertKnownProject(controller, dir);
      const file = await readFile(dir, params.get('name') ?? '');
      status(200);
      sendJson(res, 200, file);
      return;
    }

    if (action === 'save' && req.method === 'POST') {
      const body = await readBody(req);
      assertKnownProject(controller, body.dir);
      const result = await writeFile(body.dir, body.name, body.content);
      status(200);
      sendJson(res, 200, result);
      controller.rescanSoon();
      return;
    }

    if (action === 'create' && req.method === 'POST') {
      const body = await readBody(req);
      assertKnownProject(controller, body.dir);
      const content = body.content ?? templateFor(body.template ?? 'html');
      const result = await writeFile(body.dir, body.name, content);
      status(200);
      sendJson(res, 200, result);
      controller.rescanSoon();
      return;
    }

    if (action === 'delete' && req.method === 'POST') {
      const body = await readBody(req);
      assertKnownProject(controller, body.dir);
      const result = await deleteFile(body.dir, body.name);
      status(200);
      sendJson(res, 200, result);
      controller.rescanSoon();
      return;
    }

    if (action === 'rename' && req.method === 'POST') {
      const body = await readBody(req);
      assertKnownProject(controller, body.dir);
      const result = await renameFile(body.dir, body.from, body.to);
      status(200);
      sendJson(res, 200, result);
      controller.rescanSoon();
      return;
    }

    sendJson(res, 404, { error: `unknown file action: ${action}` });
    status(404);
  } catch (error) {
    const code = error instanceof EditorError ? error.status : 500;
    if (code >= 500) err(`editor ${action}: ${error.message}`);
    sendJson(res, code, { error: error.message });
    status(code);
  }
}

/**
 * Rejects any directory the dashboard did not discover as a project. The
 * editor can therefore only touch folders that already contain HTML, which is
 * exactly the set a user would expect to edit here.
 */
function assertKnownProject(controller, dir) {
  const abs = path.resolve(String(dir ?? ''));
  const known = controller.projects.some((p) => p.dir === abs);
  if (!known) {
    throw new EditorError(`not an editable project: ${abs}`, 403);
  }
  return abs;
}

async function vendorAllFor(urls, contextPath) {
  const config = loadConfig();
  const { vendorAll } = await import('./lib/vendor.mjs');
  await vendorAll(urls, config.vendorPath, { log: (m) => info(`${path.basename(contextPath)}: ${m}`) });
}

// ---------------------------------------------------------------- startup

export async function start(config) {
  if (config.help) {
    console.log(USAGE.trim());
    return { server: null, stop: async () => {} };
  }

  const server = createServer(config);

  if (config.single) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
    server.watchDir?.();

    const base = `http://${config.host}:${config.port}`;
    const entry = await fs.readdir(config.root).catch(() => []);
    const hasIndex = entry.includes('index.html');

    if (!config.quiet) {
      console.log('');
      ok(`serving ${C.dim}${config.root}${C.reset}`);
      ok(`index      ${hasIndex ? base + '/' : C.yellow + 'no index.html - directory listing' + C.reset}`);
      if (!config.noReload) ok(`live reload ${C.dim}SSE${C.reset}`);
      console.log('');
    }
    return { server, stop: () => server.stop() };
  }

  await controllerInit(config, server);
  server.controller.watch();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  if (!config.quiet) {
    const base = `http://${config.host}:${config.port}`;
    const projects = server.controller.projects;
    console.log('');
    console.log(`${C.bold}sim-host${C.reset}  ${C.dim}control dashboard${C.reset}`);
    console.log('');
    ok(`dashboard  ${C.cyan}${base}/${C.reset}`);
    ok(`${projects.length} project${projects.length === 1 ? '' : 's'} across ${config.roots.length} root${config.roots.length === 1 ? '' : 's'}`);
    for (const root of config.roots) console.log(`  ${C.dim}${root}${C.reset}`);
    if (projects.length) {
      console.log('');
      for (const project of projects.slice(0, 10)) {
        console.log(`  ${C.dim}:${project.preferredPort}${C.reset}  ${project.label} ${C.dim}${project.fileCount} html${C.reset}`);
      }
      if (projects.length > 10) info(`... and ${projects.length - 10} more`);
    }
    if (!config.noReload) ok(`live reload ${C.dim}SSE${C.reset}`);
    console.log('');
    info(`${C.dim}ctrl-c to stop${C.reset}`);
    console.log('');
  }

  return {
    server,
    stop: async () => {
      await server.controller.stopAll();
      await server.stop();
    },
  };
}

async function controllerInit(config, server) {
  await server.controller.init();
}

// ---------------------------------------------------------------- cli

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SELF;

if (isMain) {
  const config = loadConfig();

  if (config.help) {
    console.log(USAGE.trim());
    process.exit(0);
  }

  if (config.list) {
    const { scanWorkspace, buildTree } = await import('./lib/workspace.mjs');
    const projects = await scanWorkspace(config.roots, { portFor: preferredPortFor });
    if (!projects.length) console.log('no projects found');
    for (const project of projects) {
      console.log(`${C.cyan}:${project.preferredPort}${C.reset}  ${project.label}  ${C.dim}${project.fileCount} html  ${project.dir}${C.reset}`);
    }
    console.log('');
    info(`${projects.length} project(s)`);
    process.exit(0);
  }

  const { server, stop } = await start(config);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('');
    info(`received ${signal}, shutting down`);
    if (config.single) {
      await stop();
    } else {
      await stop();
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
