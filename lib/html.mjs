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
export function injectRuntime(html, { cssHref, jsSrc, config }) {
  if (html.includes(RUNTIME_MARKER)) return html;
  if (html.includes('__SIM_HOST__')) return html;

  const styleTag = `<link rel="stylesheet" href="${escapeHtml(cssHref)}" ${RUNTIME_MARKER}>`;
  const configTag = `<script ${RUNTIME_MARKER}>window.__SIM_HOST__ = ${jsonForScript(config)};</script>`;
  const scriptTag = `<script type="module" src="${escapeHtml(jsSrc)}" ${RUNTIME_MARKER}></script>`;

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