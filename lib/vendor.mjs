#!/usr/bin/env node
// vendor.mjs
// Resolves external CDN dependencies used by simulations, downloads them once,
// and serves them from a local cache.
//
// Why: a simulation should not need the internet to run, and a pinned CDN URL
// should keep meaning the same thing tomorrow. Everything fetched is stored
// under vendor/ and recorded in vendor/manifest.json with its resolved
// integrity, so a rebuild is reproducible and offline.
//
// Safety: only an allowlist of CDN hosts may be fetched. Arbitrary URLs are
// refused, which keeps this from being an open proxy.

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VENDOR_PREFIX = '/__simhost/vendor/';

/** CDN hosts this project is allowed to fetch from. */
const ALLOWED_HOSTS = new Set([
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'esm.sh',
  'skypack.dev',
  'cdn.skypack.dev',
  'raw.githubusercontent.com',
]);

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 25 * 1024 * 1024;

/** True when a URL points at an allowlisted CDN. */
export function isVendorable(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? ALLOWED_HOSTS.has(url.hostname)
      : false;
  } catch {
    return false;
  }
}

/** Maps a remote URL to its path inside the vendor directory. */
export function vendorPathFor(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/[^a-z0-9.-]/gi, '_');
  const rest = `${url.pathname}${url.search}`.replace(/^\/+/, '');
  return path.join(host, rest.replace(/\.\./g, '_'));
}

/** Inverse of vendorPathFor: the original remote URL for a cached file. */
export function remoteUrlFor(relVendorPath) {
  const normalized = relVendorPath.split(path.sep).join('/');
  const slash = normalized.indexOf('/');
  if (slash === -1) return null;
  const host = normalized.slice(0, slash).replace(/_/g, '.');
  const rest = normalized.slice(slash);
  const base = ALLOWED_HOSTS.has(host) ? host : null;
  return base ? `https://${host}${rest}` : null;
}

// Matches any allowlisted CDN URL appearing inside markup or a JS import.
// Stops at quote/space/end so prose mentioning a URL is not mangled.
const URL_PATTERN = new RegExp(
  `https?://(${Array.from(ALLOWED_HOSTS).map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/[^"'\\s)<>\\]]*`,
  'g',
);

/**
 * Rewrites every CDN reference in a document to a local vendor path.
 * Returns { html, urls } where urls is the list of remote URLs replaced.
 */
export function rewriteCdnUrls(html) {
  const urls = new Set();
  const out = html.replace(URL_PATTERN, (match) => {
    if (!isVendorable(match)) return match;
    urls.add(match);
    return VENDOR_PREFIX + vendorPathFor(match).split(path.sep).join('/');
  });
  return { html: out, urls: [...urls] };
}

/** Collects every CDN URL referenced by a document, without rewriting. */
export function findCdnUrls(html) {
  const found = new Set();
  for (const match of html.matchAll(URL_PATTERN)) {
    if (isVendorable(match[0])) found.add(match[0]);
  }
  return [...found];
}

/** Reads the manifest, returning an empty one when absent or corrupt. */
export async function readManifest(vendorRoot) {
  try {
    const raw = await fsp.readFile(path.join(vendorRoot, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, entries: {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

async function writeManifest(vendorRoot, manifest) {
  await fsp.mkdir(vendorRoot, { recursive: true });
  const target = path.join(vendorRoot, 'manifest.json');
  const temp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsp.rename(temp, target);
}

/**
 * Downloads one URL into the vendor cache unless already present.
 * Writes atomically so a crash never leaves a truncated file that later looks
 * cached. Returns { url, file, status, bytes, sha256, fromCache }.
 */
export async function vendorOne(url, vendorRoot, { force = false, log = () => {} } = {}) {
  if (!isVendorable(url)) {
    throw new Error(`refusing to fetch non-allowlisted host: ${url}`);
  }

  const rel = vendorPathFor(url);
  const abs = path.join(vendorRoot, rel);

  if (!force) {
    try {
      const stat = await fsp.stat(abs);
      if (stat.size > 0) {
        const manifest = await readManifest(vendorRoot);
        return { url, file: rel, status: 'cached', bytes: stat.size, sha256: manifest.entries[url]?.sha256 ?? null, fromCache: true };
      }
    } catch {
      // not cached yet
    }
  }

  log(`fetch ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'sim-host/1.0 (+vendor-resolver)' },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`fetch failed ${response.status} ${response.statusText} for ${url}`);
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength && contentLength > MAX_BYTES) {
    throw new Error(`refusing ${url}: ${contentLength} bytes exceeds ${MAX_BYTES}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`refusing ${url}: response exceeded ${MAX_BYTES} bytes`);
  }
  if (buffer.byteLength === 0) {
    throw new Error(`empty response for ${url}`);
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  await fsp.mkdir(path.dirname(abs), { recursive: true });
  const temp = `${abs}.${process.pid}.tmp`;
  await fsp.writeFile(temp, buffer);
  await fsp.rename(temp, abs);

  const manifest = await readManifest(vendorRoot);
  manifest.entries[url] = {
    file: rel.split(path.sep).join('/'),
    sha256,
    bytes: buffer.byteLength,
    resolvedFrom: response.url || url,
    vendoredAt: new Date().toISOString(),
  };
  await writeManifest(vendorRoot, manifest);

  return { url, file: rel, status: 'downloaded', bytes: buffer.byteLength, sha256, fromCache: false };
}

/**
 * Ensures every URL in a list is cached. Downloads in parallel with a small
 * concurrency cap so a doc with many deps cannot open dozens of sockets.
 */
export async function vendorAll(urls, vendorRoot, { force = false, log = () => {}, concurrency = 4 } = {}) {
  const results = [];
  const queue = [...new Set(urls)];
  const workers = Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, async () => {
    for (;;) {
      const url = queue.shift();
      if (!url) return;
      try {
        results.push(await vendorOne(url, vendorRoot, { force, log }));
      } catch (err) {
        results.push({ url, status: 'error', error: err.message });
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Rewrites a bundled library's own relative asset references to vendor paths,
 * so a downloaded add-on that loads a sibling file resolves locally too.
 * Only rewrites when the referenced sibling exists in the cache.
 */
export async function rewriteVendoredImports(source, absFile) {
  const dir = path.dirname(absFile);
  const rewrites = new Map();

  for (const match of source.matchAll(/(from|import)\s*\(?\s*['"](\.\.?\/[^'"]+)['"]/g)) {
    const target = path.resolve(dir, match[2]);
    if (fs.existsSync(target)) rewrites.set(match[2], VENDOR_PREFIX + path.relative(dir, target).split(path.sep).join('/'));
  }

  let out = source;
  for (const [from, to] of rewrites) {
    out = out.split(`'${from}'`).join(`'${to}'`).split(`"${from}"`).join(`"${to}"`);
  }
  return out;
}
