#!/usr/bin/env node
// ports.mjs
// Deterministic port assignment plus a registry of running host instances.
//
// The problem this solves: several directories want a live server at once.
// Handing each one a fixed port means collisions and remembering numbers. So a
// directory's port is DERIVED from its absolute path - the same directory
// always gets the same port on every run, on every machine. If that port is
// taken by something else, we walk forward deterministically instead of
// grabbing a random one, so the mapping stays predictable.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

export const DEFAULT_PORT = 5050;
export const PORT_RANGE_START = 5050;
export const PORT_RANGE_END = 5199;

/**
 * Ports inside the range that a browser refuses to open.
 *
 * These are Chromium's restricted "unsafe" ports (SIP blocking): 5060 is SIP,
 * 5061 is both, plus a handful of others. A project that derives one gets a
 * green "live" URL in the dashboard that curl happily fetches and no browser
 * will ever load - a silent, permanent failure that looks like a broken app.
 *
 * Measured against 38 real project directories under /root, two derived onto
 * 5060/5061, so this is not theoretical.
 */
export const BROWSER_BLOCKED_PORTS = new Set([
  5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  10080,
]);

/** True when the port is safe for a browser to load. */
export function isBrowserSafe(port) {
  return !BROWSER_BLOCKED_PORTS.has(Number(port));
}

/** Stable 32-bit hash of a path. Same input, same output, forever. */
export function hashPath(absPath) {
  return crypto.createHash('sha256').update(path.resolve(absPath)).digest();
}

/**
 * Derives the preferred port for a directory.
 *
 * Deterministic, and never a browser-blocked port: a folder that hashes onto
 * 5060 shifts forward to the next usable one, deterministically, so the mapping
 * stays stable while the resulting URL is always openable.
 */
export function preferredPortFor(absPath) {
  const digest = hashPath(absPath);
  const span = PORT_RANGE_END - PORT_RANGE_START + 1;
  const raw = PORT_RANGE_START + (digest.readUInt32BE(0) % span);
  if (isBrowserSafe(raw)) return raw;
  for (let i = 1; i <= span; i += 1) {
    const next = PORT_RANGE_START + ((raw - PORT_RANGE_START + i) % span);
    if (isBrowserSafe(next)) return next;
  }
  return raw;
}

/** Full ordered candidate list for a path, beginning with its derived port. */
export function candidatePortsFor(absPath, limit = 24) {
  const preferred = preferredPortFor(absPath);
  const out = [];
  for (let i = 0; i <= PORT_RANGE_END - PORT_RANGE_START && out.length < limit; i += 1) {
    const port = PORT_RANGE_START + ((preferred - PORT_RANGE_START + i) % (PORT_RANGE_END - PORT_RANGE_START + 1));
    if (out.includes(port)) continue;
    // Skip browser-blocked ports entirely rather than offering a URL that only
    // curl can reach.
    if (!isBrowserSafe(port)) continue;
    out.push(port);
  }
  return out;
}

/** True when a TCP server can bind the port on the given host. */
export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Picks a free port for a directory: its derived port when free, otherwise the
 * next free candidate. Returns { port, derived, drifted } where drifted means we
 * had to move off the derived port because something else held it.
 */
export async function allocatePort(absPath, { host = '127.0.0.1', preferred = null } = {}) {
  const base = preferred ?? preferredPortFor(absPath);
  const candidates = candidatePortsFor(absPath);

  // Try the caller's preference first, then the derived list.
  const ordered = preferred && !candidates.includes(preferred)
    ? [preferred, ...candidates]
    : candidates;

  for (const port of ordered) {
    if (await isPortFree(port, host)) {
      return {
        port,
        derived: base,
        drifted: port !== base,
        host,
      };
    }
  }
  throw new Error(`no free port in range ${PORT_RANGE_START}-${PORT_RANGE_END} for ${absPath}`);
}

// ---------------------------------------------------------------- registry

/**
 * Tracks every host instance started from this dashboard. Persisted as JSON so
 * the dashboard survives a restart and can clean up orphans.
 */
export class InstanceRegistry {
  constructor(filePath, { host = '127.0.0.1' } = {}) {
    this.filePath = filePath;
    this.host = host;
    /** @type {Map<string, object>} keyed by absolute directory */
    this.instances = new Map();
  }

  static keyFor(dir) {
    return path.resolve(dir);
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : parsed?.instances ?? [];
      for (const entry of entries) {
        if (entry?.dir) this.instances.set(InstanceRegistry.keyFor(entry.dir), entry);
      }
    } catch {
      // first run, or a corrupt file; start clean
    }
    return this;
  }

  /**
   * Persists the registry.
   *
   * Saves are serialised through a promise chain and the temp file gets a
   * random suffix. Both matter: register/unregister can fire concurrently, and
   * two saves sharing one temp path made one rename fail with ENOENT, which
   * left a stale instances.json behind. That file is the record of which child
   * processes to stop, so losing it leaks server processes.
   */
  async save() {
    const run = async () => {
      const payload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        instances: [...this.instances.values()],
      };
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(temp, this.filePath);
    };

    this.saveChain = (this.saveChain ?? Promise.resolve()).then(run, run);
    return this.saveChain;
  }

  get(dir) {
    return this.instances.get(InstanceRegistry.keyFor(dir)) ?? null;
  }

  list() {
    return [...this.instances.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  }

  /** True when the recorded pid is still alive. */
  async isAlive(instance) {
    if (!instance?.pid) return false;
    try {
      process.kill(instance.pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  }

  async register(dir, { port, pid, label = null, entryUrl = null }) {
    const record = {
      dir: path.resolve(dir),
      port,
      pid,
      host: this.host,
      label: label ?? path.basename(path.resolve(dir)),
      entryUrl,
      url: `http://${this.host}:${port}/`,
      startedAt: new Date().toISOString(),
    };
    this.instances.set(record.dir, record);
    await this.save();
    return record;
  }

  async unregister(dir) {
    const key = InstanceRegistry.keyFor(dir);
    const had = this.instances.delete(key);
    await this.save();
    return had;
  }

  /** Drops registry entries whose process is gone. Returns removed count. */
  async prune() {
    const dead = [];
    for (const [key, instance] of this.instances) {
      if (!(await this.isAlive(instance))) dead.push(key);
    }
    for (const key of dead) this.instances.delete(key);
    if (dead.length) await this.save();
    return dead.length;
  }

  async clear() {
    this.instances.clear();
    await this.save();
  }
}
