import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === 'win32';
const exe = resolve(process.env.PBMCP_EXE || join(root, win ? 'pbmcp.exe' : 'pbmcp'));
const scratch = join(root, 'test/out/processes');
assert.equal(dirname(scratch), join(root, 'test/out'));
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '1', PBMCP_PRELOAD: '0',
  PUREBASIC_MCP_INDEX: join(root, 'test/fixtures/docs-index.json') };
const report = spawnSync(exe, ['version'], { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
assert.equal(report.status, 0, report.stderr || String(report.error));
const home = process.env.PUREBASIC_HOME || report.stdout.match(/^PureBasic \S+ - (.+)$/m)?.[1];
assert.ok(home, report.stdout);
const compiler = home === 'pbcompiler' ? home : join(home, win ? 'Compilers/pbcompiler.exe' : 'compilers/pbcompiler');
function compile(source, output) {
  const result = spawnSync(compiler, win ? ['/THREAD', '/CONSOLE', source, '/EXE', output]
    : ['--thread', '--console', source, '--output', output], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error || ''));
}
const request = (name, args) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n';
function call(binary, name, args, extra = {}, timeout = 15000) {
  const result = spawnSync(binary, [], { input: request(name, args), env: { ...env, ...extra },
    encoding: 'utf8', timeout, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout.trim());
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    if (!win && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') return false; throw error; }
}

const source = join(scratch, 'descendants.pb');
writeFileSync(source, '\uFEFF' + `EnableExplicit
Define base.s = GetEnvironmentVariable("PBMCP_TEST_BASE"), f.i
If ProgramParameter(0) = "child"
  f = CreateFile(#PB_Any, base + "-started")
  If f = 0 : End 20 : EndIf
  CloseFile(f)
  Delay(6000)
  f = CreateFile(#PB_Any, base + "-late")
  If f : CloseFile(f) : EndIf
Else
  Define child.i = RunProgram(ProgramFilename(), "child", "", #PB_Program_Open | #PB_Program_Hide)
  If child = 0 : End 21 : EndIf
  f = CreateFile(#PB_Any, base + "-pid")
  If f = 0 : End 22 : EndIf
  WriteStringN(f, Str(ProgramID(child)), #PB_UTF8)
  WriteStringN(f, ProgramFilename(), #PB_UTF8)
  CloseFile(f)
  Define deadline.i = ElapsedMilliseconds() + 2000
  While FileSize(base + "-started") = -1 And ElapsedMilliseconds() < deadline
    Delay(5)
  Wend
  If FileSize(base + "-started") = -1 : End 23 : EndIf
  CloseProgram(child)
  If ProgramParameter(0) <> "normal" : Delay(12000) : EndIf
EndIf
`);
for (const mode of ['normal', 'timeout', 'server-exit']) {
  const base = join(scratch, mode);
  let server, pid, program;
  try {
    const extra = { PBMCP_TEST_BASE: base };
    if (mode === 'server-exit') {
      server = spawn(exe, [], { env: { ...env, ...extra }, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      let error;
      server.on('error', value => { error = value; });
      server.stderr.resume();
      server.stdin.on('error', value => { error = value; });
      server.stdin.end(request('pb_run', { file: source, args: [mode], timeoutMs: 10000 }));
      const deadline = performance.now() + 10000;
      while ((!existsSync(base + '-pid') || !existsSync(base + '-started')) && performance.now() < deadline && !error) await sleep(10);
      assert.ifError(error);
      assert.ok(existsSync(base + '-started'), 'child never started before server shutdown');
      server.kill('SIGKILL');
    } else {
      const response = call(exe, 'pb_run', { file: source, args: [mode], timeoutMs: 1000 }, extra);
      assert.equal(response.result.isError, mode === 'timeout', JSON.stringify(response));
      assert.match(response.result.content[0].text, mode === 'timeout' ? /^TIMEOUT/ : /^exit 0/);
    }
    [pid, program] = readFileSync(base + '-pid', 'utf8').trim().split(/\r?\n/);
    pid = Number(pid);
    assert.ok(Number.isInteger(pid) && pid > 0);
    const deadline = performance.now() + 3000;
    while (alive(pid) && performance.now() < deadline) await sleep(10);
    assert.equal(alive(pid), false, `${mode}: child ${pid} survived`);
    assert.equal(existsSync(base + '-late'), false, `${mode}: child continued writing after return`);
    if (mode !== 'server-exit') assert.equal(existsSync(dirname(program)), false, `${mode}: executable/temp directory was left behind`);
  } finally {
    if (server?.exitCode === null) server.kill('SIGKILL');
    if (!pid && existsSync(base + '-pid')) [pid, program] = readFileSync(base + '-pid', 'utf8').trim().split(/\r?\n/);
    if (pid && alive(Number(pid))) { process.kill(Number(pid), 'SIGKILL'); await sleep(100); }
    if (program) {
      const target = resolve(dirname(program));
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith('pbmcp-'));
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}

const stdinReader = join(scratch, 'stdin-reader.pb');
const stdinReady = join(scratch, 'stdin-ready');
writeFileSync(stdinReader, '\uFEFF' + `EnableExplicit
If OpenConsole() = 0 : End 1 : EndIf
Define ready.i = CreateFile(#PB_Any, GetEnvironmentVariable("PBMCP_STDIN_READY"))
If ready = 0 : End 2 : EndIf
CloseFile(ready)
Define byte.a, bytes.i = ReadConsoleData(@byte, 1)
PrintN("stdin-bytes=" + Str(bytes))
CloseConsole()
`);
const stdinServer = spawn(exe, [], { env: { ...env, PBMCP_STDIN_READY: stdinReady },
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdinOutput = '', stdinError = '', stdinFailure;
stdinServer.stdout.setEncoding('utf8').on('data', value => stdinOutput += value);
stdinServer.stderr.setEncoding('utf8').on('data', value => stdinError += value);
stdinServer.on('error', error => { stdinFailure = error; });
stdinServer.stdin.on('error', error => { stdinFailure = error; });
const stdinClosed = new Promise(resolve => stdinServer.on('close', resolve));
const stdinTimer = setTimeout(() => stdinServer.kill('SIGKILL'), 15000);
try {
  stdinServer.stdin.write(request('pb_run', { file: stdinReader, timeoutMs: 3000 }));
  const deadline = performance.now() + 10000;
  while (!existsSync(stdinReady) && stdinServer.exitCode === null && performance.now() < deadline && !stdinFailure) await sleep(10);
  assert.ifError(stdinFailure);
  assert.ok(existsSync(stdinReady), 'stdin reader never started: ' + stdinError);
  stdinServer.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
  assert.equal(await stdinClosed, 0, stdinError);
  assert.ifError(stdinFailure);
  const responses = stdinOutput.trim().split('\n').map(JSON.parse);
  assert.equal(responses.length, 2, stdinOutput);
  assert.equal(responses[0].result.isError, false, stdinOutput);
  assert.match(responses[0].result.content[0].text, /stdin-bytes=0/);
  assert.deepEqual(responses[1], { jsonrpc: '2.0', id: 2, result: {} }, 'child consumed an MCP request');
} finally {
  clearTimeout(stdinTimer);
  if (stdinServer.exitCode === null) stdinServer.kill('SIGKILL');
  await stdinClosed;
}

// Exercise both real reporters with the state produced by PATH-only discovery.
const reportSource = join(scratch, 'path-report.pb');
const reporter = join(scratch, win ? 'path-report.exe' : 'path-report');
let main = readFileSync(join(root, 'src/main.pb'), 'utf8').replace(/XIncludeFile "([^"]+)"/g,
  (_, file) => `XIncludeFile "${join(root, 'src', file)}"`);
main = main.replace('Define arg$ = ProgramParameter(0)',
  'gConfigReady = #True\ngPbHome$ = ""\ngCompilerPath$ = "pbcompiler"\ngPbVersion$ = "6.41"\nDefine arg$ = ProgramParameter(0)');
writeFileSync(reportSource, main);
compile(reportSource, reporter);
const pathReport = spawnSync(reporter, ['version'], { env, encoding: 'utf8', timeout: 5000, windowsHide: true });
assert.equal(pathReport.status, 0, pathReport.stderr);
assert.match(pathReport.stdout, /^PureBasic 6\.41 - pbcompiler$/m);
assert.match(call(reporter, 'pb_version', {}).result.content[0].text, /PureBasic 6\.41 — pbcompiler/);

const fakeHome = join(scratch, 'fake-home');
const fakeCompiler = join(fakeHome, win ? 'Compilers/pbcompiler.exe' : 'compilers/pbcompiler');
mkdirSync(dirname(fakeCompiler), { recursive: true });
const fragment = join(scratch, 'version-fragment.pb');
writeFileSync(fragment, '\uFEFFEnableExplicit\nIf OpenConsole()\n  Print("PureBasic 6.41")\n  Delay(22000)\n  CloseConsole()\nEndIf\n');
compile(fragment, fakeCompiler);
const started = performance.now();
const fragmentReport = call(exe, 'pb_version', {}, { PUREBASIC_HOME: fakeHome }, 19000);
const elapsed = performance.now() - started;
assert.match(fragmentReport.result.content[0].text, /PureBasic 6\.41 — /);
assert.ok(elapsed >= 14500 && elapsed < 18000, `version deadline was bypassed: ${elapsed} ms`);
console.log(`process tests passed (stdin isolation, descendants on success/timeout/server exit, both PATH reporters, partial-line version timeout ${Math.round(elapsed)}ms)`);
