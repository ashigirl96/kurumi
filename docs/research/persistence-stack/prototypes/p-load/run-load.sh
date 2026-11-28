cd "$(dirname "$0")"
for c in "idle NORMAL" "load NORMAL" "load FULL" "load FULLFSYNC" "sleepy NORMAL" "sleepy FULL" "sleepy FULLFSYNC"; do
  bun load.ts $c 25
done
