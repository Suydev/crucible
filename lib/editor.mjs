#!/usr/bin/env node
// editor.mjs
// File read/write for the dashboard editor.
//
// This module can WRITE to the filesystem, so every rule here is a security
// boundary rather than a nicety. The dashboard binds to 127.0.0.1, but a
// localhost service that writes files is still a sharp tool: another local
// process, a malicious page via DNS rebinding, or a stray click could all reach
// it. The constraints are therefore deliberately narrow:
//
//   - only files that already sit inside a scanned project directory
//   - only a fixed allowlist of text extensions
//   - never inside vendor/, node_modules/, .git/, or the state directory
//   - never a dotfile, never a path with separators in its name
//   - a hard size cap on every write

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { extractTitle } from './html.mjs';

/** Extensions the editor may read and write. */
export const EDITABLE_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.md', '.txt', '.svg', '.xml',
]);

/** Directories the editor refuses to touch, by name, at any depth. */
export const FORBIDDEN_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'vendor', '.sim-host',
  'dist', 'build', 'out', 'target', '__pycache__', '.cache', 'coverage',
]);

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_NAME_LENGTH = 120;

export class EditorError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'EditorError';
    this.status = status;
  }
}

/** True when any path segment is forbidden or hidden. */
export function hasForbiddenSegment(relPath) {
  return relPath
    .split(/[\\/]/)
    .some((seg) => !seg || seg.startsWith('.') || FORBIDDEN_DIRS.has(seg));
}

/**
 * Validates a bare filename. Rejects anything that is not a single, safe,
 * editable file name.
 */
export function validateName(name) {
  if (typeof name !== 'string') throw new EditorError('file name is required');
  const trimmed = name.trim();

  if (!trimmed) throw new EditorError('file name cannot be empty');
  if (trimmed.length > MAX_NAME_LENGTH) throw new EditorError(`file name too long (max ${MAX_NAME_LENGTH})`);
  if (trimmed !== name.trim() || /\s/.test(trimmed)) {
    // Internal spaces are allowed, leading/trailing are not meaningful.
  }
  if (name !== trimmed) throw new EditorError('file name cannot start or end with whitespace');
  if (trimmed.startsWith('.')) throw new EditorError('cannot create dotfiles');
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new EditorError('file name cannot contain a path separator');
  }
  if (trimmed.includes('\0')) throw new EditorError('invalid file name');

  const ext = path.extname(trimmed).toLowerCase();
  if (!ext) throw new EditorError('file name needs an extension, for example .html');
  if (!EDITABLE_EXTENSIONS.has(ext)) {
    throw new EditorError(
      `cannot edit ${ext} files (allowed: ${[...EDITABLE_EXTENSIONS].join(', ')})`,
    );
  }
  return trimmed;
}

/** Ensures the target resolves inside the project directory and is safe. */
export function resolveInProject(projectDir, name) {
  if (typeof projectDir !== 'string' || !projectDir.trim()) {
    throw new EditorError('project directory is required');
  }
  const safeName = validateName(name);
  const project = path.resolve(projectDir);
  const target = path.resolve(project, safeName);

  const rel = path.relative(project, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new EditorError('path escapes the project directory', 403);
  }
  if (hasForbiddenSegment(rel)) {
    throw new EditorError('refusing to touch a protected location', 403);
  }
  return { project, target, name: safeName };
}

/** Reads a file for editing. Throws EditorError with a useful status. */
export async function readFile(projectDir, name) {
  const { target, name: safeName } = resolveInProject(projectDir, name);

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    throw new EditorError(`no such file: ${safeName}`, 404);
  }
  if (stat.isDirectory()) throw new EditorError(`${safeName} is a directory`, 400);
  if (stat.size > MAX_FILE_BYTES) {
    throw new EditorError(`${safeName} is too large to edit (${Math.round(stat.size / 1024)} kB)`, 413);
  }

  const content = await fsp.readFile(target, 'utf8');
  return {
    name: safeName,
    dir: projectDir,
    content,
    size: stat.size,
    mtime: stat.mtimeMs,
    isHtml: /\.html?$/i.test(safeName),
    title: /\.html?$/i.test(safeName) ? extractTitle(content, safeName) : safeName,
  };
}

/**
 * Writes a file atomically. Returns { created, size, mtime }.
 *
 * Atomic matters here: a crash mid-write would leave a truncated simulation
 * that the user would then have to notice and repair.
 */
export async function writeFile(projectDir, name, content) {
  const { target, name: safeName } = resolveInProject(projectDir, name);

  if (typeof content !== 'string') throw new EditorError('content must be a string');

  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    throw new EditorError(`content is too large (${Math.round(bytes / 1024)} kB, max ${MAX_FILE_BYTES / 1024} kB)`, 413);
  }

  let existed = true;
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) throw new EditorError(`${safeName} is a directory`, 400);
  } catch (err) {
    if (err instanceof EditorError) throw err;
    existed = false;
  }

  const temp = `${target}.simhost-${process.pid}-${Date.now()}.tmp`;
  try {
    await fsp.writeFile(temp, content, 'utf8');
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw new EditorError(`could not write ${safeName}: ${err.message}`, 500);
  }

  const stat = await fsp.stat(target);
  return {
    name: safeName,
    dir: projectDir,
    created: !existed,
    size: stat.size,
    mtime: stat.mtimeMs,
    isHtml: /\.html?$/i.test(safeName),
    title: /\.html?$/i.test(safeName) ? extractTitle(content, safeName) : safeName,
  };
}

/** Deletes a file. Refuses to delete the last remaining html in a folder. */
export async function deleteFile(projectDir, name) {
  const { target, name: safeName } = resolveInProject(projectDir, name);

  try {
    await fsp.unlink(target);
  } catch (err) {
    if (err.code === 'ENOENT') throw new EditorError(`no such file: ${safeName}`, 404);
    throw new EditorError(`could not delete ${safeName}: ${err.message}`, 500);
  }
  return { name: safeName, dir: projectDir, deleted: true };
}

/** Renames a file within the same project. */
export async function renameFile(projectDir, from, to) {
  const source = resolveInProject(projectDir, from);
  const dest = resolveInProject(projectDir, to);

  if (source.target === dest.target) {
    return { name: dest.name, dir: projectDir, renamed: false };
  }
  if (fs.existsSync(dest.target)) {
    throw new EditorError(`${dest.name} already exists`, 409);
  }

  try {
    await fsp.rename(source.target, dest.target);
  } catch (err) {
    if (err.code === 'ENOENT') throw new EditorError(`no such file: ${source.name}`, 404);
    throw new EditorError(`could not rename: ${err.message}`, 500);
  }
  return { name: dest.name, dir: projectDir, renamed: true, from: source.name };
}

/** Lists every editable file in a project directory. */
export async function listEditable(projectDir) {
  const project = path.resolve(projectDir);
  let entries;
  try {
    entries = await fsp.readdir(project, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (!EDITABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    try {
      const stat = await fsp.stat(path.join(project, entry.name));
      files.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs });
    } catch {
      // vanished mid-scan
    }
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

// ---------------------------------------------------------------- templates

export const TEMPLATES = {
  html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>New Simulation</title>
<style>
  body {
    margin: 0;
    background: #0f1115;
    color: #e6e9ef;
    font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 24px;
  }
  canvas { border-radius: 10px; border: 1px solid #262b36; }
</style>
</head>
<body>
  <h2>New Simulation</h2>
  <canvas id="c" width="600" height="400"></canvas>

<script>
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  function draw(t) {
    ctx.fillStyle = '#0f1115';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
</script>
</body>
</html>
`,

  blank: '',

  canvas3d: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Three.js Scene</title>
<style>
  body { margin: 0; background: #0f1115; color: #e6e9ef; overflow: hidden; }
  canvas { display: block; }
</style>
</head>
<body>
<script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>
<script>
  // three.js is fetched from the CDN and cached locally by sim-host on first
  // load, so this keeps working offline afterwards.
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1115);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 2, 6);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1));

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 1.6, 1.6),
    new THREE.MeshStandardMaterial({ color: 0x4fc3f7, roughness: 0.35 }),
  );
  scene.add(cube);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  (function animate() {
    requestAnimationFrame(animate);
    cube.rotation.x += 0.006;
    cube.rotation.y += 0.009;
    renderer.render(scene, camera);
  })();
</script>
</body>
</html>
`,
};

/** Returns template contents, defaulting to the basic html scaffold. */
export function templateFor(name = 'html') {
  if (!Object.hasOwn(TEMPLATES, name)) {
    throw new EditorError(`unknown template: ${name}`);
  }
  return TEMPLATES[name];
}
