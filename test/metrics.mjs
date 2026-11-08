import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = resolve(process.env.PBMCP_EXE || join(root, 'pbmcp' + (process.platform === 'win32' ? '.exe' : '')));
const source = join(root, 'test', 'fixtures', 'hello.pb');
const tempRoot = resolve(tmpdir());
const scratch = mkdtempSync(join(tempRoot, 'pbmcp-metrics-'));
try {
  for (const zone of ['Pacific/Kiritimati', 'America/Adak']) {
    const metrics = join(scratch, zone.replaceAll('/', '-') + '.jsonl');
    const env = { ...process.env, TZ: zone, PUREBASIC_MCP_NO_METRICS: '0',
      PUREBASIC_MCP_METRICS: metrics, PBMCP_DOCS_TIMING: '0', PBMCP_PRELOAD: '0',
      PUREBASIC_MCP_INDEX: join(root, 'test', 'fixtures', 'docs-index.json') };
    const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'pb_check', arguments: { file: source } } }) + '\n';
    const before = Date.now();
    const result = spawnSync(exe, [], { input: request, cwd: root, env, encoding: 'utf8',
      timeout: 15000, windowsHide: true });
    const after = Date.now();
    assert.equal(result.status, 0, result.stderr || String(result.error));
    assert.equal(JSON.parse(result.stdout).result.isError, false, result.stdout);
    const record = JSON.parse(readFileSync(metrics, 'utf8').trim());
    assert.match(record.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    const timestamp = Date.parse(record.ts);
    assert.ok(timestamp >= before - 30000 && timestamp <= after + 30000,
      `${zone}: timestamp ${record.ts} is not current UTC time`);
  }
} finally {
  assert.equal(dirname(scratch), tempRoot);
  assert.ok(basename(scratch).startsWith('pbmcp-metrics-'));
  rmSync(scratch, { recursive: true, force: true });
}
console.log('metrics UTC timestamps passed across time zones');
