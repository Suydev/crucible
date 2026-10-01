// test/editor.test.mjs
// The editor writes to the filesystem, so validation is the feature under test
// as much as the CRUD itself. Each "refuses" case is a path that must never
// reach the disk.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  EditorError,
  EDITABLE_EXTENSIONS,
  MAX_FILE_BYTES,
  deleteFile,
  listEditable,
  readFile,
  renameFile,
  resolveInProject,
  templateFor,
  validateName,
  writeFile,
} from '../lib/editor.mjs';

async function makeProject() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-ed-'));
  const project = path.join(base, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, 'existing.html'), '<html><title>Existing</title></html>');
  await fs.mkdir(path.join(project, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(project, 'node_modules', 'x.html'), 'nope');
  return { base, project };
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- names

test('validateName accepts ordinary editable names', () => {
  assert.equal(validateName('sim.html'), 'sim.html');
  assert.equal(validateName('my simulation.css'), 'my simulation.css');
  assert.equal(validateName('a.b.js'), 'a.b.js');
});

test('validateName rejects path separators and traversal', () => {
  for (const bad of ['../evil.html', 'a/b.html', 'a\\b.html', '../../etc/passwd']) {
    assert.throws(() => validateName(bad), EditorError, `should reject ${bad}`);
  }
});

test('validateName rejects dotfiles and hidden parents', () => {
  assert.throws(() => validateName('.env'), EditorError);
  assert.throws(() => validateName('.gitignore'), EditorError);
});

test('validateName rejects non-editable extensions', () => {
  for (const bad of ['evil.sh', 'evil.py', 'evil.exe', 'evil', 'evil.php']) {
    assert.throws(() => validateName(bad), EditorError, `should reject ${bad}`);
  }
});

test('validateName rejects empty, whitespace, and null bytes', () => {
  assert.throws(() => validateName(''), EditorError);
  assert.throws(() => validateName('   '), EditorError);
  assert.throws(() => validateName('a\0.html'), EditorError);
  assert.throws(() => validateName(null), EditorError);
});

test('validateName rejects absurdly long names', () => {
  assert.throws(() => validateName(`${'a'.repeat(500)}.html`), EditorError);
});

test('editable extension list excludes executable types', () => {
  for (const ext of ['.sh', '.exe', '.php', '.bat', '.ps1']) {
    assert.ok(!EDITABLE_EXTENSIONS.has(ext), `${ext} must not be editable`);
  }
});

// ---------------------------------------------------------------- resolution

test('resolveInProject keeps the target inside the project', () => {
  const { target } = resolveInProject('/tmp/p', 'a.html');
  assert.equal(target, path.resolve('/tmp/p', 'a.html'));
});

test('resolveInProject refuses to escape the project', () => {
  assert.throws(() => resolveInProject('/tmp/p', '../outside.html'), EditorError);
});

// ---------------------------------------------------------------- CRUD

test('write then read round-trips content', async () => {
  const { base, project } = await makeProject();
  const content = '<html><title>Fresh</title><body>hi</body></html>';
  const written = await writeFile(project, 'fresh.html', content);

  assert.equal(written.created, true);
  assert.equal(written.title, 'Fresh');

  const read = await readFile(project, 'fresh.html');
  assert.equal(read.content, content);
  assert.equal(read.isHtml, true);

  await cleanup(base);
});

test('writing an existing file overwrites without reporting creation', async () => {
  const { base, project } = await makeProject();
  const result = await writeFile(project, 'existing.html', '<html><title>Changed</title></html>');
  assert.equal(result.created, false);
  const read = await readFile(project, 'existing.html');
  assert.equal(read.title, 'Changed');
  await cleanup(base);
});

test('delete removes the file and 404s afterwards', async () => {
  const { base, project } = await makeProject();
  await deleteFile(project, 'existing.html');
  await assert.rejects(() => readFile(project, 'existing.html'), EditorError);
  await cleanup(base);
});

test('rename moves a file and refuses to clobber', async () => {
  const { base, project } = await makeProject();
  await writeFile(project, 'a.html', '<html><title>A</title></html>');

  const moved = await renameFile(project, 'a.html', 'b.html');
  assert.equal(moved.renamed, true);
  assert.equal((await readFile(project, 'b.html')).title, 'A');

  await assert.rejects(() => renameFile(project, 'b.html', 'existing.html'), EditorError);
  await cleanup(base);
});

test('renaming a file to itself is a no-op', async () => {
  const { base, project } = await makeProject();
  const res = await renameFile(project, 'existing.html', 'existing.html');
  assert.equal(res.renamed, false);
  await cleanup(base);
});

test('reading a missing file gives a 404-shaped error', async () => {
  const { base, project } = await makeProject();
  await assert.rejects(
    () => readFile(project, 'nope.html'),
    (err) => err instanceof EditorError && err.status === 404,
  );
  await cleanup(base);
});

test('deleting a missing file gives a 404-shaped error', async () => {
  const { base, project } = await makeProject();
  await assert.rejects(
    () => deleteFile(project, 'nope.html'),
    (err) => err instanceof EditorError && err.status === 404,
  );
  await cleanup(base);
});

// ---------------------------------------------------------------- limits

test('oversized content is refused', async () => {
  const { base, project } = await makeProject();
  const huge = 'x'.repeat(MAX_FILE_BYTES + 1024);
  await assert.rejects(
    () => writeFile(project, 'big.html', huge),
    (err) => err instanceof EditorError && err.status === 413,
  );
  await cleanup(base);
});

test('non-string content is refused', async () => {
  const { base, project } = await makeProject();
  await assert.rejects(() => writeFile(project, 'x.html', 42), EditorError);
  await cleanup(base);
});

test('writes are atomic: no temp files remain behind', async () => {
  const { base, project } = await makeProject();
  await writeFile(project, 'atomic.html', '<html></html>');
  const entries = await fs.readdir(project);
  assert.ok(!entries.some((f) => f.includes('simhost-') || f.endsWith('.tmp')), `stray temp files: ${entries}`);
  await cleanup(base);
});

// ---------------------------------------------------------------- listing

test('listEditable returns only editable files, no dotfiles', async () => {
  const { base, project } = await makeProject();
  await writeFile(project, 'notes.md', '# hi');
  await writeFile(project, 'script.sh', 'echo nope', { mode: 0o644 }).catch(() => {});
  await fs.writeFile(path.join(project, '.hidden.html'), 'x');

  const files = await listEditable(project);
  const names = files.map((f) => f.name);

  assert.ok(names.includes('existing.html'));
  assert.ok(names.includes('notes.md'));
  assert.ok(!names.includes('.hidden.html'), 'dotfiles must be hidden');
  assert.ok(!names.includes('script.sh'), 'non-editable must be hidden');

  await cleanup(base);
});

// ---------------------------------------------------------------- templates

test('templates are available and self-contained', () => {
  assert.ok(templateFor('html').includes('<!DOCTYPE html>'));
  assert.ok(templateFor('canvas3d').includes('three'));
  assert.equal(templateFor('blank'), '');
  assert.throws(() => templateFor('nope'), EditorError);
});

test('template html is directly servable', async () => {
  const { base, project } = await makeProject();
  await writeFile(project, 'from-template.html', templateFor('html'));
  const read = await readFile(project, 'from-template.html');
  assert.ok(read.content.includes('<canvas'), 'template should contain a canvas');
  await cleanup(base);
});
