// test/workspace.test.mjs
// The workspace scan runs against the real filesystem, so these tests build a
// throwaway tree rather than trusting the developer's home directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanWorkspace, buildTree } from '../lib/workspace.mjs';
import { collectHtmlFiles } from '../lib/scanner.mjs';

async function makeTree() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-ws-'));

  await fs.mkdir(path.join(dir, 'project-a'), { recursive: true });
  await fs.writeFile(path.join(dir, 'project-a', 'index.html'), '<html><head><title>Project A</title></head><body></body></html>');
  await fs.writeFile(path.join(dir, 'project-a', 'second.html'), '<html><head><title>Second</title></head></html>');

  await fs.mkdir(path.join(dir, 'project-b', 'nested'), { recursive: true });
  await fs.writeFile(path.join(dir, 'project-b', 'nested', 'deep.html'), '<html><head><title>Deep</title></head></html>');

  // Things that must be ignored.
  await fs.mkdir(path.join(dir, 'project-a', 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(dir, 'project-a', 'node_modules', 'pkg', 'index.html'), '<html><title>Ignored</title></html>');
  await fs.mkdir(path.join(dir, '.hidden'), { recursive: true });
  await fs.writeFile(path.join(dir, '.hidden', 'x.html'), '<html></html>');
  await fs.writeFile(path.join(dir, 'project-a', 'notes.md'), '# not html');

  return dir;
}

test('scanWorkspace finds directories containing html', async () => {
  const dir = await makeTree();
  const projects = await scanWorkspace([dir]);

  const labels = projects.map((p) => p.label);
  assert.ok(labels.includes('project-a'), 'should find project-a');
  assert.ok(labels.includes('nested'), 'should find the nested folder');
  assert.ok(!labels.includes('pkg'), 'must ignore node_modules');

  await fs.rm(dir, { recursive: true, force: true });
});

test('scanWorkspace reads titles from html', async () => {
  const dir = await makeTree();
  const projects = await scanWorkspace([dir]);
  const a = projects.find((p) => p.label === 'project-a');
  assert.equal(a.fileCount, 2, 'two html files in project-a');
  assert.equal(a.entryUrl, 'index.html', 'index.html should be the entry point');
  const index = a.files.find((f) => f.name === 'index.html');
  assert.equal(index.title, 'Project A');

  await fs.rm(dir, { recursive: true, force: true });
});

test('scanWorkspace tolerates a missing root', async () => {
  const projects = await scanWorkspace(['/definitely/not/here/at/all']);
  assert.deepEqual(projects, []);
});

test('buildTree nests by path and marks projects', () => {
  const tree = buildTree([
    { dir: '/root/a/b', label: 'b', fileCount: 2, preferredPort: 5051, updated: 'now' },
  ]);
  assert.equal(tree.children[0].name, 'root');
  const rootNode = tree.children[0];
  assert.equal(rootNode.children[0].name, 'a');
  assert.equal(rootNode.children[0].children[0].name, 'b');
  assert.equal(rootNode.children[0].children[0].project.label, 'b');
});

test('buildTree handles an empty project list', () => {
  const tree = buildTree([]);
  assert.deepEqual(tree.children, []);
});

test('collectHtmlFiles skips dotfiles and node_modules', async () => {
  const dir = await makeTree();
  const files = await collectHtmlFiles(path.join(dir, 'project-a'));
  assert.ok(!files.some((f) => f.includes('node_modules')));
  assert.ok(files.includes('index.html'));
  await fs.rm(dir, { recursive: true, force: true });
});
