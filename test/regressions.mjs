import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === 'win32';
const suffix = win ? '.exe' : '';
const exe = resolve(process.env.PBMCP_EXE || join(root, 'pbmcp' + suffix));
const scratch = join(root, 'test', 'out', 'regressions');
assert.equal(dirname(scratch), join(root, 'test', 'out'));
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '1', PBMCP_PRELOAD: '1', PBMCP_DOCS_TIMING: '0' };
const cacheBase = join(scratch, 'cache');
const cacheDir = join(cacheBase, 'purebasic-mcp');
mkdirSync(cacheDir, { recursive: true });
const cacheEnv = win ? { LOCALAPPDATA: cacheBase } : { XDG_CACHE_HOME: cacheBase };
let checks = 0;
function verify(value, message) { assert.ok(value, message); checks++; }
function call(id, name, args) { return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }; }
function rpc(binary, messages, overrides = {}, cwd = root) {
  const result = spawnSync(binary, [], {
    input: messages.map(m => JSON.stringify(m)).join('\n') + '\n', cwd,
    env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  verify(result.status === 0, `${binary}: exit ${result.status}: ${result.stderr || result.error || ''}`);
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}
const text = response => response?.result?.content?.[0]?.text || '';

const validEntry = { name: 'Valid', library: 'fixture', syntax: ['Valid()'], parameters: [], os: [], seeAlso: [] };
const badIndex = join(scratch, 'malformed-index.json');
for (const entry of [null, 3, [], {}, { name: 42 }, { name: '' },
  { ...validEntry, library: [] }, { ...validEntry, syntax: [null] }, { ...validEntry, os: [3] },
  { ...validEntry, seeAlso: [{}] }, { ...validEntry, parameters: {} },
  { ...validEntry, parameters: [null] }, { ...validEntry, parameters: [{ description: [] }] }]) {
  writeFileSync(badIndex, JSON.stringify({ commands: [entry], reference: [] }));
  const responses = rpc(exe, [call(1, 'pb_command', { name: 'Valid' }), { jsonrpc: '2.0', id: 2, method: 'ping' }],
    { PUREBASIC_MCP_INDEX: badIndex });
  verify(responses[0].result?.isError === true && text(responses[0]).includes('schema validation'), 'bad command entry accepted');
  verify(responses[1].id === 2 && !!responses[1].result, 'bad index killed the session');
}
for (const entry of [null, 3, [], {}, { title: 42 }, { title: 'Reference', file: [] }]) {
  writeFileSync(badIndex, JSON.stringify({ commands: [validEntry], reference: [entry] }));
  const [response] = rpc(exe, [call(1, 'pb_command', { name: 'Reference' })], { PUREBASIC_MCP_INDEX: badIndex });
  verify(response.result?.isError === true && text(response).includes('schema validation'), 'bad reference entry accepted');
}
for (const value of [null, 42, []]) {
  writeFileSync(badIndex, JSON.stringify(value));
  const [response] = rpc(exe, [call(1, 'pb_docs_search', { query: 'Valid' })], { PUREBASIC_MCP_INDEX: badIndex });
  verify(response.result?.isError === true && text(response).includes('schema validation'), 'non-object index root accepted');
}

// Mix main-thread compiler/config work with preload to reproduce the old race.
const replay = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'regression-test', version: '0' } } },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  call(3, 'pb_check', { file: join(scratch, 'missing.pb') }),
  call(4, 'pb_docs_search', { query: '日本語🚀' }),
];
for (let i = 0; i < 20; i++) {
  const responses = rpc(exe, replay);
  verify(responses.length === 4 && responses[3].id === 4, `preload replay ${i}: incomplete responses`);
}

// A bad decoy at cwd/hello.pb catches checking the wrong existing file.
const parent = join(scratch, 'paths');
const child = join(parent, 'child');
mkdirSync(join(child, 'branch'), { recursive: true });
copyFileSync(join(root, 'test', 'fixtures', 'hello.pb'), join(parent, 'hello.pb'));
copyFileSync(join(root, 'test', 'fixtures', 'bad.pb'), join(child, 'hello.pb'));
const paths = ['../hello.pb', 'branch/../../hello.pb', './../hello.pb',
  '../child/../hello.pb', parent + '/child/../hello.pb', join(parent, 'hello.pb')];
for (const file of paths) {
  for (const tool of ['pb_check', 'pb_run']) {
    const response = rpc(exe, [call(1, tool, { file })], {}, child)[0];
    verify(response.result?.isError === false, `${tool} ${file}: ${text(response)}`);
    verify(tool === 'pb_check' ? text(response).startsWith('OK — 13 lines,') : text(response).startsWith('exit 0 ·'),
      `${tool} selected the wrong file: ${text(response)}`);
  }
}
const missingAtRoot = '__pbmcp_path_regression_missing__.pb';
const rootPath = join(parse(child).root, missingAtRoot);
for (const tool of ['pb_check', 'pb_run']) {
  const response = rpc(exe, [call(1, tool, { file: '../'.repeat(64) + missingAtRoot })], {}, child)[0];
  verify(text(response) === 'File not found: ' + rootPath, `${tool}: parent traversal escaped the root: ${text(response)}`);
}

function fixture(version) {
  return JSON.stringify({ schemaVersion: 1, purebasicVersion: version, generatedAt: '2026-11-08',
    commands: [{ name: 'FixtureCommand', library: 'test', description: 'Index discovery fixture.', parameters: [] }], reference: [] });
}
const cachedIndex = join(cacheDir, 'index-cache.json');
writeFileSync(cachedIndex, fixture('cache'));
const version = spawnSync(exe, ['version'], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
verify(version.status === 0, 'compiler discovery: ' + version.stderr);
const pbHome = process.env.PUREBASIC_HOME || version.stdout.match(/^PureBasic \S+ - ([^\r\n]+)$/m)?.[1];
const compiler = pbHome ? join(pbHome, win ? 'Compilers' : 'compilers', 'pbcompiler' + suffix) : 'pbcompiler';

// Build controlled embedded indexes in a copied source tree, preserving src/.
const sources = join(scratch, 'src');
cpSync(join(root, 'src'), sources, { recursive: true });
const binaries = {};
for (const [kind, contents] of [['valid', fixture('embedded')], ['empty', '{"commands":[],"reference":[]}'],
  ['invalid', '{oops'], ['schema', '{}']]) {
  const dir = join(scratch, kind);
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, 'pbmcp' + suffix);
  writeFileSync(join(sources, 'pbdocs-index.json'), contents);
  const args = win ? ['/THREAD', '/CONSOLE', join(sources, 'main.pb'), '/EXE', binary]
    : ['--thread', '--console', join(sources, 'main.pb'), '--output', binary];
  const compiled = spawnSync(compiler, args, { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  verify(compiled.status === 0, `build ${kind}: ${compiled.stdout} ${compiled.stderr} ${compiled.error || ''}`);
  binaries[kind] = binary;
}
function report(binary, overrides = {}) {
  const responses = rpc(binary, [call(1, 'pb_version', {}), call(2, 'pb_command', { name: 'FixtureCommand' })],
    { ...cacheEnv, PUREBASIC_MCP_INDEX: '', ...overrides });
  return { version: text(responses[0]), docs: responses[1] };
}
function selects(binary, expected, overrides) {
  const result = report(binary, overrides);
  verify(result.version.includes('Docs index: PB ' + expected + ','), `expected ${expected}: ${result.version}`);
  verify(result.docs.result?.isError === false, text(result.docs));
}
selects(binaries.valid, 'embedded');
for (const kind of ['empty', 'invalid', 'schema']) selects(binaries[kind], 'cache');

const dropIn = join(dirname(binaries.valid), 'index.json');
const versioned = join(dirname(binaries.valid), 'index-version.json');
writeFileSync(dropIn, fixture('packaged'));
writeFileSync(versioned, fixture('versioned'));
utimesSync(versioned, new Date('2020-01-01'), new Date('2020-01-01'));
utimesSync(dropIn, new Date('2021-01-01'), new Date('2021-01-01'));
selects(binaries.valid, 'packaged');
utimesSync(versioned, new Date('2022-01-01'), new Date('2022-01-01'));
selects(binaries.valid, 'versioned');
const explicit = join(scratch, 'override.json');
writeFileSync(explicit, fixture('explicit'));
selects(binaries.valid, 'explicit', { PUREBASIC_MCP_INDEX: explicit });
writeFileSync(explicit, '{oops');
verify(report(binaries.valid, { PUREBASIC_MCP_INDEX: explicit }).docs.result?.isError === true,
  'invalid explicit index silently fell back');
writeFileSync(versioned, '{oops');
verify(report(binaries.valid).docs.result?.isError === true, 'invalid drop-in silently fell back');
writeFileSync(cachedIndex, '{oops');
verify(report(binaries.empty).docs.result?.isError === true, 'invalid cache index was accepted');
const emptyCache = win ? { LOCALAPPDATA: join(scratch, 'no-cache') } : { XDG_CACHE_HOME: join(scratch, 'no-cache') };
verify(text(report(binaries.empty, emptyCache).docs).startsWith('Docs index has no commands'),
  'empty embedded index without cache lost its missing-index hint');

// Prevent an alternative build command from reintroducing the unsafe runtime.
const rejected = spawnSync(compiler, win ? ['/CHECK', join(sources, 'main.pb')] : ['--check', join(sources, 'main.pb')],
  { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
verify(rejected.status !== 0 && (rejected.stdout + rejected.stderr).includes('thread-safe build'),
  'a build without thread safety was accepted');
console.log(`regressions: ${checks} checks passed (preload, paths, index precedence/fallback, thread-safety guard)`);
