// test/settings.test.mjs
// Persisted settings decide which directories the dashboard scans. If they were
// unreliable, the same folder would appear in one session and vanish in the
// next, which is exactly the bug the persistence was added to fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Point the module at a temp HOME so the real config is never touched.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-settings-'));
process.env.HOME = tempHome;

const settings = await import('../lib/settings.mjs');

test('a missing config file yields defaults, not an error', async () => {
  const value = await settings.readSettings();
  assert.equal(value.roots, null);
  assert.equal(value.port, 5050);
});

test('write then read round-trips roots', async () => {
  await settings.writeSettings({ roots: ['/tmp/a', '/tmp/b'] });
  const value = await settings.readSettings();
  assert.deepEqual(value.roots, ['/tmp/a', '/tmp/b']);
});

test('a bare tilde expands to the home directory', async () => {
  await settings.writeSettings({ roots: ['~/projects'] });
  const value = await settings.readSettings();
  assert.deepEqual(value.roots, [path.join(tempHome, 'projects')]);
});

test('an empty roots array resets to the default', async () => {
  await settings.writeSettings({ roots: [] });
  const value = await settings.readSettings();
  assert.equal(value.roots, null, 'empty should mean "use the default", not "scan nothing"');
});

test('invalid roots entries are dropped', async () => {
  await settings.writeSettings({ roots: ['/tmp/ok', '', '   ', 42, null] });
  const value = await settings.readSettings();
  assert.deepEqual(value.roots, ['/tmp/ok']);
});

test('out-of-range ports are ignored', async () => {
  await settings.writeSettings({ port: 0 });
  assert.equal((await settings.readSettings()).port, 5050);
  await settings.writeSettings({ port: 99999 });
  assert.equal((await settings.readSettings()).port, 5050);
  await settings.writeSettings({ port: 5173 });
  assert.equal((await settings.readSettings()).port, 5173);
});

test('a corrupt config file does not throw', async () => {
  await fs.mkdir(path.join(tempHome, '.sim-host'), { recursive: true });
  await fs.writeFile(settings.SETTINGS_PATH, '{not json', 'utf8');
  const value = await settings.readSettings();
  assert.equal(value.port, 5050, 'falls back to defaults');
});

test('resolveRoots falls back when nothing is configured', async () => {
  await fs.rm(settings.SETTINGS_PATH, { force: true });
  const roots = await settings.resolveRoots(['/fallback']);
  assert.deepEqual(roots, ['/fallback']);
});

test('writes are atomic: no temp files remain', async () => {
  await settings.writeSettings({ roots: ['/tmp/x'] });
  const entries = await fs.readdir(path.join(tempHome, '.sim-host'));
  assert.ok(!entries.some((f) => f.includes('.tmp')), `stray temp files: ${entries}`);
});

test('concurrent writes do not corrupt the file', async () => {
  await Promise.all([
    settings.writeSettings({ roots: ['/tmp/one'] }),
    settings.writeSettings({ roots: ['/tmp/two'] }),
    settings.writeSettings({ roots: ['/tmp/three'] }),
  ]);
  const value = await settings.readSettings();
  assert.ok(Array.isArray(value.roots), 'file must remain valid JSON');
  assert.equal(value.roots.length, 1);
});

await fs.rm(tempHome, { recursive: true, force: true });
