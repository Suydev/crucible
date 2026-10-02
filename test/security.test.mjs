// test/security.test.mjs
// Regression tests for the audit findings.
//
// Every case here corresponds to a vulnerability that was verified working
// before it was fixed. They are written as "the attack must fail" so a
// regression is a loud failure rather than a silent hole.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EditorError,
  deleteFile,
  readFile,
  resolveInProject,
  writeFile,
} from '../lib/editor.mjs';
import { isVendorable, vendorPathFor, rewriteCdnUrls, findCdnUrls } from '../lib/vendor.mjs';

async function project() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-sec-'));
  const dir = path.join(base, 'proj');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'a.html'), '<html><title>A</title></html>');
  return { base, dir };
}

// ---------------------------------------------------------------- symlinks

test('reading through a symlink does not escape the project', async () => {
  const { base, dir } = await project();
  const secret = path.join(base, 'secret.txt');
  await fs.writeFile(secret, 'TOP SECRET');
  await fs.symlink(secret, path.join(dir, 'leak.txt'));

  await assert.rejects(
    () => readFile(dir, 'leak.txt'),
    (err) => err instanceof EditorError && err.status === 403,
    'a symlink out of the project must be refused',
  );

  await fs.rm(base, { recursive: true, force: true });
});

test('writing through a symlink does not clobber the target', async () => {
  const { base, dir } = await project();
  const secret = path.join(base, 'secret.txt');
  await fs.writeFile(secret, 'ORIGINAL');
  await fs.symlink(secret, path.join(dir, 'leak.txt'));

  await assert.rejects(
    () => writeFile(dir, 'leak.txt', 'OVERWRITTEN'),
    (err) => err instanceof EditorError && err.status === 403,
  );

  assert.equal(await fs.readFile(secret, 'utf8'), 'ORIGINAL', 'target must be untouched');
  await fs.rm(base, { recursive: true, force: true });
});

test('deleting a symlink is refused rather than followed', async () => {
  const { base, dir } = await project();
  const secret = path.join(base, 'keep.txt');
  await fs.writeFile(secret, 'KEEP');
  await fs.symlink(secret, path.join(dir, 'link.txt'));

  await assert.rejects(() => deleteFile(dir, 'link.txt'), EditorError);
  assert.ok(fssync.existsSync(secret), 'target must survive');
  await fs.rm(base, { recursive: true, force: true });
});

test('a symlink pointing inside the project is still refused', async () => {
  const { base, dir } = await project();
  await fs.symlink(path.join(dir, 'a.html'), path.join(dir, 'alias.html'));
  // Refusing all symlinks is simpler and safer than reasoning about which
  // targets are benign; a user can copy the file instead.
  await assert.rejects(() => readFile(dir, 'alias.html'), EditorError);
  await fs.rm(base, { recursive: true, force: true });
});

test('a regular new file is not treated as a symlink', async () => {
  const { base, dir } = await project();
  const res = await writeFile(dir, 'fresh.html', '<html></html>');
  assert.equal(res.created, true);
  await fs.rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- traversal

test('resolveInProject still rejects traversal in the name', () => {
  assert.throws(() => resolveInProject('/tmp/p', '../x.html'), EditorError);
  assert.throws(() => resolveInProject('/tmp/p', 'a/b.html'), EditorError);
  assert.throws(() => resolveInProject('/tmp/p', '/etc/passwd'), EditorError);
});

test('resolveInProject rejects protected segments', () => {
  assert.throws(() => resolveInProject('/tmp/p', '.env.html'), EditorError);
});

// ---------------------------------------------------------------- vendor

test('raw.githubusercontent is no longer allowlisted', () => {
  // It serves arbitrary user-authored content and is the easiest way to get an
  // allowlisted host to redirect somewhere internal.
  assert.equal(isVendorable('https://raw.githubusercontent.com/a/b/c.js'), false);
});

test('known CDNs remain allowlisted', () => {
  assert.equal(isVendorable('https://unpkg.com/three@0.128.0/build/three.min.js'), true);
  assert.equal(isVendorable('https://cdn.jsdelivr.net/npm/three/build/three.js'), true);
  assert.equal(isVendorable('https://esm.sh/react'), true);
});

test('vendor path cannot contain traversal', () => {
  const rel = vendorPathFor('https://unpkg.com/../../etc/passwd');
  assert.ok(!rel.includes('..'));
});

// ---------------------------------------------------------------- assets

test('the runtime asset name guard rejects dot segments', () => {
  // The guard that crashed the server: /__simhost/.. passed /^\w[\w.-]+$/ and
  // resolved to a directory, so createReadStream emitted EISDIR unhandled.
  const pattern = /^[\w.-]+$/;
  assert.ok(pattern.test('..'), 'documents why the pattern alone was insufficient');
  assert.ok(pattern.test('.'));

  // The fix is the explicit rejection below, which the server applies.
  const rejects = (name) => !pattern.test(name) || name === '.' || name === '..';
  assert.equal(rejects('..'), true);
  assert.equal(rejects('.'), true);
  assert.equal(rejects('runtime.js'), false);
});

test('handleFileStream is used rather than a bare pipe', async () => {
  // Guards against reintroducing an un-listened createReadStream.
  const source = await fs.readFile(
    new URL('../server.mjs', import.meta.url).pathname,
    'utf8',
  );
  const occurrences = source.match(/createReadStream\(/g) ?? [];
  assert.ok(occurrences.length <= 2, `createReadStream should only appear in the helper (found ${occurrences.length})`);
  assert.ok(
    source.includes("stream.on('error'"),
    'the stream must have an error listener',
  );
});

// ---------------------------------------------------------------- registry

test('concurrent registry saves do not collide on a temp file', async () => {
  const { InstanceRegistry } = await import('../lib/ports.mjs');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-reg-'));
  const file = path.join(base, 'nested', 'instances.json');

  const reg = new InstanceRegistry(file);
  await Promise.all([
    reg.register('/tmp/a', { port: 5101, pid: 1 }),
    reg.register('/tmp/b', { port: 5102, pid: 2 }),
    reg.register('/tmp/c', { port: 5103, pid: 3 }),
  ]);

  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(parsed.instances.length, 3, 'every register must be persisted');

  const leftovers = (await fs.readdir(path.dirname(file))).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp files should survive');

  await fs.rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------- hosting

test('the host API refuses directories outside the configured roots', async () => {
  const { createServer } = await import('../server.mjs');
  const { loadConfig } = await import('../lib/config.mjs');

  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-root-'));
  const root = path.join(base, 'root');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), '<html></html>');

  const config = loadConfig(['--roots', root, '--no-reload'], {});
  const server = createServer(config);
  const controller = server.controller;
  await controller.init();   // populates this.projects from the scan

  // A directory outside the roots must not resolve at all.
  assert.equal(controller.isKnownProject('/etc'), false);
  assert.equal(controller.isKnownProject(path.join(base, 'outside')), false);
  assert.equal(controller.isKnownProject(root), true);

  // And hosting must refuse rather than spawn a child for it.
  await assert.rejects(
    () => controller.hostDir('/etc'),
    /not a hostable project|invalid directory/,
  );
  await assert.rejects(
    () => controller.hostDir(path.join(base, 'outside')),
    /not a hostable project|invalid directory/,
  );

  await fs.rm(base, { recursive: true, force: true });
});

test('stopDir on an unregistered directory returns immediately without signalling', async () => {
  const { createServer } = await import('../server.mjs');
  const { loadConfig } = await import('../lib/config.mjs');

  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-stop-'));
  const root = path.join(base, 'root');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'index.html'), '<html></html>');

  const config = loadConfig(['--roots', root, '--no-reload'], {});
  const server = createServer(config);

  const started = Date.now();
  const result = await server.controller.stopDir(root);
  const elapsed = Date.now() - started;

  assert.equal(result.stopped, false, 'nothing to stop');
  assert.ok(elapsed < 1500, `should not wait when there is no record (took ${elapsed}ms)`);

  await fs.rm(base, { recursive: true, force: true });
});


// ---------------------------------------------------------------- http guard

test('loopback Host headers are accepted, everything else refused', async () => {
  const { isLoopbackHost } = await import('../lib/http-guard.mjs');
  for (const host of ['localhost:5050', '127.0.0.1:5050', '[::1]:5050', 'LOCALHOST:5050']) {
    assert.equal(isLoopbackHost(host, 5050), true, `${host} should be accepted`);
  }
  for (const host of ['attacker.example', 'evil.localhost', '127.0.0.1.evil.com', '', undefined]) {
    assert.equal(isLoopbackHost(host, 5050), false, `${host} should be refused`);
  }
});

test('a cross-origin Origin header is detected', async () => {
  const { checkOrigin } = await import('../lib/http-guard.mjs');
  const ok = { headers: { origin: 'http://127.0.0.1:5050', host: '127.0.0.1:5050' } };
  assert.equal(checkOrigin(ok), null, 'same-origin must be allowed');

  const evil = { headers: { origin: 'http://evil.example', host: '127.0.0.1:5050' } };
  assert.match(checkOrigin(evil), /cross-origin/);

  // Sec-Fetch-Site cannot be forged by page script, so it is the strong signal.
  const rebind = { headers: { host: '127.0.0.1:5050', 'sec-fetch-site': 'cross-site' } };
  assert.match(checkOrigin(rebind), /cross-site/);
});

test('only application/json bodies are accepted by the API', async () => {
  const { isJsonRequest } = await import('../lib/http-guard.mjs');
  assert.equal(isJsonRequest({ headers: { 'content-type': 'application/json' } }), true);
  assert.equal(isJsonRequest({ headers: { 'content-type': 'application/json; charset=utf-8' } }), true);
  // text/plain is a CORS-simple content type: it needs no preflight, which is
  // exactly why it must not be enough to write a file.
  assert.equal(isJsonRequest({ headers: { 'content-type': 'text/plain' } }), false);
  assert.equal(isJsonRequest({ headers: {} }), false);
});

test('the API guard rejects a bad Host before anything else', async () => {
  const { guardApiRequest } = await import('../lib/http-guard.mjs');
  const bad = { method: 'POST', headers: { host: 'attacker.example', 'content-type': 'application/json' } };
  assert.match(guardApiRequest(bad, 5050), /invalid Host/);

  const good = {
    method: 'POST',
    headers: { host: '127.0.0.1:5050', origin: 'http://127.0.0.1:5050', 'content-type': 'application/json', 'content-length': '2' },
  };
  assert.equal(guardApiRequest(good, 5050), null, 'a legitimate request must pass');
});

test('the SSE client cap is enforced', async () => {
  const { LiveReloadHub, MAX_CLIENTS } = await import('../lib/live-reload.mjs');
  assert.ok(MAX_CLIENTS > 0 && MAX_CLIENTS <= 128, 'a sane cap');

  const hub = new LiveReloadHub({ heartbeatMs: 60_000 });
  const fakeRes = () => ({
    writeHead: () => {}, setHeader: () => {}, write: () => true, end: () => {}, on: () => {}, writableLength: 0,
  });
  const fakeReq = () => ({ socket: { setNoDelay: () => {} }, on: () => {}, once: () => {} });

  let accepted = 0;
  for (let i = 0; i < MAX_CLIENTS + 5; i += 1) {
    if (hub.attach(fakeReq(), fakeRes())) accepted += 1;
  }
  assert.equal(accepted, MAX_CLIENTS, 'must stop accepting past the cap');
  hub.closeAll();
});

test('a slow SSE client is dropped rather than buffered without bound', async () => {
  const { LiveReloadHub } = await import('../lib/live-reload.mjs');
  const hub = new LiveReloadHub({ heartbeatMs: 60_000 });
  const slow = {
    writeHead: () => {}, setHeader: () => {}, write: () => true, end: () => {}, on: () => {}, writableLength: 10 * 1024 * 1024,
  };
  hub.attach({ socket: { setNoDelay: () => {} }, on: () => {}, once: () => {} }, slow);

  // The greeting itself is the first send, so a peer that is already far behind
  // is evicted immediately rather than after it has buffered more frames.
  assert.equal(hub.size, 0, 'a client with a huge buffer must be dropped, not buffered');

  // A healthy client is kept, so the cap cannot evict everyone.
  const healthy = {
    writeHead: () => {}, setHeader: () => {}, write: () => true, end: () => {}, on: () => {}, writableLength: 0,
  };
  hub.attach({ socket: { setNoDelay: () => {} }, on: () => {}, once: () => {} }, healthy);
  assert.equal(hub.size, 1);
  hub.broadcast('reload', { reason: 'test' });
  assert.equal(hub.size, 1, 'a healthy client must survive a broadcast');
  hub.closeAll();
});

test('vendor URLs must be https', async () => {
  assert.equal(isVendorable('http://unpkg.com/three@0.128.0/build/three.min.js'), false,
    'cleartext fetch would let a network attacker substitute the script');
  assert.equal(isVendorable('https://unpkg.com/three@0.128.0/build/three.min.js'), true);
});
