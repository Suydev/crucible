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

/** Stable 32-bit hash of a path. Same input, same output, forever. */
export function hashPath(absPath) {
  return crypto.createHash('sha256').update(path.resolve(absPath)).digest();
}

/** Derives the preferred port for a directory. */
export function preferredPortFor(absPath) {
  const digest = hashPath(absPath);
  const span = PORT_RANGE_END - PORT_RANGE_START + 1;
  return PORT_RANGE_START + (digest.readUInt32BE(0) % span);
}

/** Full ordered candidate list for a path, beginning with its derived port. */
export function candidatePortsFor(absPath, limit = 24) {
  const preferred = preferredPortFor(absPath);
  const out = [];
  for (let i = 0; i < limit; i += 1) {
    const port = PORT_RANGE_START + ((preferred - PORT_RANGE_START + i) % (PORT_RANGE_END - PORT_RANGE_START + 1));
    if (!out.includes(port)) out.push(port);
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

  async save() {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      instances: [...this.instances.values()],
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.filePath);
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
