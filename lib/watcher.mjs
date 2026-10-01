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

/**
 * Builds a path -> mtimeMs snapshot of every file under root.
 *
 * Breadth-first with bounded concurrency rather than recursive await-in-loop.
 * Sequential awaits made a walk take longer than the poll interval, which is
 * what caused the queueing described on startWatching(). Measured 3.47s -> 1.19s
 * on the real tree here.
 */
const SCAN_CONCURRENCY = 32;

async function snapshot(roots) {
  const files = [];

  // Phase 1: discover directories breadth-first.
  const queue = roots.map((dir) => ({ dir, depth: 0 }));
  while (queue.length) {
    const batch = queue.splice(0, SCAN_CONCURRENCY);
    const found = await Promise.all(batch.map(async ({ dir, depth }) => {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }
      const dirs = [];
      const local = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) dirs.push({ dir: full, depth: depth + 1 });
        else if (entry.isFile()) local.push(full);
      }
      return { dirs, files: local };
    }));

    for (const { dirs, files: local } of found) {
      files.push(...local);
      for (const next of dirs) {
        if (next.depth <= 8) queue.push(next);
      }
    }
  }

  // Phase 2: stat everything concurrently.
  const map = new Map();
  for (let i = 0; i < files.length; i += SCAN_CONCURRENCY) {
    const batch = files.slice(i, i + SCAN_CONCURRENCY);
    const stats = await Promise.all(batch.map(async (file) => {
      try {
        return [file, (await fsp.stat(file)).mtimeMs];
      } catch {
        return null; // file vanished mid-walk
      }
    }));
    for (const entry of stats) {
      if (entry) map.set(entry[0], entry[1]);
    }
  }

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
export function startWatching(roots, { onChange, onError, debounceMs = 120, pollMs = 5000, verbose = false }) {
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

  // A walk can take longer than the poll interval. Without this guard the poll
  // re-armed mid-walk and snapshots queued forever, so the loop never idled:
  // measured at 24-51% of a core at rest, burning fs calls continuously.
  let inFlight = false;

  const flush = async () => {
    timer = null;
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const next = await snapshot(roots);
      if (closed) return;
      const change = diffSnapshots(previous, next);
      previous = next;
      emit(change);
    } catch (err) {
      onError?.(err);
    } finally {
      inFlight = false;
    }
  };

  const schedule = () => {
    if (closed || timer) return;
    timer = setTimeout(flush, debounceMs);
  };

  // Instant path. The handles are retained so close() can release them;
  // leaving them open kept the event loop alive after shutdown.
  const watchers = [];
  for (const root of roots) {
    try {
      const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (filename && SKIP_DIRS.has(path.basename(String(filename)))) return;
        schedule();
      });
      watcher.on('error', () => { /* a dead watcher is covered by the poll */ });
      watchers.push(watcher);
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
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* already closed */ }
      }
      watchers.length = 0;
    },
  };
}