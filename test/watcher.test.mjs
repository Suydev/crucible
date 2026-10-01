// test/watcher.test.mjs
// The watcher is the one always-running component, so its failure modes matter:
// a poll that outruns its own walk (measured at 24-51% of a core), and handles
// that keep the process alive after close().

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startWatching, diffSnapshots } from '../lib/watcher.mjs';

async function tree() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-watch-'));
  await fs.writeFile(path.join(dir, 'a.txt'), 'one');
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
  await fs.writeFile(path.join(dir, 'sub', 'b.txt'), 'two');
  return dir;
}

test('diffSnapshots reports added, removed, and modified files', () => {
  const before = new Map([['/a', 1], ['/b', 2]]);
  const after = new Map([['/a', 3], ['/c', 4]]);
  const diff = diffSnapshots(before, after);

  assert.deepEqual(diff.added, ['/c']);
  assert.deepEqual(diff.removed, ['/b']);
  assert.deepEqual(diff.modified, ['/a']);
});

test('an unchanged tree produces no events', () => {
  const same = new Map([['/a', 1]]);
  const diff = diffSnapshots(same, new Map([['/a', 1]]));
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.modified, []);
  assert.equal(diffSnapshots(same, same).removed.length, 0);
});

test('close() releases the fs.watch handles so the process can exit', async () => {
  const dir = await tree();
  const events = [];

  const watcher = startWatching([dir], {
    onChange: (change) => events.push(change),
    onError: () => {},
    debounceMs: 50,
    pollMs: 200,
  });

  await new Promise((r) => setTimeout(r, 300));
  await fs.writeFile(path.join(dir, 'a.txt'), 'changed');
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(events.length > 0, 'a write should produce an event');

  // Count inotify handles. The test runner keeps the event loop alive itself,
  // so probing for process exit can never succeed here; the real defect is a
  // leaked handle keeping a live server from shutting down.
  const count = () => process.getActiveResourcesInfo().filter((r) => r === 'FSEventWrap').length;
  const before = count();
  assert.ok(before > 0, 'a watch handle should be active while running');

  watcher.close();

  await new Promise((r) => setTimeout(r, 250));
  const after = count();
  assert.ok(after < before, `close() must release the fs.watch handle (${before} -> ${after})`);

  await fs.rm(dir, { recursive: true, force: true });
});

test('close() is safe to call twice', async () => {
  const dir = await tree();
  const watcher = startWatching([dir], { onChange: () => {}, onError: () => {} });
  watcher.close();
  watcher.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a missing root does not throw', async () => {
  const watcher = startWatching(['/definitely/not/here'], {
    onChange: () => {},
    onError: () => {},
  });
  await new Promise((r) => setTimeout(r, 300));
  watcher.close();
});

test('no events fire after close()', async () => {
  const dir = await tree();
  let fired = false;
  const watcher = startWatching([dir], {
    onChange: () => { fired = true; },
    onError: () => {},
    pollMs: 50,
  });

  await new Promise((r) => setTimeout(r, 200));
  watcher.close();

  await fs.writeFile(path.join(dir, 'a.txt'), 'after-close');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(fired, false, 'a closed watcher must stay silent');

  await fs.rm(dir, { recursive: true, force: true });
});
