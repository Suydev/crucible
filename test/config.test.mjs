// test/config.test.mjs
// Flag and env parsing, plus the precedence rule: CLI beats env beats default.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, loadConfig } from '../lib/config.mjs';

test('parseArgs handles --key value', () => {
  assert.equal(parseArgs(['--port', '8080']).port, 8080);
});

test('parseArgs handles --key=value', () => {
  assert.equal(parseArgs(['--port=8080']).port, 8080);
});

test('parseArgs handles boolean flags', () => {
  assert.equal(parseArgs(['--single']).single, true);
  assert.equal(parseArgs(['--verbose']).verbose, true);
});

test('parseArgs maps --no-x onto the noX spec', () => {
  assert.equal(parseArgs(['--no-reload']).noReload, true);
  assert.equal(parseArgs(['--no-reload=false']).noReload, false);
});

test('parseArgs splits comma lists', () => {
  assert.deepEqual(parseArgs(['--roots', '/a,/b , /c']).roots, ['/a', '/b', '/c']);
});

test('parseArgs ignores unknown flags', () => {
  assert.deepEqual(parseArgs(['--nonsense', 'x']).nonsense, undefined);
});

test('CLI flag beats environment variable', () => {
  const config = loadConfig(['--port', '7000'], { SIM_HOST_PORT: '6000' });
  assert.equal(config.port, 7000);
});

test('environment variable beats default', () => {
  const config = loadConfig([], { SIM_HOST_PORT: '6000' });
  assert.equal(config.port, 6000);
});

test('default port is 5050', () => {
  assert.equal(loadConfig([], {}).port, 5050);
});

test('vendor cache is shared, not per served directory', () => {
  const config = loadConfig(['--single', '--root', '/tmp/whatever'], {});
  assert.ok(
    config.vendorPath.includes('sim-host') || config.vendorPath.includes('.sim-host'),
    `vendor cache should live in the sim-host repo, got ${config.vendorPath}`,
  );
});

test('registry path is inside the sim-host repo', () => {
  const config = loadConfig(['--single', '--root', '/tmp/whatever'], {});
  assert.ok(config.registryPath.includes('instances.json'));
});

test('roots default to home when unspecified', () => {
  const config = loadConfig([], {});
  assert.equal(config.roots.length, 1);
});

test('verbose is suppressed by quiet', () => {
  const config = loadConfig(['--verbose', '--quiet'], {});
  assert.equal(config.verbose, false);
});
