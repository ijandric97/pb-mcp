import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './scratch.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
makeScratch('protocol-isolation');
const protocol = join(root, 'test', 'protocol.mjs');

function run(label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [protocol], { cwd: root, env: process.env,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => child.kill(), 45000);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ label, code, signal, stdout, stderr });
    });
  });
}

const results = await Promise.all([run('first'), run('second')]);
for (const result of results) {
  assert.equal(result.code, 0, `${result.label} protocol suite failed (${result.signal}): ${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /protocol tests passed/);
}
console.log('protocol isolation passed (two concurrent protocol suites)');
