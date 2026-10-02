#!/usr/bin/env node
// kill-port.mjs
// Finds and terminates whatever is listening on a TCP port.
//
// Usage: node scripts/kill-port.mjs [--port 5050] [--signal SIGTERM] [--json]
// Exit codes: 0 = port is free or was freed, 1 = nothing was listening,
//             2 = a process was listening but could not be signalled.
//
// Environment notes that shaped this file:
//   - This box has NO `ss` and NO `netstat`.
//   - /proc/net/tcp and /proc/net/tcp6 are NOT readable (sandbox denies them).
//   - `lsof` and `fuser` both fail for the same reason.
//   - `pgrep -f` and /proc/<pid>/cmdline DO work for our own processes.
// So the port check is a real TCP connect attempt in pure node, and the process
// lookup matches on command line. No external binary is required to succeed.

import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const HOST = '127.0.0.1';

/**
 * True when something accepts a TCP connection on the port.
 * This is the authoritative "is it in use" test - it needs no tooling.
 */
export function isPortInUse(port, { host = HOST, timeout = 400 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** Reads a pid's full command line. Empty string when unreadable. */
export async function readCmdline(pid) {
  try {
    const { stdout } = await run('cat', [`/proc/${pid}/cmdline`], { timeout: 2000 });
    return stdout.split('\0').filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

/**
 * Finds pids that look like a crucible server bound to `port`.
 *
 * Matching is deliberately narrow. We only kill processes whose command line
 * looks like our own server, so a stray `node something.js --port 5050` or an
 * unrelated service is reported but never killed.
 */
export async function findServerPids(port) {
  const patterns = [
    `server\\.mjs .*--port ${port}( |$)`,
    `server\\.mjs --root .*--port ${port}( |$)`,
  ];

  const pids = new Set();
  for (const pattern of patterns) {
    try {
      const { stdout } = await run('pgrep', ['-f', pattern], { timeout: 4000 });
      for (const line of stdout.split('\n')) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
      }
    } catch {
      // pgrep exits 1 when nothing matches
    }
  }

  const results = [];
  for (const pid of pids) {
    const command = await readCmdline(pid);
    // Second gate: the command line must really contain the server and port.
    if (!command.includes('server.mjs') || !command.includes(String(port))) continue;
    results.push({ pid, port, command });
  }
  return results;
}

/** Sends a signal to a pid. True when delivered or the process is already gone. */
export async function signalProcess(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return true;
    return false;
  }
}

/** Polls the TCP probe until the port is free, or the deadline passes. */
async function waitUntilFree(port, ms = 4000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!(await isPortInUse(port))) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return !(await isPortInUse(port));
}

/**
 * Frees a port.
 * @returns {{freed:boolean, killed:Array, reason:string, portInUse:boolean}}
 */
export async function freePort(port, { signal = 'SIGTERM' } = {}) {
  const wasInUse = await isPortInUse(port);
  if (!wasInUse) {
    return { freed: true, killed: [], reason: 'already-free', portInUse: false };
  }

  const targets = await findServerPids(port);
  const killed = [];
  for (const target of targets) {
    if (await signalProcess(target.pid, signal)) {
      killed.push(target);
    }
  }

  const freed = await waitUntilFree(port);

  if (freed) return { freed: true, killed, reason: 'killed', portInUse: false };

  // Something is still bound. Escalate to SIGKILL once, then re-probe.
  for (const target of targets) {
    if (await signalProcess(target.pid, 'SIGKILL')) killed.push({ ...target, signal: 'SIGKILL' });
  }
  const hardFreed = await waitUntilFree(port, 2000);

  return {
    freed: hardFreed,
    killed,
    reason: hardFreed ? 'killed-sigkill' : 'foreign-process',
    portInUse: !hardFreed,
  };
}

// ---------------------------------------------------------------- cli

const invokedDirectly = process.argv[1]
  && (process.argv[1].endsWith('kill-port.mjs') || process.argv[1].endsWith('kill-port.js'));

if (invokedDirectly) {
  const args = process.argv.slice(2);
  let port = 5050;
  let signal = 'SIGTERM';
  let asJson = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port') { port = Number(args[i + 1]); i += 1; }
    else if (args[i] === '--signal') { signal = args[i + 1]; i += 1; }
    else if (args[i] === '--json') asJson = true;
  }

  const result = await freePort(port, { signal });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.reason === 'already-free') {
    console.log(`port ${port} already free`);
  } else if (result.freed) {
    for (const k of result.killed) console.log(`killed pid ${k.pid} (${k.command})`);
    if (!result.killed.length) console.log(`port ${port} is free`);
  } else {
    console.error(`port ${port} still in use by a process this script will not kill`);
    console.error(`find it with: pgrep -af -- "--port ${port}"`);
  }

  process.exit(result.freed ? 0 : 2);
}