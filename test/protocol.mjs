import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeScratch } from './scratch.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = resolve(process.env.PBMCP_EXE || join(root, 'pbmcp' + (process.platform === 'win32' ? '.exe' : '')));
const scratch = makeScratch('protocol');
const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '1', PBMCP_DOCS_TIMING: '0',
  PUREBASIC_MCP_INDEX: join(root, 'test', 'fixtures', 'docs-index.json') };
const request = (id, method = 'ping', params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const initParams = { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'protocol-test', version: '0' } };
function session(messages, fileMode = false) {
  return rawSession(messages.map(JSON.stringify).join('\n') + '\n', fileMode);
}
function rawSession(input, fileMode = false) {
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

// Raw JSON preserves integer boundaries that JavaScript Number would round.
for (const [id, expected] of [
  ['9223372036854775807', '9223372036854775807'], ['-9223372036854775808', '-9223372036854775808'],
  ['9007199254740993', '9007199254740993'], ['9007199254740993.0', '9007199254740993'],
  ['9007199254740993e0', '9007199254740993'], ['92233720368547758070e-1', '9223372036854775807'],
  ['-9.223372036854775808e18', '-9223372036854775808'], ['1.0', '1'], ['1e3', '1000'],
  ['100e-2', '1'], ['0.1e1', '1'], ['0e9999999999999999999999', '0'],
  ['1e+' + '0'.repeat(1000) + '2', '100'],
  ...['9223372036854775808', '-9223372036854775809', '18446744073709551616', '-18446744073709551616',
    '1e100', '9223372036854775808.0', '1.0000000000000001', '1e-5000',
    '1e9999999999999999999999', '-9223372036854775809e0'].map(id => [id, null]),
]) {
  const result = spawnSync(exe, [], { cwd: root, env, encoding: 'utf8', timeout: 5000, windowsHide: true,
    input: `{"jsonrpc":"2.0","id":${id},"method":"ping"}\n` + JSON.stringify(request('after-numeric-id')) + '\n' });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  const response = JSON.parse(lines[0]);
  if (expected !== null) {
    assert.deepEqual(response.result, {}, lines[0]);
    assert.equal(/"id":(-?\d+)/.exec(lines[0])?.[1], expected, 'numeric ID changed: ' + id);
  } else {
    assert.equal(response.id, null, lines[0]);
    assert.equal(response.error?.code, -32600, lines[0]);
  }
  assert.deepEqual(JSON.parse(lines[1]), { jsonrpc: '2.0', id: 'after-numeric-id', result: {} });
}
for (const fileMode of [false, true]) {
  const raw = [
    String.raw`{"jsonrpc":"2.0","\u0069d":5.0,"method":"ping"}`,
    String.raw`{"jsonrpc":"2.0","i\u0064":7e0,"method":"ping","params":{"id":1e100}}`,
    String.raw`{"jsonrpc":"2.0","\u0069\u0064":-7.0,"method":"ping"}`,
    '{"jsonrpc":"2.0","id":1.5,"id":8,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1.5,"id":"string-id","method":"ping"}',
  ];
  const replies = rawSession('[' + raw.join(',') + ']\n', fileMode)[0];
  assert.equal(replies.length, raw.length);
  assert.deepEqual(replies.map(r => r.result), raw.map(() => ({})));
  assert.deepEqual(replies.map(r => r.id), [5, 7, -7, 8, 'string-id']);
  const [mixed] = rawSession('[null,[],{"jsonrpc":"2.0","id":1.0000000000000001,"method":"ping"},' +
    '{"jsonrpc":"2.0","id":10e1,"method":"ping","params":{"id":1e100,"text":"id: 2e5"}}]\n', fileMode);
  assert.deepEqual(mixed.map(r => r.id), [null, null, null, 100]);
  assert.deepEqual(mixed.slice(0, 3).map(r => r.error.code), [-32600, -32600, -32600]);
  assert.deepEqual(mixed[3].result, {});
  assert.equal(rawSession('not-json 9223372036854775808\n', fileMode)[0].error.code, -32700);
}
for (const id of ['9223372036854775808', 'quote "9223372036854775808"', 'slash \\"9223372036854775808']) {
  assert.deepEqual(session([request(id)])[0], { jsonrpc: '2.0', id, result: {} });
}
assert.deepEqual(session([{ ...request('fraction-in-params'), params: { value: 0.12345678901234567890, exponent: 1e100 } }])[0],
  { jsonrpc: '2.0', id: 'fraction-in-params', result: {} });

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

const toolSchemas = session([request(1, 'tools/list')])[0].result.tools;
const validArgs = {
  pb_docs_search: { query: 'window', library: 'Window', limit: 2 },
  pb_command: { name: 'OpenWindow' },
  pb_check: { file: join(root, 'test', 'fixtures', 'hello.pb') },
  pb_run: { file: join(root, 'test', 'fixtures', 'hello.pb'), args: [], timeoutMs: 1000 },
  pb_version: {},
};
for (const tool of toolSchemas) {
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(validArgs[tool.name]).sort(), Object.keys(tool.inputSchema.properties).sort());
  for (const key of ['unexpected', 'libary', 'query|library', 'file|args', '', 'File', '__proto__']) {
    const [response, next] = session([
      request(1, 'tools/call', { name: tool.name, arguments: { ...validArgs[tool.name], [key]: true } }),
      request('after-unknown-argument'),
    ]);
    assert.equal(response.result?.isError, true, JSON.stringify(response));
    assert.ok(response.result.content[0].text.includes(`Invalid arguments for tool ${tool.name}: Unknown argument at ${key}`));
    assert.deepEqual(next, { jsonrpc: '2.0', id: 'after-unknown-argument', result: {} });
  }
}
assert.equal(session([request(1, 'tools/call', { name: 'missing', arguments: { unexpected: true } })])[0].error.message,
  'Tool missing not found');

const frameLimit = 1024 * 1024;
const ping = JSON.stringify(request('boundary'));
const padded = bytes => ping + ' '.repeat(bytes - Buffer.byteLength(ping));
for (const fileMode of [false, true]) for (const bytes of [frameLimit, frameLimit + 1, frameLimit * 3]) {
  const input = padded(bytes) + '\n' + JSON.stringify(request('after-large-frame')) + '\n';
  const [first, next, extra] = rawSession(input, fileMode);
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

// Count containers, not bracket characters in strings, and recover after rejection.
for (const fileMode of [false, true]) {
  for (const levels of [128, 129, 32770]) {
    const nested = '['.repeat(levels - 2) + '0' + ']'.repeat(levels - 2);
    const input = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"nested":' + nested + '}}\n';
    const [first, next] = rawSession(input + JSON.stringify(request('after-depth')) + '\n', fileMode);
    if (levels === 128) assert.deepEqual(first, { jsonrpc: '2.0', id: 1, result: {} });
    else {
      assert.equal(first.id, null);
      assert.equal(first.error.code, -32600);
      assert.match(first.error.message, /nesting exceeds 128/);
    }
    assert.deepEqual(next, { jsonrpc: '2.0', id: 'after-depth', result: {} });
  }
  const braces = '[]{}'.repeat(1000) + String.raw`\" [ } \\`;
  assert.deepEqual(session([request(braces)], fileMode)[0], { jsonrpc: '2.0', id: braces, result: {} });
  for (const invalid of [JSON.stringify(request(1)) + '\0garbage',
    '{"jsonrpc":"2.0","id":"nul\0value","method":"ping"}', '\0',
    JSON.stringify(request(1)) + ' '.repeat(65536) + '\0garbage']) {
    const [first, next, extra] = rawSession(invalid + '\n' + JSON.stringify(request('after-nul')) + '\n', fileMode);
    assert.equal(first.id, null);
    assert.equal(first.error.code, -32600);
    assert.match(first.error.message, /NUL/);
    assert.deepEqual(next, { jsonrpc: '2.0', id: 'after-nul', result: {} });
    assert.equal(extra, undefined);
    assert.equal(rawSession(invalid, fileMode)[0].error.code, -32600, 'unterminated NUL frame accepted');
  }
}
// Reject malformed Unicode before native JSON/string conversion and recover on the next frame.
for (const fileMode of [false, true]) {
  const invalidEscapes = [String.raw`\ud800`, String.raw`\udbff`, String.raw`\udc00`, String.raw`\udfff`,
    String.raw`\ud800x`, String.raw`\ud800\ud800`, String.raw`\udc00\ud800`,
    String.raw`\ud800\\udc00`, String.raw`\ud800\u0041`, String.raw`\uDBFF\uDFFF\uDC00`];
  const invalid = invalidEscapes.map(value => `{"jsonrpc":"2.0","id":"${value}","method":"ping"}`);
  invalid.push(String.raw`{"jsonrpc":"2.0","id":1,"method":"ping","params":{"\ud800":"value"}}`,
    String.raw`[{"jsonrpc":"2.0","id":1,"method":"ping","params":{"text":"\udfff"}}]`);
  const replies = rawSession(invalid.map(line => line + '\n' + JSON.stringify(request('after-surrogate'))).join('\n') + '\n', fileMode);
  assert.equal(replies.length, invalid.length * 2);
  for (let i = 0; i < replies.length; i += 2) {
    assert.equal(replies[i].id, null);
    assert.equal(replies[i].error?.code, -32600);
    assert.match(replies[i].error.message, /surrogate/i);
    assert.deepEqual(replies[i + 1], { jsonrpc: '2.0', id: 'after-surrogate', result: {} });
  }
  for (const [raw, id] of [[String.raw`\ud800\udc00`, '\u{10000}'], [String.raw`\uDBFF\uDFFF`, '\u{10ffff}'],
    [String.raw`\\ud800`, String.raw`\ud800`], [String.raw`\\\ud800\udc00`, '\\\u{10000}']]) {
    assert.deepEqual(rawSession(`{"jsonrpc":"2.0","id":"${raw}","method":"ping"}\n`, fileMode),
      [{ jsonrpc: '2.0', id, result: {} }]);
  }

  const malformed = [
    [0x80], [0xbf], [0xc0, 0xaf], [0xc1, 0xbf], [0xc2], [0xc2, 0x20],
    [0xe0, 0x9f, 0xbf], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf], [0xe1, 0x80],
    [0xf0, 0x8f, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf1, 0x80, 0x80],
    [0xf5, 0x80, 0x80, 0x80], [0xfe], [0xff],
  ];
  const prefix = Buffer.from('{"jsonrpc":"2.0","id":"');
  const suffix = Buffer.from('","method":"ping"}\n' + JSON.stringify(request('after-utf8')) + '\n');
  const frames = malformed.map(bytes => Buffer.concat([prefix, Buffer.from(bytes), suffix]));
  // The invalid continuation falls on the other side of the input chunk boundary.
  frames.push(Buffer.concat([Buffer.alloc(65536 - prefix.length - 1, 0x20), prefix, Buffer.from([0xe0, 0x80, 0x80]), suffix]));
  const utf8Replies = rawSession(Buffer.concat(frames), fileMode);
  assert.equal(utf8Replies.length, frames.length * 2);
  for (let i = 0; i < utf8Replies.length; i += 2) {
    assert.equal(utf8Replies[i].id, null);
    assert.equal(utf8Replies[i].error?.code, -32600);
    assert.match(utf8Replies[i].error.message, /UTF-8/);
    assert.deepEqual(utf8Replies[i + 1], { jsonrpc: '2.0', id: 'after-utf8', result: {} });
  }
  assert.match(rawSession(Buffer.concat([prefix, Buffer.from([0xf0, 0x90])]), fileMode)[0].error.message, /UTF-8/);
  const boundaryId = String.fromCodePoint(0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xffff, 0x10000, 0x10ffff);
  assert.deepEqual(session([request(boundaryId)], fileMode), [{ jsonrpc: '2.0', id: boundaryId, result: {} }]);
}
console.log('protocol tests passed (envelopes/calls, exact numeric IDs, Unicode/depth/NUL/frame limits and recovery, batch framing, notifications, execution hints, unknown tools/arguments)');
