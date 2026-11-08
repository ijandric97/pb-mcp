import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = resolve(process.env.PBMCP_EXE || join(root, 'pbmcp' + (process.platform === 'win32' ? '.exe' : '')));
const scratch = join(root, 'test', 'out', 'compiler');
assert.equal(dirname(scratch), join(root, 'test', 'out'));
rmSync(scratch, { recursive: true, force: true });
const project = join(scratch, 'project with spaces');
mkdirSync(join(project, 'nested'), { recursive: true });
mkdirSync(join(project, 'assets'), { recursive: true });
const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '1', PBMCP_DOCS_TIMING: '0',
  PUREBASIC_MCP_INDEX: join(root, 'test', 'fixtures', 'docs-index.json') };
function rpc(calls, overrides = {}) {
  const started = performance.now();
  const result = spawnSync(exe, [], { cwd: root, windowsHide: true, env: { ...env, ...overrides },
    encoding: 'utf8', timeout: 15000,
    input: calls.map(([name, args], i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1,
      method: 'tools/call', params: { name, arguments: args } })).join('\n') + '\n' });
  assert.equal(result.status, 0, result.stderr || String(result.error || result.signal));
  return { responses: result.stdout.trim().split('\n').map(line => JSON.parse(line)), ms: performance.now() - started };
}
function invoke(name, args, overrides) { return rpc([[name, args]], overrides).responses[0]; }
const text = response => response.result.content[0].text;
function ok(response) { assert.equal(response.result.isError, false, text(response)); return text(response); }
function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? snapshot(path) : [[path, readFileSync(path)]];
  });
}

const main = join(project, 'main.pb');
writeFileSync(main, '\uFEFF' + [
  'EnableExplicit', 'XIncludeFile "sibling.pbi"', 'IncludePath "nested/"',
  'XIncludeFile "helper.pbi"', 'IncludePath #PB_Compiler_FilePath',
  'DataSection', 'Payload:', 'IncludeBinary "assets/payload.bin"', 'EndDataSection',
  'If OpenConsole()', '  PrintN(SiblingText() + NestedText())',
  '  PrintN("source=" + #PB_Compiler_FilePath)', '  PrintN("payload=" + Str(PeekA(?Payload)))',
  '  If ReadFile(0, "assets/data.txt")', '    PrintN("data=" + ReadString(0, #PB_UTF8))',
  '    CloseFile(0)', '  EndIf', '  CloseConsole()', 'EndIf',
].join('\n'));
writeFileSync(join(project, 'sibling.pbi'), 'Procedure.s SiblingText()\n  ProcedureReturn "sibling+"\nEndProcedure\n');
writeFileSync(join(project, 'nested', 'helper.pbi'), 'Procedure.s NestedText()\n  ProcedureReturn "nested"\nEndProcedure\n');
writeFileSync(join(project, 'assets', 'payload.bin'), Buffer.from([97]));
writeFileSync(join(project, 'assets', 'data.txt'), 'relative-data');
const before = snapshot(project);
assert.match(ok(invoke('pb_check', { file: main })), /^OK — /);
const run = ok(invoke('pb_run', { file: main }));
assert.ok(run.includes('sibling+nested'), run);
assert.ok(run.includes('source=' + project + sep), run);
assert.ok(run.includes('payload=97') && run.includes('data=relative-data'), run);
assert.deepEqual(snapshot(project), before, 'compiler modified the project or left output beside its source');
const missingInclude = join(project, 'missing-include.pb');
writeFileSync(missingInclude, 'EnableExplicit\nXIncludeFile "nested/absent.pbi"\n');
for (const tool of ['pb_check', 'pb_run']) {
  const failed = invoke(tool, { file: missingInclude });
  assert.equal(failed.result.isError, true, text(failed));
  assert.ok(text(failed).includes('absent.pbi'), 'missing include diagnostic was lost: ' + text(failed));
}
const brokenMain = join(project, 'broken-main.pb');
const brokenInclude = join(project, 'nested', 'broken.pbi');
writeFileSync(brokenMain, 'EnableExplicit\nXIncludeFile "nested/broken.pbi" ; Dim wrong As Integer\n');
writeFileSync(brokenInclude, 'EnableExplicit\nunknownVariable = 1\n');
for (const tool of ['pb_check', 'pb_run']) {
  const failed = invoke(tool, { file: brokenMain });
  assert.equal(failed.result.isError, true, text(failed));
  assert.match(text(failed), /Line 2: .*variables have to be declared: unknownVariable/);
  assert.ok(text(failed).includes(brokenInclude), 'included source path was lost: ' + text(failed));
  assert.ok(!text(failed).includes('Line 0:'), text(failed));
  assert.ok(!text(failed).includes('PureBasic has no `Dim'), 'hint used the main file instead of the included file');
}

const hello = join(root, 'test', 'fixtures', 'hello.pb');
const args = ['alpha', 'beta gamma', '', 'tail\\', 'tab\tvalue', String.raw`\u0000`, String.raw`\\u0000`];
const echoed = ok(invoke('pb_run', { file: hello, args }));
assert.deepEqual(echoed.split(/\r?\n/).filter(line => /^arg\d+=/.test(line)).map(line => line.slice(line.indexOf('=') + 1)), args);
const rejected = invoke('pb_run', { file: hello, args: ['alpha', 'quote "inner" arg'] });
assert.equal(rejected.result.isError, true);
assert.match(text(rejected), /Double quotes are not supported.*args\.1/);
assert.ok(!text(rejected).includes('hello from pb_run'), 'unsupported arguments reached the executable');
for (const value of ['line\nbreak', 'carriage\rreturn']) {
  const invalid = invoke('pb_run', { file: hello, args: ['alpha', value] });
  assert.equal(invalid.result.isError, true, text(invalid));
  assert.match(text(invalid), /Newlines are not supported.*args\.1/);
}
for (const value of ['nul\0value', '\\' + '\0']) {
  const invalid = invoke('pb_run', { file: hello, args: [value] });
  assert.equal(invalid.error?.code, -32600);
  assert.match(invalid.error.message, /NUL characters are not supported/);
}

const bp = readFileSync(join(root, 'test', 'fixtures', 'bp.pb'), 'utf8').replace(/\r\n/g, '\n');
for (const [name, source] of [['lf', bp], ['crlf', bp.replace(/\n/g, '\r\n')], ['cr', bp.replace(/\n/g, '\r')],
  ['no-final-newline', bp.trimEnd()]]) {
  const file = join(scratch, name + '.pb');
  writeFileSync(file, source);
  const result = ok(invoke('pb_check', { file }));
  assert.ok(result.includes('Best practices (3):') && result.includes('Line 4:') && result.includes('Line 7:'), result);
}
const clean = join(scratch, 'clean.pb');
writeFileSync(clean, '\uFEFFEnableExplicit\nDefine text.s = "Global; Goto EndProcedure"\n; Global Goto\n');
assert.ok(!ok(invoke('pb_check', { file: clean })).includes('Best practices'), 'strings, comments, or BOM confused the lint');

const large = join(scratch, 'large.pb');
writeFileSync(large, 'EnableExplicit\n' + '; padding\n'.repeat(50000));
const metrics = join(scratch, 'metrics.jsonl');
const measured = rpc([['pb_check', { file: large }]], { PUREBASIC_MCP_NO_METRICS: '0', PUREBASIC_MCP_METRICS: metrics });
const result = ok(measured.responses[0]);
const reported = Number(/^OK — 50001 lines, (\d+) ms/.exec(result)?.[1]);
const record = JSON.parse(readFileSync(metrics, 'utf8').trim());
assert.ok(Number.isFinite(reported), result);
assert.ok(reported <= record.durationMs && record.durationMs <= measured.ms + 20, 'header/metrics do not measure the full check');
assert.ok(measured.ms - reported < 500, `unreported work: wall=${measured.ms}ms, reported=${reported}ms`);
assert.ok(measured.ms < 2000, `large-file check regressed: ${measured.ms}ms`);
const longLine = join(scratch, 'long-line.pb');
writeFileSync(longLine, ' '.repeat(200000) + 'EnableExplicit\n');
assert.ok(!ok(invoke('pb_check', { file: longLine })).includes('Best practices'));

// Inspect the capture before tool formatting applies its smaller response cap.
const win = process.platform === 'win32';
const suffix = win ? '.exe' : '';
const version = spawnSync(exe, ['version'], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
assert.equal(version.status, 0, version.stderr);
const pbHome = process.env.PUREBASIC_HOME || version.stdout.match(/^PureBasic \S+ - ([^\r\n]+)$/m)?.[1];
const compiler = pbHome ? join(pbHome, win ? 'Compilers' : 'compilers', 'pbcompiler' + suffix) : 'pbcompiler';
function compile(file, output) {
  const args = win ? ['/THREAD', '/CONSOLE', file, '/EXE', output] : ['--thread', '--console', file, '--output', output];
  const result = spawnSync(compiler, args, { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
const fakeHome = join(scratch, 'fake-home');
const invalidHome = join(scratch, 'invalid-home');
const invalidCompiler = join(invalidHome, win ? 'Compilers' : 'compilers', 'pbcompiler' + suffix);
mkdirSync(dirname(invalidCompiler), { recursive: true });
writeFileSync(invalidCompiler, 'not an executable\n');
// An empty PATH also makes the Linux setsid worker fail to start.
const launchFailure = invoke('pb_check', { file: hello }, { PUREBASIC_HOME: invalidHome, PATH: '' });
assert.equal(launchFailure.result.isError, true);
assert.match(text(launchFailure), /Compiler failed to start:/);
assert.ok(text(launchFailure).includes(invalidCompiler), text(launchFailure));
mkdirSync(join(fakeHome, win ? 'Compilers' : 'compilers'), { recursive: true });
const fakeCompilerSource = join(scratch, 'fake-compiler.pb');
writeFileSync(fakeCompilerSource, '\uFEFFEnableExplicit\nIf OpenConsole()\n' +
  `  If ProgramParameter(0) = "${win ? '/VERSION' : '--version'}"\n` +
  '    PrintN("PureBasic 6.41")\n    End 1\n  EndIf\n' +
  '  ConsoleError("fatal: controlled linker failure")\n  CloseConsole()\nEndIf\nEnd 2\n');
compile(fakeCompilerSource, join(fakeHome, win ? 'Compilers' : 'compilers', 'pbcompiler' + suffix));
const failureMetrics = join(scratch, 'new-metrics-parent', 'nested', 'metrics.jsonl');
const failure = invoke('pb_run', { file: hello }, { PUREBASIC_HOME: fakeHome,
  PUREBASIC_MCP_NO_METRICS: '0', PUREBASIC_MCP_METRICS: failureMetrics });
assert.equal(failure.result.isError, true, text(failure));
assert.match(text(failure), /controlled linker failure/);
assert.match(text(failure), /Compiler exited with code 2/);
assert.equal(JSON.parse(readFileSync(failureMetrics, 'utf8').trim()).ok, false,
  'stderr-only compiler failure was recorded as success');
for (const tool of ['pb_check', 'pb_run']) {
  const nestedMetrics = join(scratch, 'metrics-' + tool, 'nested', 'metrics.jsonl');
  ok(invoke(tool, { file: hello }, { PUREBASIC_MCP_NO_METRICS: '0', PUREBASIC_MCP_METRICS: nestedMetrics }));
  assert.equal(JSON.parse(readFileSync(nestedMetrics, 'utf8').trim()).ok, true);
}
const nonzero = join(scratch, 'nonzero.pb');
writeFileSync(nonzero, '\uFEFFEnableExplicit\nEnd 7\n');
const nonzeroMetrics = join(scratch, 'nonzero-metrics.jsonl');
const nonzeroResult = invoke('pb_run', { file: nonzero }, { PUREBASIC_MCP_NO_METRICS: '0', PUREBASIC_MCP_METRICS: nonzeroMetrics });
assert.equal(nonzeroResult.result.isError, true);
assert.match(text(nonzeroResult), /^exit 7 /);
assert.equal(JSON.parse(readFileSync(nonzeroMetrics, 'utf8').trim()).ok, true, 'runtime exit code changed compile-scoped metrics');
const stderrSource = join(scratch, 'oversized-stderr.pb');
const stderrExe = join(scratch, 'oversized-stderr' + suffix);
writeFileSync(stderrSource, '\uFEFF' + `EnableExplicit
If OpenConsole()
  Select ProgramParameter(0)
    Case "long"
      ConsoleError(LSet("x", 10 * 1024 * 1024, "x"))
      Delay(3000)
    Case "flood"
      Repeat
        ConsoleError(LSet("x", 65536, "x"))
      ForEver
    Case "unicode"
      ConsoleError(LSet("x", 65535, "x") + "é🚀" + Chr(10) + Chr(10) + "after")
      PrintN("stdout-only")
    Default
      ConsoleError(LSet("x", 5 * 1024 * 1024, "x"))
  EndSelect
  CloseConsole()
EndIf
`);
compile(stderrSource, stderrExe);
for (const mode of ['long', 'flood']) {
  const timed = rpc([['pb_run', { file: stderrSource, args: [mode], timeoutMs: 1000 }]]);
  const response = timed.responses[0];
  assert.equal(response.result.isError, true);
  const elapsed = Number(/^TIMEOUT after (\d+) ms/.exec(text(response))?.[1]);
  assert.ok(elapsed >= 900 && elapsed < 2000, `${mode}: deadline delayed: ${text(response).slice(0, 100)}`);
  assert.ok(timed.ms < 3000, `${mode}: timeout response took ${timed.ms}ms`);
}
const captureSource = join(scratch, 'capture-probe.pb');
const captureExe = join(scratch, 'capture-probe' + suffix);
const includes = ['console', 'jsonrpc', 'config', 'metrics', 'docs_index', 'tool_check', 'tool_run', 'tools'];
writeFileSync(captureSource, '\uFEFFEnableExplicit\n' + includes.map(name =>
  `XIncludeFile "${join(root, 'src', name + '.pb')}"`).join('\n') + `
If ProgramParameter(0) = "--job-worker" : End RunJobWorker() : EndIf
If OpenConsole() = 0 : End 1 : EndIf
Define captured.RunResT
RunProcessCapture("${stderrExe}", "", "${scratch}", 10000, @captured)
Define marker$ = Chr(10) + "…[stderr truncated at 4 MB]"
If captured\\spawnFailed Or captured\\timedOut Or captured\\exitCode <> 0 : End 2 : EndIf
If Len(captured\\stderr) <> #MAX_CAPTURE_CHARS + Len(marker$) : End 3 : EndIf
If Right(captured\\stderr, Len(marker$)) <> marker$ : End 4 : EndIf
If Left(captured\\stderr, 16) <> LSet("x", 16, "x") : End 5 : EndIf
RunProcessCapture("${stderrExe}", "unicode", "${scratch}", 5000, @captured)
If captured\\spawnFailed Or captured\\timedOut Or captured\\exitCode <> 0 : End 6 : EndIf
If Right(captured\\stderr, Len("é🚀" + Chr(10) + Chr(10) + "after" + Chr(10))) <> "é🚀" + Chr(10) + Chr(10) + "after" + Chr(10) : End 7 : EndIf
If TrimAll(captured\\stdout) <> "stdout-only" : End 11 : EndIf
Define failed.RunResultT
failed\\compileRes\\spawnFailed = #True
If FindString(FormatRunResult(@failed, "fixture.pb"), "Compiler failed to start.") = 0 : End 8 : EndIf
failed\\compileRes\\spawnFailed = #False
failed\\compileRes\\timedOut = #True
If FindString(FormatRunResult(@failed, "fixture.pb"), "Compiler timeout after 30000 ms") = 0 : End 9 : EndIf
failed\\hasRun = #True
failed\\runRes\\spawnFailed = #True
If FindString(FormatRunResult(@failed, "fixture.pb"), "PROGRAM FAILED TO START") <> 1 : End 10 : EndIf
Define diagnosticText.s = LSet("", 1024 * 1024, Chr(10)), parseStarted.i = ElapsedMilliseconds()
NewList parsedErrors.DiagT()
NewList parsedWarnings.DiagT()
ParseDiagnostics(diagnosticText, parsedErrors(), parsedWarnings())
If ListSize(parsedErrors()) Or ListSize(parsedWarnings()) : End 12 : EndIf
If StripCompilerNoise(diagnosticText) <> "" : End 13 : EndIf
Define parseMs.i = ElapsedMilliseconds() - parseStarted
If parseMs > 2000 : End 14 : EndIf
diagnosticText = ReplaceString(Space(128 * 1024), " ", "x" + Chr(10))
parseStarted = ElapsedMilliseconds()
If Len(StripCompilerNoise(diagnosticText)) <> Len(diagnosticText) - 1 : End 18 : EndIf
If ElapsedMilliseconds() - parseStarted > 2000 : End 19 : EndIf
diagnosticText = "Error: in included file 'nested.pbi'" + Chr(13) + Chr(10) + "Error: Line 2 - failure." + Chr(10) + "Warning: Line 3 - warning." + Chr(10) + "Warning: tail"
ParseDiagnostics(diagnosticText, parsedErrors(), parsedWarnings())
If ListSize(parsedErrors()) <> 1 Or ListSize(parsedWarnings()) <> 2 : End 15 : EndIf
FirstElement(parsedErrors())
If parsedErrors()\\line <> 2 Or parsedErrors()\\file <> "nested.pbi" Or parsedErrors()\\message <> "failure" : End 16 : EndIf
If StripCompilerNoise(" " + Chr(10) + "one" + Chr(13) + Chr(10) + Chr(10) + Chr(10) + "two") <> "one" + Chr(10) + Chr(10) + "two" : End 17 : EndIf
PrintN("1 MiB diagnostic lines parsed and stripped in " + Str(parseMs) + " ms")
PrintN("stderr capture bounded")
CloseConsole()
`);
compile(captureSource, captureExe);
const captured = spawnSync(captureExe, [], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
assert.equal(captured.status, 0, `capture probe exit ${captured.status}: ${captured.stdout}${captured.stderr}`);
assert.match(captured.stdout, /stderr capture bounded/);
console.log(captured.stdout.trim());
console.log(`compiler tests passed (includes/resources/diagnostics, compiler failures, metrics paths, args, lint, stderr caps/UTF-8/deadlines); 50,000 lines: ${Math.round(measured.ms)}ms wall, ${reported}ms reported`);
