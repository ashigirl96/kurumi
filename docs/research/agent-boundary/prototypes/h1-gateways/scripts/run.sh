#!/bin/sh
# Run one probe script and save its output: sh scripts/run.sh <name> [args...]  (writes out/<name>.txt)
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE/scripts"
name=$1; shift
bun "$name.ts" "$@" > "$HERE/out/$name.txt" 2>&1
code=$?
echo "$name exit=$code lines=$(wc -l < "$HERE/out/$name.txt")"
exit $code
