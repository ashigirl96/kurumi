#!/bin/sh
# E9: agentgateway v1.7.0 CEL body rules. Needs `sh infra.sh up` (h2-ext + fakes). Output: out/e9.txt
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
docker rm -f h2-agw >/dev/null 2>&1; docker network rm h2-ag-int >/dev/null 2>&1
docker network create --internal --label kp2.lab=1 h2-ag-int >/dev/null
docker create --name h2-agw --label kp2.lab=1 --network h2-ext \
  -v "$HERE/dl/agentgateway/agentgateway-linux-arm64:/agw:ro" -v "$HERE/fakes/agw.yaml:/agw.yaml:ro" -v "$HERE/out/certs:/certs:ro" \
  --entrypoint /agw kp2-clients:h2 -f /agw.yaml >/dev/null
docker network connect --alias agw --alias api.github.localhost h2-ag-int h2-agw
docker start h2-agw >/dev/null
sleep 3
docker logs h2-agw 2>&1 | tail -3
sh "$HERE/scripts/client.sh" e9-client.sh e9 h2-ag-int >/dev/null
grep -E '^(CASE|RESULT)' "$HERE/out/e9.txt"
docker logs h2-agw > "$HERE/out/e9-agw.log" 2>&1
docker rm -f h2-agw >/dev/null; docker network rm h2-ag-int >/dev/null
