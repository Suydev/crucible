// test/vendor.test.mjs
// The CDN allowlist and URL rewriting are the security boundary here: a bad
// host must never be fetched, and rewriting must be predictable.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  VENDOR_PREFIX,
  isVendorable,
  vendorPathFor,
  rewriteCdnUrls,
  findCdnUrls,
  readManifest,
  remoteUrlFor,
} from '../lib/vendor.mjs';

test('allowlist accepts known CDNs', () => {
  assert.equal(isVendorable('https://unpkg.com/three@0.128.0/build/three.min.js'), true);
  assert.equal(isVendorable('https://cdn.jsdelivr.net/npm/three/build/three.js'), true);
  assert.equal(isVendorable('https://esm.sh/react'), true);
});

test('allowlist rejects anything else', () => {
  assert.equal(isVendorable('https://evil.example.com/x.js'), false);
  assert.equal(isVendorable('http://127.0.0.1:8080/x.js'), false);
  assert.equal(isVendorable('file:///etc/passwd'), false);
  assert.equal(isVendorable('javascript:alert(1)'), false);
  assert.equal(isVendorable('not a url'), false);
});

test('vendor path mapping is reversible and traversal-free', () => {
  const rel = vendorPathFor('https://unpkg.com/three@0.128.0/build/three.min.js');
  assert.match(rel, /unpkg\.com/);
  assert.match(rel, /three\.min\.js$/);
  assert.ok(!rel.includes('..'), 'must not contain traversal');
});

test('traversal attempts in a URL cannot escape the cache', () => {
  const rel = vendorPathFor('https://unpkg.com/../../etc/passwd');
  assert.ok(!rel.includes('..'), `traversal survived: ${rel}`);
});

test('rewriting converts CDN urls to vendor paths', () => {
  const html = '<script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>';
  const { html: out, urls } = rewriteCdnUrls(html);
  assert.ok(out.includes(`${VENDOR_PREFIX}unpkg.com/`), 'should point at the vendor prefix');
  assert.ok(!out.includes('https://unpkg.com'), 'remote url should be gone');
  assert.deepEqual(urls, ['https://unpkg.com/three@0.128.0/build/three.min.js']);
});

test('rewriting leaves non-allowlisted urls untouched', () => {
  const html = '<a href="https://example.com/page">x</a>';
  const { html: out } = rewriteCdnUrls(html);
  assert.equal(out, html);
});

test('rewriting handles multiple and multiple-line documents', () => {
  const html = [
    '<script src="https://unpkg.com/a.js"></script>',
    '<link href="https://cdn.jsdelivr.net/npm/b.css">',
    '<script>const x = "https://esm.sh/c";</script>',
  ].join('\n');
  const { urls } = rewriteCdnUrls(html);
  assert.equal(urls.length, 3);
});

test('findCdnUrls discovers without rewriting', () => {
  const html = '<script src="https://unpkg.com/three@0.128.0/build/three.min.js"></script>';
  assert.equal(findCdnUrls(html).length, 1);
});

test('manifest read is tolerant of a missing or corrupt file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-manifest-'));
  const missing = await readManifest(dir);
  assert.deepEqual(missing.entries, {});

  await fs.writeFile(path.join(dir, 'manifest.json'), '{not json', 'utf8');
  const corrupt = await readManifest(dir);
  assert.deepEqual(corrupt.entries, {}, 'corrupt manifest must not throw');

  await fs.rm(dir, { recursive: true, force: true });
});

// ------------------------------------------------------ manifest reverse lookup

test('a cached path maps back to its upstream URL, query and all', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-rev-'));
  try {
    // The manifest is written directly rather than by downloading: this suite
    // must never touch the network.
    const url = 'https://esm.sh/three@0.128.0?target=es2022';
    const rel = vendorPathFor(url);
    assert.ok(rel.includes('__q'), 'the query must have been folded into the name');

    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      version: 1,
      entries: { [url]: { file: rel, sha256: 'x', bytes: 1 } },
    }));

    // Reconstructing by prefixing https:// would request a URL that does not
    // exist upstream, so the manifest is the only thing that knows the query.
    assert.equal(await remoteUrlFor(rel, root), url);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an uncached path falls back to the path-as-URL form', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-rev2-'));
  try {
    // No manifest entry exists, but the path is a valid allowlisted URL, and
    // guessing here is what lets a cold cache fetch on demand. The manifest
    // only has to win when the two forms differ.
    assert.equal(
      await remoteUrlFor('unpkg.com/not-cached/file.js', root),
      'https://unpkg.com/not-cached/file.js',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a non-allowlisted host is never returned by the reverse lookup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-rev3-'));
  try {
    await fs.mkdir(path.join(root, 'evil.example'), { recursive: true });
    await fs.writeFile(path.join(root, 'evil.example', 'x.js'), 'x');
    assert.equal(await remoteUrlFor('evil.example/x.js', root), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// -------------------------------------------------- bare package resolution

test('package entry resolution refuses non-packages and subpaths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'simhost-pkg-'));
  try {
    const { resolvePackageEntry } = await import('../lib/vendor.mjs');
    // Resolving these would need a network round trip; the guard must reject
    // them before that happens.
    assert.equal(await resolvePackageEntry('./local.js', root), null);
    assert.equal(await resolvePackageEntry('/abs.js', root), null);
    assert.equal(await resolvePackageEntry('three/addons/controls/OrbitControls.js', root), null);
    assert.equal(await resolvePackageEntry('@scope/pkg/sub', root), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a document naming only bare specs triggers dependency work', async () => {
  const { findBareSpecifiers } = await import('../lib/import-map.mjs');
  // The pipeline used to be keyed off findCdnUrls, so a page whose only import
  // is `import('three')` named no CDN URL and was skipped entirely.
  const html = '<script type="module">const m = await import("three");</script>';
  assert.deepEqual(findBareSpecifiers(html), ['three']);
  assert.deepEqual(findBareSpecifiers('<html><body>none</body></html>'), []);
});
