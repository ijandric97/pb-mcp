# PureBasic MCP workflow and limitations

## Confirm the toolchain

- Use `pb_version` to confirm the compiler and documentation versions against the project's target. Source builds automatically index the selected installation's local help; rebuild after an installation upgrade. Explicit index overrides can still select a different version.
- Use `pb_command` directly for known command names and `pb_docs_search` to discover names. Check uncertain syntax, parameters, return values, flags, and supported OS; reuse documentation already retrieved in the current session. Do not infer names or flags from another language or an older PB version.
- For reference pages and aliases, `pb_command` returns bounded local page text with its official source URL. Use that text directly. Older indexes may lack local text; rebuild them with the current index builder or fetch the official URL when text is unavailable or truncated. Do not inspect MCP server internals.

## HTTP deployments

The optional HTTP transport requires a verifier file and bearer authorization on
every request. Its default profile exposes only `pb_docs_search` and
`pb_command`; compiler tools require explicit `--allow-compiler-tools` and a
trusted, isolated host. HTTP remains loopback-only behind a separately
configured HTTPS gateway. See the repository's `INSTALL.md` for deployment,
token-handling, and client compatibility details.

## Compile and run

- `pb_check` compiles the original source path without modifying it, preserving relative includes and resources while isolating compiler output in temporary storage. Use it after each coherent edit batch before delivery; isolate a change sooner when needed to diagnose a failure.
- `pb_run` compiles and executes a console program with stdin closed (EOF). Use it only for bounded, noninteractive tests. Do not run a GUI, screen/keyboard loop, or a program waiting for user input; it may block until timeout. Record observed output and exit status.
- `pb_check` and `pb_run` stage the selected project tree into a bounded temporary workspace, so portable relative `XIncludeFile`s resolve like a native build. Pass `projectRoot` when the project reaches outside the entry file's directory (for example a parent-relative include); the default root is the entry file's parent. Symlinks/junctions, dangling links, oversized trees, and special entries are rejected with an actionable error — keep regular files inside the chosen root. `pb_run` executes inside the staged copy with the entry directory as cwd, so executable-relative DLL/assets lookups work; files the program writes are ephemeral and removed with the workspace, and nothing is copied back to the original tree.
- Program arguments containing double quotes, NUL, or newlines are rejected because the launch interface cannot preserve them.
- Prefer MCP over invoking `pbcompiler` through shells where argument translation may alter compiler switches. Use another compiler route only when MCP cannot verify the project and the alternative is safe and available.
- The MCP `pb_check`/`pb_run` interface exposes no thread-safe compiler option. Code that uses threads must be verified with the project's native thread-safe build (`/THREAD` on Windows, `--thread` on Linux); a plain MCP execution does not verify thread-safe behavior. MCP checks remain useful for syntax and non-threaded logic.

## Failures and unavailable tools

- Distinguish source errors from tool/environment failures. Use the compiler's reported location and message, inspect the relevant source, and consult the matching documentation before changing code.
- Do not claim verification when a tool failed, timed out, or checked only a different file than the changed project. State precisely what was and was not verified.
- If MCP is unavailable in another session, use the official documentation and project's own compiler/test workflow if accessible. Do not invent command syntax or claim a compile check.
