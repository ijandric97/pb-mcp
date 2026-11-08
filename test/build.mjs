import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const git = args => {
    const result = run('git', args, { cwd: scratch, env: { ...process.env,
      GIT_AUTHOR_NAME: 'build test', GIT_AUTHOR_EMAIL: 'build@example.invalid',
      GIT_COMMITTER_NAME: 'build test', GIT_COMMITTER_EMAIL: 'build@example.invalid' } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
  };
  mkdirSync(join(scratch, 'tools'), { recursive: true });
  mkdirSync(join(scratch, 'src'));
  mkdirSync(join(scratch, 'test'));
  mkdirSync(join(scratch, 'bin'));
  mkdirSync(join(scratch, 'compiler', 'compilers'), { recursive: true });
  writeFileSync(join(scratch, 'build.sh'), readFileSync(join(root, 'build.sh')));
  writeFileSync(join(scratch, 'tools', 'lint_encoding.mjs'), '');
  writeFileSync(join(scratch, 'tools', 'build-local-index.mjs'), '');
  writeFileSync(join(scratch, 'test', 'run_tests.mjs'), '');
  const testTargetLog = join(scratch, 'test-target.txt');
  const defaultTargetLog = join(scratch, 'default-target.txt');
  writeFileSync(join(scratch, 'src', 'main.pb'), '\uFEFFEnableExplicit\n');
  writeFileSync(join(scratch, 'src', 'pbdocs-index.json'), 'embedded index before build\n');
  const nodeStub = join(scratch, 'bin', 'node');
  writeFileSync(nodeStub, [
    '#!/bin/bash',
    'case "$1" in',
    '  tools/lint_encoding.mjs) exit 0 ;;',
    '  tools/build-local-index.mjs) printf "regenerated index\\n" > src/pbdocs-index.json; exit 0 ;;',
    '  test/run_tests.mjs) printf "%s" "$PBMCP_EXE" > "$FAKE_TEST_TARGET"; printf "%s/pbmcp" "$PWD" > "$FAKE_DEFAULT_TARGET"; exit "${FAKE_TEST_STATUS:-0}" ;;',
    '  *) exit 9 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const compiler = join(scratch, 'compiler', 'compilers', 'pbcompiler');
  const constantFile = join(scratch, 'constant.txt');
  writeFileSync(compiler, [
    '#!/bin/bash',
    'out=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --constant) printf "%s" "$2" > "$FAKE_CONSTANT"; shift 2 ;;',
    '    --output) out="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'printf "fake executable\\n" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 });
  const inheritedOut = join(scratch, 'inherited output sentinel');
  writeFileSync(inheritedOut, 'keep this file\n');
  const gitProbe = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (gitProbe.error || gitProbe.status !== 0) {
    console.log('build regression skipped: git unavailable');
  } else {
    mkdirSync(join(scratch, 'empty-hooks'));
    git(['init', '-q']);
    git(['add', '.']);
    git(['-c', `core.hooksPath=${join(scratch, 'empty-hooks')}`, '-c', 'commit.gpgsign=false',
      'commit', '-qm', 'clean fixture']);
    const revision = git(['rev-parse', '--short', 'HEAD']);
    const bash = win ? (process.env.PBMCP_BASH || 'C:\\Program Files\\Git\\usr\\bin\\bash.exe') : 'bash';
    const originalOut = process.env.PBMCP_OUT;
    process.env.PBMCP_OUT = inheritedOut;
    const env = { ...process.env, PATH: `${join(scratch, 'bin')}${win ? ';' : ':'}${process.env.PATH}`,
        PUREBASIC_HOME: join(scratch, 'compiler'), FAKE_CONSTANT: constantFile,
        FAKE_TEST_TARGET: testTargetLog, FAKE_DEFAULT_TARGET: defaultTargetLog,
        PBMCP_OUT: '', PBMCP_EXE: '' };
    if (originalOut === undefined) delete process.env.PBMCP_OUT;
    else process.env.PBMCP_OUT = originalOut;
    const build = (args, extra = {}) => run(bash, [join(scratch, 'build.sh'), ...args], { cwd: scratch,
      timeout: 15000, env: { ...env, ...extra } });
    const result = build([]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(constantFile, 'utf8'), `PBMCP_REVISION$=${revision}-dirty`);
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
    console.log('build tests passed (dirty revision, acceptance test target/default and override, failure propagation)');
  }
} finally {
  assert.ok(basename(scratch).startsWith('pbmcp-build-') && dirname(scratch) === tempRoot);
  rmSync(scratch, { recursive: true, force: true });
}
