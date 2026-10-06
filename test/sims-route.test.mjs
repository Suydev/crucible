// test/sims-route.test.mjs
// The /sims/ route is the legacy single-project path. It once carried its own
// copy of the document-injection logic, which meant it silently missed the
// dependency graph crawl and the import map while both were being fixed in the
// main handler. This file pins the two routes to the same behaviour.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { createServer } from '../server.mjs';
import { isPortFree } from '../lib/ports.mjs';

let dir;
let origin;
let server;

async function freePort() {
  for (let p = 5700; p < 5800; p += 1) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free port');
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-sims-'));
  await fs.mkdir(path.join(dir, 'simulations'), { recursive: true });
  await fs.writeFile(path.join(dir, 'simulations', 'demo.html'),
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
    + '<title>Demo</title></head><body><h1>Demo</h1></body></html>');
  await fs.writeFile(path.join(dir, 'simulations', 'helper.css'), 'h1 { color: red; }');

  const port = await freePort();
  // /sims/ only exists in dashboard mode; single-project mode short-circuits to
  // the static handler before reaching it.
  const config = loadConfig([
    '--root', dir, '--port', String(port), '--no-reload', '--quiet',
  ], {});
  server = createServer(config);
  await server.controller.init();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, config.host, resolve);
  });
  origin = `http://127.0.0.1:${port}`;
});

after(async () => {
  await server?.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a simulation is listed', async () => {
  const res = await fetch(`${origin}/sims/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('demo.html'), 'the simulation must be listed');
  assert.ok(body.includes('runtime.js'), 'the index goes through the document pipeline');
});

test('a simulation document gets the dev runtime injected', async () => {
  const res = await fetch(`${origin}/sims/demo.html`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('runtime.js'), 'runtime script must be injected');
  assert.ok(body.includes('__SIM_HOST__'), 'config must be injected');
  assert.ok(body.includes('<h1>Demo</h1>'), 'original content must survive');
});

test('a non-HTML simulation asset is served with its own type', async () => {
  // This used to fall through to the 404 branch, so a stylesheet a simulation
  // linked to simply vanished in preview.
  const res = await fetch(`${origin}/sims/helper.css`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/css/);
  assert.ok((await res.text()).includes('color: red'));
});

test('traversal out of the simulations directory is refused', async () => {
  const res = await fetch(`${origin}/sims/..%2F..%2Fetc%2Fpasswd`);
  assert.ok([403, 404].includes(res.status), `got ${res.status}`);
  await res.text();
});
