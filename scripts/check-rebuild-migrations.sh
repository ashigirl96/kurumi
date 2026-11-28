#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
status=0
for f in packages/*/migrations/*/migration.sql; do
  [ -e "$f" ] || continue
  if grep -q '__new_' "$f" && ! grep -q '^-- rebuild reviewed:' "$f"; then
    echo "$f: table rebuild without a '-- rebuild reviewed: <what you checked>' line" >&2
    status=1
  fi
done
exit "$status"
