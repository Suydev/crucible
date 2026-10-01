#!/usr/bin/env node
// scanner.mjs
// Discovers simulations by walking the simulations directory. Metadata is read
// from an optional sibling .meta.json; otherwise it is inferred from the HTML.
//
// Usage: import { scanSimulations } from './lib/scanner.mjs';

import fs from 'node:fs/promises';
import path from 'node:path';
import { extractTitle, extractDescription } from './html.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache']);
const MAX_DEPTH = 6;

/**
 * Recursively collects .html files, returning repo-relative POSIX-style paths.
 * Depth-limited and cycle-safe; unreadable directories are skipped silently.
 */
export async function collectHtmlFiles(dir, baseDir = dir, depth = 0) {
  if (depth > MAX_DEPTH) return [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectHtmlFiles(full, baseDir, depth + 1));
    } else if (entry.isFile() && /\.html?$/i.test(entry.name)) {
      files.push(path.relative(baseDir, full).split(path.sep).join('/'));
    }
  }
  return files;
}

/** Reads a sibling `<name>.meta.json` if present. Never throws. */
async function readMeta(absHtmlPath) {
  const metaPath = absHtmlPath.replace(/\.html?$/i, '.meta.json');
  try {
    const raw = await fs.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function titleFromFilename(relPath) {
  const base = path.basename(relPath).replace(/\.html?$/i, '');
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function relativeAge(ms) {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/**
 * Scans the simulations directory and returns sorted descriptors.
 * Each entry: { id, title, description, tags, url, file, mtime, size, updated }
 */
export async function scanSimulations(simulationsPath) {
  const files = await collectHtmlFiles(simulationsPath);
  const sims = [];

  for (const rel of files) {
    const abs = path.join(simulationsPath, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }

    const meta = await readMeta(abs);

    let inferredTitle = '';
    let inferredDesc = '';
    try {
      const html = await fs.readFile(abs, 'utf8');
      inferredTitle = extractTitle(html, '');
      inferredDesc = extractDescription(html);
    } catch {
      // unreadable file still gets listed; fall back to the filename
    }

    const title = meta?.title || inferredTitle || titleFromFilename(rel);
    const description = meta?.description || inferredDesc || '';
    const tags = Array.isArray(meta?.tags) ? meta.tags.filter((t) => typeof t === 'string') : [];

    sims.push({
      id: rel.replace(/\.html?$/i, ''),
      title,
      description,
      tags,
      url: `/sims/${rel}`,
      file: rel,
      mtime: stat.mtimeMs,
      size: stat.size,
      updated: relativeAge(Date.now() - stat.mtimeMs),
      order: Number.isFinite(meta?.order) ? meta.order : Number.MAX_SAFE_INTEGER,
    });
  }

  sims.sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));
  return sims;
}

/** Groups simulations by their top-level directory name (tag "folder"). */
export function groupByFolder(sims) {
  const groups = new Map();
  for (const sim of sims) {
    const parts = sim.file.split('/');
    const key = parts.length > 1 ? parts[0] : 'root';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sim);
  }
  return groups;
}