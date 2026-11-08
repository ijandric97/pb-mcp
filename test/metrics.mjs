import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = resolve(process.env.PBMCP_EXE || join(root, 'pbmcp' + (process.platform === 'win32' ? '.exe' : '')));
const source = join(root, 'test', 'fixtures', 'hello.pb');
const tempRoot = resolve(tmpdir());
const scratch = mkdtempSync(join(tempRoot, 'pbmcp-metrics-'));
const running = new Set();
try {
  for (const zone of ['Pacific/Kiritimati', 'America/Adak']) {
    const metrics = join(scratch, zone.replaceAll('/', '-') + '.jsonl');
    const env = { ...process.env, TZ: zone, PUREBASIC_MCP_NO_METRICS: '0',
      PUREBASIC_MCP_METRICS: metrics, PBMCP_DOCS_TIMING: '0', PBMCP_PRELOAD: '0',
      PUREBASIC_MCP_INDEX: join(root, 'test', 'fixtures', 'docs-index.json') };
    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'pb_check', arguments: { file: source } } }) + '\n';
    const before = Date.now();
    const result = spawnSync(exe, [], { input: request, cwd: root, env, encoding: 'utf8',
      timeout: 15000, windowsHide: true });
    const after = Date.now();
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(JSON.parse(result.stdout).result.isError, false, result.stdout);
    const record = JSON.parse(readFileSync(metrics, 'utf8').trim());
    assert.match(record.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const timestamp = Date.parse(record.ts);
    assert.ok(timestamp >= before - 30000 && timestamp <= after + 30000,
      `${zone}: timestamp ${record.ts} is not current UTC time`);
  }

  const win = process.platform === 'win32';
  const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '0', PBMCP_PRELOAD: '0', PBMCP_DOCS_TIMING: '0',
    PUREBASIC_MCP_INDEX: join(root, 'test', 'fixtures', 'docs-index.json') };
  const report = spawnSync(exe, ['version'], { env, encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(report.status, 0, report.stderr || String(report.error));
  const home = report.stdout.match(/^PureBasic \S+ - (.+)$/m)?.[1];
  assert.ok(home, report.stdout);
  const compiler = home === 'pbcompiler' ? home : join(home, win ? 'Compilers/pbcompiler.exe' : 'compilers/pbcompiler');
  const probeSource = join(scratch, 'metrics-probe.pb');
  const probe = join(scratch, 'metrics-probe' + (win ? '.exe' : ''));
  writeFileSync(probeSource, '\uFEFFEnableExplicit\n' + ['console', 'jsonrpc', 'config', 'metrics'].map(name =>
    `XIncludeFile "${join(root, 'src', name + '.pb')}"`).join('\n') + `
Procedure ToolList(IdValue.i) : EndProcedure
Procedure ToolDispatch(IdValue.i, Params.i) : EndProcedure
If OpenConsole() = 0 : End 1 : EndIf
If ProgramParameter(0) = "hold"
  CompilerIf #PB_Compiler_OS = #PB_OS_Windows
    Define f.i = OpenFile(#PB_Any, MetricsPath(), #PB_File_Append)
    If f = 0 : End 2 : EndIf
  CompilerElse
    Define *encoded = UTF8(MetricsPath())
    Define fd.l = MetricsOpen(*encoded, #METRICS_OPEN_APPEND, $1B6)
    FreeMemory(*encoded)
    If fd < 0 Or MetricsFlock(fd, #METRICS_LOCK_EX_NB) <> 0 : End 2 : EndIf
  CompilerEndIf
  PrintN("locked")
  Delay(Val(ProgramParameter(1)))
  CompilerIf #PB_Compiler_OS = #PB_OS_Windows
    CloseFile(f)
  CompilerElse
    MetricsClose(fd)
  CompilerEndIf
Else
  NewList buckets$()
  AddElement(buckets$()) : buckets$() = "syntax"
  Define i.i
  For i = 1 To Val(ProgramParameter(1))
    MetricsAppend("pb_check", ProgramParameter(0) + "-" + Str(i) + " café 🚀", #True, 0, buckets$(), i)
  Next
  PrintN("done")
EndIf
CloseConsole()
`);
  const compiled = spawnSync(compiler, win ? ['/THREAD', '/CONSOLE', probeSource, '/EXE', probe]
    : ['--thread', '--console', probeSource, '--output', probe], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr + String(compiled.error || ''));

  function launch(args, metrics) {
    const child = spawn(probe, args, { env: { ...env, PUREBASIC_MCP_METRICS: metrics }, windowsHide: true });
    let stdout = '', stderr = '', error;
    child.stdout.setEncoding('utf8').on('data', text => stdout += text);
    child.stderr.setEncoding('utf8').on('data', text => stderr += text);
    child.on('error', value => { error = value; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    const worker = { child, done: new Promise(resolve => child.on('close', code => {
      clearTimeout(timer);
      running.delete(worker);
      resolve({ code, stdout, stderr, error });
    })) };
    running.add(worker);
    return worker;
  }
  function clean(result) {
    assert.ifError(result.error);
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.stderr, '');
  }
  async function hold(metrics, ms) {
    const worker = launch(['hold', String(ms)], metrics);
    const [text] = await Promise.race([once(worker.child.stdout, 'data'), worker.done.then(result => {
      throw new Error('metrics holder exited before locking: ' + JSON.stringify(result));
    })]);
    assert.equal(text.trim(), 'locked');
    return worker;
  }
  const metrics = join(scratch, 'shared.jsonl');
  writeFileSync(metrics, '{"old":true}\n');
  const writers = Array.from({ length: 4 }, (_, i) => launch(['writer' + i, '1000'], metrics));
  for (const result of await Promise.all(writers.map(worker => worker.done))) clean(result);
  const records = readFileSync(metrics, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.shift(), { old: true }, 'appends changed existing records');
  assert.equal(records.length, 4000, 'concurrent clients lost metrics');
  assert.equal(new Set(records.map(record => record.file)).size, 4000, 'concurrent clients duplicated records');
  for (const record of records) {
    assert.match(record.file, /^writer[0-3]-\d+ café 🚀$/);
    assert.equal(record.ok, true);
    assert.deepEqual(record.buckets, ['syntax']);
  }

  const delayedLog = join(scratch, 'delayed.jsonl');
  const delayed = await hold(delayedLog, 200);
  clean(await launch(['delayed', '1'], delayedLog).done);
  clean(await delayed.done);
  assert.equal(JSON.parse(readFileSync(delayedLog, 'utf8')).file, 'delayed-1 café 🚀', 'brief contention dropped a record');

  const blockedLog = join(scratch, 'blocked.jsonl');
  const blocked = await hold(blockedLog, 10000);
  const started = performance.now();
  clean(await launch(['blocked', '1'], blockedLog).done);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 400 && elapsed < 2000, `metrics lock wait was not bounded: ${elapsed}ms`);
  blocked.child.kill('SIGKILL');
  await blocked.done;
  assert.equal(readFileSync(blockedLog, 'utf8'), '', 'writer ignored the existing lock');
  clean(await launch(['recovered', '1'], blockedLog).done);
  assert.equal(JSON.parse(readFileSync(blockedLog, 'utf8')).file, 'recovered-1 café 🚀', 'exited writer left a stale lock');
} finally {
  const remaining = [...running];
  for (const worker of remaining) worker.child.kill('SIGKILL');
  await Promise.all(remaining.map(worker => worker.done));
  assert.equal(dirname(scratch), tempRoot);
  assert.ok(basename(scratch).startsWith('pbmcp-metrics-'));
  rmSync(scratch, { recursive: true, force: true });
}
console.log('metrics tests passed (UTC, 4,000 concurrent records, preserved history/UTF-8, lock retry/deadline/exit recovery)');
