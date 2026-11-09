import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

assert.ok(process.argv[2], 'Usage: node test/package_docs.mjs <packaged executable>');
const exe = resolve(process.argv[2]);
const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '1', PBMCP_PRELOAD: '0', PBMCP_DOCS_TIMING: '0' };
delete env.PUREBASIC_MCP_INDEX;
const input = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'package-docs-smoke', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  ...['pb_version', 'pb_command'].map((name, i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call',
    params: { name, arguments: i ? { name: 'OpenWindow' } : {} } })),
];
const result = spawnSync(exe, [], { input: input.map(JSON.stringify).join('\n') + '\n', cwd: dirname(exe),
  env, encoding: 'utf8', timeout: 30000, windowsHide: true });
assert.equal(result.status, 0, result.stderr || String(result.error));
assert.equal(result.stderr, '');
const responses = result.stdout.trim().split(/\r?\n/).map(JSON.parse);
assert.equal(responses.length, 3, result.stdout);
const byId = new Map(responses.map(response => [response.id, response]));
assert.equal(byId.get(1)?.result?.serverInfo?.name, 'purebasic-mcp-pb', result.stdout);
for (const id of [2, 3]) assert.equal(byId.get(id)?.result?.isError, false, JSON.stringify(byId.get(id)));
const version = byId.get(2).result.content[0].text;
const compiler = /^PureBasic (\d+\.\d+) — /m.exec(version)?.[1];
const docs = /^Docs index: PB (\d+\.\d+),/m.exec(version)?.[1];
assert.ok(compiler, 'Compiler version missing: ' + version);
assert.equal(docs, compiler, 'Packaged docs must match the compiler: ' + version);
const loadedIndex = /\n  (.+)$/.exec(version)?.[1];
assert.ok(loadedIndex, 'Docs index path missing: ' + version);
assert.equal(realpathSync(loadedIndex), realpathSync(join(dirname(exe), 'index.json')), 'Packaged index.json was not loaded');
const command = byId.get(3).result.content[0].text;
assert.match(command, /^OpenWindow  \[/);
assert.match(command, /\n\nSyntax: [^\n]*OpenWindow\(/);
console.log(`packaged docs passed (index.json, OpenWindow, compiler/help ${compiler})`);
