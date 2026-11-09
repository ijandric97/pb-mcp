# purebasic-mcp-pb

A native [PureBasic](https://www.purebasic.com/) implementation of a
[Model Context Protocol](https://modelcontextprotocol.io) server that gives
coding agents first-class PureBasic support: documentation search, real
compiler syntax checks, and compile-and-run verification — all from a single
native binary (`pbmcp.exe` on Windows, `pbmcp` on Linux) with no runtime
dependencies (no Node, no npx).

- MCP handshake p50 **27.6 ms**, RSS **15.6 MB** (Windows, verified 8/8 protocol cases on 6.40)
- MCP handshake p50 **1.4 ms**, RSS **19.7 MB**, `pb_check` median 529 ms (Linux/WSL2, PB 6.41, 8 MB index)
- Author: **Tureluut** — [www.tureluut.be](https://www.tureluut.be)
- License: **MIT** (see [LICENSE](LICENSE))

## Tools

| Tool             | Description                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pb_docs_search` | Search the PureBasic command reference. Returns command names, library, and one-line summaries. Optional `library` filter, `limit` (1–25, default 10).                                                              |
| `pb_command`     | Full command documentation: syntax, parameters, return value, remarks, example, OS, and related commands. Reference-page titles and aliases return bounded local text with the official source URL. Older indexes retain a URL fallback until rebuilt. |
| `pb_check`       | Syntax-check a `.pb` file with the **real compiler**  . Reports total processing time, compiler warnings, and structured errors with line numbers, high-confidence hints on common beginner errors, and always-on best-practice notes (missing `EnableExplicit`, `Global` inside procedures, `Goto`/`Gosub`). The file's project tree is staged to a bounded temporary workspace (see [Project staging](#project-staging)); originals are never modified.                                                                                                     |
| `pb_run`         | Compile and run a console program, reporting compiler warnings and capturing stdout. Accepts `args[]` and `timeoutMs` (default 15000, max 60000). Console programs only; the program runs inside the staged copy with the entry file's directory as its working directory, so relative resources and executable-relative DLLs come from the copied project. Generated files are ephemeral and removed with the workspace. |
| `pb_version`     | Report the server version, MCP protocol version, detected PureBasic compiler version + install path, and the docs-index version + build date + entry counts. Takes no arguments.                                     |

The docs tools answer from a docs index built by the repo's Node tooling
(see [Build from source](#build-from-source-including-the-json-index)).
The compiler tools (`pb_check`, `pb_run`) work without an index.

## Requirements

- **Windows or Linux** (the server spawns the platform's native PureBasic compiler)
- **PureBasic installed** — needed for `pb_check` / `pb_run`. Discovery order:
  - Windows: `PUREBASIC_HOME` → `Program Files (x86)` → `Program Files` →
    `C:\PureBasic` → `%LOCALAPPDATA%\Programs\PureBasic`
  - Linux: `PUREBASIC_HOME` → `~/purebasic` → `/opt/purebasic` →
    `/usr/local/purebasic` → `pbcompiler` on `PATH`
- **Node.js 18+** — required for source builds to index the selected compiler's
  installed help and for syntax-only source checks. Running the packaged server
  needs no Node.
- **Installed PureBasic help** — Windows uses `PureBasic.chm`; Linux uses the
  installed HTML help tree. Windows tries its built-in `hh.exe` extractor,
  then 7-Zip (`7z`/`7zz` on PATH or its standard Windows install location).
  Install 7-Zip if `hh.exe` cannot extract the manual.
- **Linux note**: the official PureBasic Linux compiler is a glibc ≥ 2.38
  binary (Ubuntu 24.04+); on older distros use the compiler your distro can
  run. If linking fails with `undefined reference to __wrap_memcpy`, see the
  gcc wrapper note in `INSTALL.md` (PB 6.41 + modern binutils).
  Compiler execution also requires `setsid` from util-linux to isolate each
  process group.

## Build from source (including the JSON index)

Install PureBasic with its help and Node.js, then run from the repository root:

    build.cmd

Set `PUREBASIC_HOME` to select an installation; otherwise the build uses the
same discovery order as the server. The build lints the sources, detects the
selected compiler version, and indexes the help from that installation before
compiling the final executable. It checks the manual's own version in
`MainGuide/history.html`; missing help, unknown versions, version mismatches,
extraction failures, or incomplete command coverage fail the build.

The first build compiles a temporary scanner, extracts/parses the local help,
then embeds the resulting `src/pbdocs-index.json` in the final executable.
No existing server binary or network access is required. Subsequent builds
reuse that index when the compiler, help content, scanner, and index builders are unchanged.
Edits to compiler execution, metrics, or MCP request handling keep the docs cache warm.
The previous index remains intact if generation fails. Changing installations
or updating the help automatically invalidates the cache.

    pbmcp.exe version          # compiler and docs versions should match
    build.cmd test            # build, then run the full local acceptance suite
    node test/run_tests.mjs    # acceptance suite, including installed-help checks
    make-dist.cmd             # build and assemble the self-contained dist\ bundle
    build.cmd check           # syntax only; does not regenerate documentation

(`pb_check` preserves relative includes. `build.cmd check` also uses the build
scripts' thread-safe compiler setting.)

### Linux

The same tree builds natively on Linux (PureBasic 6.x for Linux x64 + gcc
for linking; bash):

    bash build.sh            # lint + compile to ./pbmcp
    bash build.sh check      # --check on the real tree (authoritative syntax gate)
    bash build.sh test       # build + full local acceptance suite
    bash make-dist.sh        # assemble the self-contained dist/ bundle

Both build scripts enable the thread-safe runtime (`/THREAD` on Windows,
`--thread` on Linux). Documentation loading and request handling run on the
main thread. Compiler discovery matches the table above; `PBMCP_OUT` overrides
the output path on both OSes.

## Project staging

Both compiler tools accept an optional `projectRoot` (absolute, or relative
to the server's startup directory). The entry `file` keeps its usual
interpretation; the root only selects what gets staged:

- **Default root** — the entry file's parent directory.
- **Explicit root** — pass `projectRoot` when the project reaches outside
  the entry's directory, e.g. a parent-relative include:

        myproject/
          common.pbi          shared with the sibling below
          gui/window.pb       XIncludeFile "../common.pbi"
          src/main.pb

  `pb_check { file: "myproject/gui/window.pb", projectRoot: "myproject" }`
  stages the whole tree, so `../common.pbi` resolves like a native build.
- **What is copied** — the complete tree (sources, `.pbi`, DLLs/shared
  libraries, libraries, resources, data, empty directories), preserving
  relative paths. Only VCS metadata (`.git`, `.hg`, `.svn`) is excluded.
- **Limits** — 10,000 entries, 256 MiB of regular-file bytes, nesting depth
  64, 15 s staging time. Exceeding one returns an actionable error; narrow
  the root.
- **Links are rejected** — symbolic links on Linux and junctions/reparse
  points on Windows (including dangling ones) fail staging instead of being
  followed. Stage regular files only.
- **Execution moves into the copy** — `pb_run` compiles beside the staged
  entry file and runs with that directory as cwd, so executable-relative DLL
  placement (`GetPathPart(ProgramFilename())`) works as in a native build.
  Files the program writes are ephemeral: they live in the workspace and are
  deleted with it. Nothing is copied back — migrate outputs explicitly if
  you relied on the old write-into-the-source-tree behavior.
- **External dependencies** — anything outside the root (SDK DLLs, data on
  another drive) must be moved/vendored inside the root or encompassed by a
  larger explicit root. Staging is not a sandbox: absolute paths still reach
  the originals, so only trusted code should be run.

## HTTP transport

    pbmcp http --port 6817 --auth-file /secure/path/auth.json

- **Endpoint** — `http://127.0.0.1:<port>/mcp` (default port 6817; any
  integer 1–65000). HTTP requires a credential verifier file on every
  invocation and binds `127.0.0.1` only. No anonymous or non-loopback backend
  mode exists. See [INSTALL.md](INSTALL.md#3-optional-authenticated-http-and-https-gateway)
  for secure token provisioning and the canonical Caddy HTTPS gateway.
- **Authentication/profile** — each request needs a manually provisioned
  `Authorization: Bearer <token>` header. Default HTTP exposes only
  `pb_docs_search` and `pb_command`; `--allow-compiler-tools` explicitly
  enables `pb_check`, `pb_run` and `pb_version` for every configured client.
  That opt-in is for trusted clients on an isolated host, not a sandbox.
  HTTP credentials are preconfigured bearer authentication, not MCP OAuth or
  authorization discovery. Native clients must support a manual auth header;
  browser/CORS access is unsupported. A VPN or SSH tunnel is safer than public
  exposure.
- **Protocol** — MCP `2025-11-25`, stateless Streamable HTTP: one JSON-RPC
  message per POST, `application/json` results, `202` for notifications and
  responses. No sessions, no SSE streaming, no server-to-client requests.
  Clients send `Accept: application/json, text/event-stream` and, after
  initialization, `MCP-Protocol-Version: 2025-11-25`.
- **stdio is unchanged** — the default mode keeps speaking MCP
  `2025-03-26` over newline-framed stdin/stdout. Clients that cannot
  negotiate `2025-11-25` keep using stdio.
- **Boundary and admission** — browser origins are rejected; Caddy preserves
  Origin and the backend rejects it. HTTP requires bearer auth, limits each
  client to a burst of 10 then 1 request/second, and emits redacted audit
  events to stderr. These measures do not provide volumetric DDoS protection.
- **Serialized execution** — tool calls run one at a time on the main
  thread; a long compile/run delays all HTTP servicing until it finishes.
  Network receive/send bounds are 10 seconds, not an execution deadline.
- **Bounded framing** — 16 connections, 16 KiB headers, 1 MiB body,
  keepalive/chunked/HTTP/2 unsupported (rejected without dispatch).
- **Docs-index preload** — thread-safe builds (`--thread`, Linux) load the
  docs index in a background thread at startup. The Windows non-thread-safe
  build has a known preload race; deployment guidance sets `PBMCP_PRELOAD=0`.

## Local verification

During editing, use `./build.cmd check` from Git Bash on Windows or
`bash build.sh check` on Linux for the encoding and compiler syntax checks.
These commands do not rebuild the executable. After changing server behavior,
run `./build.cmd` or `bash build.sh`, then run the relevant standalone tests:

| Change | Local test |
| ------ | ---------- |
| MCP requests and framing | `node test/protocol.mjs` |
| Compiler diagnostics, retries, arguments, or output capture | `node test/compiler.mjs` |
| Process cleanup or cancellation | `node test/processes.mjs` and `node test/cancellation.mjs` |
| Documentation scanner, index, or lookup | `node test/index.mjs` |
| Installed-help indexing or its cache | `node test/local_index.mjs` |
| Metrics | `node test/metrics.mjs` |
| Online crawler | `node test/crawler.mjs` |
| Build or packaging scripts | `node test/build.mjs` and `node test/packaging.mjs` |

Crawler-only edits need no server rebuild; that test uses a local HTTP fixture.
Standalone server tests use the root executable unless `PBMCP_EXE` selects
another build. Check that override before testing so it points at the new binary.
The full suite includes 1,200 startup/shutdown sessions and deliberate timeout
tests; run it at the acceptance gate below rather than after every small edit.

Run `./build.cmd test` from Git Bash on Windows or `bash build.sh test` on
Linux before committing changes. Each command builds with the installed
compiler and matching help, then runs the full acceptance suite against that
binary. Platform-specific branches need a native test run on each supported OS.
The distribution scripts also run this suite before replacing the local bundle.
Test runs use separate temporary directories so overlapping local checks do not
overwrite each other's fixtures or session files.

## Distribution

    make-dist.cmd    (Windows)  /  make-dist.sh    (Linux)

Builds the binary and matching installed-help index in a sibling staging
directory (via the `PBMCP_OUT` override), assembles the bundle, and runs the full
local acceptance suite against the staged binary before replacing `dist/`.
Failed builds or tests preserve the previous distribution:

    dist/pbmcp[.exe]                  native server binary
    dist/index-*.json                 newest repo-root docs index (working drop-in;
                                      embedded placeholder covers when absent)
    dist/README.md
    dist/INSTALL.md                   quickstart for binary consumers
    dist/LICENSE
    dist/skills/purebasic/            companion agent skill (SKILL.md + references/)

`dist/` and packaging stages/backups are gitignored; regenerate after every
release-worthy change. Close clients running `dist/pbmcp[.exe]` on Windows
to allow cleanup of the previous executable; retained files are reported.
Catchable interruptions restore the previous bundle on Linux. On Windows,
rerunning `make-dist.cmd` recovers a retained backup if an interruption left
`dist/` missing.

## Companion skill

The repo ships the agent skill this server was built with: the complete
`skills/purebasic/` folder — `SKILL.md` plus its `references/` (tooling,
verification, best-practices). The tools do the work; the skill teaches the
agent PureBasic itself — no VB/FreeBASIC syntax, event-loop rules,
resource-cleanup pairs, and correct tool use (`pb_check` after each coherent
edit batch, console-only `pb_run`, portable relative includes — see the
skill's tooling reference). Not required to run the server, but strongly
recommended — copy the whole folder into the client's skills directory
(see `INSTALL.md`, step 4).

For faster iteration, look up a known command directly with `pb_command`, use
`pb_docs_search` to discover names, and reuse documentation from the current
session. Check each coherent edit batch before delivery. `pb_run` rejects
arguments containing double quotes, NUL, or newlines. Supported arguments are
passed as separate program parameters. Its executable and compiler artifacts stay in temporary
storage, while relative includes and runtime data paths use the original source.
Remaining processes in each run's Windows job or Linux process group are
terminated after normal exit, timeout, cancellation, or server termination.
Compiler and program stdin is a separate closed pipe (EOF).

Compiler tools process one call at a time while continuing to receive control
messages. Pings can be answered before an earlier tool call finishes. Send an
MCP `notifications/cancelled` notification with the active call's `requestId` to
stop its compiler or program and descendants; the cancelled call sends no result.
Unknown, completed, or malformed cancellation notifications are ignored.
Other tool calls remain queued in arrival order. Deferred input is bounded, so
large pipelines apply backpressure to the input pipe.

Both compiler tools show warnings without treating them as errors. Warning
sections are bounded to 40 entries and 4,000 characters. `pb_check` counts source
lines in fixed-size chunks and retains text for hints and best-practice notes
only for files up to 512 KiB; larger files still receive compiler diagnostics.

## Client configuration

Stdio **command** server — point the client straight at the binary
(`pbmcp.exe` on Windows, `pbmcp` on Linux; no `.exe` suffix there).

pi — `~/.pi/agent/mcp.json` (Windows paths use `\\` escapes, POSIX paths as-is):

```json
{
  "mcpServers": {
    "purebasic-pb": {
      "command": "C:\\path\\to\\purebasic-mcp-pb\\pbmcp.exe",
      "args": [],
      "exposure": "direct"
    }
  }
}
```

Claude Desktop — `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "purebasic-pb": {
      "command": "C:\\path\\to\\purebasic-mcp-pb\\pbmcp.exe"
    }
  }
}
```

Cursor — `~/.cursor/mcp.json` uses the same `{"command": ..., "args": []}`
shape under `"mcpServers"`. On Linux the command is e.g.
`/home/you/dist/pbmcp`. Restart the client after editing.

## Other CLI modes

(`pbmcp.exe` below; on Linux the binary is `pbmcp`)

    pbmcp.exe                                      serve MCP over stdio (default)
    pbmcp.exe version                              server/protocol/PureBasic/docs-index versions (also `--version`, `-v`)
    pbmcp.exe scan <html> [<library> <relfile>]    parse one command page as JSON (test utility)
    pbmcp.exe scan-batch <manifest.json>           parse command pages in one process
    pbmcp.exe test <file>                          replay a golden .jsonl session (test runner)
    pbmcp.exe http --port 6817 --auth-file <path>  authenticated loopback HTTP (see [HTTP transport](#http-transport))

Source builds include the short Git revision in every version report. The
`-dirty` suffix includes tracked changes made while generating the embedded
docs index; builds without Git metadata report `unknown`.

Protocol: MCP over stdio — JSON-RPC 2.0, newline-framed UTF-8,
`2025-03-26`; the optional HTTP mode speaks stateless Streamable HTTP with
`2025-11-25`.
JSON integer literals must fit the signed 64-bit range; larger identifiers can
be sent as strings. Out-of-range integer literals reject the request line with
error `-32600` and a null ID.
Numeric request IDs must have an exact integer value in that range. Decimal
and exponent forms such as `1.0` and `1e3` are normalized without floating-point
rounding; fractional and out-of-range IDs receive `-32600` with a null ID.
Request lines, including replay files, are limited to 1 MiB (1,048,576 bytes before the LF).
An oversized line receives error `-32600` with a null ID and is discarded
through its next LF; subsequent requests are processed normally.
JSON nesting is limited to 128 object/array levels, including the request
envelope and any batch array. Brackets inside strings do not count.
Deeper requests and lines containing raw NUL bytes receive `-32600` with a
null ID; the next request line is processed normally. Escaped NUL characters
in JSON strings are also rejected.
Malformed UTF-8 and unpaired Unicode surrogate escapes are rejected with
`-32600` and a null ID before decoding or native JSON processing. Valid surrogate
pairs and literal escaped backslashes remain supported; subsequent requests are
processed normally.
Requests may be sent individually or in a batch array. A batch produces one
response array; notifications receive no response. Invalid request envelopes
and unknown tools return JSON-RPC errors. Tool execution failures use
`result.isError`. Unknown tool argument names are rejected, matching the
advertised input schemas.

The batch scanner takes a UTF-8 JSON array of objects with non-empty `path`,
`library`, and `file` strings. It emits one command JSON line per entry, in input
order, and exits nonzero on an invalid manifest or unreadable page. The index
builder creates and removes its own manifest; the single-page `scan` mode remains
available for diagnostics and existing scripts.

## Environment variables

| Variable                     | Purpose                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PUREBASIC_HOME`             | Compiler/help installation; otherwise discovery uses the first valid default location                       |
| `PUREBASIC_MCP_INDEX`        | Pin an explicit docs index file (overrides exe-dir/embedded discovery)                                     |
| `PUREBASIC_MCP_METRICS`      | Redirect the JSONL metrics file                                                                            |
| `PUREBASIC_MCP_NO_METRICS=1` | Disable metrics writes entirely                                                                            |
| `PBMCP_PRELOAD=1`            | Load the docs index synchronously before serving requests; default/`0` loads it on the first docs call      |

The metrics file defaults to `<cache>/purebasic-mcp/metrics.jsonl`, where
`<cache>` is `%LOCALAPPDATA%` on Windows and `${XDG_CACHE_HOME:-~/.cache}`
on Linux.
New records use UTC timestamps with a `Z` suffix; existing records are preserved.
Concurrent clients serialize appends. A busy metrics file is retried for up to
500 ms; logging failures remain nonfatal and do not change tool results.

## PureBasic version support

Built and gated on **6.40 x64** on Windows and **6.41 x64** on Linux
(the full acceptance suite passes on both). The 6.50 beta is
compile-checked tool-compatible but not part of the test matrix.

- **Compiler tools**: version detection parses the compiler's version output
  (`/VERSION` on Windows, `--version` on Linux) with a regex and never trusts
  the exit code; the banner-filter capability is
  keyed on major version with conservative defaults for unknown versions.
  `pb_version` (tool) and `pbmcp[.exe] version` (CLI) surface the detected
  version.
- **Docs index**: source builds generate it from the selected installation and
  check its version against the compiler. Rebuild after upgrading PureBasic.
  Runtime drop-in indexes and `PUREBASIC_MCP_INDEX` remain explicit ways to use
  another reference; `pb_version` reports both versions separately.

## Docs index

The default build source is the selected installation's local manual. The index
records the help path and content hash, compiler identity/version, and parser
fingerprint. It is generated at build time; the server needs no extractor or
Node runtime and does not reindex during MCP requests.

The online mirror remains available for deliberately building a different
reference. It is not used by the automatic source build:

    node tools/fetch-online-docs.mjs tmp/online-docs
    node tools/build-online-index.mjs tmp/online-docs --out index-online.json --pb-version online

- Command entries are parsed by the shipped binary itself in one `scan-batch`
  process per index build. Command records and ranking stay compatible with
  single-page scanning.
- The optional online mirror finds reference pages by a fixpoint crawl and
  replaces the previous mirror only after a successful refresh. Removed pages
  disappear from the refreshed mirror. An existing nonempty destination must
  have a crawler `manifest.json`; other directories are preserved and rejected.
  The installed help is indexed directly without downloading pages.
  Index output is replaced only after a complete
  file has been written.
  Empty command discovery or coverage fails the refresh and preserves the
  previous mirror or index, including HTTP 200 error pages with no command links.
  Command-page titles must match their command filenames; HTTP 200 maintenance
  pages fail the refresh before the previous mirror is replaced.
- An optional `referenceText` map stores cleaned reference bodies once per file;
  keyword and constant aliases share those bodies. HTML decoration is removed,
  code examples retain line breaks/indentation, and `pb_command` caps the answer
  using its existing 14,000-character content limit. Command-target aliases reuse
  the indexed command documentation. Legacy indexes still resolve to a source URL.
- `purebasicVersion` is `"online"` when built with `--pb-version online` —
  the site carries no version marker; `source` records the URL and crawl
  timestamp for auditability.
- The GitHub repo (fantaisie-software/purebasic) holds DocMaker _sources_,
  not rendered pages — keep it as offline fallback, not as parse target.

Without any index the server starts and `pb_check` / `pb_run` work
untouched — only the docs tools report the missing-index hint.

Index discovery order is an explicit `PUREBASIC_MCP_INDEX`, the newest
`index*.json` beside the executable (including packaged `index.json`), the
embedded index, then the newest `index*.json` in the cache directory if the
embedded index is invalid or empty. An explicitly selected file or drop-in
that is invalid or empty reports an error instead of silently switching versions.

## Tests

    build.cmd test            # Windows: build + test the resulting binary locally
    bash build.sh test        # Linux: build + test the resulting binary locally
    node test/run_tests.mjs    # full acceptance suite: framing + multibyte,
                               # protocol, docs tools, pb_check, pb_run,
                               # metrics, wiring, missing-index UX, scanner
    node --test test/project.test.mjs   # project staging/safety/runtime (focused)
    node --test test/http.test.mjs      # HTTP protocol/security/integration (focused)

Set `PBMCP_EXE` to test a build elsewhere (e.g. `test/out_version/`) — the
repo-root exe is locked while a live server runs on it.
The build scripts' `test` mode sets `PBMCP_EXE` to their own output, including
any `PBMCP_OUT` override, and returns nonzero if the suite fails. All checks
run locally; no hosted CI or Git hooks are required.

Documentation assertions use `test/fixtures/docs-index.json`, independently of
the embedded index or user cache; `PUREBASIC_MCP_INDEX` can select another index
explicitly. The suite also runs controlled index-discovery builds, compiler
include/resource and latency regressions, stdio failure/timeout tests, and a
local HTTP crawler fixture. Installed-help tests check version validation,
cache invalidation, warm reuse, bootstrap scanning, and failure preservation.
The suite does not download the live documentation.

Highlights: 7-byte dribble stress cutting UTF-8 chars across stdin chunk
boundaries, byte-exact response lines matched independently of reply order,
pb_run timeout/orphan/cleanup gates, compiler and program cancellation,
descendant cleanup after normal exit and server termination, partial-line compiler
version timeouts, PATH-only version reports, and missing-index UX paths.
Set `PUREBASIC_HOME` to the installation to test.

## Layout

    src/main.pb        entry, arg parse (serve | http | scan | scan-batch | test | version)
    src/console.pb     byte-level stdin framing, control polling, and queued input
    src/scan_support.pb shared UTF-8 output, JSON string helpers, and file reads
    src/scan_main.pb   small scanner-only executable used by the local index build
    src/jsonrpc.pb     request parse, response/error builders, id copy
    src/config.pb      PB home discovery, /VERSION detect, capability flags, cache dir
    src/metrics.pb     JSONL metrics (frozen record shape), error-bucket classifier
    src/docs_index.pb  docs index cache + search + lookup + did-you-mean
    src/html_scan.pb   native HTML scanner + single-page/batch scan modes
    src/pbdocs-index.json   installed-help index embedded by source builds
    src/tool_check.pb  shared compiler pipeline (staging, spawn/capture, diagnostics) + pb_check
    src/tool_run.pb    pb_run (staged compile/run, timeout, tree-kill)
    src/tools.pb       tool registry, tools/list schemas, docs tool handlers
    src/http.pb        bounded authenticated loopback Streamable HTTP adapter
    tools/lint_encoding.mjs   shared build-time encoding gate (using Node.js)
    build.sh / make-dist.sh   Linux build + packaging (build.cmd / make-dist.cmd ports)
    tools/fetch-online-docs.mjs   mirror the official online docs
    tools/build-online-index.mjs  docs index + shared reference text from a docs tree
    tools/build-local-index.mjs   matching installed-help index + content cache
    test/run_tests.mjs     full local acceptance suite; creates isolated JSONL sessions
    test/fixtures/        compiler sources and deterministic docs index
    test/fixtures_html_scan/   HTML parser inputs and JSON goldens

## Source-encoding rule

All `src/*.pb` are **UTF-8 with BOM**. BOM-less UTF-8 is silently misread as
CP-1252 by the PB compilers; the Node lint in both build scripts enforces the
BOM, and tool descriptions carry a deliberate em-dash canary so an encoding
regression is visible in tool output.

## Status

Production-ready and deployed as the active PureBasic MCP in daily agent use
(verified through a 9-session dogfood week: 71.4 % first-try success on the
frozen task set, zero doc-hallucination classes).

## Author & license

Written by **Tureluut** — [www.tureluut.be](https://www.tureluut.be).

Licensed under the **MIT License** — see [LICENSE](LICENSE). Use it,
modify it, ship it; provided "as is", without warranty of any kind.
