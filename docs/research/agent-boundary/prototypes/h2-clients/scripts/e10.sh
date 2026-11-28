#!/bin/sh
# E10: does agentgateway v1.7.0 hold a request in extAuthz for AUTHZ_SLEEP seconds (default 960)?
# Usage: sh scripts/e10.sh [seconds] [out-subdir]. curl (no client timeout) through :80 (default timeouts) and :3002 (raised). Needs `sh infra.sh up`.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
S=${1:-960}
O=$HERE/out/${2:-e10}; rm -rf "$O"; mkdir -p "$O"
docker rm -f h2-authz h2-agw10 h2-e10-client >/dev/null 2>&1; docker network rm h2-ag10-int >/dev/null 2>&1
docker network create --internal --label kp2.lab=1 h2-ag10-int >/dev/null
docker run -d --name h2-authz --label kp2.lab=1 --network h2-ext --network-alias authz -e AUTHZ_SLEEP="$S" \
  -v "$HERE/fakes:/fakes:ro" kp2-clients:h2 bun /fakes/authz.ts >/dev/null
docker create --name h2-agw10 --label kp2.lab=1 --network h2-ext \
  -v "$HERE/dl/agentgateway/agentgateway-linux-arm64:/agw:ro" -v "$HERE/fakes/agw-e10.yaml:/agw.yaml:ro" -v "$HERE/out/certs:/certs:ro" \
  --entrypoint /agw kp2-clients:h2 -f /agw.yaml >/dev/null
docker network connect --alias agw h2-ag10-int h2-agw10
docker start h2-agw10 >/dev/null
sleep 3
docker run --rm --label kp2.lab=1 --name h2-e10-client --network h2-ag10-int --cap-drop ALL --user 501:20 --read-only kp2-clients:h2 sh -c '
  for p in 80 3002; do
    ( s=$(date +%s); r=$(curl -sS -X POST --data approve-me -w " http=%{http_code} t=%{time_total}" http://agw:$p/x 2>&1); echo "port $p started $s ended $(date +%s): $r" ) &
  done; wait' > "$O/client.txt" 2>&1
docker logs h2-authz > "$O/authz.log" 2>&1
docker logs h2-agw10 > "$O/agw.log" 2>&1
docker rm -f h2-authz h2-agw10 >/dev/null; docker network rm h2-ag10-int >/dev/null
cat "$O/client.txt"; grep -v listening "$O/authz.log"
