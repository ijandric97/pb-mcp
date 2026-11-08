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
  return snapshot(dist);
}

function assertNoStaging() {
  const leftovers = readdirSync(scratch).filter(name => name.startsWith('.dist-stage-') || name.startsWith('.dist-stage.'));
  assert.deepEqual(leftovers, [], `staging directories remain: ${leftovers.join(', ')}`);
}

try {
  copyFileSync(join(root, win ? 'make-dist.cmd' : 'make-dist.sh'), script);
  mkdirSync(join(scratch, 'src'), { recursive: true });
  mkdirSync(join(scratch, 'test'), { recursive: true });
  writeFileSync(join(scratch, 'test', 'run_tests.mjs'),
    'if (process.env.FAIL_TESTS === "1") process.exit(1);\n' +
    'if (!process.env.PBMCP_EXE) throw new Error("staged executable was not selected");\n');
  mkdirSync(join(scratch, 'skills', 'purebasic', 'references'), { recursive: true });
  writeFileSync(join(scratch, 'README.md'), 'readme');
  writeFileSync(join(scratch, 'INSTALL.md'), 'install');
  writeFileSync(join(scratch, 'src', 'pbdocs-index.json'), '{"commands":[]}');
  writeFileSync(join(scratch, 'skills', 'purebasic', 'SKILL.md'), 'skill');
  writeFileSync(join(scratch, 'skills', 'purebasic', 'references', 'guide.md'), 'guide');
  writeFileSync(join(scratch, 'version'), 'process.exit(0);\n');
  writeFileSync(join(scratch, 'hold.js'), 'setInterval(() => {}, 1000);\n');

  if (win) {
    writeFileSync(join(scratch, 'build.cmd'), [
      '@echo off',
      'if "%FAIL_BUILD%"=="1" exit /b 1',
      'if "%FAIL_SMOKE%"=="1" (echo invalid>"%PBMCP_OUT%") else (copy /y "%PBMCP_NODE_EXE%" "%PBMCP_OUT%" >nul)',
      'exit /b 0',
      '',
    ].join('\r\n'));
  } else {
    writeFileSync(join(scratch, 'build.sh'), [
      '#!/bin/bash',
      'if [ "${FAIL_BUILD:-0}" = 1 ]; then exit 1; fi',
      'if [ "${FAIL_SMOKE:-0}" = 1 ]; then printf invalid > "$PBMCP_OUT"; else cp "$PBMCP_NODE_EXE" "$PBMCP_OUT" && chmod +x "$PBMCP_OUT"; fi',
      '',
    ].join('\n'), { mode: 0o755 });
  }

  let previous = setPreviousDist();
  let result = run({ FAIL_BUILD: '1' });
  assert.notEqual(result.status, 0, 'build failure unexpectedly succeeded');
  assert.deepEqual(snapshot(dist), previous, 'build failure changed the previous bundle');
  assertNoStaging();

  previous = setPreviousDist();
  const install = readFileSync(join(scratch, 'INSTALL.md'));
  rmSync(join(scratch, 'INSTALL.md'));
  result = run();
  writeFileSync(join(scratch, 'INSTALL.md'), install);
  assert.notEqual(result.status, 0, 'copy failure unexpectedly succeeded');
  assert.deepEqual(snapshot(dist), previous, 'copy failure changed the previous bundle');
  assertNoStaging();

  previous = setPreviousDist();
  result = run({ FAIL_SMOKE: '1' });
  assert.notEqual(result.status, 0, 'smoke failure unexpectedly succeeded');
  assert.deepEqual(snapshot(dist), previous, 'smoke failure changed the previous bundle');
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

  if (win) {
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
      else assert.ok(existsSync(join(dist, 'README.md')), 'successful locked-exe publish is incomplete');
    } finally {
      old.kill();
      await closed;
    }
  }

  console.log(`packaging tests passed (${win ? 'make-dist.cmd' : 'make-dist.sh'}: build/copy/smoke/test/move/publish/restore failures, successful replacement${win ? ', locked executable' : ''})`);
} finally {
  const resolved = join(tempRoot, scratch.slice(tempRoot.length + 1));
  if (dirname(resolved) !== tempRoot) throw new Error(`unsafe cleanup target: ${resolved}`);
  rmSync(resolved, { recursive: true, force: true });
}
