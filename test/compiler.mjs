import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = resolve(process.env.PBMCP_EXE || join(root, 'pbmcp' + (process.platform === 'win32' ? '.exe' : '')));
const scratch = join(root, 'test', 'out', 'compiler');
assert.equal(dirname(scratch), join(root, 'test', 'out'));
rmSync(scratch, { recursive: true, force: true });
const project = join(scratch, 'project with spaces');
mkdirSync(join(project, 'nested'), { recursive: true });
mkdirSync(join(project, 'assets'), { recursive: true });
const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '1', PBMCP_DOCS_TIMING: '0',
  PUREBASIC_MCP_INDEX: join(root, 'test', 'fixtures', 'docs-index.json') };
function rpc(calls, overrides = {}) {
  const started = performance.now();
  const result = spawnSync(exe, [], { cwd: root, windowsHide: true, env: { ...env, ...overrides },
    encoding: 'utf8', timeout: 15000,
    input: calls.map(([name, args], i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1,
      method: 'tools/call', params: { name, arguments: args } })).join('\n') + '\n' });
  assert.equal(result.status, 0, result.stderr || String(result.error || result.signal));
  return { responses: result.stdout.trim().split('\n').map(line => JSON.parse(line)), ms: performance.now() - started };
}
function invoke(name, args, overrides) { return rpc([[name, args]], overrides).responses[0]; }
const text = response => response.result.content[0].text;
function ok(response) { assert.equal(response.result.isError, false, text(response)); return text(response); }
function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? snapshot(path) : [[path, readFileSync(path)]];
  });
}

const main = join(project, 'main.pb');
writeFileSync(main, '\uFEFF' + [
  'EnableExplicit', 'XIncludeFile "sibling.pbi"', 'IncludePath "nested/"',
  'XIncludeFile "helper.pbi"', 'IncludePath #PB_Compiler_FilePath',
  'DataSection', 'Payload:', 'IncludeBinary "assets/payload.bin"', 'EndDataSection',
  'If OpenConsole()', '  PrintN(SiblingText() + NestedText())',
  '  PrintN("source=" + #PB_Compiler_FilePath)', '  PrintN("payload=" + Str(PeekA(?Payload)))',
  '  If ReadFile(0, "assets/data.txt")', '    PrintN("data=" + ReadString(0, #PB_UTF8))',
  '    CloseFile(0)', '  EndIf', '  CloseConsole()', 'EndIf',
].join('\n'));
writeFileSync(join(project, 'sibling.pbi'), 'Procedure.s SiblingText()\n  ProcedureReturn "sibling+"\nEndProcedure\n');
writeFileSync(join(project, 'nested', 'helper.pbi'), 'Procedure.s NestedText()\n  ProcedureReturn "nested"\nEndProcedure\n');
writeFileSync(join(project, 'assets', 'payload.bin'), Buffer.from([97]));
writeFileSync(join(project, 'assets', 'data.txt'), 'relative-data');
const before = snapshot(project);
assert.match(ok(invoke('pb_check', { file: main })), /^OK — /);
const run = ok(invoke('pb_run', { file: main }));
assert.ok(run.includes('sibling+nested'), run);
assert.ok(run.includes('source=' + project + sep), run);
assert.ok(run.includes('payload=97') && run.includes('data=relative-data'), run);
assert.deepEqual(snapshot(project), before, 'compiler modified the project or left output beside its source');
const missingInclude = join(project, 'missing-include.pb');
writeFileSync(missingInclude, 'EnableExplicit\nXIncludeFile "nested/absent.pbi"\n');
for (const tool of ['pb_check', 'pb_run']) {
  const failed = invoke(tool, { file: missingInclude });
  assert.equal(failed.result.isError, true, text(failed));
  assert.ok(text(failed).includes('absent.pbi'), 'missing include diagnostic was lost: ' + text(failed));
}

const hello = join(root, 'test', 'fixtures', 'hello.pb');
const args = ['alpha', 'beta gamma', '', 'tail\\', 'tab\tvalue', String.raw`\u0000`, String.raw`\\u0000`];
const echoed = ok(invoke('pb_run', { file: hello, args }));
assert.deepEqual(echoed.split(/\r?\n/).filter(line => /^arg\d+=/.test(line)).map(line => line.slice(line.indexOf('=') + 1)), args);
const rejected = invoke('pb_run', { file: hello, args: ['alpha', 'quote "inner" arg'] });
assert.equal(rejected.result.isError, true);
assert.match(text(rejected), /Double quotes are not supported.*args\.1/);
assert.ok(!text(rejected).includes('hello from pb_run'), 'unsupported arguments reached the executable');
for (const value of ['line\nbreak', 'carriage\rreturn']) {
  const invalid = invoke('pb_run', { file: hello, args: ['alpha', value] });
  assert.equal(invalid.result.isError, true, text(invalid));
  assert.match(text(invalid), /Newlines are not supported.*args\.1/);
}
for (const value of ['nul\0value', '\\' + '\0']) {
  const invalid = invoke('pb_run', { file: hello, args: [value] });
  assert.equal(invalid.error?.code, -32600);
  assert.match(invalid.error.message, /NUL characters are not supported/);
}

const bp = readFileSync(join(root, 'test', 'fixtures', 'bp.pb'), 'utf8').replace(/\r\n/g, '\n');
for (const [name, source] of [['lf', bp], ['crlf', bp.replace(/\n/g, '\r\n')], ['cr', bp.replace(/\n/g, '\r')],
  ['no-final-newline', bp.trimEnd()]]) {
  const file = join(scratch, name + '.pb');
  writeFileSync(file, source);
  const result = ok(invoke('pb_check', { file }));
  assert.ok(result.includes('Best practices (3):') && result.includes('Line 4:') && result.includes('Line 7:'), result);
}
const clean = join(scratch, 'clean.pb');
writeFileSync(clean, '\uFEFFEnableExplicit\nDefine text.s = "Global; Goto EndProcedure"\n; Global Goto\n');
assert.ok(!ok(invoke('pb_check', { file: clean })).includes('Best practices'), 'strings, comments, or BOM confused the lint');

const large = join(scratch, 'large.pb');
writeFileSync(large, 'EnableExplicit\n' + '; padding\n'.repeat(50000));
const metrics = join(scratch, 'metrics.jsonl');
const measured = rpc([['pb_check', { file: large }]], { PUREBASIC_MCP_NO_METRICS: '0', PUREBASIC_MCP_METRICS: metrics });
const result = ok(measured.responses[0]);
const reported = Number(/^OK — 50001 lines, (\d+) ms/.exec(result)?.[1]);
const record = JSON.parse(readFileSync(metrics, 'utf8').trim());
assert.ok(Number.isFinite(reported), result);
assert.ok(reported <= record.durationMs && record.durationMs <= measured.ms + 20, 'header/metrics do not measure the full check');
assert.ok(measured.ms - reported < 500, `unreported work: wall=${measured.ms}ms, reported=${reported}ms`);
assert.ok(measured.ms < 2000, `large-file check regressed: ${measured.ms}ms`);
const longLine = join(scratch, 'long-line.pb');
writeFileSync(longLine, ' '.repeat(200000) + 'EnableExplicit\n');
assert.ok(!ok(invoke('pb_check', { file: longLine })).includes('Best practices'));
console.log(`compiler tests passed (includes/resources, original paths, args, lint); 50,000 lines: ${Math.round(measured.ms)}ms wall, ${reported}ms reported`);
