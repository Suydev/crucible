#!/usr/bin/env node
// vendor-graph.mjs
// Downloads and rewrites a CDN module's entire dependency graph.
//
// The design point: the on-disk cache is a FAITHFUL mirror of upstream, and
// every transform is applied at serve time. That keeps the SHA-256 in
// vendor/manifest.json meaningful - a cached file is byte-identical to what the
// CDN served - while the browser still receives a document it can run.
//
// Three CDN families exist in the wild and each needs different handling:
//
//   raw file CDNs (unpkg, jsdelivr /npm/, cdnjs, jspm)
//       Serve the package as published. Bare specifiers survive
//       (`from 'three'`) and are handled by an import map.
//
//   re-export stubs (esm.sh, skypack, jsdelivr /+esm)
//       Serve a tiny entry that re-exports origin-relative paths, e.g.
//       `export * from '/npm/d3-array@3.2.4/+esm'`. Served from our own origin
//       those resolve to OUR root and 404, so they must be rewritten to carry
//       the vendor prefix.
//
//   extensionless URLs (esm.sh/three@0.128.0, jsdelivr /+esm)
//       Have no file extension, so extension-based MIME lookup returns
//       application/octet-stream. Chromium strict-checks MIME for module
//       scripts and refuses it. Anything JS-shaped is served as
//       text/javascript regardless of its name (see lib/mime.mjs).

import path from 'node:path';
import crypto from 'node:crypto';
import { vendorPathFor, ALLOWED_HOSTS } from './vendor.mjs';

export const MAX_GRAPH_FILES = 600;
export const MAX_GRAPH_DEPTH = 8;

/**
 * Parallelism for the walk. Each level of the BFS is fetched concurrently.
 *
 * This is a latency decision, not a throughput one: the walk is bounded by the
 * slowest single fetch, so doing it one file at a time made a cold first load
 * cost the SUM of every round trip. Measured on this machine, a cold d3 graph
 * (47 files) took 6.2s serially versus well under a second at 8. The CDN is the
 * bottleneck, not the server, so the cap stays low and the wave order stays
 * deterministic.
 */
export const CRAWL_CONCURRENCY = 8;

/**
 * Every specifier reference a module can make, with its kind.
 * Dynamic specifiers built from a variable are deliberately skipped: they
 * cannot be resolved statically, and pretending otherwise produces a graph that
 * is wrong in a way that is hard to see. Bundlers draw the same line.
 */
const EDGE_PATTERNS = [
  // import ... from 'x' / export ... from 'x' / export * from 'x'
  { kind: 'esm', re: /(?:\bfrom|\bimport)\s*['"]([^'"\n]+)['"]/g },
  // side-effect import: import 'x'
  { kind: 'esm', re: /^\s*import\s*['"]([^'"\n]+)['"]/gm },
  // dynamic import with a literal argument
  { kind: 'esm', re: /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g },
  // new URL('./x', import.meta.url) - asset relative to the module
  { kind: 'asset', re: /\bnew\s+URL\s*\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url\s*\)/g },
  // new Worker(new URL('./x', import.meta.url))
  { kind: 'worker', re: /\bnew\s+Worker\s*\(\s*new\s+URL\s*\(\s*['"]([^'"\n]+)['"]/g },
  // fetch('./x') - relative to the module
  { kind: 'asset', re: /\bfetch\s*\(\s*['"](\.[^'"\n]+)['"]/g },
];

/** Finds every static reference a module makes. */
export function findEdges(source) {
  const edges = [];
  const seen = new Set();

  for (const { kind, re } of EDGE_PATTERNS) {
    re.lastIndex = 0;
    for (const match of source.matchAll(re)) {
      const specifier = match[1];
      if (!specifier) continue;
      const key = `${kind}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ kind, specifier });
    }
  }
  return edges;
}

/** Classifies one specifier into how it must be resolved. */
export function classifySpecifier(specifier) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return 'absolute-url';
  if (specifier.startsWith('./') || specifier.startsWith('../')) return 'relative';
  if (specifier.startsWith('//')) return 'scheme-relative';
  if (specifier.startsWith('/')) return 'root-absolute';
  return 'bare';
}

/**
 * Resolves a specifier found inside a vendored file to an absolute CDN URL, or
 * null when it cannot be resolved (a bare specifier, which the import map owns).
 */
export function resolveEdge(specifier, moduleUrl, { host } = {}) {
  const base = new URL(moduleUrl);
  const kind = classifySpecifier(specifier);

  if (kind === 'bare') return null;

  if (kind === 'absolute-url') {
    try {
      const u = new URL(specifier);
      return ALLOWED_HOSTS.has(u.hostname) ? u.toString() : null;
    } catch {
      return null;
    }
  }

  // Scheme-relative inherits the referring module's protocol, so the host still
  // has to clear the allowlist. Resolving it without that check would let a
  // vendored file name an arbitrary host and have the crawler fetch it.
  if (kind === 'scheme-relative') {
    try {
      const u = new URL(specifier, base);
      return ALLOWED_HOSTS.has(u.hostname) ? u.toString() : null;
    } catch {
      return null;
    }
  }

  if (kind === 'relative') {
    try {
      return new URL(specifier, base).toString();
    } catch {
      return null;
    }
  }

  // root-absolute: the path belongs to the SAME CDN that served this module.
  // This is the esm.sh / skypack / jsdelivr-+esm re-export form.
  try {
    return new URL(specifier, base.origin).toString();
  } catch {
    return null;
  }
}

/**
 * Rewrites a module's source so every reference resolves locally.
 *
 * - relative stays relative: the cache preserves the upstream directory
 *   topology, so a sibling resolves without any rewrite at all
 * - root-absolute and absolute-URL become vendor paths
 * - bare is left alone for the import map
 */
export function rewriteModuleSource(source, moduleUrl) {
  let out = source;

  for (const { re } of EDGE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (whole) => {
      const quoted = /['"]([^'"\n]+)['"]/.exec(whole);
      if (!quoted) return whole;
      const specifier = quoted[1];
      const kind = classifySpecifier(specifier);

      if (kind === 'relative' || kind === 'bare' || kind === 'scheme-relative') return whole;

      const absolute = resolveEdge(specifier, moduleUrl);
      if (!absolute) return whole;

      // Preserve the original quoting style.
      const quote = quoted[0][0];
      const localPath = `/__simhost/vendor/${vendorPathFor(absolute).split(path.sep).join('/')}`;
      return whole.replace(quoted[0], `${quote}${localPath}${quote}`);
    });
  }

  return out;
}

/** Runs `fn` over `items` with a bounded number in flight, preserving order. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Walks the graph from a set of entry URLs, one BFS level at a time.
 *
 * A level is fetched concurrently, but the next level is not started until the
 * current one has finished. That keeps the traversal a true breadth-first walk
 * (and the depth cap meaningful) without paying the sum of all round trips.
 *
 * `urls` is emitted in discovery order, so two runs over the same graph produce
 * the same list.
 *
 * @param {string[]} entryUrls
 * @param {(url:string)=>Promise<string|null>} fetchText returns null when missing
 * @returns {Promise<{urls:string[], edges:Map<string,string[]>, truncated:boolean}>}
 */
export async function crawlGraph(entryUrls, fetchText, { concurrency = CRAWL_CONCURRENCY } = {}) {
  const visited = new Set();
  const edges = new Map();
  const urls = [];
  let truncated = false;

  // Marked on enqueue, not on visit: two modules importing the same dependency
  // must not both queue it, or the graph is fetched twice.
  let frontier = [];
  for (const url of entryUrls) {
    if (visited.has(url)) continue;
    visited.add(url);
    frontier.push({ url, depth: 0 });
  }

  for (let depth = 0; frontier.length; depth += 1) {
    if (urls.length >= MAX_GRAPH_FILES) {
      truncated = true;
      break;
    }

    const sources = await mapPool(frontier, concurrency, async ({ url }) => {
      try {
        return await fetchText(url);
      } catch {
        // One unreachable file must not abandon the rest of the graph.
        return null;
      }
    });

    const next = [];
    for (let i = 0; i < frontier.length; i += 1) {
      const { url } = frontier[i];
      const source = sources[i];
      if (source == null) continue;

      if (urls.length >= MAX_GRAPH_FILES) {
        truncated = true;
        break;
      }
      urls.push(url);

      const found = [];
      for (const edge of findEdges(source)) {
        const target = resolveEdge(edge.specifier, url);
        if (!target) continue;
        if (!found.includes(target)) found.push(target);
        if (depth + 1 < MAX_GRAPH_DEPTH && !visited.has(target)) {
          visited.add(target);
          next.push({ url: target, depth: depth + 1 });
        }
      }
      edges.set(url, found);
    }

    if (truncated) break;
    frontier = next;
  }

  return { urls, edges, truncated };
}

/** Exposed so tests can assert the graph budget without importing internals. */
export function graphBudget() {
  return { MAX_GRAPH_FILES, MAX_GRAPH_DEPTH, digest: crypto.createHash('sha256').update(String(MAX_GRAPH_FILES)).digest('hex').slice(0, 8) };
}
