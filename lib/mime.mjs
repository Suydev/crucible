#!/usr/bin/env node
// mime.mjs
// Minimal extension -> Content-Type map. Deliberately tiny: simulations are
// HTML/JS/CSS/SVG/JSON/images, not a general-purpose media library.

import path from 'node:path';

const TYPES = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}));

/**
 * Content-Type for a file path.
 *
 * `vendorHint` covers vendored CDN modules, which frequently have no extension
 * at all (esm.sh/three@0.128.0, jsdelivr /npm/pkg@1/+esm). Chromium enforces
 * strict MIME checking on module scripts and refuses anything that is not a
 * JavaScript type, so guessing octet-stream for those made the whole page fail
 * before a single line of the library ran.
 */
export function contentTypeFor(filePath, { vendorHint = false } = {}) {
  const known = TYPES.get(path.extname(filePath).toLowerCase());
  if (known) return known;
  if (vendorHint) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * True when a vendored file is JS-shaped rather than a real asset. Extensionless
 * CDN module URLs and anything under a package's +esm/ or esm.sh tree count.
 */
export function looksLikeVendorModule(filePath, originalUrl = '') {
  const lower = filePath.toLowerCase();
  if (/\.(mjs|js|cjs|jsx|ts|tsx)$/.test(lower)) return true;
  if (/\.(json|wasm|css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|map|html?|txt|xml|md)$/.test(lower)) {
    return false;
  }
  // No extension at all, and the URL looks like a module endpoint.
  const url = String(originalUrl).toLowerCase().split('?')[0];
  if (/\/\+esm\/?$/.test(url)) return true;
  // esm.sh and skypack serve module entry points with no file extension at
  // all: esm.sh/three@0.128.0, esm.sh/three@0.128.0/es2022/three.mjs
  if (/^https?:\/\/(esm\.sh|esm\.run|[a-z.]*skypack[a-z.]*|cdn\.skypack\.[a-z]+)\//.test(url)) return true;
  if (/\.[a-z]{2,5}$/.test(url)) return true;   // has a real extension
  return !path.extname(lower);                    // bare path -> treat as module
}

/** True when the path should be served with no-cache headers (dev asset). */
export function isReloadSensitive(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.html' || ext === '.htm' || ext === '.js' || ext === '.mjs' || ext === '.css';
}