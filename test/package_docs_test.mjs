import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './scratch.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === 'win32';
const exe = resolve(process.env.PBMCP_EXE || join(root, win ? 'pbmcp.exe' : 'pbmcp'));
const scratch = makeScratch('package-docs');
const bundle = join(scratch, 'bundle with spaces');
mkdirSync(bundle);
const packaged = join(bundle, win ? 'pbmcp.exe' : 'pbmcp');
copyFileSync(exe, packaged);
const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '1', PBMCP_DOCS_TIMING: '0',
  PUREBASIC_MCP_INDEX: join(scratch, 'inherited-missing-index.json') };
const report = spawnSync(exe, ['version'], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
assert.equal(report.status, 0, report.stderr || String(report.error));
const version = /^PureBasic (\d+\.\d+) - /m.exec(report.stdout)?.[1];
assert.ok(version, report.stdout);
const valid = { ...JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'docs-index.json'), 'utf8')), purebasicVersion: version };
const index = join(bundle, 'index.json');
const smoke = (binary = packaged) => spawnSync(process.execPath, [join(root, 'test', 'package_docs.mjs'), binary],
  { cwd: root, env, encoding: 'utf8', timeout: 35000, windowsHide: true });
writeFileSync(index, JSON.stringify(valid));
const passed = smoke();
assert.equal(passed.status, 0, passed.stdout + passed.stderr);
assert.match(passed.stdout, /packaged docs passed/);
if (win) {
  const alternateCase = smoke(packaged.toLowerCase());
  assert.equal(alternateCase.status, 0, alternateCase.stdout + alternateCase.stderr);
}
for (const [name, contents] of [
  ['invalid JSON', '{broken'],
  ['invalid entry', JSON.stringify({ ...valid, commands: [{}] })],
  ['wrong version', JSON.stringify({ ...valid, purebasicVersion: '0.00' })],
  ['missing OpenWindow', JSON.stringify({ ...valid, commands: [{ name: 'Other', syntax: ['Other()'] }] })],
]) {
  writeFileSync(index, contents);
  const rejected = smoke();
  assert.equal(rejected.error, undefined, rejected.error?.message);
  assert.notEqual(rejected.status, 0, `packaged docs accepted ${name}`);
}
rmSync(index);
const missing = smoke();
assert.equal(missing.error, undefined, missing.error?.message);
assert.notEqual(missing.status, 0, 'packaged docs silently fell back from a missing index.json');
console.log('packaged docs tests passed (real bundle lookup, ignored environment override, corrupt/mismatched/missing docs)');
