#!/usr/bin/env node
// http-guard.mjs
// Cross-origin protection for a server that reads and writes the user's disk.
//
// Binding to 127.0.0.1 is NOT a trust boundary. Any web page the user visits can
// issue a CORS-"simple" POST to a loopback server: text/plain needs no
// preflight, so the browser sends it and the response is simply ignored by the
// attacker. That request still executes server-side. DNS rebinding additionally
// lets a page become same-origin with the loopback host.
//
// This was demonstrated against this server: a request carrying
// `Origin: http://evil.example` and `Content-Type: text/plain` overwrote a
// project file on disk. Three checks close it:
//
//   1. Host must be a loopback name we actually serve. Blocks DNS rebinding.
//   2. A cross-site Origin / Sec-Fetch-Site is refused. Blocks the simple-POST
//      vector from a hostile page.
//   3. API bodies must be application/json, which is not a simple content type
//      and therefore forces a preflight that we never approve.
//
// None of this defends against a malicious *local* process, which is out of
// scope: anything running as the same user can read the files directly.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True when the Host header names a loopback interface we serve. */
export function isLoopbackHost(hostHeader, port) {
  if (!hostHeader) return false;
  // Strip the port. Handles "host:port", bare host, and bracketed IPv6.
  let host = hostHeader.trim();
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close === -1) return false;
    host = host.slice(0, close + 1);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
  }
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Classifies a request as loopback-origin or not.
 * Returns null when acceptable, or a human-readable reason to reject.
 */
export function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin) {
    // A same-origin fetch may legitimately send Origin; only a different one is
    // a problem. Allow when the Origin's host matches the Host header.
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      return `malformed Origin: ${origin}`;
    }
    if (originHost !== req.headers.host) {
      return `cross-origin request from ${origin}`;
    }
  }

  // Sec-Fetch-Site is set by every current browser and cannot be forged by page
  // script. It is the strongest signal available.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return `cross-site request (Sec-Fetch-Site: ${site})`;
  }

  return null;
}

/** True when the request declares a JSON body. */
export function isJsonRequest(req) {
  const type = req.headers['content-type'];
  if (!type) return false;
  const base = type.split(';')[0].trim().toLowerCase();
  return base === 'application/json';
}

/**
 * Full guard for the API surface.
 * Returns null when the request may proceed, else a reason string.
 */
export function guardApiRequest(req, port) {
  if (!isLoopbackHost(req.headers.host, port)) {
    return `invalid Host header: ${req.headers.host ?? '(missing)'}`;
  }
  const originProblem = checkOrigin(req);
  if (originProblem) return originProblem;

  // Only requests that carry a body need the content-type check.
  const hasBody = req.headers['content-length'] && req.headers['content-length'] !== '0';
  const isPreflight = req.method === 'OPTIONS';
  if (hasBody && !isPreflight && !isJsonRequest(req)) {
    return 'API requests must send Content-Type: application/json';
  }
  return null;
}
