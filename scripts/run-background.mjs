#!/usr/bin/env node
// run-background.mjs
// Starts a command fully detached and returns immediately.
//
// Needed because a plain `&` in a shell still ties the child's stdio to the
// calling shell's pipes, so the caller blocks until the child exits. This does
// a real detach: new session, stdio to a log file, and an unref'd handle.
//
// Usage: node scripts/run-background.mjs <logfile> <command...>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [logfile, ...command] = process.argv.slice(2);

if (!logfile || command.length === 0) {
  console.error('usage: node scripts/run-background.mjs <logfile> <command...>');
  process.exit(2);
}

fs.mkdirSync(path.dirname(logfile), { recursive: true });
const fd = fs.openSync(logfile, 'a');

const child = spawn(command[0], command.slice(1), {
  detached: true,
  stdio: ['ignore', fd, fd],
});

child.unref();
fs.closeSync(fd);

console.log(child.pid);
