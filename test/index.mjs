import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exe = resolve(process.env.PBMCP_EXE || join(root, 'pbmcp' + (process.platform === 'win32' ? '.exe' : '')));
const scratch = join(root, 'test', 'out', 'index');
assert.equal(dirname(scratch), join(root, 'test', 'out'));
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const env = { ...process.env, PUREBASIC_MCP_NO_METRICS: '1', PBMCP_DOCS_TIMING: '0' };
const fixturePages = join(root, 'test', 'fixtures_html_scan', 'pages');
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
const pages = walk(fixturePages).filter(p => p.endsWith('.html')).sort().map(path => {
  const file = relative(fixturePages, path).replaceAll('\\', '/');
  return { path, library: file.split('/')[0], file };
});
const manifest = join(scratch, 'manifest Ω.json');
function batch(entries) {
  writeFileSync(manifest, JSON.stringify(entries));
  return spawnSync(exe, ['scan-batch', manifest], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
}
const requests = [...pages, ...pages.slice().reverse(), pages[0]];
const scanned = batch(requests);
assert.equal(scanned.status, 0, scanned.stderr);
assert.equal(scanned.stderr, '');
const records = scanned.stdout.trim().split(/\r?\n/);
assert.equal(records.length, requests.length);
for (const [i, request] of requests.entries()) {
  const expected = JSON.parse(readFileSync(join(root, 'test', 'fixtures_html_scan', 'goldens', request.file + '.json'), 'utf8'));
  assert.deepEqual(JSON.parse(records[i]), expected, 'batch parser state leaked into ' + request.file);
}
assert.equal(batch([]).stdout, '');
for (const invalid of [{}, [null], [{ path: 42, library: 'Window', file: 'bad.html' }],
  [{ path: pages[0].path, library: '', file: 'bad.html' }], [{ ...pages[0], path: 'nul\0path' }]]) {
  const failed = batch(invalid);
  assert.notEqual(failed.status, 0, 'invalid manifest was accepted');
  assert.ok(failed.stderr.includes('scanner'), failed.stderr);
}
writeFileSync(manifest, '{oops');
assert.notEqual(spawnSync(exe, ['scan-batch', manifest], { env, timeout: 15000, windowsHide: true }).status, 0);
const partial = batch([pages[0], { ...pages[0], path: join(scratch, 'missing.html') }, pages[1]]);
assert.equal(partial.status, 1);
assert.equal(partial.stdout.trim().split(/\r?\n/).length, 1, 'batch continued after an unreadable page');
assert.match(partial.stderr, /cannot open HTML file/);

const docs = join(scratch, 'docs');
mkdirSync(join(docs, 'window'), { recursive: true });
const referenceDir = join(docs, 'Reference');
mkdirSync(referenceDir, { recursive: true });
const commandFiles = ['OpenWindow', 'CloseWindow', 'WindowEvent'];
for (const name of commandFiles) copyFileSync(join(fixturePages, 'Window', name + '.html'), join(docs, 'window', name.toLowerCase() + '.html'));
writeFileSync(join(referenceDir, 'commandindex.html'), commandFiles.map(name => `<a href="../window/${name.toLowerCase()}.html">${name}</a>`).join('\n'));
writeFileSync(join(referenceDir, 'constructs.html'), `<html><head><title>Language constructs</title><style>HiddenHead</style></head><body>
<script>HiddenScript = '</body>';</script><!-- HiddenComment </body> -->
<nav>HiddenNavigation</nav><p>Visible overview with café and 🚀.</p>
<b>Syntax</b><blockquote><pre><b><font color="#006666">CompilerIf</font></b> &lt;constant expression&gt;
  Debug &quot;héllo 🚀&quot;
<b><font color="#3A3966">CompilerEndIf</font></b></pre></blockquote><b>Description</b>
<p>Visible details after the example.</p><table><tr><td>Name</td><td>Description</td></tr></table>
<footer>HiddenFooter</footer></body></html>`);
writeFileSync(join(referenceDir, 'pbconstants.html'), `<html><body><table>
<tr><td>#PB_Fixture</td><td><a href="constructs.html">Language constructs</a></td></tr>
<tr><td>#PB_Window_SystemMenu</td><td><a href="../window/openwindow.html">OpenWindow</a></td></tr>
</table></body></html>`);
writeFileSync(join(referenceDir, 'long.html'), '<html><head><title>Long page</title></head><body><p>' + 'Long readable text. '.repeat(2000) + '</p></body></html>');
const output = join(scratch, 'index.json');
function build(binary = exe) {
  return spawnSync(process.execPath, [join(root, 'tools', 'build-online-index.mjs'), docs, '--out', output,
    '--pb-version', 'fixture', '--pbmcp', binary], { cwd: root, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
}
const built = build();
assert.equal(built.status, 0, built.stdout + built.stderr);
assert.match(built.stdout, /3 command pages scanned in one process/);
const index = JSON.parse(readFileSync(output, 'utf8'));
assert.equal(index.schemaVersion, 1);
assert.equal(Object.keys(index.referenceText).length, 3, 'reference bodies were duplicated for aliases');
const body = index.referenceText['reference/constructs.html'];
assert.ok(body.includes('Visible overview with café and 🚀.') && body.includes('Visible details after the example.'), body);
assert.ok(body.includes('CompilerIf <constant expression>\n  Debug "héllo 🚀"\nCompilerEndIf'), body);
assert.ok(body.includes('Name Description'), body);
assert.ok(!/Hidden|<font|&quot;|&lt;/.test(body), body);
function command(name, file = output) {
  const result = spawnSync(exe, [], { env: { ...env, PUREBASIC_MCP_INDEX: file }, cwd: root, windowsHide: true,
    encoding: 'utf8', timeout: 15000, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'pb_command', arguments: { name } } }) + '\n' });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.result.isError, false, result.stdout);
  return response.result.content[0].text;
}
for (const name of ['Language constructs', 'CompilerIf', '#PB_Fixture']) {
  const text = command(name);
  assert.ok(text.includes(body), text);
  assert.ok(!text.includes('fetch the URL'), text);
}
assert.ok(command('#PB_Window_SystemMenu').includes('Syntax: Result = OpenWindow('), 'command-target constant alias required a network fetch');
const long = command('Long page');
assert.ok(long.includes('truncated') && long.length < 14100 && long.includes('reference/long.html'), long.slice(-200));
const legacy = join(scratch, 'legacy.json');
delete index.referenceText;
writeFileSync(legacy, JSON.stringify(index));
assert.ok(command('Language constructs', legacy).includes('Local text is unavailable'), 'old indexes lost their source-URL fallback');
index.referenceText = [];
writeFileSync(legacy, JSON.stringify(index));
assert.ok(command('Language constructs', legacy).includes('Local text is unavailable'), 'invalid optional text map crashed lookup');

// Failed scans/coverage must leave an existing output index intact.
const previous = readFileSync(output);
assert.notEqual(build(join(scratch, 'missing-scanner')).status, 0);
assert.deepEqual(readFileSync(output), previous, 'scanner failure replaced the working index');
writeFileSync(join(referenceDir, 'commandindex.html'), '<a href="../window/absent.html">AbsentCommand</a>');
assert.notEqual(build().status, 0);
assert.deepEqual(readFileSync(output), previous, 'coverage failure replaced the working index');
console.log('index tests passed (batch parity/errors, builder coverage, offline text/aliases, legacy fallback, caps)');
