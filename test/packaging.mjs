import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tempRoot = join(root, 'tmp');
mkdirSync(tempRoot, { recursive: true });
const scratch = mkdtempSync(join(tempRoot, 'packaging-'));
assert.equal(dirname(scratch), tempRoot);
const win = process.platform === 'win32';
const script = join(scratch, win ? 'make-dist.cmd' : 'make-dist.sh');
const dist = join(scratch, 'dist');

function snapshot(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name);
    const relative = join(prefix, entry.name);
    return entry.isDirectory() ? snapshot(path, relative) : [[relative, readFileSync(path).toString('hex')]];
  });
}

function run(overrides = {}) {
  const cmd = win ? (process.env.ComSpec || 'cmd.exe') : 'bash';
  const args = win ? ['/d', '/c', script] : [script];
  const result = spawnSync(cmd, args, { cwd: scratch, encoding: 'utf8', timeout: 30000,
    windowsHide: true, env: { ...process.env, PBMCP_NODE_EXE: process.execPath, ...overrides } });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function setPreviousDist() {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'previous.txt'), 'old bundle');
  writeFileSync(join(dist, 'old-extra.txt'), 'preserve me');
  writeFileSync(join(dist, 'pbmcp.exe'), 'previous binary');
  writeFileSync(join(dist, 'index.json'), 'previous index');
  writeFileSync(join(dist, 'README.md'), 'previous readme');
  return snapshot(dist);
}

function assertNoStaging(detail = '') {
  const leftovers = readdirSync(scratch).filter(name => name.startsWith('.dist-stage-') || name.startsWith('.dist-stage.'));
  assert.deepEqual(leftovers, [], `staging directories remain: ${leftovers.join(', ')}`);
  const lock = join(scratch, '.dist-publish.lock');
  assert.equal(existsSync(lock), false, `publish lock was not released${detail ? `\n${detail}` : ''}`);
}

try {
  copyFileSync(join(root, win ? 'make-dist.cmd' : 'make-dist.sh'), script);
  mkdirSync(join(scratch, 'src'), { recursive: true });
  mkdirSync(join(scratch, 'test'), { recursive: true });
  writeFileSync(join(scratch, 'test', 'package_docs.mjs'),
    'if (process.env.FAIL_DOCS === "1") process.exit(1);\n' +
    'if (process.argv[2] !== process.env.PBMCP_OUT) throw new Error("staged docs executable was not selected");\n');
  writeFileSync(join(scratch, 'test', 'run_tests.mjs'),
    'if (process.env.FAIL_TESTS === "1") process.exit(1);\n' +
    'if (!process.env.PBMCP_EXE) throw new Error("staged executable was not selected");\n');
  mkdirSync(join(scratch, 'skills', 'purebasic', 'references'), { recursive: true });
  writeFileSync(join(scratch, 'README.md'), 'readme');
  writeFileSync(join(scratch, 'INSTALL.md'), 'install');
  writeFileSync(join(scratch, 'LICENSE'), 'license');
  writeFileSync(join(scratch, 'src', 'pbdocs-index.json'), '{"commands":[]}');
  writeFileSync(join(scratch, 'packaged-index.json'), '{"commands":[]}');
  writeFileSync(join(scratch, 'skills', 'purebasic', 'SKILL.md'), 'skill');
  writeFileSync(join(scratch, 'skills', 'purebasic', 'references', 'guide.md'), 'guide');
  writeFileSync(join(scratch, 'version'), 'process.exit(0);\n');
  writeFileSync(join(scratch, 'hold.js'), 'setInterval(() => {}, 1000);\n');

  if (win) {
    writeFileSync(join(scratch, 'build.cmd'), [
      '@echo off',
      'if "%FAIL_BUILD%"=="1" exit /b 1',
      'copy /y "%~dp0packaged-index.json" "%PBMCP_INDEX_OUT%" >nul || exit /b 1',
      String.raw`>"%~dp0src\pbdocs-index.json" echo changed by another build`,
      'if "%FAIL_SMOKE%"=="1" (echo invalid>"%PBMCP_OUT%") else (copy /y "%PBMCP_NODE_EXE%" "%PBMCP_OUT%" >nul)',
      'exit /b 0',
      '',
    ].join('\r\n'));
  } else {
    writeFileSync(join(scratch, 'build.sh'), [
      '#!/bin/bash',
      'if [ "${FAIL_BUILD:-0}" = 1 ]; then exit 1; fi',
      'cp packaged-index.json "$PBMCP_INDEX_OUT" || exit 1',
      'printf "changed by another build" > src/pbdocs-index.json',
      'if [ "${FAIL_SMOKE:-0}" = 1 ]; then printf invalid > "$PBMCP_OUT"; else cp "$PBMCP_NODE_EXE" "$PBMCP_OUT" && chmod +x "$PBMCP_OUT"; fi',
      '',
    ].join('\n'), { mode: 0o755 });
  }

  let previous = setPreviousDist();
  const sourceBeforeLock = readFileSync(join(scratch, 'src', 'pbdocs-index.json'), 'utf8');
  mkdirSync(join(scratch, '.dist-publish.lock'));
  let result = run({ FAIL_BUILD: '1' });
  assert.notEqual(result.status, 0, 'publisher ignored an existing lock');
  assert.ok((result.stdout + result.stderr).includes('publish lock exists'), 'lock rejection was not explained');
  assert.deepEqual(snapshot(dist), previous, 'lock rejection changed the previous bundle');
  assert.equal(readFileSync(join(scratch, 'src', 'pbdocs-index.json'), 'utf8'), sourceBeforeLock,
    'lock rejection entered the build');
  assert.equal(readdirSync(scratch).some(name => name.startsWith('.dist-stage')), false,
    'lock rejection created a staging directory');
  assert.equal(existsSync(join(scratch, '.dist-publish.lock')), true, 'rejected publisher removed another publisher’s lock');
  rmSync(join(scratch, '.dist-publish.lock'), { recursive: true });

  previous = setPreviousDist();
  result = run({ FAIL_BUILD: '1' });
  assert.notEqual(result.status, 0, 'build failure unexpectedly succeeded');
  assert.deepEqual(snapshot(dist), previous, 'build failure changed the previous bundle');
  assertNoStaging(`${result.stdout}\n${result.stderr}`);

  for (const name of ['INSTALL.md', 'LICENSE']) {
    previous = setPreviousDist();
    const file = join(scratch, name), contents = readFileSync(file);
    rmSync(file);
    result = run();
    writeFileSync(file, contents);
    assert.notEqual(result.status, 0, `${name} copy failure unexpectedly succeeded`);
    assert.deepEqual(snapshot(dist), previous, 'copy failure changed the previous bundle');
    assertNoStaging();
  }

  previous = setPreviousDist();
  result = run({ FAIL_SMOKE: '1' });
  assert.notEqual(result.status, 0, 'smoke failure unexpectedly succeeded');
  assert.deepEqual(snapshot(dist), previous, 'smoke failure changed the previous bundle');
  assertNoStaging();

  previous = setPreviousDist();
  result = run({ FAIL_DOCS: '1' });
  assert.notEqual(result.status, 0, 'packaged docs failure unexpectedly succeeded');
  assert.deepEqual(snapshot(dist), previous, 'packaged docs failure changed the previous bundle');
  assertNoStaging();

  previous = setPreviousDist();
  result = run({ FAIL_TESTS: '1' });
  assert.notEqual(result.status, 0, 'test failure unexpectedly succeeded');
  assert.deepEqual(snapshot(dist), previous, 'test failure changed the previous bundle');
  assertNoStaging();

  previous = setPreviousDist();
  result = run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(existsSync(join(dist, 'previous.txt')), false, 'successful publish kept stale files');
  assert.equal(readFileSync(join(dist, 'README.md'), 'utf8'), 'readme');
  assert.equal(readFileSync(join(dist, 'LICENSE'), 'utf8'), 'license');
  assert.equal(readFileSync(join(dist, 'index.json'), 'utf8'), '{"commands":[]}');
  assert.equal(readFileSync(join(dist, 'skills', 'purebasic', 'references', 'guide.md'), 'utf8'), 'guide');
  assertNoStaging();

  // Replace only the copied script's move commands, leaving its recovery logic intact.
  const moveProbe = join(scratch, win ? 'move-probe.cmd' : 'move-probe.sh');
  writeFileSync(moveProbe, win ? [
    '@echo off',
    'set /p moveCount=<"%~dp0move-count"',
    'set /a moveCount+=1',
    '>"%~dp0move-count" echo %moveCount%',
    'if "%FAIL_MOVE%"=="%moveCount%" exit /b 1',
    'if "%FAIL_RESTORE%"=="1" if %moveCount% GTR 1 exit /b 1',
    'move %*',
    'exit /b %errorlevel%',
    '',
  ].join('\r\n') : [
    '#!/bin/bash',
    'read -r count < "$PWD/move-count"',
    'count=$((count + 1))',
    'echo "$count" > "$PWD/move-count"',
    'if [ "${FAIL_MOVE:-0}" = "$count" ]; then exit 1; fi',
    'if [ "${FAIL_RESTORE:-0}" = 1 ] && [ "$count" -gt 1 ]; then exit 1; fi',
    'exec mv -- "$@"',
    '',
  ].join('\n'));
  const originalScript = readFileSync(script, 'utf8');
  writeFileSync(script, win
    ? originalScript.replace(/\bmove (?=")/g, 'call "%~dp0move-probe.cmd" ')
    : originalScript.replace(/\bmv -- /g, 'bash "$PWD/move-probe.sh" '));
  for (const [failMove, failRestore] of [[1, false], [2, false], [2, true]]) {
    previous = setPreviousDist();
    writeFileSync(join(scratch, 'move-count'), '0\n');
    result = run({ FAIL_MOVE: String(failMove), FAIL_RESTORE: failRestore ? '1' : '0' });
    assert.notEqual(result.status, 0, 'move failure unexpectedly succeeded');
    if (failRestore) {
      assert.equal(existsSync(dist), false);
      const backups = readdirSync(scratch).filter(name => name.startsWith('.dist-stage') && name.endsWith('.old'));
      assert.equal(backups.length, 1, 'failed restoration lost the previous bundle');
      const backup = join(scratch, backups[0]);
      assert.deepEqual(snapshot(backup), previous);
      assert.ok((result.stdout + result.stderr).includes(backup), 'backup location was not reported');
      renameSync(backup, dist);
    } else assert.deepEqual(snapshot(dist), previous, 'move failure damaged the previous bundle');
    assertNoStaging();
  }
  writeFileSync(script, originalScript);

  if (!win) {
    previous = setPreviousDist();
    writeFileSync(join(scratch, 'signal-count'), '0\n');
    const signalProbe = join(scratch, 'signal-probe.sh');
    writeFileSync(signalProbe, [
      '#!/bin/bash',
      'read -r count < "$PWD/signal-count"',
      'count=$((count + 1))',
      'echo "$count" > "$PWD/signal-count"',
      'if [ "$count" = 2 ]; then kill -TERM "$PPID"; exit 0; fi',
      'exec mv -- "$@"',
      '',
    ].join('\n'));
    writeFileSync(script, originalScript.replace(/\bmv -- /g, 'bash "$PWD/signal-probe.sh" '));
    result = run();
    assert.equal(result.status, 143, `TERM status: ${result.status}; ${result.stderr || result.stdout}`);
    assert.deepEqual(snapshot(dist), previous, 'TERM after backup rename failed to restore the previous bundle');
    assertNoStaging();
    writeFileSync(script, originalScript);
  }

  if (win) {
    // Recover the previous bundle left by a hard interruption after its rename.
    const partial = join(scratch, '.dist-stage-partial.old');
    mkdirSync(partial);
    writeFileSync(join(partial, 'pbmcp.exe'), 'locked-image fixture');
    rmSync(dist, { recursive: true });
    result = run({ FAIL_BUILD: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(dist), false, 'partial backup was restored as a complete bundle');
    assert.ok(existsSync(join(partial, 'pbmcp.exe')), 'partial backup was deleted');
    rmSync(partial, { recursive: true });

    previous = setPreviousDist();
    const recovery = join(scratch, '.dist-stage-interrupted.old');
    renameSync(dist, recovery);
    result = run({ FAIL_BUILD: '1' });
    assert.notEqual(result.status, 0, 'recovery fixture build unexpectedly succeeded');
    assert.deepEqual(snapshot(dist), previous, 'next run did not recover the previous bundle');
    assertNoStaging();

    // A running executable can prevent Windows from renaming the old dist directory.
    setPreviousDist();
    copyFileSync(process.execPath, join(dist, 'pbmcp.exe'));
    previous = snapshot(dist);
    const old = spawn(join(dist, 'pbmcp.exe'), ['hold.js'], { cwd: scratch, windowsHide: true,
      stdio: 'ignore' });
    const closed = new Promise((resolve, reject) => { old.once('close', resolve); old.once('error', reject); });
    try {
      await new Promise((resolve, reject) => { old.once('spawn', resolve); old.once('error', reject); });
      result = run();
      if (result.status !== 0) assert.deepEqual(snapshot(dist), previous, 'locked-exe failure damaged the old bundle');
      else {
        assert.ok(existsSync(join(dist, 'README.md')), 'successful locked-exe publish is incomplete');
        for (const name of readdirSync(scratch).filter(name => name.startsWith('.dist-stage-') && name.endsWith('.old'))) {
          assert.ok(result.stdout.includes(join(scratch, name)), 'retained locked executable was not reported');
        }
      }
    } finally {
      old.kill();
      await closed;
    }
  }

  console.log(`packaging tests passed (${win ? 'make-dist.cmd' : 'make-dist.sh'}: build/copy/smoke/docs/test/move/publish/restore failures, successful replacement${win ? ', locked executable' : ''})`);
} finally {
  const resolved = join(tempRoot, scratch.slice(tempRoot.length + 1));
  if (dirname(resolved) !== tempRoot) throw new Error(`unsafe cleanup target: ${resolved}`);
  rmSync(resolved, { recursive: true, force: true });
}
