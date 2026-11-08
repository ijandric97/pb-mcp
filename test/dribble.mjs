import { spawn } from 'node:child_process';

// Byte-sized writes deliberately split UTF-8 characters across stdin chunks.
export function dribble(command, args, input, { env, cwd, timeoutMs = 30000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let error = '', offset = 0;
    function stop(reason) {
      if (error) return;
      error = String(reason.message || reason);
      clearInterval(interval);
      child.stdin.destroy();
      child.kill('SIGKILL');
    }
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', stop);
    child.stdin.on('error', stop);
    const timer = setTimeout(() => stop(`session timed out after ${timeoutMs} ms`), timeoutMs);
    const interval = setInterval(() => {
      for (let j = 0; j < 10 && offset < input.length; j++, offset += 7) {
        child.stdin.write(input.subarray(offset, offset + 7));
      }
      if (offset >= input.length) {
        clearInterval(interval);
        child.stdin.end();
      }
    }, 1);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      clearInterval(interval);
      resolve({ status, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'), error });
    });
  });
}
