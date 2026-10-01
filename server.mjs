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
  vendorPathFor,
  vendorOne,
  findCdnUrls,
  isVendorable,
} from './lib/vendor.mjs';
import {
  DEFAULT_PORT,
  InstanceRegistry,
  allocatePort,
  isPortFree,
  preferredPortFor,
} from './lib/ports.mjs';
import { defaultRoots, scanWorkspace } from './lib/workspace.mjs';

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

/** Accepts an absolute dir or a path relative to any configured root. */
function resolveDir(candidate, roots) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const abs = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(roots[0] ?? ROOT, candidate);
  return isInside('/', abs) ? abs : null;
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
  async hostDir(dir, { preferredPort = null } = {}) {
    const abs = resolveDir(dir, this.roots);
    if (!abs) throw new Error('invalid directory');

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
      ...(this.config.noReload ? ['--no-reload'] : []),
    ], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, SIM_HOST_CHILD: '1' },
    });

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

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      if (!(await isPortFree(record?.port ?? 0, this.config.host))) break;
      await new Promise((r) => setTimeout(r, 120));
    }

    if (record && !(await isPortFree(record.port, this.config.host))) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
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

  async function serveFile(res, absPath) {
    const headers = {
      'Content-Type': contentTypeFor(absPath),
      'Cache-Control': isReloadSensitive(absPath) ? 'no-store' : 'no-cache',
    };
    try {
      const stat = await fs.stat(absPath);
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      createReadStream(absPath).pipe(res);
    } catch {
      sendText(res, 404, 'Not found');
    }
  }

  const handler = async (req, res) => {
    const urlPath = safeDecode(req.url ?? '/') ?? '/';

    if (urlPath === SSE_PATH) {
      hub?.attach(req, res, urlPath);
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
            await serveFile(res, abs);
            return;
          } catch (error) {
            sendText(res, 502, `vendor fetch failed: ${error.message}`);
            return;
          }
        }
        sendText(res, 404, 'Not vendored');
        return;
      }
      await serveFile(res, abs);
      return;
    }

    // Runtime assets
    if (urlPath.startsWith('/__simhost/')) {
      const name = urlPath.slice('/__simhost/'.length);
      if (!/^[\w.-]+$/.test(name)) {
        sendText(res, 400, 'Bad asset name');
        return;
      }
      await serveFile(res, path.join(ROOT, 'public', 'runtime', name));
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

    await serveFile(res, abs);
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
          const result = await controller.hostDir(body.dir, { preferredPort: body.port ?? null });
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
          sendJson(res, 200, await controller.stopDir(body.dir));
          log(200);
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
        if (!/^[\w.-]+$/.test(name)) {
          sendText(res, 400, 'Bad asset name');
          log(400);
          return;
        }
        try {
          const abs = path.join(ROOT, 'public', 'runtime', name);
          const stat = await fs.stat(abs);
          res.writeHead(200, {
            'Content-Type': contentTypeFor(abs),
            'Content-Length': stat.size,
            'Cache-Control': 'no-store',
          });
          createReadStream(abs).pipe(res);
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
    server.watchDir = () => startWatching([config.root], {
      onChange: ({ added, removed, modified }) => {
        const files = [...added, ...removed, ...modified];
        staticHandler.hub?.reloadAll(files.length ? path.basename(files[0]) : 'change');
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
async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
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
