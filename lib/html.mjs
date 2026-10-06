#!/usr/bin/env node
// html.mjs
// Small HTML helpers: escaping, tag extraction, and dev-runtime injection.
//
// Design rule: injection must be idempotent. A served simulation is re-read on
// every request, so injecting twice would stack duplicate runtime tags.

/** Escapes text for safe interpolation into HTML body or an attribute value. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Serialises a value as a JSON literal that is safe inside a <script> block. */
export function jsonForScript(value) {
  return JSON.stringify(value ?? null)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const META_DESC_RE = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i;
const META_DESC_ALT_RE = /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const TAG_RE = /<[^>]+>/g;

function stripTags(html) {
  return String(html ?? '').replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** Pulls a best-effort title out of a raw HTML document. */
export function extractTitle(html, fallback = 'Untitled') {
  const match = TITLE_RE.exec(html);
  const text = stripTags(match?.[1] ?? '');
  return text || fallback;
}

/** Pulls a description from <meta name=description> or the first <h1>. */
export function extractDescription(html) {
  const meta = META_DESC_RE.exec(html) ?? META_DESC_ALT_RE.exec(html);
  if (meta) {
    const text = stripTags(meta[1]);
    if (text) return text;
  }
  const h1 = stripTags(H1_RE.exec(html)?.[1] ?? '');
  return h1;
}

export const RUNTIME_MARKER = 'data-sim-host-runtime';

/**
 * Injects the dev runtime stylesheet and module script into a raw HTML string.
 * Returns the document unchanged when it has already been injected.
 */
export function injectRuntime(html, { cssHref, jsSrc, config, nonce = null }) {
  if (html.includes(RUNTIME_MARKER)) return html;
  if (html.includes('__SIM_HOST__')) return html;

  // A page with a CSP meta will refuse injected inline script and style tags
  // that do not carry its nonce. Re-present ours with the same one so a
  // strict-policy simulation still gets live reload.
  const scriptNonce = nonce?.scriptNonce ? ` nonce="${escapeHtml(nonce.scriptNonce)}"` : '';
  const styleNonce = nonce?.styleNonce ? ` nonce="${escapeHtml(nonce.styleNonce)}"` : '';

  const styleTag = `<link rel="stylesheet" href="${escapeHtml(cssHref)}"${styleNonce} ${RUNTIME_MARKER}>`;
  const configTag = `<script${scriptNonce} ${RUNTIME_MARKER}>window.__SIM_HOST__ = ${jsonForScript(config)};</script>`;
  const scriptTag = `<script type="module" src="${escapeHtml(jsSrc)}"${scriptNonce} ${RUNTIME_MARKER}></script>`;

  let out = html;
  const headOpen = /<head[^>]*>/i.exec(out);

  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    out = out.slice(0, at) + styleTag + configTag + out.slice(at);
  } else if (/<html[^>]*>/i.test(out)) {
    const htmlOpen = /<html[^>]*>/i.exec(out);
    const at = htmlOpen.index + htmlOpen[0].length;
    out = out.slice(0, at) + `<head>${styleTag}${configTag}</head>` + out.slice(at);
  } else {
    out = styleTag + configTag + out;
  }

  const bodyClose = out.search(/<\/body>/i);
  if (bodyClose !== -1) {
    out = out.slice(0, bodyClose) + scriptTag + out.slice(bodyClose);
  } else {
    out += scriptTag;
  }

  return out;
}
/**
 * Lists the project-local module scripts a document loads.
 *
 * A page's bare dependencies are not always in the page. `<script type="module"
 * src="./scene.js">` moves them into a file the document handler never reads,
 * so a dependency map built from the HTML alone leaves `import * as THREE from
 * 'three'` in that module unresolvable. Reading the module is what lets one map
 * cover the whole page.
 *
 * Only same-origin, non-vendor sources are returned: an absolute URL is already
 * resolvable by itself, and an inline module has no file to attribute it to.
 */
export function findLocalModuleScripts(html) {
  const srcs = new Set();
  for (const tag of String(html ?? '').match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']?module["']?/i.test(tag)) continue;
    const value = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!value) continue;
    if (/^(https?:|data:|\/\/)/i.test(value)) continue;
    if (value.startsWith('/__simhost/')) continue;
    srcs.add(value);
  }
  return [...srcs];
}

const CSP_META_RE = /<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i;
const ATTR_RE = /([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/**
 * Reads the page's own Content-Security-Policy meta tag.
 *
 * A document carrying a CSP with a nonce will refuse our injected runtime and
 * config scripts outright, and the browser reports it as a script error rather
 * than anything about the dev server. Reading the nonce lets us re-present our
 * own injected tags with it; the caller can then warn if it is absent.
 *
 * Returns null when the document has no CSP meta.
 */
export function parseCsp(html) {
  const tag = CSP_META_RE.exec(html);
  if (!tag) return null;

  const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0]);
  const policy = (content?.[1] ?? content?.[2] ?? '').trim();
  if (!policy) return null;

  const nonceOf = (directive) => {
    const m = new RegExp(`${directive}[^;]*?'nonce-([^']+)'`, 'i').exec(policy);
    return m ? m[1] : null;
  };

  return {
    present: true,
    policy,
    scriptNonce: nonceOf('script-src') ?? nonceOf('default-src'),
    styleNonce: nonceOf('style-src') ?? nonceOf('default-src'),
  };
}

/**
 * Removes Subresource Integrity from tags we repointed at the local cache.
 *
 * The served bytes are deliberately NOT identical to upstream: root-absolute
 * specifiers are rewritten so the browser can resolve them at all. An `integrity`
 * attribute therefore always fails after a rewrite, and it fails silently from
 * the author's point of view - the script simply never loads. Dropping it is
 * correct precisely because the content is ours.
 */
export function stripIntegrityForVendor(html) {
  return html.replace(
    /<(script|link)\b[^>]*?\b(?:src|href)\s*=\s*(["'])[^"']*\/__simhost\/vendor\/[^"']*\2[^>]*>/gi,
    (tag) => tag.replace(/\s*\b(?:integrity|crossorigin)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''),
  );
}
