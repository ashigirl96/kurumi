#!/bin/sh
# Reruns H1 end to end: sh run-all.sh  (about 4 minutes). Needs Docker Desktop, gh (first run only, to
# download the gateway binaries into dl/), bun, openssl, and the image kurumi-agent:sdk-0.3.332.
# Fake canaries and local fakes only; no real credential, no external account. Cleans up on exit.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
sh ../setup.sh >/dev/null || exit 1
sh fetch-deps.sh >/dev/null || exit 1
grep -q brokerServer repo/packages/agent-runtime/src/turn.ts || { echo "repo/ lacks the broker patch (broker.diff)"; exit 1; }
rm -rf out && mkdir -p out
trap 'sh infra.sh down; rm -rf out/sess-* out/data-*' EXIT
sh infra.sh up > out/infra.txt 2>&1 || { cat out/infra.txt; exit 1; }

fail=0
for s in wire lifecycle iron broker e13; do sh scripts/run.sh $s || fail=1; done
bun scripts/table.ts > out/table-wire.md
bun scripts/table-lifecycle.ts > out/table-lifecycle.md
bun scripts/checks.ts | tee out/checks.txt || fail=1
exit $fail
