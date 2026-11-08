# Changelog

## Unreleased — 2026-11-08

### Added

- Windows build regressions exercise the real `build.cmd` with a controlled
  compiler, including output paths, test targeting, and failed build stages.
- Multiprocess metrics regressions check complete records, bounded lock waits,
  and recovery after a writer holding the file exits.
- Local `build.cmd test` / `bash build.sh test` commands that build and run the
  full acceptance suite against the resulting binary, including output overrides.
- Live/replay protocol regressions for exact decimal/exponent IDs, nesting
  boundaries, raw NUL bytes, oversized lines, and recovery on the next request.
- Git source revisions in CLI, initialization, and `pb_version` reports, with
  a tracked-change marker and a fallback for builds without Git metadata.
- The `LICENSE` file in both native distribution bundles.
- Local release gates: distribution scripts run the full acceptance suite against
  the staged binary before replacing the existing bundle. Failed tests preserve
  the previous distribution.
- Process regressions for descendants after success, timeout, and server exit;
  partial-line compiler version output; and both PATH-only version reporters.
- Automatic build-time documentation matching. Windows and Linux builds generate
  the embedded index from the help in the selected compiler's installation and
  verify the manual's version independently against the compiler version.
- A local index builder that extracts Windows CHM help or reads installed HTML
  help, compiles a temporary batch scanner, and records compiler/help provenance.
  Missing, unknown, or mismatched help fails the build. Failed generation leaves
  the previous index intact.
- Content-based index caching. Unchanged compiler, help, and parser inputs reuse
  the existing index without extraction, rescanning, or rewriting it.
- A `scan-batch <manifest.json>` CLI mode that parses command pages in one native
  process, preserving the existing single-page scanner's records and ordering.
- An optional `referenceText` map with one local body per reference file. Reference
  titles, language keywords, and constant aliases return local documentation;
  command-target aliases reuse their indexed command documentation. Responses
  retain source URLs and the existing 14,000-character limit. Legacy indexes keep
  their URL fallback.
- Regression coverage for compiler/include behavior, preload and index discovery,
  process and pipe lifecycle, batch scanning, crawler failures, and local-help
  version validation and caching.
- Dedicated protocol and packaging regression suites, plus tests for malformed
  documentation entries, oversized stderr lines, stale mirror pages, partial
  index writes, and publication/rollback failures.

### Changed

- Documentation loads lazily by default. `PBMCP_PRELOAD=1` now loads the index
  synchronously before serving requests instead of using a background thread.
- The Windows encoding gate uses the already-required Node.js runtime instead
  of PowerShell.
- Documentation guidance now uses `pb_command` directly for known names, reserves
  search for discovery, reuses previous lookups, and checks coherent edit batches.
- The companion skill uses the project's explicit target or installed compiler
  instead of always targeting PureBasic 6.40.
- `pb_check` reports total handler processing time, including source analysis;
  metrics use the same complete processing boundary.
- Source builds now require Node.js and the selected installation's help.
  Windows tries `hh.exe` and falls back to 7-Zip for CHM extraction. The packaged
  native server still needs neither Node.js nor an extractor at runtime.
- The embedded documentation was regenerated from the installed PureBasic 6.41
  help: 1,888 commands, 1,949 reference entries, and 103 unique reference bodies.
  Both the compiler and documentation now report 6.41 in the rebuilt artifacts.
- The embedded index generation time and parser fingerprint reflect the audit
  fixes; documentation records are unchanged.
- `.gitattributes` preserves LF line endings for shell scripts, including
  Windows checkouts used through WSL.

### Fixed

- Removed concurrent documentation loading, which could cause intermittent
  Windows access violations when short MCP sessions exited. Regressions cover
  1,200 startup/shutdown sessions with default, disabled, and eager loading.
- `pb_check` reports compiler launch failures with the compiler path instead
  of returning only `ERRORS (0):`.
- Unknown argument names are rejected for all tools, matching their
  `additionalProperties: false` schemas.
- Metrics appends serialize across clients and retry brief contention without
  changing the record format or making logging failures fatal.
- Single-page scans infer library and relative-file metadata when optional CLI
  arguments are omitted, including relative and forward-slash paths.
- Missing-index messages explain the platform's installed-help build command,
  packaged index replacement, and explicit index overrides.
- Requests deeper than 128 object/array levels are rejected before the native
  JSON parser can overflow its stack.
- Numeric request IDs are normalized with exact decimal arithmetic, preserving
  signed 64-bit integers written with decimal points or exponents and rejecting
  fractional or out-of-range values instead of rounding them.
- Replay files share the bounded byte reader used by live stdin. Raw NUL bytes
  are rejected before decoding, so they cannot silently discard trailing input.
- Build-test fixtures ignore inherited output overrides, preventing stub builds
  from overwriting the real server being tested.
- Compiler/program stdin uses a separate closed pipe, preventing launched code
  from consuming later MCP requests.
- Out-of-range JSON integer literals are rejected before dispatch instead of
  wrapping request IDs. Valid signed 64-bit ID boundaries retain their values.
- Metrics timestamps use UTC with a `Z` suffix, avoiding ambiguous local times
  when daylight saving time changes.
- Build revision markers are calculated after documentation generation, so a
  regenerated tracked index is included in the `-dirty` state.
- Both platform builds use the Node.js encoding gate; removed the duplicate
  shell implementation. Syntax-only source checks also require Node.js.
- Compiler diagnostics and noise filtering scan and copy output once, avoiding
  repeated prefix scans and string growth on many short lines.
- Online command pages with unexpected titles fail before publishing a mirror,
  preserving working documentation when HTTP 200 responses contain error pages.
- Bash packaging restores the previous bundle on catchable interruptions;
  Windows packaging recovers a retained backup on the next invocation.
- Empty online command discovery and empty coverage now fail before replacing
  a working documentation mirror or index.
- Compiler/program stderr uses bounded native byte-pipe reads with a 4 MiB
  capture limit, so oversized lines and continuous output cannot delay timeout
  checks. UTF-8 is decoded after capture, preserving split characters and blank lines.
- HTML scanner sections, syntax, tables, rows, parameters, examples, related
  links, and OS lists grow to fit their content instead of overflowing arrays
  or silently dropping entries.
- Stdin request frames have a 1 MiB limit. Oversized frames receive one error
  and are discarded through the next newline without disrupting later requests.
- Packaging tests force old-bundle move, publication, and restoration failures.
  Windows packaging reports the backup location if restoration fails.
- Each compiler/program run owns its descendants for its complete lifetime.
  Windows launch workers join a kill-on-close job before starting user code;
  Linux workers use a separate process group and parent-death notification.
  Normal completion now terminates remaining children before temporary cleanup.
- Compiler version detection reads bounded raw bytes so an unfinished output
  line cannot bypass its 15-second deadline.
- CLI and MCP version reports recognize a compiler discovered only through PATH,
  even when its installation directory is unknown.
- Initialization validates the required protocol version, capabilities object,
  and client name/version before negotiating a successful MCP handshake.
- The online crawler refuses to replace nonempty directories without its own
  manifest, and rechecks the destination before publishing a completed mirror.
- Compiler diagnostics retain the actual error, line number, and source path
  for failures inside included files. Source-based hints do not use unrelated
  lines from the main file for those errors.
- `pb_run` reports compiler stderr, unparsed stdout, launch failures, and compile
  timeouts. Failed compilation is recorded as failed in metrics, while runtime
  exit codes retain the existing compile-scoped metric meaning.
- Metrics overrides create their selected parent directories when needed.
- Removed unused schema/scanner helpers and the unused version-exit capability.
- `tools/call` validates its params, tool name, and optional argument object
  before reading members, preventing the missing-params crash. Request validation
  rejects incorrect JSON-RPC versions, invalid request IDs, and invalid parameter
  envelopes.
- Documentation index loading validates command/reference records and nested
  field types before constructing lookups or formatting entries. Invalid indexes
  return diagnostics instead of crashing; legacy reference-text fallback remains
  supported.
- JSON-RPC request batches produce one response array, reject invalid members,
  omit notifications, and reset batch state before the next message.
- Unknown tools return JSON-RPC `-32602` errors instead of tool-result text.
- `pb_run` correctly advertises that executed programs can make destructive
  changes and interact with external systems.
- Both stderr drain paths enforce the 4,194,304-character retention allowance,
  including line terminators, and mark oversized output as truncated. The
  underlying stderr API can still allocate a complete line temporarily.
- Windows/Linux distributions are assembled and smoke-tested in staging before
  replacing `dist/`. Build, copy, and smoke-test failures preserve the previous
  bundle; failed publication attempts restore it where possible.
- Online documentation refreshes use clean staging directories so obsolete pages
  disappear. Working/source directory destinations are rejected, failed refreshes
  preserve the previous mirror, and failed rollback retains a recoverable backup
  with its location reported.
- Online indexes are written to a sibling temporary file and renamed only after
  the complete write succeeds, preserving the existing index on write failure.
- Windows builds and both platforms' syntax checks enable the thread-safe runtime
  required by background documentation preload. The entry point rejects builds
  that omit this setting.
- Relative paths containing leading or nested `..` resolve correctly above the
  server's working directory on Windows and Linux.
- Documentation discovery accepts packaged `index.json` as well as versioned
  `index*.json` files. An unusable embedded index can fall back to the user cache;
  invalid explicit or drop-in indexes retain their own diagnostics.
- Compiler checks and console builds compile the original source path, preserving
  relative includes, binary resources, and compiler file/path constants while
  isolating generated output in temporary storage.
- Unsupported quote/newline arguments and NUL-containing JSON strings are rejected
  before they can be silently altered. Empty, tab-containing, spaced, and trailing
  backslash arguments retain their values.
- Online reference crawling tolerates HTTP 404/410 links while reporting exhausted
  network and server failures. Failed refreshes preserve the previous successful
  mirror and manifest; missing reference pages are omitted from refreshed mirrors.
- Local-help indexing handles reference folder casing and the installed manual's
  keyword styling. Command coverage failures stop generation before replacing an
  existing index.
- Acceptance tests use a controlled documentation fixture instead of depending on
  the developer's cache. Child-process failures, early exits, EPIPE, stream closure,
  timers, and timeouts produce explicit outcomes and clean up correctly.

### Performance

- Source linting scans lines and strings linearly. A 50,000-line fixture decreased
  from approximately 3.4 seconds to 0.11 seconds on the tested Windows setup.
- Batch indexing of the existing documentation mirror decreased from 31,366 ms to
  981 ms, approximately 32 times faster, with structurally identical command and
  reference records for that comparison.

### Validation

- Windows source-build acceptance suite: **164 passed, 0 failed**, including
  malformed requests/indexes, batch framing, bounded stderr, partial-write and
  publication failures, packaging, and installed-help integration checks.
- The local Windows release gate passed end to end in an isolated copy, including
  its full acceptance suite and replacement of the previous test bundle.
- Native thread-safe syntax check, UTF-8 BOM lint, and the full source build
  passed with PureBasic 6.41. Windows packaging tests covered build/copy/smoke
  failures, replacement, and a locked executable. Linux packaging passed isolated
  build/copy/smoke failure and replacement checks in WSL; all shell scripts passed
  syntax checks and now retain LF line endings.
- Earlier packaged RPC lookups verified local `CompilerIf` text, the installed
  `OpenWindow` signature, and a command-target constant alias. Package files and
  the recorded CHM content hash matched their sources. The restarted client
  confirmed matching compiler/documentation versions and a working reference lookup.
- The full Linux acceptance suite and a live online crawl were not rerun. HTML
  help layout and version handling use local fixtures; crawler tests use a local
  HTTP server.
- Matching occurs during builds. Rebuild after upgrading or changing the compiler
  installation; explicit runtime index overrides can still select another version.

Notable changes to pbmcp. The server version lives in `src/jsonrpc.pb`
(`#SERVER_VERSION$`); every rebuild stamps its compile date automatically
(`pbmcp version` / the `pb_version` tool report both).

## 0.4.0

### Added

- **Streamable HTTP transport** — `pbmcp http [--port N] --auth-file PATH`
  serves stateless Streamable HTTP on the IPv4 loopback only (default port
  6817). HTTP mode negotiates MCP protocol `2025-11-25`; stdio keeps
  `2025-03-26`. New `src/http.pb`; unknown HTTP options are rejected with an
  actionable error.
- **Mandatory bearer authentication** — every `http` invocation requires
  `--auth-file` with a credential verifier file
  (`{"clients":[{"id":...,"tokenSha256":...}]}`, 1–32 clients; SHA-256
  digests only, never plaintext tokens); no anonymous mode exists. Each
  request must carry exactly one `Authorization: Bearer <token>`:
  missing/invalid tokens get an empty 401 with
  `WWW-Authenticate: Bearer realm="pbmcp"`, duplicate or combined headers
  get 400. Preconfigured bearer auth, not MCP OAuth/authorization
  discovery. INSTALL.md documents token provisioning and a canonical Caddy
  2.10+ HTTPS gateway recipe for internet deployment (a VPN/SSH tunnel
  remains the simpler alternative).
- **HTTP tool profile** — HTTP by default exposes only `pb_docs_search` and
  `pb_command`; `pb_check`, `pb_run` and `pb_version` are hidden from
  `tools/list` and direct calls return the MCP `isError` unavailable-tool
  result instead of a transport error. `--allow-compiler-tools` opts the
  whole process in to all five tools — for trusted clients on an isolated
  host, not a sandbox.
- **Admission control and audit** — per-client token bucket (burst 10, then
  1 request/second) answers exhausted clients with an empty 429 carrying an
  integer `Retry-After`; redacted JSON-line audit events (validated client
  ID, method/tool name, status, elapsed time) go to stderr — never tokens,
  raw headers, paths or tool arguments.
- **Project staging for `pb_check` and `pb_run`** — both tools accept an
  optional `projectRoot` (absolute, or relative to the server's startup
  directory). The complete tree (default: the entry file's parent) is copied
  to a bounded temporary workspace, so parent-relative `XIncludeFile`s
  resolve like a native build and originals are never modified.
  - Limits: 10,000 entries, 256 MiB of regular-file bytes, nesting depth 64,
    15 s staging time; exceeding one returns an actionable error.
  - VCS metadata (`.git`, `.hg`, `.svn`) is excluded; symlinks (Linux) and
    junctions/reparse points (Windows), including dangling ones, are
    rejected instead of followed.
- **`pb_run` executes inside the staged copy** — compiles beside the staged
  entry file and runs with that directory as cwd, so relative resources and
  executable-relative DLL placement (`GetPathPart(ProgramFilename())`)
  work as in a native build. Stale staged executables are removed before
  compiling; files the program writes are ephemeral and deleted with the
  workspace (nothing is copied back).

### Changed

- **Docs-index preload default follows the runtime**: builds without a
  thread-safe runtime (the Windows non-`/THREAD` build) now default the
  serve-mode preload **off** and load the index lazily on the first docs
  call; `PBMCP_PRELOAD=1` force-enables it. Overlapping the preload
  worker's runtime calls with the request loop corrupted the heap on the
  non-TS build (0xC0000005/0xC0000354 in ~8-15% of docs-call sessions);
  thread-safe builds (`--thread`, required on Linux) keep the warm preload.
- Linux build (`build.sh`) passes `--thread` — required; the non-TS runtime
  heap-corrupts when the preload thread runs concurrently.
- `pb_check` best-practice notes stay always-on; the tool description now
  documents the project-staging behavior and `projectRoot` parameter.

### Fixed

- Allocation failures no longer corrupt the protocol: OOM when building a
  JSON-RPC response or growing a stdout buffer exits (1) instead of
  dereferencing null; HTML reads detect short reads and abort cleanly.

## 0.3.3

- `version` / `--version` / `-v` CLI mode; version stays consistent between
  the CLI line and `serverInfo.version`.
- `pb_check` best-practices support (procedure-scope hints, always-on lint).
- Earlier releases predate this changelog.
