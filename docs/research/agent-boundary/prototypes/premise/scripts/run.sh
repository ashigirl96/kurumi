#!/bin/sh
# Run one probe script and save its output: sh scripts/run.sh <name>  (writes out/<name>.txt)
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
cd "$HERE/scripts"
bun "$1.ts" > "$HERE/out/$1.txt" 2>&1
code=$?
echo "$1 exit=$code lines=$(wc -l < "$HERE/out/$1.txt")"
exit $code
