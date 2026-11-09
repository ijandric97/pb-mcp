import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

export function makeScratch(name) {
  const parent = resolve(tmpdir());
  const scratch = resolve(mkdtempSync(join(parent, `pbmcp-${name}-`)));
  const relativeScratch = relative(parent, scratch);
  assert.ok(relativeScratch && !relativeScratch.startsWith('..') &&
    dirname(scratch) === parent && basename(scratch).startsWith(`pbmcp-${name}-`));

  process.env.TMPDIR = process.env.TEMP = process.env.TMP = scratch;
  process.on('exit', () => {
    if (dirname(scratch) === parent && basename(scratch).startsWith(`pbmcp-${name}-`)) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch {}
    }
  });
  return scratch;
}
