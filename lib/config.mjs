#!/usr/bin/env node
// config.mjs
// Resolves the effective runtime configuration from defaults, environment
// variables, and CLI flags. Precedence: CLI flag > env var > built-in default.
//
// Usage: import { loadConfig } from './lib/config.mjs';

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class ConfigError extends Error {
  constructor(message, hint = null) {
    super(message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HOME = os.homedir();

const DEFAULTS = {
  port: 5050,
  host: '127.0.0.1',
  root: ROOT,
  roots: [],
  vendorRoot: 'vendor',
  simulationsDir: 'simulations',
  logDir: '/tmp',
  quiet: false,
  verbose: false,
  list: false,
  help: false,
  single: false,
  noReload: false,
};

const ENV_KEYS = {
  port: 'SIM_HOST_PORT',
  host: 'SIM_HOST_HOST',
  root: 'SIM_HOST_ROOT',
  roots: 'SIM_HOST_ROOTS',
};

/**
 * Single-letter aliases. They were advertised in USAGE but parseArgs looked up
 * `p`/`q`/`v`/`h` in FLAGS, which is keyed by long name, so `node server.mjs -p
 * 8080` parsed to nothing and silently fell back to 5050.
 */
const ALIASES = {
  p: 'port',
  q: 'quiet',
  v: 'verbose',
  h: 'help',
};

const FLAGS = {
  port: { type: 'number' },
  host: { type: 'string' },
  root: { type: 'string' },
  roots: { type: 'list' },
  vendorRoot: { type: 'string' },
  simulationsDir: { type: 'string' },
  noReload: { type: 'boolean' },
  quiet: { type: 'boolean' },
  verbose: { type: 'boolean' },
  list: { type: 'boolean' },
  help: { type: 'boolean' },
  single: { type: 'boolean' },
  proxy: { type: 'string' },
  proxyPaths: { type: 'string' },   // split on commas
};

/**
 * Parses argv into a flat flag object. Supports --key value, --key=value,
 * boolean --key, and --no-key.
 */
export function parseArgs(argv = process.argv.slice(2), unknown = []) {
  const out = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) continue;

    let name = token.replace(/^--?/, '');
    let value;

    const eq = name.indexOf('=');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }

    // A leading --no- means "set the matching boolean spec to true".
    // The spec may be spelled bare (--no-reload -> noReload) or camel-cased
    // (--no-single -> single). Resolve either spelling.
    if (name.startsWith('no-')) {
      const bare = name.slice(3);
      const camel = `no${bare.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())}`;
      const target = FLAGS[camel] ? camel : (FLAGS[bare] ? bare : null);
      if (target && FLAGS[target].type === 'boolean') {
        out[target] = value === undefined ? true : value !== 'false';
        continue;
      }
    }

    // --vendor-root -> vendorRoot; -p -> port
    const camel = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const resolved = ALIASES[name] ?? (FLAGS[name] ? name : camel);
    const spec = FLAGS[resolved];
    if (!spec) {
      // Silently ignoring a typo meant `--pot 8080` behaved like no flag at
      // all. Report it so the mistake is visible.
      unknown.push(token);
      continue;
    }

    if (spec.type === 'boolean') {
      out[resolved] = value === undefined ? true : value !== 'false';
      continue;
    }

    if (value === undefined) {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined) continue;

    if (spec.type === 'number') out[resolved] = Number(value);
    else if (spec.type === 'list') out[resolved] = String(value).split(',').map((s) => s.trim()).filter(Boolean);
    else out[resolved] = value;
  }

  return out;
}

function expandTilde(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

/** Merges defaults, env, and flags into the final, normalised config object. */
export function loadConfig(argv = process.argv.slice(2), env = process.env) {
  const unknown = [];
  const flags = parseArgs(argv, unknown);
  if (unknown.length) {
    throw new ConfigError(
      `unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n`
      + `  run "node server.mjs --help" for the full list`,
    );
  }
  const config = { ...DEFAULTS };

  for (const [key, envKey] of Object.entries(ENV_KEYS)) {
    const raw = env[envKey];
    if (raw === undefined || raw === '') continue;
    config[key] = FLAGS[key]?.type === 'number'
      ? Number(raw)
      : FLAGS[key]?.type === 'list'
        ? raw.split(',').map((s) => s.trim()).filter(Boolean)
        : raw;
  }

  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined) continue;
    config[key] = value;
  }

  // Validate rather than coerce. Number('notanumber') is NaN and fell through
  // to 5050, so a typo produced a confusing EADDRINUSE on the wrong port.
  const rawPort = Number(config.port);
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    // Show what the user typed. JSON.stringify(NaN) is "null", so this used to
    // report "invalid port: null" for someone who typed `abc`.
    const shown = typeof config.port === 'number' ? String(config.port) : JSON.stringify(config.port);
    throw new ConfigError(
      `invalid port: ${shown} (expected an integer 1-65535)`,
      `try: node server.mjs --port ${DEFAULTS.port}`,
    );
  }
  config.port = rawPort;

  // An upstream must be a plain http(s) origin. Anything else would make the
  // proxy an open forwarder.
  if (config.proxy != null && config.proxy !== '') {
    let upstream;
    try {
      upstream = new URL(String(config.proxy));
    } catch {
      throw new ConfigError(`invalid --proxy: ${JSON.stringify(String(config.proxy))}`,
        'expected an origin, e.g. http://127.0.0.1:3000');
    }
    if (!/^https?:$/.test(upstream.protocol)) {
      throw new ConfigError(`--proxy must be http or https (got ${upstream.protocol})`,
        'e.g. http://127.0.0.1:3000');
    }
    config.proxy = upstream.origin;
    const paths = String(config.proxyPaths ?? '').split(',')
      .map((p) => p.trim()).filter(Boolean);
    config.proxyPaths = paths.length ? paths : ['/api/'];
  } else {
    config.proxy = null;
  }
  config.root = path.resolve(expandTilde(config.root));

  // Storage roots scanned by the dashboard. Explicit roots win; otherwise use
  // the home directory, which is where these files actually live.
  const explicitRoots = config.roots?.length ? config.roots : [];
  config.roots = (explicitRoots.length ? explicitRoots : [HOME]).map((r) => path.resolve(expandTilde(r)));

  // The vendor cache is shared across every hosted project, so a library like
  // three.js is stored once instead of once per folder. It deliberately lives
  // in the crucible repo rather than in any directory being served.
  config.vendorPath = config.vendorRoot
    ? (path.isAbsolute(config.vendorRoot)
      ? config.vendorRoot
      : path.resolve(ROOT, config.vendorRoot))
    : path.join(ROOT, '.crucible', 'vendor');

  config.registryPath = path.join(ROOT, '.crucible', 'instances.json');
  config.simulationsPath = path.resolve(config.root, config.simulationsDir);
  config.verbose = Boolean(config.verbose) && !config.quiet;

  return config;
}

export const USAGE = `
crucible - local host and control dashboard for HTML/JS simulations

Usage:
  node server.mjs [options]

Dashboard mode (default):
  Scans your storage roots, lists every folder containing HTML, and serves a
  control panel where each folder can be started on its own port.

Single-project mode:
  --single --root DIR        Serve DIR directly, with live reload, no dashboard.

Options:
  -p, --port <n>        Dashboard port (default 5050)
      --host <addr>     Bind address (default 127.0.0.1)
      --roots <a,b>     Comma-separated storage roots to scan
                        (default: your home directory)
      --root <dir>      Repo root for vendor cache and state
      --single          Serve --root directly instead of the dashboard
      --vendor-root <d> Vendor cache directory (default vendor)
      --no-reload       Disable SSE live reload
      --list            Print discovered projects and their ports, then exit
  -q, --quiet           Suppress request logging
  -v, --verbose         Log file-watch activity
  -h, --help            Show this help

Environment:
  SIM_HOST_PORT, SIM_HOST_HOST, SIM_HOST_ROOT, SIM_HOST_ROOTS

Ports:
  Each folder gets a deterministic port derived from its absolute path, so the
  same folder always lands on the same port. If that port is taken, the next
  free port in 5050-5199 is used instead.

Examples:
  node server.mjs                          # dashboard over ~
  node server.mjs --roots ~/projects       # dashboard over one tree
  node server.mjs --single --root ./sims   # serve one folder, no dashboard
  node server.mjs --list                   # what would be found
`;
