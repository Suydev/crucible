#!/usr/bin/env node
// list-ports.mjs
// Prints every directory crucible would host, with the port it will get and
// whether that port is currently taken.
//
// Usage: node scripts/list-ports.mjs [--all]
//   default  projects only
//   --all    include the full port range and what is holding it
// Exit codes: 0 = printed, 1 = no projects found.

import { loadConfig } from '../lib/config.mjs';
import { scanWorkspace } from '../lib/workspace.mjs';
import { isPortFree, PORT_RANGE_START, PORT_RANGE_END } from '../lib/ports.mjs';

const config = loadConfig();
const showAll = process.argv.includes('--all');

const projects = await scanWorkspace(config.roots, {
  portFor: (dir) => null,   // filled in below, needs the async probe
});

const rows = [];
for (const project of projects) {
  const { preferredPortFor } = await import('../lib/ports.mjs');
  const port = preferredPortFor(project.dir);
  const free = await isPortFree(port, config.host);
  rows.push({ ...project, port, free });
}

rows.sort((a, b) => a.port - b.port);

if (!rows.length) {
  console.log('no projects found in the configured roots');
  process.exit(1);
}

const pad = (v, n) => String(v).padEnd(n);

console.log('');
console.log(`${pad('PORT', 7)}${pad('STATE', 9)}${pad('FILES', 7)}DIRECTORY`);
console.log('-'.repeat(72));
for (const row of rows) {
  const state = row.free ? 'free' : 'in use';
  console.log(`${pad(row.port, 7)}${pad(state, 9)}${pad(row.fileCount, 7)}${row.dir}`);
}
console.log('');

const conflicts = rows.filter((r) => !r.free);
if (conflicts.length) {
  console.log(`${conflicts.length} port(s) already taken; those folders will drift to the next free port.`);
  console.log('');
}

if (showAll) {
  console.log(`scan range ${PORT_RANGE_START}-${PORT_RANGE_END}, roots:`);
  for (const root of config.roots) console.log(`  ${root}`);
  console.log('');
}
