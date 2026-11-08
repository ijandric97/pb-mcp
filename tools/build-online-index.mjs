#!/usr/bin/env node
// ---------------------------------------------------------------------------
// build-online-index.mjs - build the docs index (schemaVersion 1, with an
// optional referenceText map) from a local documentation tree: the online mirror made
// by fetch-online-docs.mjs, or any other tree with the same layout. Point
// --out at src/pbdocs-index.json and rebuild to embed the result, or drop
// it next to pbmcp.exe as index-<version>.json to switch help versions.
//
// Parity strategy: command entries are parsed by the shipped, parity-tested
// binary itself - one `pbmcp(.exe) scan-batch <manifest>` process -
// so the emitted command JSON is byte-identical to what the former native
// builder produced. Reference entries, coverage and the assembly are
// replicated here (ports of the former native builder's stages).
//
// Usage:
//   node tools/build-online-index.mjs <docsRoot> --out <file>
//        --pb-version <v> [--source-json '{"kind":"online",...}']
//        [--manifest <file>] [--pbmcp <exe>]
// ---------------------------------------------------------------------------
import { readdirSync, readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, rmdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const docsRoot = args[0];
function argOf(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
}
const outFile = argOf('--out', null);
let pbVersion = argOf('--pb-version', 'unknown');
let sourceJson = argOf('--source-json', null);
const manifestFile = argOf('--manifest', null);
const pbmcp = argOf('--pbmcp', join(ROOT, `pbmcp${process.platform === 'win32' ? '.exe' : ''}`));

if (!docsRoot || !outFile) {
  console.error('usage: build-online-index.mjs <docsRoot> --out <file> --pb-version <v> [--source-json <json>]');
  process.exit(2);
}
if (manifestFile && !sourceJson) {
  // default source block from the crawler manifest + content hash
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  sourceJson = JSON.stringify({
    kind: 'online',
    url: manifest.url,
    crawledAt: manifest.crawledAt,
  });
}

// --- verbatim helpers (parity with index_build.pb / html_scan.pb) ----------

const SKIP_DIRS = new Set(['helppictures', 'examples', 'mainguide', 'catalogs',
  'residents', 'sdk', 'subsystems', 'themes', 'purelibraries', 'compilers']);

// PureBasic LCase(): ASCII only (localeCompare is approximated ci elsewhere).
const asciiLower = s => s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32));

// HtmlTrimAll charset: tab lf cr space nbsp vtab ff
function trimAll(s) {
  return s.replace(/^[\t\n\r \x20\xA0\x0B\x0C]+/, '').replace(/[\t\n\r \x20\xA0\x0B\x0C]+$/, '');
}

// HtmlCleanText: nbsp->space; per line: tab/cr->space, collapse runs, trim;
// emit every line with a leading \n (blank lines become empty lines);
// collapse \n\n\n runs; trim ends.
function cleanText(s) {
  s = s.replace(/\xA0/g, ' ');
  const lines = s.split('\n').map(line =>
    trimAll(line.replace(/\t/g, ' ').replace(/\r/g, ' ').replace(/ {2,}/g, ' ')));
  let out = '';
  for (const line of lines) out += '\n' + line;
  while (out.includes('\n\n\n')) out = out.replace(/\n\n\n/g, '\n\n');
  return trimAll(out);
}

// HtmlDecodeEntities (same entity set and fallback behaviour).
function decodeEntities(s) {
  return s.replace(/&([a-z]+|#\w+);/gi, (all, ent) => {
    switch (asciiLower(ent)) {
      case 'quot': return '"';
      case 'gt': return '>';
      case 'lt': return '<';
      case 'amp': return '&';
      case 'nbsp': return '\xA0';
    }
    if (ent[0] === '#') {
      const code = /^#x/i.test(ent) ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (code > 0 && code <= 0x10FFFF) return String.fromCodePoint(code);
    }
    return all;
  });
}

// Strip tags for text extraction; <br> yields \n exactly like the PB tree
// builder's <br> text node. <pre>/<style>/<script> content is kept for <p>
// summaries only via the caller (reference pages have none).
function nodeText(html) {
  return decodeEntities(html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ''));
}

// --- discovery (IndexDiscover) ----------------------------------------------

const entries = readdirSync(docsRoot, { withFileTypes: true });
const referenceDir = entries.find(e => e.isDirectory() && asciiLower(e.name) === 'reference')?.name || 'reference';
const libraries = [];
const referenceFiles = [];
for (const e of entries) {
  if (!e.isDirectory()) continue;
  const name = e.name;
  if (name.startsWith('#') || name.startsWith('$')) continue;
  if (SKIP_DIRS.has(asciiLower(name))) continue;
  const dir = join(docsRoot, name);
  const files = readdirSync(dir).filter(f =>
    asciiLower(f).endsWith('.html') && asciiLower(f) !== 'index.html');
  if (asciiLower(name) === 'reference') {
    for (const f of files) {
      if (asciiLower(f) !== 'commandindex.html') referenceFiles.push(f);
    }
  } else if (files.length > 0) {
    libraries.push(name);
  }
}
// localeCompare-equivalent ci sort, retaining case spelling (insertion-sort
// semantics = stable).
libraries.sort((a, b) => {
  const la = asciiLower(a), lb = asciiLower(b);
  return la < lb ? -1 : la > lb ? 1 : 0;
});

// --- command entries via the shipped parser (HtmlCommandJson) ---------------

console.log(`parsing ${libraries.length} libraries...`);
const cmds = []; // { raw, name, library }
const pages = [];
for (const lib of libraries) {
  const files = readdirSync(join(docsRoot, lib)).filter(f =>
    asciiLower(f).endsWith('.html') && asciiLower(f) !== 'index.html');
  for (const file of files) {
    pages.push({ path: resolve(docsRoot, lib, file), library: lib, file: `${lib}/${file}` });
  }
}
const scanDir = mkdtempSync(join(tmpdir(), 'pbmcp-index-'));
const scanManifest = join(scanDir, 'pages.json');
try {
  writeFileSync(scanManifest, JSON.stringify(pages));
  const output = execFileSync(pbmcp, ['scan-batch', scanManifest],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120000, windowsHide: true }).trim();
  const records = output === '' ? [] : output.split(/\r?\n/);
  if (records.length !== pages.length) throw new Error(`Scanner returned ${records.length} records for ${pages.length} pages`);
  for (const raw of records) {
    const parsed = JSON.parse(raw); // validation only; raw string is emitted
    cmds.push({ raw, name: parsed.name, library: parsed.library });
  }
} finally {
  rmSync(scanManifest, { force: true });
  rmdirSync(scanDir);
}
console.log(`  ${cmds.length} command pages scanned in one process`);
// Stable sort: library ci, then name ci, stable.
cmds.forEach((c, i) => (c.ord = i));
cmds.sort((A, B) => {
  const la = asciiLower(A.library), lb = asciiLower(B.library);
  if (la !== lb) return la < lb ? -1 : 1;
  const na = asciiLower(A.name), nb = asciiLower(B.name);
  if (na !== nb) return na < nb ? -1 : 1;
  return A.ord - B.ord;
});

// --- reference entries (IndexReferenceJson) ---------------------------------

function referenceText(html) {
  const visible = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|script|style|nav|form|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const body = visible.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i)?.[1] ?? visible;
  return body.split(/(<pre\b[^>]*>[\s\S]*?<\/pre\s*>)/gi).map(part => {
    if (/^<pre\b/i.test(part)) return trimAll(nodeText(part)).replace(/\r\n?/g, '\n');
    return cleanText(nodeText(part
      .replace(/<\/?(?:p|div|blockquote|h[1-6]|li|ul|ol|dl|dt|dd|table|tr)\b[^>]*>/gi, '\n')
      .replace(/<\/(?:td|th)\s*>/gi, '\t')));
  }).filter(Boolean).join('\n\n');
}
const referenceTexts = {};
function referenceJson(file) {
  let html = readFileSync(join(docsRoot, referenceDir, file), 'utf8');
  referenceTexts[`reference/${file}`] = referenceText(html);
  // IndexTextWithoutBr: <br> tags are stripped before parsing, so they
  // contribute no newline to extracted text (double-space bug otherwise).
  html = html.replace(/<br(?=[\s/>])[^>]*>/gi, '');
  let title = '';
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tm) title = trimAll(nodeText(tm[1]));
  if (asciiLower(title.slice(0, 9)) === 'purebasic') {
    let k = 9;
    const step = () => { while (k < title.length && title.charCodeAt(k) <= 32) k++; };
    step();
    if (title[k] === '-') { k++; step(); title = title.slice(k); }
  }
  title = trimAll(title);
  if (title === '') title = file;
  let summary = '';
  // real tag-name boundary: <p> / <p attr> but NOT <pre> (parity with the
  // PB tokenizer, which compares the parsed tag name)
  const ps = [...html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)];
  for (const pm of ps) {
    const text = nodeText(pm[1]);
    if (trimAll(text).length > 40) {
      summary = cleanText(text).replace(/\n/g, ' ');
      if (summary.length > 300) summary = summary.slice(0, 300);
      break;
    }
  }
  const id = file.replace(/\.html$/i, '');
  return { json: JSON.stringify({ id, title, file: `reference/${file}`, summary }), title };
}

console.log(`parsing ${referenceFiles.length} reference pages...`);
const refs = referenceFiles
  .slice()
  .sort((a, b) => {
    // NTFS $I30 enumeration order (what ExamineDirectory returns on the
    // builder's machine): binary compare of UPCASED names.
    const la = a.toUpperCase(), lb = b.toUpperCase();
    return la < lb ? -1 : la > lb ? 1 : 0;
  })
  .map(referenceJson);

// --- constants + keyword alias entries (IndexReferenceJson shape) -----------
//
// Two symbol-lookup gaps, both filled with extra reference entries in the
// same {id, title, file, summary} shape:
//
// 1. pbconstants.html lists every #PB_ constant (library, compiler, #True...)
//    with a link to the page documenting it. One entry per constant routes a
//    name query ("#PB_Window_SystemMenu", "#PB_Compiler_Date") to that page.
//    Constant VALUES are deliberately not stored: they are compiler residents
//    (version- and OS-dependent), the index carries only the name->page
//    mapping, exactly like the official help.
//
// 2. Reference page titles are plural or group titles ("Enumerations",
//    "Compiler Directives"), so a bare keyword ("Enumeration", "CompilerIf")
//    resolves nowhere. Every page's Syntax block marks its real keywords with
//    color="#3A3966" online or "#006666" locally (placeholders use #924B72),
//    giving one alias entry per keyword.

const usedRefKeys = new Set(refs.map(r => asciiLower(r.title)));
const cmdNames = new Set(cmds.map(c => asciiLower(c.name)));

function referenceTarget(href) {
  // href=TARGET is relative to reference/: '../<lib>/<page>.html' (command
  // page) or '<page>.html' (another reference page). Normalize to a path
  // relative to the documentation root (DOCS_URL_BASE$ + file on the PB side).
  href = trimAll(href).replace(/^"|"$/g, '');
  const low = asciiLower(href);
  if (low.startsWith('../reference/')) return 'reference/' + href.slice(13);
  if (low.startsWith('../')) return href.slice(3);
  return 'reference/' + href;
}

const constRefs = [];
{
  const html = readFileSync(join(docsRoot, referenceDir, 'pbconstants.html'), 'utf8');
  const rowRe = /<tr><td[^>]*>[\s\S]*?(#[A-Za-z0-9_]+)(?:<\/font>)?<\/td><td[^>]*>(?:<font[^>]*>)?<a\s[^>]*?href\s*=\s*"?([^">\s]+)"?[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const name = trimAll(nodeText(m[1]));
    const label = trimAll(nodeText(m[3]));
    const key = asciiLower(name);
    if (usedRefKeys.has(key)) continue; // never shadow a real page
    usedRefKeys.add(key);
    const summary = (label !== '' && asciiLower(label) !== asciiLower(name))
      ? `PureBasic constant - see ${label}`
      : 'PureBasic constant';
    const target = referenceTarget(m[2]);
    // The official table links library-level entries as '../<lib>/.html',
    // which 403s online - fall back to the constants overview itself; the
    // summary still says what to look for ("see VectorDrawing").
    const file = /\/\.html$/.test(target) ? 'reference/pbconstants.html' : target;
    constRefs.push({
      json: JSON.stringify({ id: key, title: name, file, summary }),
      title: name,
    });
  }
  console.log(`  ${constRefs.length} constants from pbconstants.html`);
}

const kwRefs = [];
for (const r of refs) {
  const file = JSON.parse(r.json).file.replace(/^reference\//, '');
  const html = readFileSync(join(docsRoot, referenceDir, file), 'utf8');
  // Section end = a <b> that is NOT an inline keyword wrap (<b><font ...>):
  // headers like <b>Description</b> terminate; <b><font color=#3A3966>...</font></b>
  // inside the syntax is content. Pages covering several constructs have one
  // Syntax block each (compilerdirectives.html has seven) - scan them all.
  const syntaxRe = /<b(?:\s[^>]*)?>\s*Syntax\s*<\/b(?:\s[^>]*)?>([\s\S]*?)(?=<b(?:\s[^>]*)?>(?!<font)|$)/gi;
  let sm;
  while ((sm = syntaxRe.exec(html)) !== null) {
  const seenKw = new Set();
  for (const m of sm[1].matchAll(/<b>\s*<font\b[^>]*\bcolor\s*=\s*["']?#(?:3A3966|006666)["']?[^>]*>([A-Za-z][A-Za-z0-9_]*)</gi)) {
    const kw = m[1];
    const key = asciiLower(kw);
    if (seenKw.has(key)) continue;
    seenKw.add(key);
    // the page's own entry already covers it; commands keep their name
    if (key === asciiLower(r.title) || usedRefKeys.has(key) || cmdNames.has(key)) continue;
    usedRefKeys.add(key);
    kwRefs.push({
      json: JSON.stringify({ id: key, title: kw, file: `reference/${file}`,
        summary: `PureBasic keyword - see ${r.title}` }),
      title: kw,
    });
  }
  }
}
console.log(`  ${kwRefs.length} keyword aliases from reference Syntax blocks`);

// --- coverage (IndexCoverage) -----------------------------------------------

const covHtml = readFileSync(join(docsRoot, referenceDir, 'commandindex.html'), 'utf8');
const expected = [];
const seen = new Set();
const linkRe = /<a\s[^>]*?href\s*=\s*"?\.\.\/[a-z0-9_]+\/[a-z0-9_]+\.html[^>]*>([\s\S]*?)<\/a>/gi;
let m;
while ((m = linkRe.exec(covHtml)) !== null) {
  let name = trimAll(nodeText(m[1]));
  if (name.endsWith('()')) name = name.slice(0, -2);
  if (name === '') continue;
  const key = asciiLower(name);
  if (!seen.has(key)) { seen.add(key); expected.push(name); }
}
const builtNames = new Set(cmds.map(c => asciiLower(c.name)));
let missing = 0, extra = 0;
for (const name of expected) {
  if (!builtNames.has(asciiLower(name))) {
    missing++;
    if (missing <= 20) console.log(`  MISSING: ${name}`);
  }
}
if (missing > 20) console.log(`  ... and ${missing - 20} more`);
for (const c of cmds) if (!seen.has(asciiLower(c.name))) extra++;
console.log(`  expected ${expected.length}, indexed ${cmds.length}, missing ${missing}, extra ${extra}`);
if (missing > 0) process.exit(1);

// --- emit (RunIndexMode emit order, byte for byte) ---------------------------

const commandCounts = {};
for (const c of cmds) commandCounts[c.library] = (commandCounts[c.library] || 0) + 1;

const generatedAt = new Date().toISOString();
if (sourceJson === null) sourceJson = JSON.stringify({ kind: 'local-tree' });

let out = '{"schemaVersion":1,"generatedAt":' + JSON.stringify(generatedAt)
  + ',"purebasicVersion":' + JSON.stringify(pbVersion)
  + ',"source":' + sourceJson;
out += ',"libraries":{';
out += libraries.map(l =>
  JSON.stringify(l) + ':{"dir":' + JSON.stringify(l)
  + ',"commandCount":' + commandCounts[l] + '}').join(',');
out += '},"commands":[';
out += cmds.map(c => c.raw).join(',');
out += '],"reference":[';
out += refs.concat(constRefs, kwRefs).map(r => r.json).join(',');
out += '],"referenceText":' + JSON.stringify(referenceTexts) + '}';

// sanity: must parse
JSON.parse(out);

mkdirSync(dirname(outFile), { recursive: true });
const staged = join(dirname(resolve(outFile)), `.pbdocs-${randomUUID()}.json`);
try {
  writeFileSync(staged, out, { flag: 'wx' });
  renameSync(staged, outFile);
} finally {
  rmSync(staged, { force: true });
}
console.log(`wrote ${outFile} (${Math.round(Buffer.byteLength(out) / 1024)} KB)`);
console.log('Done.');
