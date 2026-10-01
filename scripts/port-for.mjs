#!/usr/bin/env node
// port-for.mjs
// Prints the deterministic port for a directory.
//
// Usage: node scripts/port-for.mjs <dir>

import path from 'node:path';
import { preferredPortFor } from '../lib/ports.mjs';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/port-for.mjs <dir>');
  process.exit(2);
}

console.log(preferredPortFor(path.resolve(target)));
