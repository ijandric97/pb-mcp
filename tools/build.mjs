#!/usr/bin/env node
// Shared native build: embed and package the index returned for this compiler.
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLocalIndex } from './build-local-index.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [compiler, source, output] = process.argv.slice(2);
const win = process.platform === 'win32';
let work;
try {
  if (!compiler || !source || !output) throw new Error('usage: build.mjs <compiler> <source> <output>');
  const index = buildLocalIndex(compiler, join(root, 'src', 'pbdocs-index.json'));
  work = mkdtempSync(join(tmpdir(), 'pbmcp-build-'));
  const snapshot = join(work, 'index.json');
  writeFileSync(snapshot, JSON.stringify(index));

  let revision = 'unknown';
  try {
    // A digits-only Git hash must still reach PureBasic as a string constant.
    revision = 'g' + execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = spawnSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--'], { windowsHide: true });
    if (dirty.status !== 0) revision += '-dirty';
  } catch { /* Source archives have no Git metadata. */ }

  const args = win ? ['/THREAD', '/CONSOLE', source, '/EXE', output]
    : ['--thread', '--console', source, '--output', output];
  for (const constant of [`PBMCP_INDEX$=${snapshot}`, `PBMCP_REVISION$=${revision}`]) {
    args.push(win ? '/CONSTANT' : '--constant', constant);
  }
  console.log(`build: compiling "${source}"`);
  const result = spawnSync(compiler, args, { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0 || !existsSync(output)) {
    throw new Error(`compile FAILED: ${result.error?.message || `exit ${result.status}; expected ${output}`}`);
  }
  if (process.env.PBMCP_INDEX_OUT) copyFileSync(snapshot, resolve(process.env.PBMCP_INDEX_OUT));
} catch (error) {
  console.error(`build: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (work) rmSync(work, { recursive: true, force: true });
}
