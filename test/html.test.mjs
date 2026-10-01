// test/html.test.mjs
// Injection must be idempotent - a served document is re-read per request, and a
// double injection would stack duplicate runtime tags on every load.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtml,
  jsonForScript,
  extractTitle,
  extractDescription,
  injectRuntime,
  RUNTIME_MARKER,
} from '../lib/html.mjs';

const OPTS = {
  cssHref: '/__simhost/runtime.css',
  jsSrc: '/__simhost/runtime.js',
  config: { name: 'x.html', path: '/x.html', liveReload: true },
};

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
});

test('jsonForScript escapes sequences that could break out of a script block', () => {
  const out = jsonForScript({ x: '</script><script>alert(1)</script>' });
  assert.ok(!out.includes('</script>'), 'must not emit a closing script tag');
});

test('extractTitle reads the title tag', () => {
  assert.equal(extractTitle('<html><head><title>Hello</title></head></html>'), 'Hello');
});

test('extractTitle falls back when absent', () => {
  assert.equal(extractTitle('<html><body>x</body></html>', 'Fallback'), 'Fallback');
});

test('extractDescription prefers meta description then h1', () => {
  assert.equal(
    extractDescription('<meta name="description" content="From meta"><h1>H</h1>'),
    'From meta',
  );
  assert.equal(extractDescription('<h1>From heading</h1>'), 'From heading');
});

test('injection adds css, config, and the module script', () => {
  const out = injectRuntime('<html><head><title>t</title></head><body>b</body></html>', OPTS);
  assert.ok(out.includes('runtime.css'));
  assert.ok(out.includes('runtime.js'));
  assert.ok(out.includes('__SIM_HOST__'));
  assert.ok(out.includes(RUNTIME_MARKER));
});

test('injection is idempotent', () => {
  const once = injectRuntime('<html><head></head><body></body></html>', OPTS);
  const twice = injectRuntime(once, OPTS);
  assert.equal(once, twice, 'second injection must be a no-op');
  assert.equal(twice.split(RUNTIME_MARKER).length - 1, once.split(RUNTIME_MARKER).length - 1);
});

test('injection handles a document with no head or body', () => {
  const out = injectRuntime('<p>bare fragment</p>', OPTS);
  assert.ok(out.includes('runtime.css'));
  assert.ok(out.includes('runtime.js'));
});

test('injection preserves the original body content', () => {
  const out = injectRuntime('<html><body><h1>Keep me</h1></body></html>', OPTS);
  assert.ok(out.includes('<h1>Keep me</h1>'));
});

test('injection places the script before the closing body tag', () => {
  const out = injectRuntime('<html><body>x</body></html>', OPTS);
  assert.ok(out.indexOf('runtime.js') < out.indexOf('</body>'));
});
