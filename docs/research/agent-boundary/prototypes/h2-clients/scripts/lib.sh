# Sourced by the in-container client scripts.
# t <name> <expect-regex> <command...>: runs the command, prints its output, then one RESULT line.
T=kurumi-fake-turn1
t() {
  name=$1; expect=$2; shift 2
  echo "===== $name"
  echo "\$ $*"
  o=$("$@" 2>&1); c=$?
  printf '%s\n' "$o" | tail -25
  if [ $c -eq 0 ] && printf '%s' "$o" | grep -Eq -- "$expect"; then
    echo "RESULT $name works"
  else
    echo "RESULT $name breaks (exit $c): $(printf '%s' "$o" | grep -v '^\s*$' | tail -1 | cut -c1-200)"
  fi
}
claude_run() { # prompt, extra args...: the real CLI, stream-json, 120 s cap
  p=$1; shift
  timeout 120 claude -p "$p" --output-format stream-json --verbose "$@" < /dev/null 2>&1 | node /scripts/summ.js
}
