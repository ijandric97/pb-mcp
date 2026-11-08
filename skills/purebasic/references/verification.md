# Verified PureBasic 6.40 behaviors

These targeted checks were run with the PureBasic MCP 0.3.1 server and its 6.40 compiler/docs index. They validate only the listed cases, not every example or rule in the skill.

- A main-scope `Define outer.i` is not visible inside a procedure with `EnableExplicit`; `pb_check` reports the undeclared variable. Declaring `Global outer.i` makes it accessible.
- A `Read.i grid(0)` from inside a procedure compiles and runs when `grid()` is declared globally. The test read `Data.i 42` and printed `array=42`.
- `ValD("3.5")` preserves the decimal and printed `3.5`; `Val()` is integer conversion, while `ValD()`/`ValF()` parse decimal values.
- Historical MCP 0.3.1 limitation: checking a main file with a relative `XIncludeFile "sibling.pbi"` failed because the main file was relocated. The current server compiles the original source path; sibling/nested includes and relative resources have dedicated regression tests.

Re-run checks when changing the supported compiler version or when relying on behavior beyond these examples.

[best-practices.md](best-practices.md) is documentation-reviewed guidance
(official docs, with forum corroboration for pitfalls), not blanket
compiler/runtime-tested coverage — only the list above was executed.
