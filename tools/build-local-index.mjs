#!/usr/bin/env node
// Generate the embedded index from the same installation as the build compiler.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === 'win32';

function childPath(dir, name) {
  const entry = readdirSync(dir).find(entry => entry.toLowerCase() === name.toLowerCase());
  return entry ? join(dir, entry) : '';
}

export function helpFile(dir, section, name) {
  const folder = childPath(dir, section);
  return folder ? childPath(folder, name) : '';
}

export function findLocalHelp(home) {
  const chm = childPath(home, 'PureBasic.chm');
  if (chm) return { kind: 'local-chm', path: chm };
  const candidates = [home];
  for (const name of ['help', 'documentation']) {
    const folder = childPath(home, name);
    if (folder) candidates.push(childPath(folder, 'english'), folder);
  }
  const path = candidates.find(path => path && helpFile(path, 'reference', 'commandindex.html'));
  if (!path) throw new Error(`Local PureBasic help not found in ${home}; install the help shipped with this compiler.`);
  return { kind: 'local-tree', path };
}

export function checkHelpVersion(docs, compilerVersion) {
  const history = helpFile(docs, 'mainguide', 'history.html');
  const version = history && readFileSync(history, 'utf8').match(/\bVersion\s+(\d+\.\d+)\b/i)?.[1];
  if (!version) throw new Error(`Cannot determine the local help version in ${docs} (MainGuide/history.html).`);
  if (version !== compilerVersion) throw new Error(`Local help ${version} does not match compiler ${compilerVersion}; repair the PureBasic installation.`);
  return version;
}

export function helpHash(source) {
  const hash = createHash('sha256');
  if (source.kind === 'local-chm') hash.update(readFileSync(source.path));
  else {
    function visit(dir, relative = '') {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = relative + entry.name;
        if (entry.isDirectory()) visit(join(dir, entry.name), name + '/');
        else if (entry.isFile() && /\.html$/i.test(name)) hash.update(name).update('\0').update(readFileSync(join(dir, entry.name))).update('\0');
      }
    }
    visit(source.path);
  }
  return hash.digest('hex');
}

export function cachedIndexMatches(index, source, version) {
  return index?.schemaVersion === 1 && index.purebasicVersion === version
    && JSON.stringify(index.source) === JSON.stringify(source)
    && Array.isArray(index.commands) && index.commands.length > 0 && Array.isArray(index.reference)
    && index.referenceText && !Array.isArray(index.referenceText) && typeof index.referenceText === 'object';
}

export function parserFingerprint(projectRoot = root) {
  const hash = createHash('sha256');
  for (const file of [
    join(projectRoot, 'tools', 'build-local-index.mjs'),
    join(projectRoot, 'tools', 'build-online-index.mjs'),
    join(projectRoot, 'src', 'scan_main.pb'),
    join(projectRoot, 'src', 'scan_support.pb'),
    join(projectRoot, 'src', 'html_scan.pb'),
  ]) {
    hash.update(file).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

function run(command, args, timeout = 120000) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  return result.stdout;
}

function extractHelp(chm, output) {
  mkdirSync(output);
  // hh.exe can silently produce no files; verify its output before accepting it.
  if (win) {
    const hh = join(process.env.WINDIR || 'C:\\Windows', 'hh.exe');
    const extracted = spawnSync(hh, ['-decompile', output, chm], { windowsHide: true, timeout: 60000 });
    if (!extracted.error && extracted.status === 0 && helpFile(output, 'reference', 'commandindex.html')) return;
  }
  const extractors = ['7z', '7zz', ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean).map(dir => join(dir, '7-Zip', '7z.exe'))];
  for (const extractor of extractors) {
    const result = spawnSync(extractor, ['x', '-y', '-bd', '-bso0', '-bsp0', `-o${output}`, chm],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (result.error?.code === 'ENOENT') continue;
    if (!result.error && result.status === 0 && helpFile(output, 'reference', 'commandindex.html')) return;
    throw new Error(`Could not extract ${chm}: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  throw new Error(`Could not extract ${chm}. Install 7-Zip (7z/7zz on PATH or the standard Windows install location).`);
}

export function buildLocalIndex(compiler, outFile) {
  compiler = realpathSync(compiler);
  outFile = resolve(outFile);
  const detected = spawnSync(compiler, [win ? '/VERSION' : '--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const version = detected.stdout?.match(/PureBasic\s+(\d+\.\d+)/)?.[1];
  // PureBasic /VERSION may exit 1 even when version detection succeeds.
  if (detected.error || !version) throw new Error(`Cannot detect compiler version: ${detected.error?.message || detected.stderr || detected.stdout}`);
  const home = dirname(dirname(compiler));
  const help = findLocalHelp(home);
  const source = { kind: help.kind, path: help.path, sha256: helpHash(help), compiler, compilerVersion: version,
    compilerSha256: createHash('sha256').update(readFileSync(compiler)).digest('hex'), parserSha256: parserFingerprint() };
  let cached;
  try { cached = JSON.parse(readFileSync(outFile, 'utf8')); } catch { /* Missing or invalid indexes are rebuilt. */ }
  if (cachedIndexMatches(cached, source, version)) {
    console.log(`local docs: compiler/help ${version}, unchanged (${help.path})`);
    return;
  }

  const work = mkdtempSync(join(tmpdir(), 'pbmcp-local-index-'));
  const staged = join(dirname(outFile), `.pbdocs-${randomUUID()}.json`);
  try {
    const docs = help.kind === 'local-chm' ? join(work, 'help') : help.path;
    if (help.kind === 'local-chm') extractHelp(help.path, docs);
    checkHelpVersion(docs, version);
    const scanner = join(work, win ? 'pbmcp.exe' : 'pbmcp');
    const main = join(root, 'src', 'scan_main.pb');
    const args = win ? ['/THREAD', '/CONSOLE', main, '/EXE', scanner] : ['--thread', '--console', main, '--output', scanner];
    console.log(`local docs: compiler/help ${version}, indexing ${help.path}`);
    run(compiler, args);
    const output = join(work, 'index.json');
    console.log(run(process.execPath, [join(root, 'tools', 'build-online-index.mjs'), docs, '--out', output,
      '--pb-version', version, '--source-json', JSON.stringify(source), '--pbmcp', scanner]).trim());
    const bytes = readFileSync(output);
    if (!cachedIndexMatches(JSON.parse(bytes), source, version)) throw new Error('Generated local index failed validation.');
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(staged, bytes, { flag: 'wx' });
    renameSync(staged, outFile);
  } finally {
    rmSync(staged, { force: true });
    if (dirname(work) !== resolve(tmpdir()) || !basename(work).startsWith('pbmcp-local-index-')) throw new Error('Unexpected temporary path');
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = name => process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes('--compiler') || !process.argv.includes('--out')) {
    console.error('usage: build-local-index.mjs --compiler <pbcompiler> --out <index.json>');
    process.exitCode = 2;
  } else {
    try { buildLocalIndex(value('--compiler'), value('--out')); }
    catch (error) { console.error(`local docs: ${error.message}`); process.exitCode = 1; }
  }
}
