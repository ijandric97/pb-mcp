import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './scratch.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = makeScratch('encoding');
const tools = join(scratch, 'tools');
const src = join(scratch, 'src');
mkdirSync(tools);
mkdirSync(src);
const lint = join(tools, 'lint_encoding.mjs');
copyFileSync(join(root, 'tools', 'lint_encoding.mjs'), lint);

writeFileSync(join(src, 'valid.pb'), Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('Debug "café 🚀"', 'utf8')]));
let result = spawnSync(process.execPath, [lint], { encoding: 'utf8', windowsHide: true });
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /OK\s+valid\.pb/);

writeFileSync(join(src, 'missing-bom.pb'), Buffer.from('Debug "valid UTF-8"', 'utf8'));
result = spawnSync(process.execPath, [lint], { encoding: 'utf8', windowsHide: true });
assert.equal(result.status, 1);
assert.match(result.stderr, /missing-bom\.pb - missing UTF-8 BOM/);

writeFileSync(join(src, 'invalid.pb'), Buffer.from([0xef, 0xbb, 0xbf, 0xc3, 0x28]));
rmSync(join(src, 'missing-bom.pb'));
result = spawnSync(process.execPath, [lint], { encoding: 'utf8', windowsHide: true });
assert.equal(result.status, 1);
assert.match(result.stderr, /invalid\.pb - invalid UTF-8/);
console.log('encoding tests passed (valid UTF-8, required BOM, malformed UTF-8)');
