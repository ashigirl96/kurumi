#!/bin/sh
# 表を作り直す SQL（`__new_` の表を作って入れ替える）は、行のある DB で落ちうるので、見直した印の行が無ければ止める。
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
