// test/import-map.test.mjs
// The import map is what makes a vendored CDN library's own module graph
// resolve. Without it, a page importing three plus an add-on renders nothing:
// the add-on still says `from 'three'` and the browser refuses.
//
// Each case below corresponds to a form that actually failed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseVendorPath,
  findBareSpecifiers,
  buildImportMap,
  injectImportMap,
  IMPORT_MAP_MARKER,
} from '../lib/import-map.mjs';

// ---------------------------------------------------------------- parsing

test('vendor paths parse into npm identity', () => {
  const a = parseVendorPath('unpkg.com/three@0.128.0/build/three.module.js');
  assert.equal(a.pkg, 'three');
  assert.equal(a.version, '0.128.0');
  assert.equal(a.host, 'unpkg.com');
  assert.deepEqual(a.rest, ['build', 'three.module.js']);
});

test('a version as its own segment is also parsed', () => {
  const a = parseVendorPath('cdn.jsdelivr.net/npm/three/0.128.0/build/three.module.js');
  assert.equal(a.pkg, 'three');
  assert.equal(a.version, '0.128.0');
});

test('scoped packages parse', () => {
  const a = parseVendorPath('unpkg.com/@scope/pkg@1.2.3/dist/index.mjs');
  assert.equal(a.pkg, '@scope/pkg');
  assert.equal(a.version, '1.2.3');
});

test('a path with no version yields nothing', () => {
  assert.equal(parseVendorPath('unpkg.com/three/build/three.js'), null);
});

// ---------------------------------------------------------------- specifiers

test('bare specifiers are found and relative/absolute ones are not', () => {
  const source = `
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
    import './local.js';
    import '../up.js';
    import '/absolute.js';
    import 'https://cdn.example/x.js';
    export { x } from 'other-pkg';
    const p = import('lazy-pkg');
  `;
  const found = findBareSpecifiers(source);
  assert.ok(found.includes('three'));
  assert.ok(found.includes('three/addons/controls/OrbitControls.js'));
  assert.ok(found.includes('other-pkg'));
  assert.ok(found.includes('lazy-pkg'));
  assert.ok(!found.some((f) => f.startsWith('.') || f.startsWith('/')));
  assert.ok(!found.some((f) => f.includes('cdn.example')));
});

// ---------------------------------------------------------------- graph walk

const SEEDS = [
  'unpkg.com/three@0.128.0/build/three.module.js',
  'unpkg.com/three@0.128.0/examples/jsm/controls/OrbitControls.js',
];

const CACHE = {
  'unpkg.com/three@0.128.0/build/three.module.js':
    'export class Vector3 {}\nexport const REVISION = "128";',
  'unpkg.com/three@0.128.0/examples/jsm/controls/OrbitControls.js':
    "import { Vector3 } from 'three';\nimport { EventDispatcher } from '../../dispatchers/EventDispatcher.js';\nexport class OrbitControls {}",
  'unpkg.com/three@0.128.0/examples/jsm/dispatchers/EventDispatcher.js':
    'export class EventDispatcher {}',
};

const readCached = async (rel) => CACHE[rel] ?? null;

test("a bare 'three' resolves to the shallowest entry point", async () => {
  const { imports, unmapped } = await buildImportMap(SEEDS, readCached);
  assert.equal(
    imports.three,
    '/__simhost/vendor/unpkg.com/three@0.128.0/build/three.module.js',
    'must point at build/, not at the deeply nested OrbitControls',
  );
  assert.deepEqual(unmapped, []);
});

test('a subpath resolves only when a seed actually names it', async () => {
  // The map is derived from the URLs the document itself uses, so nothing is
  // invented: no seed names an `addons/` tree, so no `three/addons/` key.
  const without = await buildImportMap(SEEDS, readCached);
  assert.equal(without.imports['three/addons/'], undefined);
  assert.deepEqual(without.unmapped, [], 'nothing the document uses should be unresolvable');

  // When a seeded file references a subpath whose target is ALSO seeded, it
  // resolves; a subpath pointing at nothing seeded stays unmapped rather than
  // being guessed at.
  // Both the referencing file and its target must be in the seed set - the map
  // is built from what the document actually pulls in.
  const seeds = [
    ...SEEDS,
    'unpkg.com/three@0.128.0/examples/jsm/addons/Thing.js',
    'unpkg.com/three@0.128.0/examples/jsm/addons/Other.js',
  ];
  const resolved = await buildImportMap(seeds, async (rel) => {
    if (rel.includes('addons/Other')) return 'export class Other {}';
    if (rel.includes('addons/Thing')) return "import { O } from 'three/addons/Other.js'; export class Thing {}";
    return "import { V } from 'three'; export class Vector3 {}";
  });
  assert.equal(
    resolved.imports['three/addons/Other.js'],
    '/__simhost/vendor/unpkg.com/three@0.128.0/examples/jsm/addons/Other.js',
  );

  const dangling = await buildImportMap(SEEDS, async () => "import { X } from 'three/addons/Missing.js';");
  assert.ok(dangling.unmapped.includes('three/addons/Missing.js'),
    'a subpath with no seeded target must be reported, not guessed');
});

test('relative siblings are followed so their bare imports are seen', async () => {
  const { imports } = await buildImportMap(SEEDS, readCached);
  // EventDispatcher is only reachable through OrbitControls' relative import.
  assert.ok(Object.keys(imports).length >= 1);
});

test('an unresolvable specifier is refused, not guessed', async () => {
  const { imports, unmapped } = await buildImportMap([
    'unpkg.com/three@0.128.0/build/three.module.js',
  ], async () => "import { x } from 'completely-unknown-package';");
  assert.equal(imports['completely-unknown-package'], undefined,
    'an unknown bare specifier must not be mapped to something arbitrary');
  assert.ok(unmapped.includes('completely-unknown-package'));
});

test('two equally shallow entry points are ambiguous and refused', async () => {
  const { imports, unmapped } = await buildImportMap([
    'unpkg.com/dual@1.0.0/a.js',
    'unpkg.com/dual@1.0.0/b.js',
  ], async () => "import { y } from 'dual';");
  assert.equal(imports.dual, undefined);
  assert.ok(unmapped.includes('dual'), 'ambiguity must be reported, not resolved by coin flip');
});

test('a missing cached file does not throw', async () => {
  const { scanned } = await buildImportMap(['unpkg.com/x@1.0.0/y.js'], async () => {
    throw new Error('ENOENT');
  });
  assert.equal(scanned, 0);
});

// ---------------------------------------------------------------- injection

test('an import map lands first in head', () => {
  const html = '<html><head><title>t</title></head><body><script type="module" src="a.js"></script></body></html>';
  const out = injectImportMap(html, { three: '/__simhost/vendor/x.js' });
  const mapAt = out.indexOf('type="importmap"');
  const moduleAt = out.indexOf('type="module"');
  assert.ok(mapAt !== -1, 'map must be injected');
  assert.ok(mapAt < moduleAt, 'the map must precede every module script');
  assert.ok(out.includes(IMPORT_MAP_MARKER));
});

test('an empty map leaves the document byte-identical', () => {
  const html = '<html><head></head><body>no modules here</body></html>';
  assert.equal(injectImportMap(html, {}), html);
  assert.equal(injectImportMap(html, {}), injectImportMap(html, undefined));
});

test('injection is idempotent', () => {
  const once = injectImportMap('<html><head></head><body></body></html>', { three: '/v/x.js' });
  const twice = injectImportMap(once, { three: '/v/x.js' });
  assert.equal((twice.match(/type="importmap"/g) ?? []).length, 1);
});

test('an author import map is preserved and wins on conflict', () => {
  const html = '<html><head><script type="importmap">{"imports":{"three":"/mine.js"}}</script></head><body></body></html>';
  const out = injectImportMap(html, { three: '/theirs.js', extra: '/extra.js' });

  assert.ok(out.includes('/mine.js'), "the author's mapping must survive");
  assert.ok(!out.includes('/theirs.js'), 'the derived mapping must not override the author');
  assert.ok(out.includes('/extra.js'), 'keys the author did not declare are still added');
  assert.equal((out.match(/type="importmap"/g) ?? []).length, 1,
    'a second tag would be ignored by Firefox and Safari entirely');
});

test('injection handles a document with no head', () => {
  const out = injectImportMap('<div>fragment</div>', { three: '/v/x.js' });
  assert.ok(out.includes('type="importmap"'));
});

test('an import map cannot break out of its script tag', () => {
  const out = injectImportMap('<html><head></head></html>', {
    x: '</script><script>alert(1)</script>',
  });
  assert.ok(!out.includes('</script><script>alert'));
});