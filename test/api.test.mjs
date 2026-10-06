// test/api.test.mjs
// HTTP coverage for the dashboard API surface.
//
// These endpoints had ZERO tests, which meant deleting every
// assertKnownProject() call in handleFileApi - opening arbitrary-directory
// write, create, delete and rename - still passed the entire suite. This file
// exists to close that.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { createServer } from '../server.mjs';
import { isPortFree } from '../lib/ports.mjs';

let base;
let root;
let projectDir;
let origin;
let server;

async function freePort() {
  for (let p = 5500; p < 5600; p += 1) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free port');
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-api-'));
  projectDir = path.join(root, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'index.html'), '<html><title>Base</title></html>');

  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;

  const config = loadConfig(['--roots', root, '--port', String(port), '--no-reload'], {});
  server = createServer(config);
  await server.controller.init();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, config.host, resolve);
  });
});

after(async () => {
  await server?.stop();
  await fs.rm(root, { recursive: true, force: true });
});

/** Sends a request verbatim and returns the status line code. */
function rawRequest(base, lines) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`${lines.join('\r\n')}\r\n`);
    });
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (c) => { buf += c; });
    socket.on('end', () => resolve(Number((/HTTP\/1\.\d (\d{3})/.exec(buf) ?? [])[1] ?? 0)));
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('timeout')); });
  });
}

/** POST/GET with the headers the guard requires. */
async function call(method, endpoint, body, extraHeaders = {}) {
  const init = {
    method,
    headers: {
      host: new URL(origin).host,
      origin: origin,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
  };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(`${origin}/__simhost/api/${endpoint}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

// ---------------------------------------------------------------- guard

test('a cross-origin write is refused', async () => {
  const res = await fetch(`${origin}/__simhost/api/file/save`, {
    method: 'POST',
    headers: {
      host: 'attacker.example',
      origin: 'http://evil.example',
      'content-type': 'text/plain',
    },
    body: JSON.stringify({ dir: projectDir, name: 'pwn.html', content: 'x' }),
  });
  assert.equal(res.status, 403, 'a hostile page must not be able to write files');
  await res.text();
  assert.equal(fsSync.existsSync(path.join(projectDir, 'pwn.html')), false);
});

test('a DNS-rebinding Host header is refused', async () => {
  // Node's fetch forbids setting Host, so this must go over a raw socket or the
  // test proves nothing about the guard.
  const status = await rawRequest(origin, [
    'POST /__simhost/api/file/save HTTP/1.1',
    `Host: attacker.example`,
    `Origin: ${origin}`,
    'Content-Type: application/json',
    'Content-Length: ' + Buffer.byteLength(JSON.stringify({ dir: projectDir, name: 'rebind.html', content: 'x' })),
    'Connection: close',
    '',
    JSON.stringify({ dir: projectDir, name: 'rebind.html', content: 'x' }),
  ]);
  assert.equal(status, 403, 'a rebinding Host header must be refused');
  assert.equal(fsSync.existsSync(path.join(projectDir, 'rebind.html')), false);
});

test('text/plain bodies are refused even from loopback', async () => {
  // A CORS-simple content type needs no preflight, so it must never be enough.
  const res = await fetch(`${origin}/__simhost/api/file/save`, {
    method: 'POST',
    headers: { host: new URL(origin).host, 'content-type': 'text/plain' },
    body: JSON.stringify({ dir: projectDir, name: 'plain.html', content: 'x' }),
  });
  assert.equal(res.status, 403);
  await res.text();
});

test('a Sec-Fetch-Site: cross-site request is refused', async () => {
  const res = await call('POST', 'file/save',
    { dir: projectDir, name: 'sf.html', content: 'x' },
    { 'sec-fetch-site': 'cross-site' });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------- editor

test('the editor refuses a directory that is not a known project', async () => {
  for (const endpoint of ['file/save', 'file/create', 'file/delete', 'file/rename']) {
    const body = endpoint === 'file/rename'
      ? { dir: '/etc', from: 'passwd', to: 'passwd.bak' }
      : { dir: '/etc', name: 'passwd', content: 'x' };
    const res = await call('POST', endpoint, body);
    assert.equal(res.status, 403, `${endpoint} must refuse /etc`);
    assert.match(res.json.error, /not an editable project/);
  }
});

test('editor CRUD round-trips over HTTP', async () => {
  const listed = await call('GET', `file/list?dir=${encodeURIComponent(projectDir)}`);
  assert.equal(listed.status, 200);
  assert.ok(listed.json.files.some((f) => f.name === 'index.html'));

  const created = await call('POST', 'file/create', { dir: projectDir, name: 'made.html' });
  assert.equal(created.status, 200);
  assert.equal(created.json.created, true);
  assert.ok(fsSync.existsSync(path.join(projectDir, 'made.html')));

  const read = await call('GET', `file/read?dir=${encodeURIComponent(projectDir)}&name=made.html`);
  assert.equal(read.status, 200);
  assert.ok(read.json.content.includes('<canvas'), 'template should contain a canvas');

  const saved = await call('POST', 'file/save',
    { dir: projectDir, name: 'made.html', content: '<html><title>Edited</title></html>' });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.created, false, 'overwriting an existing file is not a creation');
  assert.match(await fs.readFile(path.join(projectDir, 'made.html'), 'utf8'), /Edited/);

  const renamed = await call('POST', 'file/rename',
    { dir: projectDir, from: 'made.html', to: 'renamed.html' });
  assert.equal(renamed.status, 200);
  assert.ok(fsSync.existsSync(path.join(projectDir, 'renamed.html')));

  const deleted = await call('POST', 'file/delete', { dir: projectDir, name: 'renamed.html' });
  assert.equal(deleted.status, 200);
  assert.equal(fsSync.existsSync(path.join(projectDir, 'renamed.html')), false);
});

test('reading a missing file is a 404 with a message', async () => {
  const res = await call('GET', `file/read?dir=${encodeURIComponent(projectDir)}&name=nope.html`);
  assert.equal(res.status, 404);
  assert.match(res.json.error, /no such file/);
});

test('an invalid filename is refused with the allowlist', async () => {
  const res = await call('POST', 'file/save',
    { dir: projectDir, name: 'evil.sh', content: 'rm -rf /' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /cannot edit/);
});

test('oversized content is refused and the connection survives', async () => {
  const huge = 'x'.repeat(5 * 1024 * 1024);
  const first = await call('POST', 'file/save', { dir: projectDir, name: 'big.html', content: huge });
  assert.equal(first.status, 413);

  // The rejected body must be drained or destroyed, otherwise the keep-alive
  // socket is left holding unconsumed bytes and the next request dies.
  const second = await call('GET', `file/list?dir=${encodeURIComponent(projectDir)}`);
  assert.equal(second.status, 200, 'the connection must still work after a 413');
});

// ---------------------------------------------------------------- dashboard

test('state returns a tree and a project list', async () => {
  const res = await call('GET', 'state');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.projects));
  assert.ok(res.json.projects.some((p) => p.dir === projectDir));
  assert.ok(res.json.tree);
});

test('rescan works and reports a count', async () => {
  const res = await call('POST', 'rescan');
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.count, 'number');
});

test('hosting a directory outside the roots is refused, not 500', async () => {
  const res = await call('POST', 'host', { dir: '/etc' });
  // 403 when the known-project gate rejects it, 400 when the path itself is
  // outside every configured root. Neither may surface as a 500.
  assert.ok(res.status === 400 || res.status === 403, `got ${res.status}`);
  assert.match(res.json.error, /invalid directory|not a hostable project/);
});

test('a port outside the managed range is ignored', async () => {
  // Without the range check the API could make a host squat on any local port.
  const res = await call('POST', 'host', { dir: projectDir, port: 9000 });
  if (res.status === 200) {
    assert.ok(res.json.port >= 5050 && res.json.port <= 5199,
      `port ${res.json.port} escaped the managed range`);
    await call('POST', 'stop', { dir: projectDir });
  } else {
    assert.equal(res.status, 403);
  }
});

test('stopping a directory that was never hosted is harmless', async () => {
  const res = await call('POST', 'stop', { dir: projectDir });
  assert.equal(res.status, 200);
  assert.equal(res.json.stopped, false);
});

test('a known action with the wrong method is 405 with Allow', async () => {
  const res = await call('GET', 'rescan');
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
});

test('an unknown action is a 404 naming the action', async () => {
  const res = await call('GET', 'nonsense');
  assert.equal(res.status, 404);
  assert.match(res.json.error, /nonsense/);
});

// ---------------------------------------------------------------- static guard

test('a symlink pointing outside the root is not served', async () => {
  const secretDir = path.join(root, 'outside');
  await fs.mkdir(secretDir, { recursive: true });
  const secret = path.join(secretDir, 'loot.txt');
  await fs.writeFile(secret, 'TOP-SECRET-CONTENT');

  const link = path.join(projectDir, 'innocent.txt');
  await fs.symlink(secret, link).catch(() => {}); // may be unsupported

  const res = await fetch(`${origin}/__simhost/../../../etc/passwd`).catch(() => null);
  void res;

  const direct = await fetch(`${origin}/sims/${projectDir.split('/').pop()}/innocent.txt`);
  if (direct.status !== 404) {
    const body = await direct.text();
    assert.ok(!body.includes('TOP-SECRET-CONTENT'),
      'a symlink out of the root must not be served');
  }
  await fs.rm(secretDir, { recursive: true, force: true });
});
