import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './scratch.mjs';
import { cachedIndexMatches, checkHelpVersion, findLocalHelp, helpHash, indexContentHash, parserFingerprint } from '../tools/build-local-index.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = makeScratch('local-index');
const home = join(scratch, 'installation with spaces');
const docs = join(home, 'Help', 'English');
mkdirSync(join(docs, 'Reference'), { recursive: true });
mkdirSync(join(docs, 'MainGuide'));
const lint = join(scratch, 'encoding');
mkdirSync(join(lint, 'tools'), { recursive: true });
mkdirSync(join(lint, 'src'));
writeFileSync(join(lint, 'tools', 'lint_encoding.mjs'), readFileSync(join(root, 'tools', 'lint_encoding.mjs')));
writeFileSync(join(lint, 'src', 'good.pb'), '\uFEFFEnableExplicit');
const lintEncoding = () => spawnSync(process.execPath, [join(lint, 'tools', 'lint_encoding.mjs')],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 });
assert.equal(lintEncoding().status, 0);
writeFileSync(join(lint, 'src', 'bad.pb'), 'EnableExplicit');
const rejectedEncoding = lintEncoding();
assert.equal(rejectedEncoding.status, 1);
assert.match(rejectedEncoding.stderr, /bad\.pb - missing UTF-8 BOM/);
writeFileSync(join(docs, 'Reference', 'commandindex.html'), 'commands');
const history = join(docs, 'MainGuide', 'history.html');
writeFileSync(history, '<b>10th August 2026 : Version 6.41</b>\nVersion 6.40');
const tree = findLocalHelp(home);
assert.deepEqual(tree, { kind: 'local-tree', path: docs });
assert.equal(checkHelpVersion(docs, '6.41'), '6.41');
assert.throws(() => checkHelpVersion(docs, '6.40'), /help 6\.41 does not match compiler 6\.40/);
const hash = helpHash(tree);
writeFileSync(history, 'Version 6.42');
assert.notEqual(helpHash(tree), hash, 'changed local help did not invalidate the cache');
writeFileSync(history, 'Version unknown');
assert.throws(() => checkHelpVersion(docs, '6.41'), /Cannot determine/);
rmSync(history);
assert.throws(() => checkHelpVersion(docs, '6.41'), /Cannot determine/);
writeFileSync(join(home, 'PureBasic.chm'), 'CHM fixture');
assert.equal(findLocalHelp(home).kind, 'local-chm', 'installed CHM must take precedence over an old extracted tree');
rmSync(join(home, 'PureBasic.chm'));
rmSync(join(docs, 'Reference', 'commandindex.html'));
assert.throws(() => findLocalHelp(home), /Local PureBasic help not found/);

const source = { kind: 'local-tree', path: docs, sha256: hash, compiler: '/compiler', compilerVersion: '6.41', compilerSha256: 'compiler', parserSha256: 'parser' };
const fixture = { schemaVersion: 1, purebasicVersion: '6.41', source,
  commands: [{ name: 'Boundary', parameters: [{ name: 'value', description: 'input' }], syntax: ['Boundary(value)'] }],
  reference: [{ title: 'Language constructs', id: 'constructs', file: 'reference/constructs.html', summary: 'Language reference' }],
  referenceText: { 'reference/constructs.html': 'Local reference text' } };
fixture.contentSha256 = indexContentHash(fixture);
assert.equal(cachedIndexMatches(fixture, source, '6.41'), true);
for (const changed of [null, { ...fixture, purebasicVersion: '6.40' }, { ...fixture, commands: [] },
  { ...fixture, commands: [{}] }, { ...fixture, commands: [{ name: ' ' }] },
  { ...fixture, commands: [{ name: 'Boundary', syntax: ['valid', 42] }] },
  { ...fixture, commands: [{ name: 'Boundary', parameters: [null] }] },
  { ...fixture, reference: null }, { ...fixture, reference: [{}] },
  { ...fixture, reference: [{ title: 'Language constructs', summary: 42 }] },
  { ...fixture, referenceText: [] }, { ...fixture, referenceText: { 'reference/constructs.html': 42 } }]) {
  if (changed) changed.contentSha256 = indexContentHash(changed);
  assert.ok(!cachedIndexMatches(changed, source, '6.41'), 'invalid cached index was reused');
}
for (const changed of [{ ...fixture, contentSha256: undefined }, { ...fixture, contentSha256: 'invalid' },
  { ...fixture, commands: [{ ...fixture.commands[0], syntax: ['WrongSyntax()'] }] },
  { ...fixture, reference: [] }, { ...fixture, referenceText: {} }]) {
  assert.ok(!cachedIndexMatches(changed, source, '6.41'), 'changed or unsigned cached content was reused');
}
for (const field of ['path', 'sha256', 'compiler', 'compilerVersion', 'compilerSha256', 'parserSha256']) {
  assert.ok(!cachedIndexMatches(fixture, { ...source, [field]: 'changed' }, '6.41'), `${field} change did not invalidate cache`);
}

const parserInputs = join(scratch, 'parser-inputs');
mkdirSync(join(parserInputs, 'tools'), { recursive: true });
mkdirSync(join(parserInputs, 'src'));
for (const file of ['tools/build-local-index.mjs', 'tools/build-online-index.mjs', 'src/scan_main.pb',
  'src/scan_support.pb', 'src/html_scan.pb', 'src/metrics.pb']) {
  writeFileSync(join(parserInputs, file), readFileSync(join(root, file)));
}
const parserHash = parserFingerprint(parserInputs);
writeFileSync(join(parserInputs, 'src/metrics.pb'), 'unrelated runtime change');
assert.equal(parserFingerprint(parserInputs), parserHash, 'unrelated runtime changes invalidated the parser cache');
writeFileSync(join(parserInputs, 'src/scan_support.pb'), 'changed shared scanner helper');
assert.notEqual(parserFingerprint(parserInputs), parserHash, 'scanner helper changes did not invalidate the cache');
writeFileSync(join(parserInputs, 'src/scan_support.pb'), readFileSync(join(root, 'src/scan_support.pb')));
writeFileSync(join(parserInputs, 'src/html_scan.pb'), 'changed HTML parser');
assert.notEqual(parserFingerprint(parserInputs), parserHash, 'HTML parser changes did not invalidate the cache');

// Exercise actual installed help, bootstrap compilation, and the warm cache.
const win = process.platform === 'win32';
const exe = resolve(process.env.PBMCP_EXE || join(root, win ? 'pbmcp.exe' : 'pbmcp'));
const report = spawnSync(exe, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
assert.equal(report.status, 0, report.stderr);
const installation = report.stdout.match(/^PureBasic (\d+\.\d+) - (.+)$/m);
assert.ok(installation, report.stdout);
const [, version, installedHome] = installation;
const compiler = join(installedHome.trim(), win ? 'Compilers' : 'compilers', win ? 'pbcompiler.exe' : 'pbcompiler');
const scanExe = join(scratch, win ? 'scan-only.exe' : 'scan-only');
const scanBuildArgs = win
  ? ['/THREAD', '/CONSOLE', join(root, 'src', 'scan_main.pb'), '/EXE', scanExe]
  : ['--thread', '--console', join(root, 'src', 'scan_main.pb'), '--output', scanExe];
const scanBuild = spawnSync(compiler, scanBuildArgs, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
assert.equal(scanBuild.status, 0, scanBuild.stderr || scanBuild.stdout);
const page = join(scratch, 'scanner-parity.html');
const manifest = join(scratch, 'scanner-parity.json');
writeFileSync(page, '<html><head><title>DemoCommand</title></head><body><b>Syntax</b><p>DemoCommand()</p><b>Description</b><p>Small scanner parity fixture.</p></body></html>');
writeFileSync(manifest, JSON.stringify([{ path: page, library: 'test', file: 'test/DemoCommand.html' }]));
const fullScan = spawnSync(exe, ['scan-batch', manifest], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
const isolatedScan = spawnSync(scanExe, ['scan-batch', manifest], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
assert.equal(fullScan.status, 0, fullScan.stderr);
assert.equal(isolatedScan.status, 0, isolatedScan.stderr);
assert.equal(isolatedScan.stdout, fullScan.stdout, 'scanner-only entry changed scan-batch output');
const output = join(scratch, 'generated', 'index.json');
function build(selectedCompiler = compiler) {
  return spawnSync(process.execPath, [join(root, 'tools', 'build-local-index.mjs'), '--compiler', selectedCompiler, '--out', output],
    { encoding: 'utf8', windowsHide: true, timeout: 45000 });
}
const generated = build();
assert.equal(generated.status, 0, generated.stdout + generated.stderr);
const index = JSON.parse(readFileSync(output, 'utf8'));
assert.equal(index.purebasicVersion, version);
assert.equal(index.source.compilerVersion, version);
assert.ok(index.source.kind.startsWith('local-'));
assert.ok(index.commands.some(command => command.name === 'OpenWindow'));
assert.ok(index.reference.some(page => page.title === 'CompilerIf'), 'local manual keyword styling lost its aliases');
assert.ok(Object.values(index.referenceText).some(text => text.includes('CompilerEndIf')));
const before = readFileSync(output);
const modified = statSync(output).mtimeMs;
const warm = build();
assert.equal(warm.status, 0, warm.stdout + warm.stderr);
assert.match(warm.stdout, /unchanged/);
assert.deepEqual(readFileSync(output), before);
assert.equal(statSync(output).mtimeMs, modified, 'warm builds rewrote the index');
assert.notEqual(build(join(scratch, 'missing-compiler')).status, 0);
assert.deepEqual(readFileSync(output), before, 'failed generation replaced a working index');
writeFileSync(output, JSON.stringify({ ...index, commands: [{}] }));
const repairedShape = build();
assert.equal(repairedShape.status, 0, repairedShape.stdout + repairedShape.stderr);
assert.doesNotMatch(repairedShape.stdout, /unchanged/);
assert.ok(JSON.parse(readFileSync(output, 'utf8')).commands.some(command => command.name === 'OpenWindow'),
  'malformed cached command entry was not regenerated');
for (const changed of [{ ...index, commands: index.commands.slice(0, 1) }, { ...index, referenceText: {} },
  { ...index, contentSha256: undefined }]) {
  writeFileSync(output, JSON.stringify(changed));
  const restored = build();
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  assert.doesNotMatch(restored.stdout, /unchanged/);
  const repaired = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(repaired.commands, index.commands, 'incomplete command coverage was not repaired');
  assert.deepEqual(repaired.referenceText, index.referenceText, 'missing local reference text was not repaired');
  assert.equal(cachedIndexMatches(repaired, index.source, version), true);
}
writeFileSync(output, JSON.stringify({ ...index, purebasicVersion: 'stale-version' }));
const repaired = build();
assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
assert.equal(JSON.parse(readFileSync(output, 'utf8')).purebasicVersion, version, 'stale cached index was not rebuilt');
console.log(`local index tests passed (local help/version validation, content integrity/cache recovery, failure preservation, installed compiler/help ${version})`);
