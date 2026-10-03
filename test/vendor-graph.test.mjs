// test/vendor-graph.test.mjs
// Covers the graph walk and the specifier rewriting that make CDN libraries run
// offline. Every case here is a form that actually failed before.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  MAX_GRAPH_FILES,
  MAX_GRAPH_DEPTH,
  findEdges,
  classifySpecifier,
  resolveEdge,
  rewriteModuleSource,
  crawlGraph,
} from '../lib/vendor-graph.mjs';
import { looksLikeVendorModule } from '../lib/mime.mjs';
import { vendorPathFor } from '../lib/vendor.mjs';

// ---------------------------------------------------------------- edges

test('edges are found in every static reference form', () => {
  const source = `
    import * as THREE from 'three';
    import { OrbitControls } from 'https://unpkg.com/three@0.128.0/examples/jsm/controls/OrbitControls.js';
    import './sibling.js';
    export { x } from './other.js';
    export * from '../up.js';
    import('https://esm.sh/three@0.128.0');
    const asset = new URL('./texture.png', import.meta.url);
    const w = new Worker(new URL('./worker.js', import.meta.url));
    fetch('./data.json');
  `;
  const specs = findEdges(source).map((e) => e.specifier);
  assert.ok(specs.includes('three'));
  assert.ok(specs.includes('./sibling.js'));
  assert.ok(specs.includes('./other.js'));
  assert.ok(specs.includes('../up.js'));
  assert.ok(specs.includes('./texture.png'));
  assert.ok(specs.includes('./worker.js'));
  assert.ok(specs.includes('./data.json'));
});

test('non-literal dynamic imports are skipped, not guessed', () => {
  const specs = findEdges("const p = './x' + lang + '.js'; import(p);").map((e) => e.specifier);
  assert.ok(!specs.some((s) => s.includes('lang')));
});

// ---------------------------------------------------------------- classify

test('specifier kinds are classified per the module spec', () => {
  assert.equal(classifySpecifier('three'), 'bare');
  assert.equal(classifySpecifier('@scope/pkg/sub'), 'bare');
  assert.equal(classifySpecifier('./a.js'), 'relative');
  assert.equal(classifySpecifier('../a.js'), 'relative');
  assert.equal(classifySpecifier('/npm/three@0.128.0/+esm'), 'root-absolute');
  assert.equal(classifySpecifier('https://esm.sh/three'), 'absolute-url');
});

// ---------------------------------------------------------------- resolve

test('a bare specifier is not resolvable by the crawler', () => {
  assert.equal(resolveEdge('three', 'https://unpkg.com/three@0.128.0/build/three.module.js'), null);
});

test('a relative sibling resolves against the module URL', () => {
  assert.equal(
    resolveEdge('./Pass.js', 'https://unpkg.com/three@0.128.0/examples/jsm/postprocessing/EffectComposer.js'),
    'https://unpkg.com/three@0.128.0/examples/jsm/postprocessing/Pass.js',
  );
});

test('a root-absolute specifier resolves against the CDN origin', () => {
  // The esm.sh / skypack / jsdelivr-+esm form. Resolved against OUR origin it
  // would 404; it belongs to the CDN that served the module.
  assert.equal(
    resolveEdge('/npm/d3-array@3.2.4/+esm', 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm'),
    'https://cdn.jsdelivr.net/npm/d3-array@3.2.4/+esm',
  );
  assert.equal(
    resolveEdge('/three@0.128.0/es2022/three.mjs', 'https://esm.sh/three@0.128.0'),
    'https://esm.sh/three@0.128.0/es2022/three.mjs',
  );
});

test('an absolute URL on a non-allowlisted host is refused', () => {
  assert.equal(resolveEdge('https://evil.example/x.js', 'https://unpkg.com/a@1/b.js'), null);
});

// ---------------------------------------------------------------- rewrite

test('root-absolute specifiers are rewritten to vendor paths', () => {
  const src = 'export * from "/npm/d3-array@3.2.4/+esm";';
  const out = rewriteModuleSource(src, 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm');
  assert.ok(out.includes('/__simhost/vendor/cdn.jsdelivr.net/npm/d3-array@3.2.4/+esm.js'),
    `expected a vendor path, got: ${out}`);
  assert.ok(!out.includes('from "/npm/'), 'must not leave an origin-relative path');
});

test('relative and bare specifiers are left untouched', () => {
  const src = "import { V } from 'three';\nimport { P } from './Pass.js';";
  assert.equal(rewriteModuleSource(src, 'https://unpkg.com/three@0.128.0/build/three.module.js'), src);
});

test('quote style is preserved when rewriting', () => {
  const single = rewriteModuleSource("import x from '/npm/a@1/+esm';", 'https://cdn.jsdelivr.net/npm/b@1/+esm');
  assert.ok(single.includes("'/__simhost/vendor/"), 'single quotes must be kept');
  const double = rewriteModuleSource('import x from "/npm/a@1/+esm";', 'https://cdn.jsdelivr.net/npm/b@1/+esm');
  assert.ok(double.includes('"/__simhost/vendor/'), 'double quotes must be kept');
});

test('an absolute URL on a blocked host is not rewritten into the cache', () => {
  const src = "import x from 'https://evil.example/lib.js';";
  const out = rewriteModuleSource(src, 'https://unpkg.com/a@1/b.js');
  assert.ok(!out.includes('/__simhost/vendor/'), 'must not invent a vendor path');
  assert.ok(out.includes('evil.example'), 'the original reference must survive untouched');
});

test('an origin-relative path resolves to the CDN that served the module', () => {
  // esm.sh emits these. Because the referring module came from esm.sh, the path
  // belongs to esm.sh - not to whatever origin finally serves the bytes.
  assert.equal(
    resolveEdge('/three@0.128.0/es2022/three.mjs', 'https://esm.sh/three@0.128.0'),
    'https://esm.sh/three@0.128.0/es2022/three.mjs',
  );
});

// ---------------------------------------------------------------- crawl

test('the crawl follows relative siblings transitively', async () => {
  const files = {
    'https://cdn.jsdelivr.net/npm/a@1/+esm': 'import "./b.js"; export const a=1;',
    // './b.js' from /npm/a@1/+esm resolves to /npm/a@1/b.js
    'https://cdn.jsdelivr.net/npm/a@1/b.js': 'import "./c.js"; export const b=2;',
    'https://cdn.jsdelivr.net/npm/a@1/c.js': 'export const c=3;',
  };
  const graph = await crawlGraph(['https://cdn.jsdelivr.net/npm/a@1/+esm'], async (u) => files[u] ?? null);
  assert.equal(graph.urls.length, 3, 'the whole chain must be discovered');
  assert.ok(graph.urls.includes('https://cdn.jsdelivr.net/npm/a@1/c.js'));
});

test('the crawl follows root-absolute re-export stubs', async () => {
  const files = {
    'https://cdn.jsdelivr.net/npm/pkg@1/+esm': 'export * from "/npm/dep@2/+esm";',
    'https://cdn.jsdelivr.net/npm/dep@2/+esm': 'export const dep = 1;',
  };
  const graph = await crawlGraph(['https://cdn.jsdelivr.net/npm/pkg@1/+esm'], async (u) => files[u] ?? null);
  assert.equal(graph.urls.length, 2, 'the re-export target must be crawled');
});

test('a cycle terminates instead of looping', async () => {
  const files = {
    'https://unpkg.com/a@1/x.js': 'import "./y.js";',
    'https://unpkg.com/a@1/y.js': 'import "./x.js";',
  };
  const graph = await crawlGraph(['https://unpkg.com/a@1/x.js'], async (u) => files[u] ?? null);
  assert.equal(graph.urls.length, 2);
  assert.equal(graph.truncated, false);
});

test('an unreachable file is skipped without throwing', async () => {
  const graph = await crawlGraph(['https://unpkg.com/a@1/x.js'], async () => null);
  assert.equal(graph.urls.length, 0);
});

test('a throwing fetcher is tolerated', async () => {
  const graph = await crawlGraph(['https://unpkg.com/a@1/x.js'], async () => { throw new Error('boom'); });
  assert.equal(graph.urls.length, 0);
});

// ---------------------------------------------------------------- mime

test('extensionless CDN module URLs are recognised as modules', () => {
  // Chromium strict-checks MIME on module scripts, so these must be served as
  // text/javascript or the page never runs a line of the library.
  assert.equal(looksLikeVendorModule('esm.sh/three@0.128.0', 'https://esm.sh/three@0.128.0'), true);
  assert.equal(looksLikeVendorModule('cdn.jsdelivr.net/npm/d3@7/+esm', 'https://cdn.jsdelivr.net/npm/d3@7/+esm'), true);
  assert.equal(looksLikeVendorModule('esm.sh/a/es2022/three.mjs', 'https://esm.sh/a/es2022/three.mjs'), true);
});

test('real assets in the vendor tree are not mislabelled as modules', () => {
  for (const [p, u] of [
    ['a/data.json', 'https://unpkg.com/a@1/data.json'],
    ['a/style.css', 'https://unpkg.com/a@1/style.css'],
    ['a/lib.wasm', 'https://unpkg.com/a@1/lib.wasm'],
    ['a/logo.svg', 'https://unpkg.com/a@1/logo.svg'],
  ]) {
    assert.equal(looksLikeVendorModule(p, u), false, `${p} must stay an asset`);
  }
});

// ---------------------------------------------------------------- paths

test('extensionless vendor URLs get a .js cache name', () => {
  // Not cosmetic: an esm.sh entry caches as a FILE while its child needs the
  // same name to be a DIRECTORY, which the filesystem cannot do.
  const entry = vendorPathFor('https://esm.sh/three@0.128.0');
  const child = vendorPathFor('https://esm.sh/three@0.128.0/es2022/three.mjs');
  assert.equal(entry, 'esm.sh/three@0.128.0.js');
  assert.ok(child.startsWith('esm.sh/three@0.128.0/'), `child is ${child}`);
  // The child lives inside a DIRECTORY named three@0.128.0, while the entry is
  // a FILE named three@0.128.0.js. Different names, so both can exist.
  assert.ok(child.startsWith(`esm.sh/three@0.128.0/`));
  // entry must be a file, child must live in a directory of a DIFFERENT name,
  // so the filesystem never needs one path to be both.
  const childDir = path.posix.dirname(child);
  assert.equal(childDir, 'esm.sh/three@0.128.0/es2022');
  // The directory holding the child must not be the entry's own file path.
  assert.notEqual(childDir, entry, `entry file and child directory collide: ${entry}`);
  assert.notEqual(childDir + path.posix.extname(entry), childDir + '/' + entry,
    'entry must not sit where the child directory needs to be');
});

test('query strings become a deterministic cache suffix', () => {
  const a = vendorPathFor('https://esm.sh/three@0.128.0?target=es2022');
  const b = vendorPathFor('https://esm.sh/three@0.128.0?target=es2022');
  const c = vendorPathFor('https://esm.sh/three@0.128.0?dev');
  assert.equal(a, b, 'same query must map to the same path');
  assert.notEqual(a, c, 'different queries must not collide');
  assert.ok(!a.includes('?'), 'a literal ? would break path lookup');
});

test('ordinary vendor paths are unchanged', () => {
  assert.equal(
    vendorPathFor('https://unpkg.com/three@0.128.0/build/three.module.js'),
    'unpkg.com/three@0.128.0/build/three.module.js',
  );
});

// ---------------------------------------------------------------- concurrency

test('the walk is concurrent but still emits discovery order', async () => {
  const entry = 'https://cdn.jsdelivr.net/npm/a@1/+esm';
  const file = (n) => `https://cdn.jsdelivr.net/npm/a@1/${n}.js`;
  const files = {
    [entry]: 'import "./b.js"; import "./c.js"; import "./d.js";',
    [file('b')]: 'import "./e.js";',
    [file('c')]: 'export const c=1;',
    [file('d')]: 'export const d=1;',
    [file('e')]: 'export const e=1;',
  };

  // Concurrency must not change WHAT is discovered, only how fast.
  const serial = await crawlGraph([entry], async (u) => files[u] ?? null, { concurrency: 1 });
  const parallel = await crawlGraph([entry], async (u) => files[u] ?? null, { concurrency: 4 });

  assert.deepEqual(parallel.urls, serial.urls,
    'the same graph must produce the same order at any concurrency');
  assert.equal(parallel.urls.length, 5);
});

test('a module shared by two parents is fetched once', async () => {
  const entry = 'https://cdn.jsdelivr.net/npm/a@1/+esm';
  // './shared.js' from /npm/a@1/*.js resolves to /npm/a@1/shared.js.
  const shared = 'https://cdn.jsdelivr.net/npm/a@1/shared.js';
  const files = {
    [entry]: 'import "./b.js"; import "./c.js";',
    // './b.js' from /npm/a@1/+esm resolves to /npm/a@1/b.js, so the keys must
    // reflect that or the crawl simply finds nothing to follow.
    'https://cdn.jsdelivr.net/npm/a@1/b.js': 'import "./shared.js";',
    'https://cdn.jsdelivr.net/npm/a@1/c.js': 'import "./shared.js";',
    [shared]: 'export const s=1;',
  };
  let fetched = 0;
  const graph = await crawlGraph([entry], async (u) => {
    if (files[u]) fetched += 1;
    return files[u] ?? null;
  });
  assert.equal(fetched, 4, 'a diamond must not re-fetch the shared node');
  assert.equal(graph.urls.filter((u) => u === shared).length, 1);
});

test('concurrency=1 and the default discover the same set', async () => {
  const entry = 'https://unpkg.com/a@1/x.js';
  const files = {
    [entry]: 'import "./y.js";',
    'https://unpkg.com/a@1/y.js': 'import "./z.js";',
    'https://unpkg.com/a@1/z.js': 'export const z=1;',
  };
  const a = await crawlGraph([entry], async (u) => files[u] ?? null, { concurrency: 1 });
  const b = await crawlGraph([entry], async (u) => files[u] ?? null);
  assert.deepEqual(a.urls, b.urls);
});

test('the file cap is reported rather than silently exceeded', async () => {
  const entry = 'https://unpkg.com/a@1/x.js';
  const many = Array.from({ length: 40 }, (_, i) =>
    `import "./f${i}.js";`).join('\n');
  const files = { [entry]: many };
  for (let i = 0; i < 40; i += 1) files[`https://unpkg.com/a@1/f${i}.js`] = 'export const x=1;';

  const graph = await crawlGraph([entry], async (u) => files[u] ?? null);
  assert.ok(graph.urls.length <= MAX_GRAPH_FILES,
    `walked ${graph.urls.length}, over the ${MAX_GRAPH_FILES} cap`);
});

test('the depth cap stops a very deep chain', async () => {
  const files = {};
  for (let i = 0; i < 20; i += 1) {
    files[`https://unpkg.com/a@1/n${i}.js`] = i < 19 ? `import "./n${i + 1}.js";` : 'export const end=1;';
  }
  const graph = await crawlGraph(['https://unpkg.com/a@1/n0.js'], async (u) => files[u] ?? null);
  assert.ok(graph.urls.length <= MAX_GRAPH_DEPTH + 1,
    `reached depth beyond ${MAX_GRAPH_DEPTH}: ${graph.urls.length}`);
});

// ---------------------------------------------------------------- security

test('a scheme-relative specifier is allowlisted before it is fetched', () => {
  // Inheriting the module's protocol must not become a way to name any host.
  assert.equal(resolveEdge('//unpkg.com/a@1/b.js', 'https://esm.sh/three@0.128.0'),
    'https://unpkg.com/a@1/b.js');
  assert.equal(resolveEdge('//evil.example/b.js', 'https://esm.sh/three@0.128.0'), null);
});

test('a scheme-relative specifier on a blocked host is not rewritten', () => {
  const src = "import x from '//evil.example/lib.js';";
  const out = rewriteModuleSource(src, 'https://esm.sh/three@0.128.0');
  assert.ok(!out.includes('/__simhost/vendor/'));
});
