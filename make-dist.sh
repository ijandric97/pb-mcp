#!/bin/bash
# ---------------------------------------------------------------------------
# make-dist.sh - build pbmcp and assemble the self-contained dist/
# (Linux port of make-dist.cmd; the layout differs only in the binary name).
#
# Usage:  make-dist.sh
#
# Output layout:
#   dist/pbmcp
#   dist/index-*.json        newest repo-root index-*.json copied verbatim -
#                            a working docs-index drop-in (the loader's glob is
#                            index-*.json; plain index.json is ignored). When
#                            none exists the binary's embedded placeholder covers.
#   dist/README.md
#   dist/INSTALL.md
#   dist/LICENSE
#   dist/skills/purebasic/        complete skill (SKILL.md + references/)
#
# Builds in a sibling staging directory; the previous dist/ stays intact
# until the new bundle builds, copies, and passes its acceptance suite.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")" || exit 1

STAGE=""
BACKUP=""
LOCK=".dist-publish.lock"
LOCK_OWNED=""
# shortcut: a hard kill leaves this lock; remove it only after confirming no publisher is active.
cleanup() {
  restore
  if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then rm -rf -- "$STAGE"; fi
  if [ -n "$LOCK_OWNED" ]; then rmdir -- "$LOCK" 2>/dev/null || echo "make-dist: could not remove lock $LOCK"; fi
}
restore() {
  if [ -n "$BACKUP" ] && [ -e "$BACKUP" ] && [ ! -e dist ] && [ ! -L dist ]; then
    if ! mv -- "$BACKUP" dist; then echo "make-dist: previous dist remains at $BACKUP"; fi
  fi
}
fail() { echo "make-dist: assembly FAILED"; exit 1; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if ! mkdir -- "$LOCK" 2>/dev/null; then
  echo "make-dist: publish lock exists at $LOCK (another publish may be running, or remove it after confirming no publisher is active)"
  exit 1
fi
LOCK_OWNED=1

echo "make-dist: creating staged dist layout"
STAGE=$(mktemp -d "$PWD/.dist-stage.XXXXXX") || fail
BACKUP="$STAGE.old"
mkdir -p "$STAGE/skills/purebasic" || fail

echo "make-dist: building pbmcp"
export PBMCP_OUT="$STAGE/pbmcp"
export PBMCP_INDEX_OUT="$STAGE/index.json"
if ! bash build.sh; then
  echo "make-dist: build FAILED"
  fail
fi
unset PBMCP_INDEX_OUT

echo "make-dist: copying docs + skill"
cp README.md "$STAGE/" || fail
cp INSTALL.md "$STAGE/" || fail
cp LICENSE "$STAGE/" || fail
echo "make-dist: copying complete skill tree (SKILL.md + references/)"
cp -R skills/purebasic/. "$STAGE/skills/purebasic/" || fail

# smoke: the artifact must launch (also warms it past first-run security
# scanning - a never-executed fresh binary can fail to start in time under
# the suite's timing-sensitive tests)
echo "make-dist: smoke - staged pbmcp version"
"$STAGE/pbmcp" version >/dev/null 2>&1 || fail

echo "make-dist: smoke - packaged documentation"
node test/package_docs.mjs "$STAGE/pbmcp" || fail

echo "make-dist: testing staged pbmcp"
PBMCP_EXE="$STAGE/pbmcp" node test/run_tests.mjs || fail

# A failed old-bundle rename leaves dist/ untouched; a failed publish restores it.
if [ -e dist ] || [ -L dist ]; then mv -- dist "$BACKUP" || fail; fi
if ! mv -- "$STAGE" dist; then fail; fi
STAGE=""
if [ -e "$BACKUP" ] || [ -L "$BACKUP" ]; then
  if ! rm -rf -- "$BACKUP"; then echo "make-dist: previous dist remains at $BACKUP"; fi
fi

echo "make-dist: OK"
ls dist dist/skills/purebasic
