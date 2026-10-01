#!/usr/bin/env node
// check-project.mjs
// A deliberately small lint. There is no ESLint here - this repo has no
// dependencies by design - so these are the project-specific rules from
// AGENTS.md that a quick script can actually enforce:
//
//   1. every script/ and lib/ file parses
//   2. package.json scripts point at files that exist
//   3. shell scripts use strict mode
//   4. no npm dependencies sneak in
//
// Usage: node scripts/check-project.mjs
// Exit codes: 0 = clean, 1 = problems found.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

// 1. every JS/MJS file parses
const files = await walk(path.join(ROOT, 'lib'));
files.push(...await walk(path.join(ROOT, 'scripts')));
files.push(path.join(ROOT, 'server.mjs'));

for (const file of files) {
  if (!/\.(mjs|js)$/.test(file)) continue;
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    problems.push(`syntax error in ${path.relative(ROOT, file)}\n    ${(result.stderr || '').split('\n')[4] ?? ''}`);
  }
}

// 2. package.json scripts reference real files
const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  const match = String(command).match(/node\s+([\w./-]+\.mjs)|bash\s+([\w./-]+\.sh)/);
  if (!match) continue;
  const target = path.join(ROOT, match[1] ?? match[2]);
  try {
    await fs.access(target);
  } catch {
    problems.push(`npm script "${name}" points at a missing file: ${match[1] ?? match[2]}`);
  }
}

// 3. shell strict mode
for (const file of files) {
  if (!file.endsWith('.sh')) continue;
  const body = await fs.readFile(file, 'utf8');
  if (!/set -euo pipefail|set -eu\b/.test(body)) {
    problems.push(`${path.relative(ROOT, file)} does not enable strict mode`);
  }
}

// 4. no dependencies crept in
const depCount = Object.keys(pkg.dependencies ?? {}).length
  + Object.keys(pkg.devDependencies ?? {}).length;
if (depCount > 0) {
  problems.push(`package.json declares ${depCount} dependency/dependencies; this project must stay dependency-free`);
}

// 5. lockfile should not exist
try {
  await fs.access(path.join(ROOT, 'package-lock.json'));
  problems.push('package-lock.json exists; this project has no dependencies to lock');
} catch { /* expected */ }

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`check-project: clean (${files.length} files checked)`);
