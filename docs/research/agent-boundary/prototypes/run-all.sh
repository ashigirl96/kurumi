#!/bin/sh
# Reruns the whole agent-boundary investigation: sh run-all.sh [--skip-hold]
# Runs setup, then the slices premise, h1-gateways, h2-clients in order; each prints its PASS/FAIL lines
# and removes the containers and networks it started. --skip-hold goes to h2-clients only (about 8
# minutes in all instead of about 25). Needs Docker Desktop for Mac (arm64), bun, gh, openssl, python3.
set -u
P=$(cd "$(dirname "$0")" && pwd)
sh "$P/setup.sh" || exit 1

fail=0
for s in premise h1-gateways h2-clients; do
  echo "===== $s"
  if [ "$s" = h2-clients ]; then sh "$P/$s/run-all.sh" "$@"; else sh "$P/$s/run-all.sh"; fi
  code=$?
  echo "===== $s exit=$code"
  [ $code = 0 ] || fail=1
done

# The evidence lands in a public repo: the home path becomes ~, and the CLI's per-run messaging token
# (dead with its container, but a secret to gitleaks and the pre-push hook) is masked.
grep -rlIE -e "$HOME" -e 'CLAUDE_CODE_MESSAGING_TOKEN=[0-9a-f]' "$P"/*/out 2>/dev/null | while read -r f; do
  perl -pi -e 's|\Q$ENV{HOME}\E|~|g; s|(CLAUDE_CODE_MESSAGING_TOKEN=)[0-9a-f]+|$1<per-run>|g' "$f"
done
exit $fail
