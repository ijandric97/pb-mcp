import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const crawler = join(root, 'tools', 'fetch-online-docs.mjs');
const tempRoot = resolve(tmpdir());
const scratch = resolve(mkdtempSync(join(tempRoot, 'pbmcp-crawler-')));
const scratchRelative = relative(tempRoot, scratch);
const scratchInsideTemp = scratchRelative !== '' && !scratchRelative.startsWith('..') && !isAbsolute(scratchRelative);
let mode = 'missing';
let transientAttempts = 0;
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/') {
    const ref = mode === 'server' ? 'broken' : mode === 'transient' ? 'transient' : mode === 'reset' ? 'reset' : 'gone';
    res.end(`<a href="reference/${ref}.html">ref</a><a href="reference/ok.html">ok</a>`);
  } else if (path === '/reference/commandindex.html') {
    res.end('<a href="../lib/cmd.html">command</a>');
  } else if (path === '/reference/gone.html') {
    res.writeHead(mode === 'missing410' ? 410 : 404).end('missing');
  } else if (path === '/reference/broken.html') {
    res.writeHead(503).end('unavailable');
  } else if (path === '/reference/reset.html') {
    req.socket.destroy();
  } else if (path === '/reference/transient.html') {
    if (++transientAttempts === 1) res.writeHead(503).end('try again');
    else res.end('<html>recovered</html>');
  } else if (path === '/reference/ok.html') {
    res.end('<html>ok</html>');
  } else if (path === '/lib/cmd.html' && mode === 'command-failure') {
    res.writeHead(500).end('broken');
  } else if (path === '/lib/cmd.html') {
    res.end('<html>command</html>');
  } else {
    res.writeHead(404).end('not found');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

function crawl(dir, nodeArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, crawler, dir, '--base', base], { cwd: root, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    let settled = false;
    let timer;
    const finish = callback => (...args) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(...args);
    };
    child.on('error', finish(reject));
    child.on('close', finish((code, signal) => resolve({ code, signal, stdout, stderr })));
    timer = setTimeout(() => {
      child.kill();
      finish(reject)(new Error('crawler timed out'));
    }, 15000);
  });
}

try {
  for (const unsafe of [root, resolve(root, '..'), resolve(root, '../../..'), join(root, 'tools')]) {
    const result = await crawl(unsafe);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /Refusing to replace/);
  }
  const tolerated = join(scratch, 'tolerated');
  mkdirSync(join(tolerated, 'reference'), { recursive: true });
  mkdirSync(join(tolerated, 'oldlib'), { recursive: true });
  writeFileSync(join(tolerated, 'reference', 'gone.html'), 'stale page');
  writeFileSync(join(tolerated, 'oldlib', 'removed.html'), 'obsolete command');
  writeFileSync(join(tolerated, 'manifest.json'), '{"stale":true}');
  const ok = await crawl(tolerated);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(readFileSync(join(tolerated, 'manifest.json'), 'utf8')).kind, 'online');
  assert.equal(existsSync(join(tolerated, 'reference', 'gone.html')), false, 'stale copy of a 404 page remains');
  assert.equal(existsSync(join(tolerated, 'oldlib', 'removed.html')), false, 'obsolete command page remains after refresh');

  mode = 'missing410';
  const gone410 = join(scratch, 'gone-410');
  mkdirSync(join(gone410, 'reference'), { recursive: true });
  writeFileSync(join(gone410, 'reference', 'gone.html'), 'stale page');
  const tolerated410 = await crawl(gone410);
  assert.equal(tolerated410.code, 0, tolerated410.stderr);
  assert.equal(existsSync(join(gone410, 'reference', 'gone.html')), false, 'stale copy of a 410 page remains');

  mode = 'transient';
  const recovered = await crawl(join(scratch, 'transient-retry'));
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(transientAttempts, 2, 'transient HTTP 503 was not retried exactly once');

  mode = 'server';
  const failed = join(scratch, 'server-failure');
  mkdirSync(failed, { recursive: true });
  writeFileSync(join(failed, 'manifest.json'), '{"stale":true}');
  writeFileSync(join(failed, 'previous.html'), 'previous mirror');
  const serverError = await crawl(failed);
  assert.equal(serverError.code, 1, serverError.stderr);
  assert.match(serverError.stderr, /FAILED 1 reference page\(s\)/);
  assert.match(serverError.stderr, /reference\/broken\.html: HTTP 503/);
  assert.equal(readFileSync(join(failed, 'manifest.json'), 'utf8'), '{"stale":true}', 'failed refresh changed the old manifest');
  assert.equal(readFileSync(join(failed, 'previous.html'), 'utf8'), 'previous mirror', 'failed refresh changed the old mirror');

  mode = 'reset';
  const resetDir = join(scratch, 'connection-reset');
  mkdirSync(resetDir, { recursive: true });
  writeFileSync(join(resetDir, 'manifest.json'), '{"stale":true}');
  const resetError = await crawl(resetDir);
  assert.equal(resetError.code, 1, resetError.stderr);
  assert.match(resetError.stderr, /FAILED 1 reference page\(s\)/);
  assert.match(resetError.stderr, /reference\/reset\.html: fetch failed/);
  assert.equal(readFileSync(join(resetDir, 'manifest.json'), 'utf8'), '{"stale":true}', 'network failure changed the old manifest');

  mode = 'command-failure';
  const commandFailure = join(scratch, 'command-failure');
  mkdirSync(commandFailure, { recursive: true });
  writeFileSync(join(commandFailure, 'manifest.json'), '{"kind":"previous"}');
  writeFileSync(join(commandFailure, 'previous.html'), 'previous mirror');
  const commandError = await crawl(commandFailure);
  assert.equal(commandError.code, 1, commandError.stderr);
  assert.match(commandError.stderr, /FAILED 1 page\(s\):/);
  assert.match(commandError.stderr, /lib\/cmd\.html: HTTP 500/);
  assert.equal(readFileSync(join(commandFailure, 'manifest.json'), 'utf8'), '{"kind":"previous"}', 'failed command refresh changed the old manifest');
  assert.equal(readFileSync(join(commandFailure, 'previous.html'), 'utf8'), 'previous mirror', 'failed command refresh changed the old mirror');
  mode = 'missing';
  for (const failRestore of [false, true]) {
    const target = join(scratch, failRestore ? 'rollback-failure' : 'publish-failure');
    mkdirSync(target);
    writeFileSync(join(target, 'previous.html'), 'previous mirror');
    const fault = join(scratch, 'rename-failure.cjs');
    writeFileSync(fault, `const fs = require('node:fs');
const path = require('node:path');
const rename = fs.renameSync;
const target = ${JSON.stringify(target)};
fs.renameSync = function(from, to) {
  if (path.resolve(to) === target && (${failRestore} || !String(from).endsWith('.previous')))
    throw new Error('simulated publication failure');
  return rename.call(this, from, to);
};
require('node:module').syncBuiltinESMExports();
`);
    const failedPublish = await crawl(target, ['--require', fault]);
    assert.equal(failedPublish.code, 1, failedPublish.stderr);
    assert.match(failedPublish.stderr, /simulated publication failure/);
    const backups = readdirSync(scratch).filter(name => name.startsWith('.' + basename(target) + '-') && name.endsWith('.previous'));
    if (failRestore) {
      assert.equal(backups.length, 1, 'failed rollback lost the backup');
      assert.equal(readFileSync(join(scratch, backups[0], 'previous.html'), 'utf8'), 'previous mirror');
      assert.match(failedPublish.stderr, /Previous mirror remains at/);
    } else {
      assert.deepEqual(backups, []);
      assert.equal(readFileSync(join(target, 'previous.html'), 'utf8'), 'previous mirror', 'failed publication did not restore the old mirror');
    }
  }
  console.log('crawler tests passed (404/410, retries, failed-refresh preservation, stale-page cleanup)');
} finally {
  await new Promise(resolve => server.close(resolve));
  assert.ok(scratchInsideTemp, `refusing recursive cleanup outside tmpdir: ${scratch}`);
  rmSync(scratch, { recursive: true, force: true });
}
