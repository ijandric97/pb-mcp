#!/bin/bash
# ---------------------------------------------------------------------------
# build.sh - one-command build for pbmcp (PureBasic 6.x x64, Linux).
#
# Usage:  build.sh          lint + compile pbmcp
#         build.sh check    thread-safe --check on the complete source tree
#                           (the switch form is the Linux one:
#                           /SWITCH switches do not exist here)
#         build.sh test     build + run the acceptance suite
#
# Both builds require thread safety: documentation preload uses the runtime
# concurrently with request handling (--thread here, /THREAD on Windows).
#
# Compiler discovery mirrors the server's own ConfigInit() Linux chain:
# PUREBASIC_HOME > ~/purebasic > /opt/purebasic > /usr/local/purebasic >
# pbcompiler on PATH. gcc must be on PATH for linking; if you hit
# "undefined reference to __wrap_memcpy" (PB 6.41 + modern binutils
# link-order bug) see the gcc wrapper note in INSTALL.md.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")"

PBC=""
if [ -n "${PUREBASIC_HOME:-}" ] && [ -x "${PUREBASIC_HOME%/}/compilers/pbcompiler" ]; then
  PBC="${PUREBASIC_HOME%/}/compilers/pbcompiler"
fi
if [ -z "$PBC" ]; then
  for pb_home in "$HOME/purebasic" /opt/purebasic /usr/local/purebasic; do
    if [ -x "$pb_home/compilers/pbcompiler" ]; then
      PBC="$pb_home/compilers/pbcompiler"
      break
    fi
  done
fi
if [ -z "$PBC" ] && command -v pbcompiler >/dev/null 2>&1; then
  PBC="$(command -v pbcompiler)"
fi
if [ -z "$PBC" ]; then
  echo "build.sh: pbcompiler not found - set PUREBASIC_HOME or install under ~/purebasic, /opt/purebasic or /usr/local/purebasic, or put pbcompiler on PATH"
  exit 1
fi

echo "build.sh: encoding lint - UTF-8 BOM required on all src/*.pb"
if ! node tools/lint_encoding.mjs; then
  echo "build.sh: lint FAILED - fix source encoding before compiling"
  exit 1
fi

SRC="$(pwd)/src/main.pb"
# PBMCP_OUT overrides the output path (make-dist.sh builds straight into
# dist/ so a running server cannot lock the target binary)
if [ -n "${PBMCP_OUT:-}" ]; then OUT="$PBMCP_OUT"; else OUT="$(pwd)/pbmcp"; fi

if [ "${1:-}" = "check" ]; then
  echo "build.sh: --check on \"$SRC\""
  exec "$PBC" --thread --check --console "$SRC"
fi

if ! node tools/build-local-index.mjs --compiler "$PBC" --out src/pbdocs-index.json; then
  echo "build.sh: local help indexing FAILED - Node.js and matching installed help are required"
  exit 1
fi

REVISION=$(git rev-parse --short HEAD 2>/dev/null) || REVISION=unknown
if [ "$REVISION" != unknown ] && ! git diff --quiet HEAD --; then REVISION="$REVISION-dirty"; fi

echo "build.sh: compiling \"$SRC\" (--thread: required on Linux, see header)"
"$PBC" --thread --console "$SRC" --output "$OUT" --constant "PBMCP_REVISION\$=$REVISION"
RC=$?
if [ $RC -ne 0 ] || [ ! -f "$OUT" ]; then
  echo "build.sh: compile FAILED"
  exit 1
fi
if [ "${1:-}" = "test" ]; then
  case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
  echo "build.sh: testing \"$OUT\""
  PBMCP_EXE="$OUT" node test/run_tests.mjs || exit $?
fi
echo "build.sh: OK - \"$OUT\""
