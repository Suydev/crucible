// test/proxy.test.mjs
// A simulation whose frontend calls /api/* is the common shape for "it renders
// but every number is zero". Without an upstream the preview cannot tell that
// apart from an empty instance, so --proxy forwards those paths.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { createServer } from '../server.mjs';
import { isPortFree } from '../lib/ports.mjs';

let dir;
let origin;
let server;
let upstream;
let upstreamPort;
let upstreamHits;

async function freePort() {
  for (let p = 5800; p < 5900; p += 1) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free port');
}

before(async () => {
  // A stand-in for a project's real API.
  upstreamHits = [];
  upstream = http.createServer(async (req, res) => {
    upstreamHits.push(req.url);
    if (req.url.startsWith('/api/stream')) {
      // Server-sent events: the reason nothing here buffers or re-encodes.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 60);
      return;
    }
    if (req.url.startsWith('/api/moved')) {
      res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/elsewhere` });
      res.end();
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ echoed: body }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  upstreamPort = await freePort();
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-proxy-'));
  await fs.writeFile(path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>App</title></head><body><div id=app></div></body></html>');

  const port = await freePort();
  const config = loadConfig([
    '--single', '--root', dir, '--port', String(port), '--no-reload', '--quiet',
    '--proxy', `http://127.0.0.1:${upstreamPort}`,
  ], {});
  server = createServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, config.host, resolve);
  });
  origin = `http://127.0.0.1:${port}`;
});

after(async () => {
  await server?.stop();
  await new Promise((r) => upstream.close(r));
  await fs.rm(dir, { recursive: true, force: true });
});

test('an /api/ path is forwarded to the upstream', async () => {
  const res = await fetch(`${origin}/api/settings`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, path: '/api/settings' });
});

test('the upstream does not see the preview host', async () => {
  upstreamHits.length = 0;
  await (await fetch(`${origin}/api/session`)).json();
  assert.equal(upstreamHits.length, 1);
});

test('a POST body is forwarded', async () => {
  const res = await fetch(`${origin}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ a: 1 }),
  });
  assert.deepEqual(await res.json(), { echoed: '{"a":1}' });
});

test('a server-sent event stream passes through unbuffered', async () => {
  const res = await fetch(`${origin}/api/stream`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.includes('data: one') && text.includes('data: two'),
    'both frames must arrive; a buffering proxy would stall the second');
});

test('an upstream redirect is rewritten back onto the preview origin', async () => {
  const res = await fetch(`${origin}/api/moved`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.ok(!location.includes(`:${upstreamPort}`),
    `a Location pointing at the upstream would navigate off-origin: ${location}`);
});

test('non-API paths are still served from disk', async () => {
  const res = await fetch(`${origin}/index.html`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('<div id=app>'));
  assert.ok(!upstreamHits.includes('/index.html'));
});

test('a dead upstream returns 502 with an explanation', async () => {
  // Start a second server pointed at a port nothing is listening on.
  const dead = await freePort();
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-dead-'));
  await fs.writeFile(path.join(dir2, 'index.html'), '<html><head></head><body></body></html>');
  const port = await freePort();
  const config = loadConfig([
    '--single', '--root', dir2, '--port', String(port), '--no-reload', '--quiet',
    '--proxy', `http://127.0.0.1:${dead}`,
  ], {});
  const s2 = createServer(config);
  await new Promise((resolve, reject) => {
    s2.once('error', reject);
    s2.listen(port, config.host, resolve);
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/anything`);
    assert.equal(res.status, 502, 'a dead upstream must be visible, not a silent empty frame');
    const body = await res.json();
    assert.ok(body.error && body.hint, 'the error must say what failed and what to do');
  } finally {
    await s2.stop();
    await fs.rm(dir2, { recursive: true, force: true });
  }
});

test('no proxy configured means no forwarding', async () => {
  const config = loadConfig(['--single', '--root', dir, '--no-reload'], {});
  assert.equal(config.proxy, null);
});
