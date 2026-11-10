import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './scratch.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === 'win32';
const exe = resolve(process.env.PBMCP_EXE || join(root, win ? 'pbmcp.exe' : 'pbmcp'));
const scratch = makeScratch('cancellation');
const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '1', PBMCP_PRELOAD: '0',
  PUREBASIC_MCP_INDEX: join(root, 'test/fixtures/docs-index.json') };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const ping = id => ({ jsonrpc: '2.0', id, method: 'ping' });
const cancelled = requestId => ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } });
const json = value => JSON.stringify(value) + '\n';

function startServer(extra = {}) {
  const child = spawn(exe, [], { cwd: root, env: { ...env, ...extra }, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.responses = [];
  child.responseLines = [];
  child.stderrText = '';
  child.failure = undefined;
  child.closed = new Promise(resolve => child.once('close', resolve));
  let tail = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {
    tail += chunk;
    for (;;) {
      const at = tail.indexOf('\n');
      if (at < 0) break;
      const line = tail.slice(0, at);
      tail = tail.slice(at + 1);
      if (line.trim()) { child.responseLines.push(line); child.responses.push(JSON.parse(line)); }
    }
  });
  child.stderr.setEncoding('utf8').on('data', value => child.stderrText += value);
  child.on('error', error => child.failure = error);
  child.stdin.on('error', error => child.failure = error);
  return child;
}

async function waitFor(server, predicate, label, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    assert.ifError(server.failure);
    assert.equal(server.exitCode, null, `${label}: server exited (${server.stderrText})`);
    if (performance.now() >= deadline) assert.fail(`${label}: timed out; responses=${JSON.stringify(server.responses)} stderr=${server.stderrText}`);
    await sleep(10);
  }
}

async function closeServer(server) {
  if (server.exitCode === null) server.stdin.end();
  const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
  try { await server.closed; } finally { clearTimeout(timer); }
  assert.ifError(server.failure);
}

async function writeFragmented(server, text) {
  for (let i = 0; i < text.length; i += 9) {
    server.stdin.write(text.slice(i, i + 9));
    await sleep(12);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    if (!win && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch (error) { if (error.code === 'ESRCH' || error.code === 'ENOENT') return false; throw error; }
}

function compile(source, output) {
  const version = spawnSync(exe, ['version'], { cwd: root, env, encoding: 'utf8', timeout: 12000, windowsHide: true });
  assert.equal(version.status, 0, version.stderr || String(version.error));
  const home = process.env.PUREBASIC_HOME || version.stdout.match(/^PureBasic \S+ - (.+)$/m)?.[1];
  assert.ok(home, version.stdout);
  const compiler = home === 'pbcompiler' ? home : join(home, win ? 'Compilers/pbcompiler.exe' : 'compilers/pbcompiler');
  const result = spawnSync(compiler, win ? ['/THREAD', '/CONSOLE', source, '/EXE', output]
    : ['--thread', '--console', source, '--output', output], { cwd: root, env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error || ''));
}

const runnerSource = join(scratch, 'descendants.pb');
writeFileSync(runnerSource, '\uFEFF' + `EnableExplicit
Define base.s = GetEnvironmentVariable("PBMCP_CANCEL_BASE"), f.i
If ProgramParameter(0) = "child"
  f = CreateFile(#PB_Any, base + "-started")
  If f = 0 : End 20 : EndIf
  CloseFile(f)
  Delay(12000)
  f = CreateFile(#PB_Any, base + "-late")
  If f : CloseFile(f) : EndIf
ElseIf ProgramParameter(0) = "short"
  Delay(1400)
  If OpenConsole() : PrintN("completed") : CloseConsole() : EndIf
Else
  Define child.i = RunProgram(ProgramFilename(), "child", "", #PB_Program_Open | #PB_Program_Hide)
  If child = 0 : End 21 : EndIf
  f = CreateFile(#PB_Any, base + "-pid")
  If f = 0 : End 22 : EndIf
  WriteStringN(f, Str(ProgramID(child)), #PB_UTF8)
  WriteStringN(f, ProgramFilename(), #PB_UTF8)
  CloseFile(f)
  Define deadline.i = ElapsedMilliseconds() + 3000
  While FileSize(base + "-started") = -1 And ElapsedMilliseconds() < deadline : Delay(5) : Wend
  If FileSize(base + "-started") = -1 : End 23 : EndIf
  Delay(15000)
EndIf
`);
const runner = runnerSource;

// Cancel a live pb_run by its exact 64-bit numeric ID. Ping is answered while
// the tool is active; a normal request is queued and resumes after cancellation.
const runtimeBase = join(scratch, 'runtime');
const runtime = startServer({ PBMCP_CANCEL_BASE: runtimeBase });
let runtimePid, runtimeProgram;
try {
  const numericCall = JSON.stringify(call('9223372036854775807', 'pb_run', { file: runner, timeoutMs: 10000 }))
    .replace('"id":"9223372036854775807"', '"id":92233720368547758070e-1') + '\n';
  runtime.stdin.write(numericCall);
  await waitFor(runtime, () => existsSync(runtimeBase + '-started') && existsSync(runtimeBase + '-pid'), 'runtime child start');
  [runtimePid, runtimeProgram] = readFileSync(runtimeBase + '-pid', 'utf8').trim().split(/\r?\n/);
  runtimePid = Number(runtimePid);
  runtime.stdin.write(json([ping('mixed-ping'), call('mixed-version', 'pb_version', {})]));
  runtime.stdin.write(json(ping('live-ping')));
  await waitFor(runtime, () => runtime.responses.some(r => r.id === 'live-ping'), 'prompt ping', 1500);
  assert.equal(runtime.responses.some(Array.isArray), false, 'mixed batch ran before the active tool finished');
  const exactId = '9223372036854775807';
  const cancelLine = `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":${exactId}}}\n`;
  await writeFragmented(runtime, cancelLine);
  runtime.stdin.write(json(call('queued', 'pb_run', { file: runner, args: ['short'], timeoutMs: 5000 })));
  runtime.stdin.write(json(call('queued-version', 'pb_version', {})));
  await waitFor(runtime, () => runtime.responses.some(r => r.id === 'queued'), 'queued request completion', 10000);
  await waitFor(runtime, () => runtime.responses.some(r => r.id === 'queued-version'), 'second queued request completion', 5000);
  assert.deepEqual(runtime.responses.map(r => Array.isArray(r) ? r.map(item => item.id) : r.id),
    ['live-ping', ['mixed-ping', 'mixed-version'], 'queued', 'queued-version'], JSON.stringify(runtime.responses));
  assert.equal(runtime.responses.find(r => r.id === 'queued').result.isError, false);
  const deadline = performance.now() + 3000;
  while (alive(runtimePid) && performance.now() < deadline) await sleep(10);
  assert.equal(alive(runtimePid), false, `cancelled descendant ${runtimePid} survived`);
  assert.equal(existsSync(runtimeBase + '-late'), false, 'cancelled descendant continued running');
  const tempDir = resolve(dirname(dirname(runtimeProgram)));
  assert.equal(relative(tmpdir(), dirname(tempDir)), '');
  assert.ok(basename(tempDir).startsWith('pbmcp-'));
  assert.equal(existsSync(tempDir), false, 'cancelled pb_run temp directory remained');
  // Reuse the canceled ID; cancellation state must not leak to a later request.
  runtime.stdin.write(`{"jsonrpc":"2.0","id":9223372036854775807,"method":"ping"}\n`);
  await waitFor(runtime, () => runtime.responseLines.some(line => /"id":9223372036854775807/.test(line)), 'canceled ID reuse');
} finally {
  await closeServer(runtime);
  if (runtimePid && alive(runtimePid)) process.kill(runtimePid, 'SIGKILL');
  if (runtimeProgram) {
    const target = resolve(dirname(dirname(runtimeProgram)));
    assert.equal(relative(tmpdir(), dirname(target)), '');
    if (existsSync(target)) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// Unrelated IDs and malformed cancellation notifications must leave the tool running.
const unaffected = startServer({ PBMCP_CANCEL_BASE: runtimeBase });
try {
  unaffected.stdin.write(json(call('active', 'pb_run', { file: runner, args: ['short'], timeoutMs: 5000 })));
  await sleep(200);
  unaffected.stdin.write(json(cancelled('other')));
  unaffected.stdin.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":{}}}\n');
  unaffected.stdin.write('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"active","reason":1}}\n');
  unaffected.stdin.write('{"method":"notifications/cancelled","params":{"requestId":"active"}}\n');
  unaffected.stdin.write('{"jsonrpc":"2.0","id":"bad-surrogate","method":"ping","params":{"text":"\\ud800"}}\n');
  unaffected.stdin.write(Buffer.concat([
    Buffer.from('{"jsonrpc":"2.0","id":"bad-utf8","method":"ping","params":{"text":"', 'utf8'),
    Buffer.from([0xc0, 0xaf]),
    Buffer.from('"}}\n', 'utf8'),
  ]));
  unaffected.stdin.write(json(ping('still-live')));
  await waitFor(unaffected, () => unaffected.responses.some(r => r.id === 'still-live'), 'ping after ignored cancellation', 1500);
  await waitFor(unaffected, () => unaffected.responses.some(r => r.id === 'active'), 'uncancelled tool completion', 4000);
  await waitFor(unaffected, () => unaffected.responses.some(r => /surrogate/i.test(r.error?.message || '')) &&
    unaffected.responses.some(r => /UTF-8/i.test(r.error?.message || '')), 'deferred malformed Unicode errors', 1500);
  const result = unaffected.responses.find(r => r.id === 'active');
  assert.equal(result.result.isError, false, JSON.stringify(result));
  assert.match(result.result.content[0].text, /completed/);
  const surrogateError = unaffected.responses.find(r => /surrogate/i.test(r.error?.message || ''));
  const utf8Error = unaffected.responses.find(r => /UTF-8/i.test(r.error?.message || ''));
  for (const response of [surrogateError, utf8Error]) {
    assert.equal(response.id, null);
    assert.equal(response.error.code, -32600);
  }
} finally {
  await closeServer(unaffected);
}

// Batch control frames preserve JSON-RPC batch response framing while cancelling
// the matching active request; the cancellation notification itself is silent.
const batchBase = join(scratch, 'batch');
const batched = startServer({ PBMCP_CANCEL_BASE: batchBase });
let batchPid, batchProgram;
try {
  batched.stdin.write(json(call('batch-active', 'pb_run', { file: runner, timeoutMs: 10000 })));
  await waitFor(batched, () => existsSync(batchBase + '-started') && existsSync(batchBase + '-pid'), 'batch test child start');
  [batchPid, batchProgram] = readFileSync(batchBase + '-pid', 'utf8').trim().split(/\r?\n/);
  batchPid = Number(batchPid);
  const batch = [cancelled('batch-active'), ping('batch-ping')];
  await writeFragmented(batched, json(batch));
  await waitFor(batched, () => batched.responses.some(r => Array.isArray(r)), 'batch response', 8000);
  const responseBatch = batched.responses.find(Array.isArray);
  assert.deepEqual(responseBatch.map(r => r.id), ['batch-ping']);
  assert.equal(batched.responses.some(r => r.id === 'batch-active'), false, 'canceled batch request emitted a response');
} finally {
  await closeServer(batched);
  if (batchPid && alive(batchPid)) process.kill(batchPid, 'SIGKILL');
  if (batchProgram) {
    const target = resolve(dirname(dirname(batchProgram)));
    assert.equal(relative(tmpdir(), dirname(target)), '');
    assert.ok(basename(target).startsWith('pbmcp-'));
    if (existsSync(target)) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

// Fake compiler: version probes return immediately; compilation writes a PID
// marker and blocks so cancellation must terminate the compiler process group.
const fakeHome = join(scratch, 'fake-home');
const fakeCompiler = join(fakeHome, win ? 'Compilers/pbcompiler.exe' : 'compilers/pbcompiler');
mkdirSync(dirname(fakeCompiler), { recursive: true });
const compilerSource = join(scratch, 'fake-compiler.pb');
writeFileSync(compilerSource, '\uFEFF' + `EnableExplicit
CompilerIf #PB_Compiler_OS = #PB_OS_Windows
Import "kernel32.lib" : FakePid() As "GetCurrentProcessId" : EndImport
CompilerElse
ImportC ""
  FakePid() As "getpid"
EndImport
CompilerEndIf
Define arg.s = ProgramParameter(0), base.s = GetEnvironmentVariable("PBMCP_FAKE_COMPILER_BASE"), f.i
If arg = "--version" Or arg = "/VERSION"
  If GetEnvironmentVariable("PBMCP_FAKE_VERSION_WAIT") = "1"
    Define versionBase.s = GetEnvironmentVariable("PBMCP_FAKE_VERSION_BASE")
    f = CreateFile(#PB_Any, versionBase + "-pid")
    If f = 0 : End 31 : EndIf
    WriteStringN(f, Str(FakePid()), #PB_UTF8) : CloseFile(f)
    Define versionDeadline.i = ElapsedMilliseconds() + 25000
    While FileSize(versionBase + "-release") = -1 And ElapsedMilliseconds() < versionDeadline : Delay(10) : Wend
  EndIf
  If OpenConsole() : PrintN("PureBasic 6.40") : CloseConsole() : EndIf
  End 0
EndIf
f = CreateFile(#PB_Any, base + "-pid")
If f = 0 : End 30 : EndIf
WriteStringN(f, Str(FakePid()), #PB_UTF8) : CloseFile(f)
Delay(12000)
f = CreateFile(#PB_Any, base + "-late")
If f : CloseFile(f) : EndIf
`);
compile(compilerSource, fakeCompiler);
const fakeBase = join(scratch, 'compiler');
const inputSource = join(scratch, 'syntax.pb');
writeFileSync(inputSource, '\uFEFFEnableExplicit\n');
const compilerServer = startServer({ PUREBASIC_HOME: fakeHome, PBMCP_FAKE_COMPILER_BASE: fakeBase });
let fakePid;
try {
  compilerServer.stdin.write(json([ping('outer-before'), call('compile-cancel', 'pb_check', { file: inputSource }), ping('outer-after')]));
  await waitFor(compilerServer, () => existsSync(fakeBase + '-pid'), 'fake compiler start');
  fakePid = Number(readFileSync(fakeBase + '-pid', 'utf8').trim());
  compilerServer.stdin.write(json([ping('batch-live-ping'), { jsonrpc: '2.0', method: 'ping' }]));
  await waitFor(compilerServer, () => compilerServer.responses.some(r => Array.isArray(r) && r[0]?.id === 'batch-live-ping'),
    'prompt batch ping during active batch', 1500);
  assert.ok(alive(fakePid), 'compiler finished before batch ping was answered');

  // Fill the exact deferred-character budget with one legal ASCII frame.
  const queued = { jsonrpc: '2.0', id: 'queued-full', method: 'unknown/queued', params: { padding: '' } };
  queued.params.padding = 'x'.repeat(1048576 - JSON.stringify(queued).length);
  assert.equal(JSON.stringify(queued).length, 1048576);
  compilerServer.stdin.write(json(queued));
  compilerServer.stdin.write(json(call('overflow', 'pb_version', {})));
  compilerServer.stdin.write(json([call('batch-overflow', 'pb_version', {}),
    { jsonrpc: '2.0', method: 'notifications/initialized' }, ping('full-queue-ping')]));
  compilerServer.stdin.write('not-json\n');
  compilerServer.stdin.write(Buffer.from([0xff, 0x0a]));
  const oversized = [cancelled('compile-cancel'), ...Array.from({ length: 64 }, (_, i) => ping('oversized-' + i))];
  compilerServer.stdin.write(json(oversized));
  await waitFor(compilerServer, () => compilerServer.responses.some(r => r.id === 'overflow') &&
    compilerServer.responses.some(r => Array.isArray(r) && r[0]?.id === 'batch-overflow') &&
    compilerServer.responses.some(r => r.error?.code === -32700) &&
    compilerServer.responses.some(r => /UTF-8/.test(r.error?.message || '')) &&
    compilerServer.responses.some(r => /Batch exceeds 64/.test(r.error?.message || '')), 'full queue responses', 3000);
  const overflow = compilerServer.responses.find(r => r.id === 'overflow');
  assert.equal(overflow.error.code, -32000);
  assert.match(overflow.error.message, /Server busy.*retry later/);
  const busyBatch = compilerServer.responses.find(r => Array.isArray(r) && r[0]?.id === 'batch-overflow');
  assert.equal(busyBatch.length, 2, 'overflow notification emitted a response');
  assert.equal(busyBatch[0].error.code, -32000);
  assert.deepEqual(busyBatch[1], { jsonrpc: '2.0', id: 'full-queue-ping', result: {} });
  assert.ok(alive(fakePid), 'oversized batch executed its cancellation notification');
  assert.equal(compilerServer.responses.some(r => r.id === 'queued-full'), false, 'queued request ran during compilation');
  await writeFragmented(compilerServer, json(cancelled('compile-cancel')));
  compilerServer.stdin.write(json(ping('compiler-ping')));
  await waitFor(compilerServer, () => compilerServer.responses.some(r => r.id === 'compiler-ping'), 'compiler cancellation ping', 2500);
  await sleep(150);
  await waitFor(compilerServer, () => compilerServer.responses.some(r => r.id === 'queued-full'), 'full queue drained after cancellation', 2500);
  assert.equal(compilerServer.responses.flat().some(r => r.id === 'compile-cancel'), false, 'canceled compiler call emitted a result');
  const outerBatch = compilerServer.responses.find(r => Array.isArray(r) && r[0]?.id === 'outer-before');
  assert.deepEqual(outerBatch?.map(r => r.id), ['outer-before', 'outer-after'], 'control batch damaged the active batch response');
  assert.equal(compilerServer.responses.find(r => r.id === 'queued-full').error.code, -32601);
  assert.ok(compilerServer.responses.indexOf(outerBatch) < compilerServer.responses.findIndex(r => r.id === 'queued-full'));
  compilerServer.stdin.write(json(call('after-full-queue', 'pb_version', {})));
  await waitFor(compilerServer, () => compilerServer.responses.some(r => r.id === 'after-full-queue'), 'queue capacity restored', 2500);
  assert.equal(compilerServer.responses.find(r => r.id === 'after-full-queue').result.isError, false);
  const deadline = performance.now() + 3000;
  while (alive(fakePid) && performance.now() < deadline) await sleep(10);
  assert.equal(alive(fakePid), false, `fake compiler ${fakePid} survived cancellation`);
  assert.equal(existsSync(fakeBase + '-late'), false, 'fake compiler continued after cancellation');
} finally {
  await closeServer(compilerServer);
  if (fakePid && alive(fakePid)) process.kill(fakePid, 'SIGKILL');
}

// Cancellation during the first /VERSION probe must not poison config state.
// Release the fake compiler after cancellation, then pb_version must retry and
// report the discovered version instead of retaining an empty cached value.
for (const [name, args] of [['valid', { file: inputSource }], ['invalid', {}]]) {
  const versionBase = join(scratch, 'version-probe-' + name);
  const versionServer = startServer({ PUREBASIC_HOME: fakeHome, PBMCP_FAKE_VERSION_WAIT: '1', PBMCP_FAKE_VERSION_BASE: versionBase });
  let versionPid;
  try {
    versionServer.stdin.write(json(call('version-cancel', 'pb_check', args)));
    await waitFor(versionServer, () => existsSync(versionBase + '-pid'), 'blocked version probe start');
    versionPid = Number(readFileSync(versionBase + '-pid', 'utf8').trim());
    versionServer.stdin.write(json(ping('version-ping')));
    await writeFragmented(versionServer, json(cancelled('version-cancel')));
    await waitFor(versionServer, () => versionServer.responses.some(r => r.id === 'version-ping'), 'version probe control polling', 2500);
    const deadline = performance.now() + 3000;
    while (alive(versionPid) && performance.now() < deadline) await sleep(10);
    assert.equal(alive(versionPid), false, `cancelled version probe ${versionPid} survived`);
    writeFileSync(versionBase + '-release', 'released');
    versionServer.stdin.write(json(call('version-retry', 'pb_version', {})));
    await waitFor(versionServer, () => versionServer.responses.some(r => r.id === 'version-retry'), 'version retry', 6000);
    assert.equal(versionServer.responses.some(r => r.id === 'version-cancel'), false, `cancelled ${name} check emitted a response`);
    const retry = versionServer.responses.find(r => r.id === 'version-retry');
    assert.equal(retry.result.isError, false, JSON.stringify(retry));
    assert.match(retry.result.content[0].text, /PureBasic 6\.40/);
  } finally {
    await closeServer(versionServer);
    if (versionPid && alive(versionPid)) process.kill(versionPid, 'SIGKILL');
  }
}

console.log('cancellation tests passed (runtime/compiler trees, exact IDs and reuse, fragmented controls, ignored cancellations, queued/mixed calls, prompt batch pings and full-queue recovery)');
