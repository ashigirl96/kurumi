# Reruns every check for both variants; output in out-<variant>.txt
D="$(cd "$(dirname "$0")" && pwd)"
for v in stable rc; do
  ( cd "$D/$v/apps/host" && {
    echo "### check 1"; sh check1.sh
    echo "### checks 2-5,7"; bun checks.ts
    echo "### check 6"; bun test inbox.test.ts 2>&1 | grep -vE '^\s*$'
  } ) > "$D/out-$v.txt" 2>&1
  echo "$v exit=$?"
done
