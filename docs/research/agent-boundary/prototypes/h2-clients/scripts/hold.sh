#!/bin/sh
# U5: hold each client's request at a gateway that answers after HOLD_SECONDS (default 960 = 16 min),
# all clients in parallel. Needs `sh infra.sh up` first (h2-ext, h2-fakes, h2-iron).
# Usage: sh scripts/hold.sh [hold-seconds]   Output: out/hold/
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
HOLD_S=${1:-960}
CANARY=CANARY_REAL_9f1c2e7a5b3d
O=$HERE/out/hold
rm -rf "$O"; mkdir -p "$O"
CLIENTS="curl curl-via-iron git-push npm-install npm-publish gh pip node-fetch claude-model claude-webfetch"
RULES='[{"host":"echo.gw","method":"POST"},{"host":"holdup.example","method":"POST"},
{"host":"git.gw","method":"POST","path":"/a/b.git/git-receive-pack"},{"host":"npm.gw","method":"GET","path":"/left-pad-fake$"},
{"host":"npm.gw","method":"PUT"},{"host":"api.gw","method":"POST","path":"/api/v3/repos/a/b/issues"},
{"host":"pypi.gw","method":"GET","path":"/simple/"},{"host":"modelhold.gw","method":"POST","path":"/v1/messages"},
{"host":"docs.gw","method":"GET","path":"/page"}]'
GW_NAMES="api.gw git.gw npm.gw pypi.gw files.gw mcp.gw model.gw modelhold.gw docs.gw echo.gw"

docker rm -f h2-holdgw >/dev/null 2>&1; docker network rm h2-hold-int >/dev/null 2>&1
docker network create --internal --label kp2.lab=1 h2-hold-int >/dev/null
docker create --name h2-holdgw --label kp2.lab=1 --network h2-ext --network-alias holdup.example \
  -e CANARY_REAL=$CANARY -e GW_NAME=hold -e HOLD="$RULES" -e HOLD_SECONDS="$HOLD_S" \
  -v "$HERE/fakes:/fakes:ro" -v "$HERE/out/certs:/certs:ro" -v "$O:/out" kp2-clients:h2 bun /fakes/gw.ts >/dev/null
aliases=""; for n in $GW_NAMES; do aliases="$aliases --alias $n"; done
docker network connect $aliases h2-hold-int h2-holdgw
docker start h2-holdgw >/dev/null
sleep 2
echo "hold run start $(date +%s) hold=${HOLD_S}s"

for c in $CLIENTS; do
  net=h2-hold-int; [ "$c" = curl-via-iron ] && net=h2-int # gitleaks:allow
  docker run -d --label kp2.lab=1 --name "h2-hold-$c" --network "$net" \
    --cap-drop ALL --security-opt no-new-privileges --user 501:20 --pids-limit 256 --memory 2g --cpus 2 \
    --read-only --tmpfs /tmp --init -v "$HERE/scripts:/scripts:ro" -v "$HERE/out/certs:/certs:ro" \
    kp2-clients:h2 sh /scripts/hold-client.sh "$c" >/dev/null
done

# Wait until every client exited, or hold + 180 s, whichever is first.
deadline=$(( $(date +%s) + HOLD_S + 180 ))
while [ "$(date +%s)" -lt $deadline ]; do
  running=$(docker ps -q --filter label=kp2.lab=1 --filter name=h2-hold- --filter status=running | grep -c . || true)
  [ "$running" -eq 0 ] && break
  sleep 10
done
for c in $CLIENTS; do
  state=$(docker inspect -f '{{.State.Status}}' "h2-hold-$c" 2>/dev/null)
  docker logs "h2-hold-$c" > "$O/$c.txt" 2>&1
  echo "container_state_at_collection=$state" >> "$O/$c.txt"
done
docker rm -f $(for c in $CLIENTS; do echo "h2-hold-$c"; done) h2-holdgw >/dev/null 2>&1
docker network rm h2-hold-int >/dev/null 2>&1
echo "hold run end $(date +%s)"
python3 -I "$HERE/scripts/hold-report.py" "$O" | tee "$O/report.txt"
