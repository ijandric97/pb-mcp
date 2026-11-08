import assert from 'node:assert/strict';
import { dribble } from './dribble.mjs';

const input = Buffer.from('日本語🚀\r\n'.repeat(100));
const echoed = await dribble(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], input);
assert.equal(echoed.status, 0, echoed.error);
assert.deepEqual(echoed.stdout, input);
const earlyExit = await dribble(process.execPath, ['-e', 'process.exit(7)'], Buffer.alloc(100000));
assert.notEqual(earlyExit.status, 0);
const closedPipe = await dribble(process.execPath,
  ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(7), 1000)'], Buffer.alloc(100000));
assert.match(closedPipe.error, /EPIPE|EOF|ECONNRESET/);
const missing = await dribble(process.execPath + '-missing', [], input);
assert.match(missing.error, /ENOENT/);
const timeout = await dribble(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'], input, { timeoutMs: 150 });
assert.match(timeout.error, /timed out/);
assert.notEqual(timeout.status, 0);
console.log('stdio lifecycle tests passed (UTF-8, early exit/EPIPE, spawn failure, timeout)');
