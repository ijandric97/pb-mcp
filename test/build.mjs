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
  mkdirSync(join(scratch, 'bin'));
  mkdirSync(join(scratch, 'compiler', 'compilers'), { recursive: true });
  writeFileSync(join(scratch, 'build.sh'), readFileSync(join(root, 'build.sh')));
  writeFileSync(join(scratch, 'tools', 'lint_encoding.mjs'), '');
  writeFileSync(join(scratch, 'tools', 'build-local-index.mjs'), '');
  writeFileSync(join(scratch, 'src', 'main.pb'), '\uFEFFEnableExplicit\n');
  writeFileSync(join(scratch, 'src', 'pbdocs-index.json'), 'embedded index before build\n');
  const nodeStub = join(scratch, 'bin', 'node');
  writeFileSync(nodeStub, [
    '#!/bin/bash',
    'case "$1" in',
    '  tools/lint_encoding.mjs) exit 0 ;;',
    '  tools/build-local-index.mjs) printf "regenerated index\\n" > src/pbdocs-index.json; exit 0 ;;',
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
    const result = run(bash, [join(scratch, 'build.sh')], { cwd: scratch, timeout: 15000,
      env: { ...process.env, PATH: `${join(scratch, 'bin')}${win ? ';' : ':'}${process.env.PATH}`,
        PUREBASIC_HOME: join(scratch, 'compiler'), FAKE_CONSTANT: constantFile } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(readFileSync(constantFile, 'utf8'), `PBMCP_REVISION$=${revision}-dirty`);
    assert.equal(readFileSync(join(scratch, 'pbmcp'), 'utf8'), 'fake executable\n');
    console.log('build tests passed (index regeneration marks the source build dirty)');
  }
} finally {
  assert.ok(basename(scratch).startsWith('pbmcp-build-') && dirname(scratch) === tempRoot);
  rmSync(scratch, { recursive: true, force: true });
}
