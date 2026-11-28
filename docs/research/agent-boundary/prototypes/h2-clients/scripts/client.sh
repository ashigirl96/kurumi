#!/bin/sh
# Runs one in-container client script on h2-int with Kurumi's turn flags (sandbox.ts dockerRunArgs:
# cap-drop ALL, no-new-privileges, uid 501:20, read-only root, tmpfs /tmp, /work volume).
# Usage: sh scripts/client.sh <script-in-scripts/> <out-name> [network]
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
NET=${3:-h2-int}
WORK=$(mktemp -d "$HERE/out/work-XXXXXX")
docker run --rm --label kp2.lab=1 --name "h2-client-$2" --network "$NET" \
  --cap-drop ALL --security-opt no-new-privileges --user 501:20 --pids-limit 256 --memory 2g --cpus 2 \
  --read-only --tmpfs /tmp --init -v "$WORK:/work" -w /work \
  -v "$HERE/scripts:/scripts:ro" -v "$HERE/out/certs:/certs:ro" \
  kp2-clients:h2 sh "/scripts/$1" > "$HERE/out/$2.txt" 2>&1
echo "$2 exit=$? results: $(grep -c '^RESULT' "$HERE/out/$2.txt")"
grep '^RESULT' "$HERE/out/$2.txt"
rm -rf "$WORK"
