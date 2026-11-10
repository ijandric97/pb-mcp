import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './scratch.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === 'win32';
const suffix = win ? '.exe' : '';
const binary = resolve(process.env.PBMCP_EXE || join(root, 'pbmcp' + suffix));
const scratch = makeScratch('build-isolation');
const project = join(scratch, 'project with spaces');
const bin = join(project, 'bin');
mkdirSync(bin, { recursive: true });
mkdirSync(join(project, 'tools'));
cpSync(join(root, 'src'), join(project, 'src'), { recursive: true });
for (const file of ['build.mjs', 'lint_encoding.mjs']) {
  copyFileSync(join(root, 'tools', file), join(project, 'tools', file));
}
const script = join(project, win ? 'build.cmd' : 'build.sh');
copyFileSync(join(root, win ? 'build.cmd' : 'build.sh'), script);
const report = spawnSync(binary, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
assert.equal(report.status, 0, report.stderr || String(report.error));
const home = report.stdout.match(/^PureBasic \S+ - (.+)$/m)?.[1].trim();
assert.ok(home, report.stdout);
const compiler = home === 'pbcompiler' ? home : join(home, win ? 'Compilers' : 'compilers', 'pbcompiler' + suffix);

// Force a digits-only revision without depending on the checkout's current hash.
const gitSource = join(project, 'git.pb');
writeFileSync(gitSource, '\uFEFFEnableExplicit\nIf OpenConsole()\nDefine i.i\n' +
  'For i = 0 To CountProgramParameters() - 1\n' +
  'If ProgramParameter(i) = "rev-parse" : PrintN("1234567") : End 0 : EndIf\nNext\n' +
  'End Val(GetEnvironmentVariable("PBMCP_TEST_DIRTY"))\nEndIf\nEnd 1\n');
const git = join(bin, 'git' + suffix);
const built = spawnSync(compiler, win ? ['/THREAD', '/CONSOLE', gitSource, '/EXE', git]
  : ['--thread', '--console', gitSource, '--output', git], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
assert.equal(built.status, 0, built.stdout + built.stderr + String(built.error || ''));

const ready = join(project, 'a-ready');
const release = join(project, 'release-a');
writeFileSync(join(project, 'tools', 'build-local-index.mjs'), `
import { existsSync, writeFileSync } from 'node:fs';
export function buildLocalIndex(compiler, outFile) {
  const index = { purebasicVersion: process.env.PBMCP_TEST_INDEX,
    commands: [{ name: 'FixtureCommand' }], reference: [] };
  writeFileSync(outFile, JSON.stringify(index));
  if (index.purebasicVersion === 'A') {
    writeFileSync(${JSON.stringify(ready)}, 'ready');
    const deadline = Date.now() + 10000;
    while (!existsSync(${JSON.stringify(release)})) {
      if (Date.now() > deadline) throw new Error('build A release timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  return index;
}
`);

function launch(tag, dirty) {
  const output = join(project, 'output-' + tag, 'pbmcp' + suffix);
  const index = join(project, 'package-' + tag, 'index.json');
  mkdirSync(dirname(output));
  mkdirSync(dirname(index));
  const child = spawn(win ? (process.env.ComSpec || 'cmd.exe') : 'bash', win ? ['/d', '/c', script] : [script],
    { cwd: project, windowsHide: true, env: { ...process.env, PATH: bin + delimiter + process.env.PATH,
      PUREBASIC_HOME: home, PBMCP_OUT: output, PBMCP_INDEX_OUT: index,
      PBMCP_TEST_INDEX: tag, PBMCP_TEST_DIRTY: dirty } });
  let log = '';
  child.stdout.on('data', chunk => log += chunk);
  child.stderr.on('data', chunk => log += chunk);
  const done = new Promise(resolve => {
    const timer = setTimeout(() => child.kill(), 20000);
    child.once('error', error => { clearTimeout(timer); resolve({ code: null, log: String(error) }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, log }); });
  });
  return { output, index, done };
}

const a = launch('A', '0');
let b, resultA, resultB;
try {
  const deadline = Date.now() + 10000;
  while (!existsSync(ready)) {
    assert.ok(Date.now() < deadline, 'build A did not reach the index barrier');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  b = launch('B', '1');
  resultB = await b.done;
} finally {
  writeFileSync(release, 'release');
  resultA = await a.done;
}
for (const [tag, build, result, revision] of [
  ['A', a, resultA, 'g1234567'], ['B', b, resultB, 'g1234567-dirty'],
]) {
  assert.equal(result.code, 0, result.log);
  const version = spawnSync(build.output, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, PUREBASIC_MCP_INDEX: '' } });
  assert.equal(version.status, 0, version.stderr);
  assert.ok(version.stdout.includes('; revision ' + revision + ')'), version.stdout);
  assert.ok(version.stdout.includes('Docs index: PB ' + tag + ','), version.stdout);
  assert.ok(version.stdout.includes('the embedded index'), version.stdout);
  assert.equal(JSON.parse(readFileSync(build.index, 'utf8')).purebasicVersion, tag);
}
assert.equal(JSON.parse(readFileSync(join(project, 'src', 'pbdocs-index.json'), 'utf8')).purebasicVersion, 'B');
console.log('build isolation passed (real compiler, numeric clean/dirty revisions, overlapping indexes and matching packaged snapshots)');
