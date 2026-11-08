import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = resolve(process.env.PBMCP_EXE || join(root, 'pbmcp' + (process.platform === 'win32' ? '.exe' : '')));
const scratch = join(root, 'test', 'out', 'protocol');
mkdirSync(scratch, { recursive: true });
const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '1', PBMCP_DOCS_TIMING: '0',
  PUREBASIC_MCP_INDEX: join(root, 'test', 'fixtures', 'docs-index.json') };
const request = (id, method = 'ping', params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const initParams = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'protocol-test', version: '0' } };
function session(messages, fileMode = false) {
  const input = messages.map(JSON.stringify).join('\n') + '\n';
  const file = join(scratch, 'session.jsonl');
  if (fileMode) writeFileSync(file, input);
  const result = spawnSync(exe, fileMode ? ['test', file] : [], {
    input: fileMode ? undefined : input, cwd: root, env, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}
const invalid = [
  [request(1, 'tools/call'), -32602, 1],
  ...[null, [], 3, 'bad'].map(params => [request(1, 'tools/call', params), -32602, 1]),
  ...[{}, { name: '' }, { name: 42 }].map(params => [request(1, 'tools/call', params), -32602, 1]),
  ...[null, [], 3, 'bad', true].map(args => [request(1, 'tools/call', { name: 'pb_version', arguments: args }), -32602, 1]),
  [{ id: 1, method: 'ping' }, -32600, 1],
  ...['1.0', null, 2].map(jsonrpc => [{ ...request(1), jsonrpc }, -32600, 1]),
  ...[null, true, {}, [], 1.5].map(id => [request(id), -32600, null]),
  [{ jsonrpc: '2.0', id: 1 }, -32600, 1],
  [request(1, 42), -32600, 1],
  ...[null, 42, 'bad', []].map(value => [value, -32600, null]),
];
for (const [message, code, id] of invalid) {
  const responses = session([message, request('still-alive')]);
  assert.equal(responses.length, 2, JSON.stringify(message));
  assert.equal(responses[0].error?.code, code, JSON.stringify(responses[0]));
  assert.equal(responses[0].id, id);
  assert.deepEqual(responses[1], { jsonrpc: '2.0', id: 'still-alive', result: {} });
}

const invalidInitialize = [
  request(1, 'initialize'),
  ...[null, [], 'bad'].map(params => request(1, 'initialize', params)),
  ...[
    {},
    { ...initParams, protocolVersion: 42 },
    { ...initParams, capabilities: null },
    { ...initParams, clientInfo: [] },
    { ...initParams, clientInfo: { version: '0' } },
    { ...initParams, clientInfo: { name: 'protocol-test' } },
  ].map(params => request(1, 'initialize', params)),
];
for (const message of invalidInitialize) {
  const [response, next] = session([message, request('still-alive')]);
  assert.equal(response.error?.code, -32602, JSON.stringify(response));
  assert.equal(response.id, 1);
  assert.deepEqual(next, { jsonrpc: '2.0', id: 'still-alive', result: {} });
}
const initialized = session([request(1, 'initialize', initParams)])[0];
assert.equal(initialized.result.protocolVersion, '2025-03-26');
assert.equal(initialized.result.serverInfo.name, 'purebasic-mcp-pb');

const batch = [request(0), { jsonrpc: '2.0', method: 'ping' }, null, [],
  { jsonrpc: '2.0', id: 9 }, request('工具🚀', 'tools/call', { name: 'missing' }), request('', 'tools/list')];
for (const fileMode of [false, true]) {
  const [responses, next] = session([batch, request(-1)], fileMode);
  assert.ok(Array.isArray(responses));
  assert.deepEqual(responses.map(r => r.id), [0, null, null, 9, '工具🚀', '']);
  assert.deepEqual(responses.slice(1, 4).map(r => r.error.code), [-32600, -32600, -32600]);
  assert.equal(responses[4].error.code, -32602);
  assert.equal(responses[4].error.message, 'Tool missing not found');
  assert.equal('result' in responses[4], false);
  const run = responses[5].result.tools.find(t => t.name === 'pb_run');
  assert.equal(run.annotations.destructiveHint, true);
  assert.equal(run.annotations.openWorldHint, true);
  assert.deepEqual(next, { jsonrpc: '2.0', id: -1, result: {} });
  assert.deepEqual(session([[{ jsonrpc: '2.0', method: 'ping' }], request(2)], fileMode),
    [{ jsonrpc: '2.0', id: 2, result: {} }]);
}
assert.equal(session([request(1, 'tools/call', { name: 'pb_version' })])[0].result.isError, false);
assert.equal(session([request(1, 'tools/call', { name: 'missing' })])[0].error.code, -32602);

const frameLimit = 1024 * 1024;
const ping = JSON.stringify(request('boundary'));
const padded = bytes => ping + ' '.repeat(bytes - Buffer.byteLength(ping));
for (const bytes of [frameLimit, frameLimit + 1, frameLimit * 3]) {
  const input = padded(bytes) + '\n' + JSON.stringify(request('after-large-frame')) + '\n';
  const result = spawnSync(exe, [], { input, cwd: root, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const [first, next, extra] = result.stdout.trim().split('\n').map(JSON.parse);
  if (bytes === frameLimit) assert.deepEqual(first, { jsonrpc: '2.0', id: 'boundary', result: {} });
  else {
    assert.equal(first.id, null);
    assert.equal(first.error.code, -32600);
    assert.match(first.error.message, /exceeds 1048576 bytes/);
  }
  assert.deepEqual(next, { jsonrpc: '2.0', id: 'after-large-frame', result: {} });
  assert.equal(extra, undefined, 'one oversized frame produced multiple errors');
}
const unfinished = spawnSync(exe, [], { input: padded(frameLimit * 3), cwd: root, env,
  encoding: 'utf8', timeout: 5000, windowsHide: true });
assert.equal(unfinished.status, 0, unfinished.stderr || String(unfinished.error));
assert.equal(unfinished.stdout.trim().split('\n').length, 1);
assert.equal(JSON.parse(unfinished.stdout).error.code, -32600);
console.log('protocol tests passed (invalid envelopes/calls, batch framing, notifications, execution hints, unknown tools)');
