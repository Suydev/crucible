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

/** Returns the Content-Type for a file path, defaulting to octet-stream. */
export function contentTypeFor(filePath) {
  return TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

/** True when the path should be served with no-cache headers (dev asset). */
export function isReloadSensitive(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.html' || ext === '.htm' || ext === '.js' || ext === '.mjs' || ext === '.css';
}