import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === 'win32';
const tempRoot = resolve(tmpdir());
const scratch = resolve(mkdtempSync(join(tempRoot, 'pbmcp-build-')));
const insideTemp = relative(tempRoot, scratch);
assert.ok(insideTemp && !insideTemp.startsWith('..') && !insideTemp.startsWith(sep));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

try {
  mkdirSync(join(scratch, 'tools'), { recursive: true });
  mkdirSync(join(scratch, 'src'));
  mkdirSync(join(scratch, 'test'));
  mkdirSync(join(scratch, 'bin'));
  mkdirSync(join(scratch, 'compiler', 'compilers'), { recursive: true });
  writeFileSync(join(scratch, 'build.sh'), readFileSync(join(root, 'build.sh')));
  writeFileSync(join(scratch, 'tools', 'lint_encoding.mjs'), '');
  writeFileSync(join(scratch, 'tools', 'build.mjs'), '');
  writeFileSync(join(scratch, 'test', 'run_tests.mjs'), '');
  const testTargetLog = join(scratch, 'test-target.txt');
  const defaultTargetLog = join(scratch, 'default-target.txt');
  const buildArgsLog = join(scratch, 'build-args.txt');
  writeFileSync(join(scratch, 'src', 'main.pb'), '\uFEFFEnableExplicit\n');
  writeFileSync(join(scratch, 'src', 'pbdocs-index.json'), 'embedded index before build\n');
  const nodeStub = join(scratch, 'bin', 'node');
  writeFileSync(nodeStub, [
    '#!/bin/bash',
    'case "$1" in',
    '  tools/lint_encoding.mjs) exit 0 ;;',
    '  tools/build.mjs) printf "%s\\n" "$2" "$3" "$4" > "$FAKE_BUILD_ARGS"; if [ "${FAKE_BUILD_STATUS:-0}" != 0 ]; then exit "$FAKE_BUILD_STATUS"; fi; printf "fake executable\\n" > "$4" ;;',
    '  test/run_tests.mjs) if [ -n "${PBMCP_INDEX_OUT:-}" ]; then exit 9; fi; printf "%s" "$PBMCP_EXE" > "$FAKE_TEST_TARGET"; printf "%s/pbmcp" "$PWD" > "$FAKE_DEFAULT_TARGET"; exit "${FAKE_TEST_STATUS:-0}" ;;',
    '  *) exit 9 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const compiler = join(scratch, 'compiler', 'compilers', 'pbcompiler');
  writeFileSync(compiler, '#!/bin/bash\nexit 99\n', { mode: 0o755 });
  const inheritedOut = join(scratch, 'inherited output sentinel');
  writeFileSync(inheritedOut, 'keep this file\n');
  {
    const bash = win ? (process.env.PBMCP_BASH || 'C:\\Program Files\\Git\\usr\\bin\\bash.exe') : 'bash';
    const originalOut = process.env.PBMCP_OUT;
    process.env.PBMCP_OUT = inheritedOut;
    const env = { ...process.env, PATH: `${join(scratch, 'bin')}${win ? ';' : ':'}${process.env.PATH}`,
        PUREBASIC_HOME: join(scratch, 'compiler'), FAKE_BUILD_ARGS: buildArgsLog,
        FAKE_TEST_TARGET: testTargetLog, FAKE_DEFAULT_TARGET: defaultTargetLog,
        PBMCP_OUT: '', PBMCP_EXE: '', PBMCP_INDEX_OUT: 'must not reach tests' };
    if (originalOut === undefined) delete process.env.PBMCP_OUT;
    else process.env.PBMCP_OUT = originalOut;
    const build = (args, extra = {}) => run(bash, [join(scratch, 'build.sh'), ...args], { cwd: scratch,
      timeout: 15000, env: { ...env, ...extra } });
    const result = build([]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const forwarded = readFileSync(buildArgsLog, 'utf8').trimEnd().replaceAll('\\', '/').split('\n');
    assert.ok(forwarded[0].endsWith('/compiler/compilers/pbcompiler'), forwarded[0]);
    assert.ok(forwarded[1].endsWith('/src/main.pb'), forwarded[1]);
    assert.ok(forwarded[2].endsWith('/pbmcp'), forwarded[2]);
    assert.equal(readFileSync(join(scratch, 'pbmcp'), 'utf8'), 'fake executable\n');
    const tested = build(['test']);
    assert.equal(tested.status, 0, tested.stderr || tested.stdout);
    assert.equal(readFileSync(testTargetLog, 'utf8'), readFileSync(defaultTargetLog, 'utf8'));
    const shellRoot = readFileSync(defaultTargetLog, 'utf8').replace(/\/pbmcp$/, '');
    const override = 'output with spaces/custom executable';
    mkdirSync(join(scratch, 'output with spaces'));
    const overridden = build(['test'], { PBMCP_OUT: override });
    assert.equal(overridden.status, 0, overridden.stderr || overridden.stdout);
    assert.equal(readFileSync(testTargetLog, 'utf8'), `${shellRoot}/${override}`);
    const bare = build(['test'], { PBMCP_OUT: 'custom' });
    assert.equal(bare.status, 0, bare.stderr || bare.stdout);
    assert.equal(readFileSync(testTargetLog, 'utf8'), `${shellRoot}/custom`);
    const failedTests = build(['test'], { PBMCP_OUT: override, FAKE_TEST_STATUS: '7' });
    assert.equal(failedTests.status, 7, failedTests.stderr || failedTests.stdout);
    assert.equal(readFileSync(testTargetLog, 'utf8'), `${shellRoot}/${override}`);
    assert.equal(readFileSync(inheritedOut, 'utf8'), 'keep this file\n', 'inherited PBMCP_OUT escaped the isolated fixture');
    const failedBuild = build([], { FAKE_BUILD_STATUS: '8' });
    assert.equal(failedBuild.status, 1, failedBuild.stderr || failedBuild.stdout);
    assert.equal(build(['check']).status, 99, 'syntax check did not bypass the shared build helper');
    console.log('build.sh tests passed (shared build arguments, acceptance target/default and override, failure propagation)');
  }

  if (win) {
    const compilerHomes = [process.env.PUREBASIC_HOME,
      process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'PureBasic'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'PureBasic'), 'C:\\PureBasic',
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'PureBasic')].filter(Boolean);
    const nativeCompiler = compilerHomes.map(home => join(home, 'Compilers', 'pbcompiler.exe')).find(existsSync);
    assert.ok(nativeCompiler, 'PureBasic compiler not found for the Windows build.cmd regression');

    const fixture = join(scratch, 'windows build');
    const fakeHome = join(fixture, 'fake compiler home');
    const fakeCompiler = join(fakeHome, 'Compilers', 'pbcompiler.exe');
    const source = join(fixture, 'fake-compiler.pb');
    const log = join(fixture, 'compiler-args.txt');
    const testTarget = join(fixture, 'test-target.txt');
    mkdirSync(dirname(fakeCompiler), { recursive: true });
    mkdirSync(join(fixture, 'tools'), { recursive: true });
    mkdirSync(join(fixture, 'src'), { recursive: true });
    mkdirSync(join(fixture, 'test'), { recursive: true });
    mkdirSync(join(fixture, 'output with spaces'), { recursive: true });
    copyFileSync(join(root, 'build.cmd'), join(fixture, 'build.cmd'));
    copyFileSync(join(root, 'tools', 'build.mjs'), join(fixture, 'tools', 'build.mjs'));
    writeFileSync(join(fixture, 'src', 'main.pb'), '\uFEFFEnableExplicit\n');
    writeFileSync(join(fixture, 'tools', 'lint_encoding.mjs'),
      'if (process.env.FAKE_LINT_FAIL === "1") process.exit(8);\n');
    writeFileSync(join(fixture, 'tools', 'build-local-index.mjs'),
      'export function buildLocalIndex() { if (process.env.FAKE_INDEX_FAIL === "1") throw new Error("index failed"); return { commands: [], reference: [] }; }\n');
    writeFileSync(join(fixture, 'test', 'run_tests.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.env.FAKE_TEST_TARGET, process.env.PBMCP_EXE || "");',
      'process.exit(Number(process.env.FAKE_TEST_EXIT || 0));',
      '',
    ].join('\n'));
    writeFileSync(source, '\uFEFF' + [
      'EnableExplicit',
      'Define.i i, file',
      'Define.s logPath, outputPath, arg',
      'logPath = GetEnvironmentVariable("FAKE_COMPILER_LOG")',
      'file = CreateFile(#PB_Any, logPath)',
      'If file = 0 : End 90 : EndIf',
      'For i = 0 To CountProgramParameters() - 1',
      '  arg = ProgramParameter(i)',
      '  WriteStringN(file, arg, #PB_UTF8)',
      '  If UCase(arg) = "/EXE" And i + 1 < CountProgramParameters() : outputPath = ProgramParameter(i + 1) : EndIf',
      'Next',
      'CloseFile(file)',
      'If GetEnvironmentVariable("FAKE_COMPILER_FAIL") = "1" : End 23 : EndIf',
      'If outputPath <> ""',
      '  file = CreateFile(#PB_Any, outputPath)',
      '  If file = 0 : End 91 : EndIf',
      '  WriteString(file, "fake executable", #PB_UTF8)',
      '  CloseFile(file)',
      'EndIf',
      'End 0',
      '',
    ].join('\n'));

    const fakeBuild = run(nativeCompiler, ['/CONSOLE', source, '/EXE', fakeCompiler], { cwd: fixture, timeout: 30000 });
    assert.equal(fakeBuild.status, 0, fakeBuild.stderr || fakeBuild.stdout);
    const cmd = process.env.ComSpec || 'cmd.exe';
    const env = { ...process.env, PUREBASIC_HOME: fakeHome, FAKE_COMPILER_LOG: log, FAKE_TEST_TARGET: testTarget,
      FAKE_LINT_FAIL: '0', FAKE_INDEX_FAIL: '0', FAKE_COMPILER_FAIL: '0', FAKE_TEST_EXIT: '0',
      PATH: `${dirname(process.execPath)};${process.env.PATH || ''}` };
    delete env.PBMCP_OUT;
    delete env.PBMCP_EXE;
    const buildCmd = (args = [], extra = {}) => run(cmd, ['/d', '/c', join(fixture, 'build.cmd'), ...args], {
      cwd: fixture, timeout: 30000, env: { ...env, ...extra },
    });
    const compilerArgs = () => readFileSync(log, 'utf8').trimEnd().split(/\r?\n/);
    const clearLog = () => writeFileSync(log, '');
    const assertCompileArgs = target => {
      const args = compilerArgs();
      assert.deepEqual(args.slice(0, 5), ['/THREAD', '/CONSOLE', join(fixture, 'src', 'main.pb'), '/EXE', target]);
      assert.equal(args[5], '/CONSTANT');
      assert.ok(args[6].startsWith('PBMCP_INDEX$='), args[6]);
      assert.equal(existsSync(args[6].slice('PBMCP_INDEX$='.length)), false, 'private index snapshot leaked');
      assert.equal(args[7], '/CONSTANT');
      assert.match(args[8], /^PBMCP_REVISION\$=(?:g[0-9a-f]+(?:-dirty)?|unknown)$/i);
      assert.equal(args.length, 9);
    };

    clearLog();
    const checked = buildCmd(['check']);
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.deepEqual(compilerArgs(), ['/THREAD', '/CHECK', join(fixture, 'src', 'main.pb')]);

    clearLog();
    const lintFailure = buildCmd([], { FAKE_LINT_FAIL: '1' });
    assert.equal(lintFailure.status, 1, lintFailure.stderr || lintFailure.stdout);
    assert.equal(readFileSync(log, 'utf8'), '', 'lint failure reached the compiler');

    clearLog();
    const checkFailure = buildCmd(['check'], { FAKE_COMPILER_FAIL: '1' });
    assert.equal(checkFailure.status, 23, checkFailure.stderr || checkFailure.stdout);

    clearLog();
    const defaultTarget = join(fixture, 'pbmcp.exe');
    const defaultBuild = buildCmd(['test']);
    assert.equal(defaultBuild.status, 0, defaultBuild.stderr || defaultBuild.stdout);
    assertCompileArgs(defaultTarget);
    assert.equal(readFileSync(testTarget, 'utf8'), defaultTarget);

    clearLog();
    const absoluteTarget = join(fixture, 'output with spaces', 'absolute target.exe');
    const absoluteBuild = buildCmd(['test'], { PBMCP_OUT: absoluteTarget });
    assert.equal(absoluteBuild.status, 0, absoluteBuild.stderr || absoluteBuild.stdout);
    assertCompileArgs(absoluteTarget);
    assert.equal(readFileSync(testTarget, 'utf8'), absoluteTarget);

    clearLog();
    const relativeTarget = join('output with spaces', 'relative target.exe');
    const relativeBuild = buildCmd(['test'], { PBMCP_OUT: relativeTarget });
    assert.equal(relativeBuild.status, 0, relativeBuild.stderr || relativeBuild.stdout);
    assertCompileArgs(relativeTarget);
    assert.equal(readFileSync(testTarget, 'utf8'), join(fixture, relativeTarget));

    clearLog();
    const compilerFailure = buildCmd([], { FAKE_COMPILER_FAIL: '1' });
    assert.equal(compilerFailure.status, 1, compilerFailure.stderr || compilerFailure.stdout);
    assert.match(compilerFailure.stdout, /compile FAILED/);

    clearLog();
    const indexFailure = buildCmd([], { FAKE_INDEX_FAIL: '1' });
    assert.equal(indexFailure.status, 1, indexFailure.stderr || indexFailure.stdout);
    assert.equal(readFileSync(log, 'utf8'), '', 'index failure reached the compiler');

    clearLog();
    const testFailure = buildCmd(['test'], { FAKE_TEST_EXIT: '7' });
    assert.equal(testFailure.status, 1, testFailure.stderr || testFailure.stdout);
    assert.equal(readFileSync(testTarget, 'utf8'), defaultTarget);
    console.log('Windows build.cmd tests passed (check, default/absolute/relative output, PBMCP_EXE, compiler/index/test failures)');
  }
} finally {
  assert.ok(basename(scratch).startsWith('pbmcp-build-') && dirname(scratch) === tempRoot);
  rmSync(scratch, { recursive: true, force: true });
}
