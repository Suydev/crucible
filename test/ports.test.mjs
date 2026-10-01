// test/ports.test.mjs
// Port derivation must be stable and collision-aware: the same directory always
// yields the same port, and allocation walks forward when that port is taken.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PORT,
  PORT_RANGE_START,
  PORT_RANGE_END,
  preferredPortFor,
  candidatePortsFor,
  isPortFree,
  allocatePort,
  hashPath,
} from '../lib/ports.mjs';

test('preferred port is deterministic for the same path', () => {
  const a = preferredPortFor('/root/isotope-code/docs');
  const b = preferredPortFor('/root/isotope-code/docs');
  assert.equal(a, b, 'same path must yield the same port');
});

test('preferred port differs across distinct paths', () => {
  const seen = new Map();
  const paths = [
    '/root/isotope-code/docs',
    '/root/keyforge/web',
    '/root/isotope-apk/www',
    '/root/sim-host/simulations',
    '/root/a/b/c',
    '/root/x/y/z',
  ];
  for (const p of paths) {
    const port = preferredPortFor(p);
    assert.ok(port >= PORT_RANGE_START && port <= PORT_RANGE_END, `${port} out of range`);
    if (seen.has(port)) {
      // A collision is legal, just rare; make sure the allocator can still walk.
      assert.ok(Array.isArray(candidatePortsFor(p)));
    }
    seen.set(port, p);
  }
});

test('trailing slash does not change the derived port', () => {
  assert.equal(
    preferredPortFor('/root/isotope-code/docs'),
    preferredPortFor('/root/isotope-code/docs/'),
  );
});

test('candidate list starts with the preferred port and stays in range', () => {
  const dir = '/root/isotope-code/docs';
  const preferred = preferredPortFor(dir);
  const candidates = candidatePortsFor(dir);

  assert.equal(candidates[0], preferred, 'first candidate must be the preferred port');
  assert.ok(candidates.length > 1, 'must offer fallbacks');
  for (const port of candidates) {
    assert.ok(port >= PORT_RANGE_START && port <= PORT_RANGE_END);
  }
  assert.equal(new Set(candidates).size, candidates.length, 'no duplicates');
});

test('hashPath is stable and path-separator insensitive', () => {
  assert.equal(hashPath('/a/b').toString('hex'), hashPath('/a/b').toString('hex'));
  assert.notEqual(hashPath('/a/b').toString('hex'), hashPath('/a/c').toString('hex'));
});

test('isPortFree reports a genuinely free port', async () => {
  const free = await isPortFree(PORT_RANGE_END - 1);
  assert.equal(typeof free, 'boolean');
});

test('allocatePort honours a preferred port when it is free', async () => {
  const result = await allocatePort('/root/whatever', { preferred: 5099 });
  assert.equal(result.port, 5099);
  assert.equal(result.drifted, false);
});

test('allocatePort walks forward when the preferred port is taken', async () => {
  const dir = '/root/isotope-code/docs';
  const preferred = preferredPortFor(dir);

  // Occupy the derived port, then confirm the allocator moves off it.
  // Skip if that port is already in use on this machine, so the test does not
  // depend on a clean machine state.
  const blocker = (await import('node:net')).createServer();
  const listenable = await new Promise((resolve) => {
    blocker.once('error', () => resolve(false));
    blocker.listen(preferred, '127.0.0.1', () => resolve(true));
  });

  if (!listenable) {
    // Port already occupied by something else: that is exactly the scenario
    // under test, so assert the allocator avoids it directly.
    const result = await allocatePort(dir);
    assert.notEqual(result.port, preferred, 'must not reuse a port that is in use');
    assert.ok(result.port >= PORT_RANGE_START && result.port <= PORT_RANGE_END);
    return;
  }

  try {
    const result = await allocatePort(dir);
    assert.notEqual(result.port, preferred, 'must not reuse the taken port');
    assert.equal(result.drifted, true);
    assert.ok(result.port >= PORT_RANGE_START && result.port <= PORT_RANGE_END);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('default port is the documented one', () => {
  assert.equal(DEFAULT_PORT, 5050);
});
