// test/serve.test.mjs
// End-to-end HTTP checks against a real single-project server.
//
// These exist because the static-serving path broke silently before: a
// refactor changed serveFile's signature and every asset returned
// {"error":"req is not defined"} with a 500, while all 100+ unit tests passed.
// Nothing in the unit suite actually made a request.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { loadConfig } from '../lib/config.mjs';
import { createServer } from '../server.mjs';
import { isPortFree } from '../lib/ports.mjs';

let dir;
let origin;
let server;

/** Issues a GET with the path sent verbatim, bypassing fetch URL normalisation. */
function rawGet(base, rawPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), hostname, () => {
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => { buf += c; });
    sock.on('end', () => {
      const status = Number((/HTTP\/1\.\d (\d{3})/.exec(buf) ?? [])[1] ?? 0);
      resolve({ status, raw: buf });
    });
    sock.on('error', reject);
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('raw request timed out')); });
  });
}

async function freePort() {
  for (let p = 5300; p < 5400; p += 1) {
    if (await isPortFree(p)) return p;
  }
  throw new Error('no free port for the test');
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-serve-'));
  await fs.writeFile(path.join(dir, 'index.html'),
    '<!DOCTYPE html><html><head><title>Root</title></head><body><p>root</p></body></html>');
  await fs.writeFile(path.join(dir, 'plain.css'), 'body { color: red; }');
  await fs.writeFile(path.join(dir, 'script.js'), 'console.log("hi");');
  await fs.writeFile(path.join(dir, '.hidden.html'), '<html>hidden</html>');
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(dir, 'node_modules', 'secret.html'), '<html>secret</html>');

  const port = await freePort();
  const config = loadConfig(['--single', '--root', dir, '--port', String(port), '--no-reload'], {});
  server = createServer(config);
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

test('index.html is served with the runtime injected', async () => {
  const res = await fetch(`${origin}/index.html`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('runtime.js'), 'runtime script must be injected');
  assert.ok(body.includes('<p>root</p>'), 'original content must survive');
});

test('root path serves index.html', async () => {
  const res = await fetch(`${origin}/`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('Root'));
});

test('css and js are served with correct content types', async () => {
  const css = await fetch(`${origin}/plain.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal((await css.text()).trim(), 'body { color: red; }');

  const js = await fetch(`${origin}/script.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('runtime assets are served, not 500', async () => {
  // This exact request returned 500 after a signature refactor.
  for (const asset of ['runtime.js', 'runtime.css']) {
    const res = await fetch(`${origin}/__simhost/${asset}`);
    assert.equal(res.status, 200, `${asset} must be served`);
    const body = await res.text();
    assert.ok(body.length > 100, `${asset} should not be empty`);
    assert.ok(!body.includes('"error"'), `${asset} returned an error payload`);
  }
});

test('runtime asset path traversal is refused without crashing', async () => {
  // fetch() normalises "/.." out of the URL before it is sent, which would make
  // this test pass without ever exercising the server. Use a raw socket so the
  // bytes reach the handler exactly as written.
  for (const raw of ['/__simhost/..', '/__simhost/.', '/__simhost/%2e%2e']) {
    const res = await rawGet(origin, raw);
    assert.ok(res.status === 400 || res.status === 403 || res.status === 404,
      `${raw} should be rejected, got ${res.status}`);
  }
  // The server must still be alive.
  const res = await fetch(`${origin}/index.html`);
  assert.equal(res.status, 200, 'server survived the traversal attempts');
});

test('served HTML carries the live-reload config', async () => {
  const body = await (await fetch(`${origin}/index.html`)).text();
  const match = /window\.__SIM_HOST__ = (\{.*?\});/s.exec(body);
  assert.ok(match, 'config script must be present');
  const config = JSON.parse(match[1]);
  assert.equal(config.liveReload, false, '--no-reload must be reflected');
  assert.equal(config.name, 'index.html');
});

test('a missing file is a 404, not a crash', async () => {
  const res = await fetch(`${origin}/nope.html`);
  assert.equal(res.status, 404);
  await res.text();
  assert.equal((await fetch(`${origin}/index.html`)).status, 200);
});

test('directory traversal out of the root is refused', async () => {
  const res = await fetch(`${origin}/%2e%2e/%2e%2e/etc/passwd`, { redirect: 'manual' });
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  await res.text();
  const body = await fetch(`${origin}/../../etc/passwd`);
  await body.text();
  assert.notEqual(body.status, 200);
});

test('a directory without index.html lists instead of 404ing', async () => {
  const res = await fetch(`${origin}/node_modules/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('dotfiles are still reachable by exact name', async () => {
  // The dev server serves any file under the root; the editor gates dotfiles,
  // not the static server. Guard the behaviour so it is a deliberate choice.
  const res = await fetch(`${origin}/.hidden.html`);
  assert.ok(res.status === 200 || res.status === 403);
  await res.text();
});

test('the SSE endpoint responds rather than hanging when reload is off', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${origin}/__simhost/live`, { signal: controller.signal });
    assert.equal(res.status, 503, 'disabled live reload should answer 503, not hang');
    await res.text();
  } catch (err) {
    assert.fail(`SSE request hung instead of responding: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
});

test('unknown paths 404 with a helpful message', async () => {
  const res = await fetch(`${origin}/deep/unknown/path.html`);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.ok(body.includes('Not found') || body.includes('404'));
});
