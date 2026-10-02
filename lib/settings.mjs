#!/usr/bin/env node
// settings.mjs
// Persistent settings shared by the shell entrypoint and the server, stored in
// ~/.crucible/config.json.
//
// Why this exists: `host` defaults to scanning the home directory, but a
// dashboard started with explicit --roots showed a different tree. The same
// folder could appear in one session and vanish in the next, which makes the
// deterministic ports much less useful as bookmarks.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const HOME = os.homedir();
export const STATE_DIR = path.join(HOME, '.crucible');
export const SETTINGS_PATH = path.join(STATE_DIR, 'config.json');

const DEFAULTS = {
  roots: null,          // null means "scan the home directory"
  port: 5050,
  host: '127.0.0.1',
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Reads settings, tolerating a missing or corrupt file. */
export async function readSettings() {
  try {
    const raw = await fsp.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Merges a partial update and writes atomically. Unknown keys are dropped so a
 * hand-edited file cannot inject config the server does not understand.
 */
export async function writeSettings(patch) {
  const current = await readSettings();

  const next = { ...current };
  if (isPlainObject(patch)) {
    if (Array.isArray(patch.roots)) {
      const roots = patch.roots
        .filter((r) => typeof r === 'string' && r.trim())
        .map((r) => path.resolve(r.replace(/^~(?=$|\/)/, HOME)));
      next.roots = roots.length ? roots : null;
    }
    if (typeof patch.port === 'number' && patch.port > 0 && patch.port < 65536) {
      next.port = Math.trunc(patch.port);
    }
    if (typeof patch.host === 'string' && patch.host.trim()) {
      next.host = patch.host.trim();
    }
  }

  await fsp.mkdir(STATE_DIR, { recursive: true });
  const temp = `${SETTINGS_PATH}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fsp.rename(temp, SETTINGS_PATH);
  return next;
}

/** The roots to scan, from settings or the supplied fallback. */
export async function resolveRoots(fallback = [HOME]) {
  const settings = await readSettings();
  if (Array.isArray(settings.roots) && settings.roots.length) return settings.roots;
  return fallback;
}
