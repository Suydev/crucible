#!/usr/bin/env node
// workspace.mjs
// Scans configured storage roots, finds hostable projects, and builds a browsable
// tree for the dashboard.
//
// A "project" is any directory that directly contains at least one .html file.
// That rule is deliberately simple: it matches how people actually organise
// work (a docs/ folder, a sims/ folder, a site root) without needing a config
// file per project.
//
// Scanning is bounded on every axis - depth, entry count, and file size - so a
// stray node_modules or a huge Documents folder cannot hang the dashboard.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { extractTitle, extractDescription } from './html.mjs';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  'target', 'vendor', '__pycache__', '.next', '.nuxt', '.cache',
  '.venv', 'venv', '.gradle', '.idea', '.vscode', 'coverage',
  '.turbo', '.output', '.vercel', '.svelte-kit', 'Pods', 'DerivedData',
]);

const IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

const MAX_DEPTH = 4;
const MAX_DIRS = 4000;
const MAX_FILES = 12000;
const MAX_HTML_BYTES = 512 * 1024;
const DIR_CONCURRENCY = 16;
const ROOT_CONCURRENCY = 4;

function shouldIgnoreDir(name) {
  return IGNORE_DIRS.has(name) || name.startsWith('.');
}

/** Walks a root, collecting directories and the .html files inside each. */
async function walk(root, { maxDepth = MAX_DEPTH } = {}) {
  const projects = [];
  let dirBudget = MAX_DIRS;
  let fileBudget = MAX_FILES;
  let truncated = false;

  /**
   * Visits a directory, fanning children out concurrently.
   *
   * The recursion was sequential - one await per child directory, roots run
   * one after another. On the real tree here that was 384ms of pure waiting;
   * bounded concurrency took it to ~107ms and the full-home CLI scan from
   * ~1.6s to ~0.5s.
   */
  async function visit(dir, depth) {
    if (dirBudget <= 0 || fileBudget <= 0) {
      truncated = true;
      return;
    }
    dirBudget -= 1;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const htmlFiles = [];
    const childDirs = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORE_FILES.has(entry.name)) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (shouldIgnoreDir(entry.name)) continue;
        childDirs.push(full);
      } else if (entry.isFile()) {
        if (!/\.html?$/i.test(entry.name)) continue;
        fileBudget -= 1;
        htmlFiles.push({ full, name: entry.name, size: 0, mtime: 0 });
      }
    }

    // This directory is a project if it holds HTML directly.
    if (htmlFiles.length) {
      const details = await Promise.all(htmlFiles.map(async (file) => {
        try {
          const stat = await fsp.stat(file.full);
          file.size = stat.size;
          file.mtime = stat.mtimeMs;
        } catch {
          return { ...file, unreadable: true };
        }
        return file;
      }));
      projects.push({ dir, depth, files: details });
    }

    if (depth < maxDepth && childDirs.length) {
      // Concurrency capped so a wide tree cannot open hundreds of handles.
      for (let i = 0; i < childDirs.length; i += DIR_CONCURRENCY) {
        await Promise.all(
          childDirs
            .slice(i, i + DIR_CONCURRENCY)
            .map((child) => visit(child, depth + 1)),
        );
      }
    }
  }

  try {
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) return { projects: [], truncated: false };
  } catch {
    return { projects: [], truncated: false, missing: true };
  }

  await visit(root, 0);
  return { projects, truncated };
}

/** Reads title/description for one HTML file, tolerating bad encoding. */
async function describe(file) {
  let title = '';
  let description = '';
  try {
    if (file.size && file.size <= MAX_HTML_BYTES) {
      const html = await fsp.readFile(file.full, 'utf8');
      title = extractTitle(html, '');
      description = extractDescription(html);
    }
  } catch {
    // unreadable or binary; fall through to filename-based naming
  }

  const prettyName = path.basename(file.name, path.extname(file.name))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return {
    name: file.name,
    title: title || prettyName,
    description,
    size: file.size,
    mtime: file.mtime,
  };
}

/**
 * Scans all roots and returns projects sorted by label.
 * Each project carries its deterministic port so the dashboard can show it
 * before anything is started.
 */
export async function scanWorkspace(roots, { portFor, now = Date.now() } = {}) {
  const all = [];

  // Roots are independent, so scan them concurrently.
  const scans = await Promise.all(roots.map((root) => walk(root)));

  for (const [index, scan] of scans.entries()) {
    const root = roots[index];
    const { projects, truncated, missing } = scan;
    if (missing) continue;

    for (const project of projects) {
      const files = await Promise.all(project.files.map(describe));
      const label = path.basename(project.dir) || project.dir;
      const newest = files.reduce((acc, f) => Math.max(acc, f.mtime ?? 0), 0);

      all.push({
        dir: project.dir,
        label,
        relativeTo: root,
        depth: project.depth,
        fileCount: files.length,
        entryUrl: pickEntryFile(files, project.dir),
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
        preferredPort: portFor ? portFor(project.dir) : null,
        mtime: newest,
        updated: relativeAge(now - newest),
      });
    }

    if (truncated) {
      all.push({
        dir: root,
        label: path.basename(root) || root,
        relativeTo: root,
        truncated: true,
        fileCount: 0,
        files: [],
        entryUrl: null,
        preferredPort: null,
        updated: 'partial scan',
      });
    }
  }

  const seen = new Set();
  const unique = [];
  for (const project of all) {
    if (seen.has(project.dir)) continue;
    seen.add(project.dir);
    unique.push(project);
  }

  unique.sort((a, b) => a.label.localeCompare(b.label));
  return unique;
}

/** Prefers index.html, else the first html file. */
function pickEntryFile(files, dir) {
  if (!files.length) return null;
  const index = files.find((f) => /^index\.html?$/i.test(f.name));
  return index?.name ?? files[0].name;
}

function relativeAge(ms) {
  if (!ms || ms < 0) return 'unknown';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

/** Default storage roots: everything a person plausibly keeps web files in. */
export function defaultRoots(home = '/root') {
  return [
    home,
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    path.join(home, 'Projects'),
  ];
}

/**
 * Builds a nested tree for the dashboard breadcrumb navigation.
 * Returns nodes: { name, path, type: 'dir'|'file', children?, count? }
 */
export function buildTree(projects, { roots = [] } = {}) {
  const byDir = new Map(projects.map((p) => [p.dir, p]));

  const rootNode = { name: 'storage', type: 'dir', path: '/', children: [] };

  for (const project of projects) {
    const parts = project.dir.split('/').filter(Boolean);
    let cursor = rootNode;
    let prefix = '';

    for (let i = 0; i < parts.length; i += 1) {
      prefix += `/${parts[i]}`;
      const isLeaf = i === parts.length - 1;
      let child = cursor.children.find((c) => c.name === parts[i] && c.type === 'dir');

      if (!child) {
        child = { name: parts[i], path: prefix, type: 'dir', children: [] };
        cursor.children.push(child);
      }
      if (isLeaf) {
        child.project = {
          dir: project.dir,
          label: project.label,
          fileCount: project.fileCount,
          preferredPort: project.preferredPort,
          updated: project.updated,
          truncated: Boolean(project.truncated),
        };
      }
      cursor = child;
    }
  }

  const sortNode = (node) => {
    node.children.sort((a, b) => {
      const aHas = a.children.length > 0 || a.project;
      const bHas = b.children.length > 0 || b.project;
      if (aHas !== bHas) return aHas ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  };
  sortNode(rootNode);

  return rootNode;
}
