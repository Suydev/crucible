#!/usr/bin/env node
// watcher.mjs
// Watches a set of roots for changes and emits debounced events.
//
// Strategy: fs.watch for instant notification, plus a low-frequency mtime poll
// as a safety net. The poll matters because fs.watch is unreliable on some
// network/container filesystems (inotify limits, bind mounts), and a silent
// missed reload is worse than a slightly slower one.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);

/** Builds a path -> mtimeMs snapshot of every file under root. */
async function snapshot(roots) {
  const map = new Map();

  async function walk(dir, depth = 0) {
    if (depth > 8) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(full);
          map.set(full, stat.mtimeMs);
        } catch {
          // file vanished mid-walk
        }
      }
    }
  }

  for (const root of roots) await walk(root);
  return map;
}

/** Returns files added, removed, or modified between two snapshots. */
export function diffSnapshots(before, after) {
  const added = [];
  const removed = [];
  const modified = [];

  for (const [file, mtime] of after) {
    if (!before.has(file)) added.push(file);
    else if (before.get(file) !== mtime) modified.push(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) removed.push(file);
  }
  return { added, removed, modified };
}

/**
 * Starts watching roots. onChange receives { added, removed, modified, files }.
 * Events are debounced by debounceMs to coalesce multi-file saves.
 */
export function startWatching(roots, { onChange, onError, debounceMs = 120, pollMs = 1000, verbose = false }) {
  let previous = new Map();
  let timer = null;
  let closed = false;

  const emit = (change) => {
    const files = [...change.added, ...change.removed, ...change.modified];
    if (!files.length) return;
    if (verbose) {
      console.log(`[watch] ${change.added.length}+ ${change.removed.length}- ${change.modified.length}~ ${files.length} file(s)`);
    }
    onChange(change);
  };

  const flush = async () => {
    timer = null;
    if (closed) return;
    try {
      const next = await snapshot(roots);
      const change = diffSnapshots(previous, next);
      previous = next;
      emit(change);
    } catch (err) {
      onError?.(err);
    }
  };

  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(flush, debounceMs);
  };

  // Instant path
  for (const root of roots) {
    try {
      fs.watch(root, { recursive: true }, (_event, filename) => {
        if (filename && SKIP_DIRS.has(path.basename(String(filename)))) return;
        schedule();
      });
    } catch (err) {
      // fs.watch may be unavailable; the poll below still covers us
      onError?.(err);
    }
  }

  // Safety-net path
  const poll = setInterval(schedule, pollMs);

  snapshot(roots)
    .then((snap) => { previous = snap; })
    .catch((err) => onError?.(err));

  return {
    close() {
      closed = true;
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}