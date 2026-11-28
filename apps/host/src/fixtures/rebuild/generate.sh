#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
dir=fixtures/rebuild
rm -rf "$dir/migrations-v1" "$dir/migrations-v2"
gen() { bunx drizzle-kit generate --dialect sqlite --schema "$dir/$1" --out "$dir/migrations-v2" --name "$2"; }
gen schema.v1.ts init
cp -r "$dir/migrations-v2" "$dir/migrations-v1"
gen schema.v2.ts rebuild_turns
