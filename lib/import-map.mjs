#!/usr/bin/env node
// import-map.mjs
// Generates an import map so a vendored CDN library's own module graph resolves.
//
// The problem: rewrites turn `https://unpkg.com/three@.../OrbitControls.js` into
// a local path, but that file still contains `} from 'three'` - a bare
// specifier. A browser cannot resolve one without an import map, so the page
// dies with "Failed to resolve module specifier 'three'" and a blank screen.
//
// This discovers what each bare specifier means from the URLs the document
// already uses. `vendorPathFor` encodes the npm identity, so
// `unpkg.com/three@0.128.0/examples/jsm/...` yields {host, pkg: 'three',
// version: '0.128.0'} - the answer is already in the URL, so no config and no
// graph parser is required.
//
// Ambiguity is refused rather than guessed: a bare specifier with two equally
// shallow candidates is left unmapped and logged, so a blank page always has a
// reason on the terminal.

import path from 'node:path';
import { jsonForScript } from './html.mjs';

export const IMPORT_MAP_MARKER = 'data-sim-host-importmap';

const MAX_GRAPH_FILES = 400;
const MAX_DEPTH = 6;

/** Splits a vendor cache path into { host, pkg, version, rest }. */
export function parseVendorPath(relVendorPath) {
  const parts = String(relVendorPath).split('/');
  if (parts.length < 2) return null;

  const host = parts[0];
  let tail = parts.slice(1);
  // jsDelivr prefixes npm packages with `npm/`; esm.sh uses `vNN/`.
  if (tail[0] === 'npm' || tail[0] === 'esm' || /^v[0-9]+$/.test(tail[0])) {
    tail = tail.slice(1);
  }

  // A scoped package spans a slash: `@scope/name`. Splitting on '/' first
  // would put the bare `@scope` in one segment, so stitch the scope back
  // together before looking for the version separator.
  let pkgSeg = tail[0] ?? '';
  let offset = 0;
  if (pkgSeg.startsWith('@') && tail.length > 1) {
    pkgSeg = `${pkgSeg}/${tail[1]}`;
    offset = 1;
  }

  // The version separator is the `@` AFTER the package name. Searching for the
  // first `@` finds the scope marker instead.
  const nameEnd = pkgSeg.indexOf('@', 1);
  const tailStart = offset + 1;

  if (nameEnd > 0) {
    // pkg@version in one segment: three@0.128.0, @scope/pkg@1.2.3
    const pkg = pkgSeg.slice(0, nameEnd);
    const version = pkgSeg.slice(nameEnd + 1);
    if (!pkg || !version) return null;
    return { host, pkg, version, rest: tail.slice(tailStart) };
  }

  if (tail.length > tailStart && /^[0-9]/.test(tail[tailStart])) {
    // Version as its own segment: three/0.128.0/... , @scope/pkg/1.2.3/...
    return {
      host,
      pkg: pkgSeg,
      version: tail[tailStart],
      rest: tail.slice(tailStart + 1),
    };
  }

  // No version at all: not an npm-package-shaped path, so it cannot be used to
  // derive an import map.
  return null;
}

/** Bare specifiers referenced by a module's source. */
export function findBareSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /(?:^|[\s;{}(])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;{}(])import\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      // Only bare specifiers need mapping; relative and absolute URLs resolve
      // on their own.
      if (!specifier.startsWith('.') && !specifier.startsWith('/') && !/^[a-z]+:/i.test(specifier)) {
        found.add(specifier);
      }
    }
  }
  return [...found];
}

/** Entry-point candidates for a package, shallowest path first. */
function entryCandidates(files, identity) {
  return files
    .map((relVendorPath) => ({ relVendorPath, info: parseVendorPath(relVendorPath) }))
    .filter(({ info }) => info
      && info.pkg === identity.pkg
      && info.version === identity.version)
    .filter(({ info }) => {
      const last = info.rest[info.rest.length - 1] ?? '';
      return last.endsWith('.js') || last.endsWith('.mjs');
    })
    .map(({ relVendorPath, info }) => ({
      relVendorPath,
      depth: info.rest.length,
      // Prefer the conventional entry points over a deeply nested add-on.
      entryish: /^(build|dist|lib|esm|index)[./]/.test(info.rest.join('/')) || info.rest.length === 1,
    }))
    .sort((a, b) => (Number(b.entryish) - Number(a.entryish)) || (a.depth - b.depth));
}

function toImportUrl(relVendorPath) {
  return `/__simhost/vendor/${String(relVendorPath).split(path.sep).join('/')}`;
}

/**
 * Walks the cached module graph from a set of seed vendor paths and builds an
 * import map for every bare specifier encountered.
 *
 * @param {string[]} seedRelVendorPaths URLs from the document, already vendored
 * @param {(rel:string)=>Promise<string|null>} readCached resolve a cached file's text
 * @returns {Promise<{imports: Record<string,string>, unmapped: string[], scanned: number}>}
 */
export async function buildImportMap(seedRelVendorPaths, readCached) {
  const imports = {};
  const unmapped = new Set();
  const seen = new Set();
  const queue = seedRelVendorPaths.map((p) => ({ rel: p, depth: 0 }));
  let scanned = 0;

  while (queue.length && scanned < MAX_GRAPH_FILES) {
    const { rel, depth } = queue.shift();
    if (seen.has(rel) || depth > MAX_DEPTH) continue;
    seen.add(rel);

    let source;
    try {
      source = await readCached(rel);
    } catch {
      continue;
    }
    if (source == null) continue;
    scanned += 1;

    const identity = parseVendorPath(rel);
    const bare = findBareSpecifiers(source);

    for (const specifier of bare) {
      // Already mapped by an earlier file; keep the first decision so the map
      // stays stable across the walk.
      if (imports[specifier]) continue;

      // Scoped package: three/addons/x -> pkg + '/addons/' + x
      const [base, ...sub] = specifier.split('/');
      // Only the document's own package may be inferred from the file's
      // identity. Falling back to the file's package for an unrelated specifier
      // mapped 'completely-unknown-package' onto three's entry point, which is
      // exactly the guessing this module is meant to refuse.
      const selfImport = base === identity?.pkg;
      const targetPkg = selfImport ? identity.pkg : base;
      const files = seedRelVendorPaths;

      if (!files.some((f) => {
        const info = parseVendorPath(f);
        return info && info.pkg === targetPkg && info.version === identity?.version;
      })) {
        // No seed URL names this package at all.
        unmapped.add(specifier);
        continue;
      }

      if (sub.length) {
        const suffix = sub.join('/');
        const match = entryCandidates(files, { pkg: targetPkg, version: identity?.version })
          .filter((c) => c.relVendorPath.includes(`/${suffix}`))
          .map((c) => c.relVendorPath);
        if (match.length === 1) {
          imports[specifier] = toImportUrl(match[0]);
          continue;
        }
        // Also offer the trailing-slash form used by `three/addons/...`.
        const tree = seedRelVendorPaths.find((f) => {
          const info = parseVendorPath(f);
          return info && info.pkg === targetPkg
            && info.version === identity?.version
            && info.rest[0] === 'addons';
        });
        if (tree && !imports[`${targetPkg}/addons/`]) {
          const info = parseVendorPath(tree);
          const dir = info.rest.slice(0, 1).join('/');
          imports[`${targetPkg}/addons/`] = toImportUrl(
            `${identity.host}/${identity.pkg}@${identity.version}/${dir}/`,
          );
        }
        if (!imports[specifier]) unmapped.add(specifier);
        continue;
      }

      // Plain bare specifier: exactly one shallowest entry point, or refuse.
      const candidates = entryCandidates(files, { pkg: targetPkg, version: identity?.version });
      const shallowest = candidates.length ? candidates[0].depth : Infinity;
      const best = candidates.filter((c) => c.depth === shallowest);
      if (best.length === 1) {
        imports[specifier] = toImportUrl(best[0].relVendorPath);
      } else {
        // Zero candidates, or genuinely ambiguous - do not guess.
        unmapped.add(specifier);
      }
    }

    // Follow relative siblings so a deeper add-on's own bare imports are seen.
    for (const match of source.matchAll(/from\s*['"](\.[^'"]+)['"]/g)) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(rel), match[1]),
      );
      if (!seen.has(resolved)) queue.push({ rel: resolved, depth: depth + 1 });
    }
  }

  return { imports, unmapped: [...unmapped], scanned };
}

const MAP_TAG_RE = /<script[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/i;

/**
 * Merges `imports` into a document.
 *
 * If the author already wrote an import map, theirs wins: the first tag is
 * rewritten in place with only the keys they did not declare. A second tag is
 * never emitted, because Firefox and Safari ignore it while Chrome merges -
 * which would silently discard the author's own mappings.
 *
 * Returns the document byte-identical when there is nothing to map, so a
 * module-less simulation never sees a tag it did not ask for.
 */
export function injectImportMap(html, imports) {
  const entries = Object.entries(imports ?? {});
  if (!entries.length) return html;

  const existing = MAP_TAG_RE.exec(html);
  if (existing) {
    let parsed = {};
    try {
      parsed = JSON.parse(/\{[\s\S]*\}/.exec(existing[0])?.[0] ?? '{}').imports ?? {};
    } catch {
      parsed = {};
    }
    const merged = { ...entries.reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}), ...parsed };
    const body = `<script type="importmap" ${IMPORT_MAP_MARKER}>${jsonForScript({ imports: merged })}</script>`;
    return html.replace(existing[0], body);
  }

  const tag = `<script type="importmap" ${IMPORT_MAP_MARKER}>${jsonForScript({ imports })}</script>`;

  const headOpen = /<head[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    // First in head: an import map added after a module script has been
    // requested is ignored by the browser.
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}