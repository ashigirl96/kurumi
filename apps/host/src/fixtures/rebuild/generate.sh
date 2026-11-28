#!/bin/sh
# 表の作り直しを含むマイグレーションの試験用に、drizzle-kit で migrations-v1（作り直しの前）と migrations-v2（作り直しを含む）を作り直す。apps/host で流す。
set -eu
dir=src/fixtures/rebuild
rm -rf "$dir/migrations-v1" "$dir/migrations-v2"
gen() { bunx drizzle-kit generate --dialect sqlite --schema "$dir/$1" --out "$dir/migrations-v2" --name "$2"; }
gen schema.v1.ts init
cp -r "$dir/migrations-v2" "$dir/migrations-v1"
gen schema.v2.ts rebuild_turns
