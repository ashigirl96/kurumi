#!/bin/sh
# Reruns slice 1 end to end: sh run-all.sh. Needs Docker and the image kurumi-agent:sdk-0.3.332.
# Uses only fake canaries and local fakes; no Anthropic endpoint, no real credential.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
sh ../setup.sh >/dev/null || exit 1
rm -rf out && mkdir -p out
trap 'sh infra.sh down' EXIT
sh infra.sh up || exit 1

fail=0
for s in dns attacker realcli relay paths; do sh scripts/run.sh $s || fail=1; done

check() { if grep -q -- "$2" "out/$1.txt"; then echo "PASS $3"; else echo "FAIL $3"; fail=1; fi; }
check dns '"d2_forwarded_with_dns_flag": false' 'DNS: internal network does not forward outside names to a resolver we control'
check dns '"d3_control_forwarded": true' 'DNS: positive control on a non-internal network does forward'
check attacker '"toolUseId": "toolu_FORGED_ASK_1"' 'stdio: forged hook_callback creates a tool_calls row'
check attacker 'List files in the workspace (read-only, safe)' 'stdio: forged hook input reaches the human as an Approval Request'
check attacker '"body": "sent with an id the hook never saw"' 'stdio: send_message delivers with an id no hook saw'
check attacker 'ATTACKER FINAL' 'stdio: spoofed result becomes the final Outbound Message'
check attacker '"status": "lost"' 'stdio: spoofed error result marks the session lost'
check attacker 'SYSTEM NOTICE FROM KURUMI' 'stdio: forged tool input is quoted in the next turn prompt under the host notice'
check attacker '"denied-but-done"' 'hook: a denied request is performed anyway'
check realcli 'INJECTED FINAL: written by a Bash child' 'real CLI: a Bash child writes into the CLI stdout and the host delivers its final'
check realcli 'INJECTED approval text' 'real CLI: a Bash child raises an Approval Request with its own text'
check relay 'GET /r2a -> 200' 'dev relay: any token with the prefix is accepted'
check relay '"authorization":"Bearer CANARY_REAL_9f1c2e7a5b3d"' 'dev relay: an echoing upstream reflects the swapped-in credential back into the container'
check paths 'exfil sink by IP 10.250.77.80:80 -> blocked' 'paths: direct IP egress blocked (Mac only)'
grep -rl 'CANARY_REAL' out/*.txt | sed 's/^/canary appears in evidence file: /'
exit $fail
