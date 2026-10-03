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
import path from 'node:path';
import crypto from 'node:crypto';
import { randomBytes } from 'node:crypto';

export const VENDOR_PREFIX = '/__simhost/vendor/';

/** CDN hosts this project is allowed to fetch from. */
export const ALLOWED_HOSTS = new Set([
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'esm.sh',
  'esm.run',
  'skypack.dev',
  'cdn.skypack.dev',
  'ga.jspm.io',
  'cdn.skypack.io',
]);

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** True when a URL points at an allowlisted CDN. */
export function isVendorable(rawUrl) {
  try {
    const url = new URL(rawUrl);
    // https only. A cleartext http:// CDN URL is fetchable by a network
    // attacker, who could substitute the script we then serve from our own
    // trusted origin.
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Maps a remote URL to its path inside the vendor directory. */
export function vendorPathFor(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/[^a-z0-9.-]/gi, '_');

  // A '?' baked into a filename breaks URL parsing: the browser treats the rest
  // as a query string and the path can never resolve. esm.sh uses queries
  // heavily (?target=, ?dev), so fold it into a short deterministic suffix.
  const querySuffix = url.search
    ? `__q${crypto.createHash('sha256').update(url.search).digest('hex').slice(0, 8)}`
    : '';

  const rest = url.pathname
    .replace(/^\/+/, '')
    // Keep a trailing slash meaningful rather than letting path.join collapse it.
    .replace(/\/+$/, '')
    .replace(/\.\./g, '_');

  // Only a plausible extension survives: `three@0.128.0` has extname '.0',
  // which is a version fragment rather than a file type.
  const ext = path.extname(rest);
  const usableExt = /^\.[a-z][a-z0-9]{1,5}$/i.test(ext) ? ext : '';

  // Extensionless module URLs are given a .js name. This is not cosmetic: an
  // esm.sh entry caches as the FILE `three@0.128.0` while its child needs
  // `three@0.128.0` to be a DIRECTORY, and the two cannot coexist. Naming the
  // file `three@0.128.0.js` removes the collision entirely, and it also makes
  // content-type lookup work without a heuristic.
  const stem = usableExt ? rest.slice(0, -usableExt.length) : (rest || 'index');

  // Query suffix goes between the stem and the extension:
  //   three@0.128.0?target=es2022 -> three@0.128.0__q43c89ee4.js
  const file = querySuffix
    ? `${stem}${querySuffix}${usableExt || '.js'}`
    : `${stem}${usableExt || '.js'}`;

  return path.join(host, file);
}

/** Inverse of vendorPathFor: the original remote URL for a cached file. */

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
export function rewriteCdnUrls(html, { only = null } = {}) {
  const urls = new Set();
  const allowed = only ? new Set(only) : null;
  const out = html.replace(URL_PATTERN, (match) => {
    if (!isVendorable(match)) return match;
    // `only` restricts rewriting to URLs that actually made it into the cache,
    // so a failed download is left pointing at the CDN instead of at a local
    // path that would 404.
    if (allowed && !allowed.has(match)) return match;
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

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One attempt is not enough: a transient `fetch failed` turned an offline-capable
 * page into a network-dependent one, because a failed URL is deliberately left
 * pointing at the CDN. Retry briefly on transport errors only - an HTTP error
 * is a real answer and must not be retried.
 */
async function fetchWithRetry(url, signal, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, {
        signal,
        redirect: 'manual',
        headers: { 'user-agent': 'crucible/1.0 (+vendor-resolver)' },
      });
      return res;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * Removes an ancestor that exists as a file where the cache needs a directory.
 *
 * This happens for real with esm.sh: the entry `three@0.128.0` caches as a FILE
 * (it is a 78-byte re-export stub) while `three@0.128.0/es2022/three.mjs` needs
 * `three@0.128.0` to be a DIRECTORY. Without this the nested fetch fails with
 * ENOTDIR and the whole graph stalls.
 *
 * Only paths inside the vendor root are ever removed.
 */
async function clearConflictingAncestors(target, vendorRoot) {
  const parts = path.relative(vendorRoot, target).split(path.sep);
  let current = vendorRoot;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = path.join(current, parts[i]);
    // Refuse to walk outside the cache, however the path was built.
    if (!isInsideVendor(vendorRoot, current)) return;

    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch {
      continue; // does not exist yet
    }
    if (!stat.isDirectory()) {
      await fsp.rm(current, { force: true, recursive: true, force: true });
    }
  }
}

function isInsideVendor(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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

// vendorAll downloads several files at once, and each one does a
// read-modify-write of the manifest. Unserialised, the last writer wins and
// entries are silently dropped. Chaining through one promise queue makes the
// updates sequential.
let manifestChain = Promise.resolve();

async function writeManifest(vendorRoot, manifest) {
  await fsp.mkdir(vendorRoot, { recursive: true });
  const target = path.join(vendorRoot, 'manifest.json');
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fsp.rename(temp, target);
}

/** Serialises a read-modify-write of the manifest across concurrent downloads. */
function updateManifest(vendorRoot, url, entry) {
  const task = manifestChain.then(async () => {
    const manifest = await readManifest(vendorRoot);
    // A hand-edited manifest with a non-object `entries` would throw in strict
    // mode and fail every subsequent vendor write.
    if (!isPlainObject(manifest.entries)) manifest.entries = {};
    manifest.entries[url] = entry;
    await writeManifest(vendorRoot, manifest);
  });
  // Keep the chain alive even when one link rejects.
  manifestChain = task.catch(() => {});
  return task;
}

/**
 * Recovers the upstream URL behind a cache-relative path.
 *
 * This cannot just be `https://${rel}`. `vendorPathFor` folds a query string
 * into a `__q<hash>` filename suffix, so the reconstruction would request a URL
 * that does not exist upstream. The manifest is the only place the original
 * query is still recorded, so it is authoritative and must be consulted before
 * falling back to the path-as-URL guess.
 *
 * Returns null when the path does not correspond to a vendorable URL, so the
 * caller can refuse it rather than fetching something arbitrary.
 */
export async function remoteUrlFor(rel, vendorRoot) {
  const manifest = await readManifest(vendorRoot);
  const entries = isPlainObject(manifest.entries) ? manifest.entries : {};
  const normalized = rel.split(path.sep).join('/');

  for (const [url, entry] of Object.entries(entries)) {
    const file = typeof entry?.file === 'string' ? entry.file.split(path.sep).join('/') : null;
    if (file === normalized) return url;
  }

  const guess = `https://${normalized}`;
  return isVendorable(guess) ? guess : null;
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

  // Redirects are followed manually and re-validated at every hop.
  // With redirect: 'follow' the allowlist was only checked on the initial URL,
  // so an allowlisted host that redirects to 127.0.0.1 turned this into a way
  // to fetch arbitrary internal addresses. raw.githubusercontent.com makes this
  // easy to trigger, since it serves attacker-controlled content.
  let response;
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      response = await fetchWithRetry(current, controller.signal);

      if (!REDIRECT_STATUS.has(response.status)) break;

      const location = response.headers.get('location');
      if (!location || hop === MAX_REDIRECTS) {
        throw new Error(`too many redirects fetching ${url}`);
      }
      const next = new URL(location, current).toString();
      if (!isVendorable(next)) {
        throw new Error(`refusing redirect to non-allowlisted host: ${next}`);
      }
      current = next;
    }
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

  // An ancestor cached as a file (esm.sh entries are 78-byte stubs) blocks mkdir
  // for any nested file under it, so clear the conflict first.
  await clearConflictingAncestors(abs, vendorRoot);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  // Random suffix: process.pid alone collides when vendorAll downloads the
  // same URL concurrently, and one rename then failed with ENOENT. That error
  // was swallowed into the results array, so the page still returned 200 with a
  // rewritten URL pointing at a file that did not exist.
  const temp = `${abs}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await fsp.writeFile(temp, buffer);
  await fsp.rename(temp, abs);

  await updateManifest(vendorRoot, url, {
    file: rel.split(path.sep).join('/'),
    sha256,
    bytes: buffer.byteLength,
    resolvedFrom: response.url || url,
    vendoredAt: new Date().toISOString(),
  });

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
