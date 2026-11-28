#!/bin/sh
# H2 lab: sh infra.sh up|down. Networks h2-int (--internal: clients + gateways) and h2-ext (gateways +
# fakes). Every container and network carries label kp2.lab=1. Mac Docker Desktop only was tested.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
IMG=kp2-clients:h2
CANARY=CANARY_REAL_9f1c2e7a5b3d
OUT=${OUT:-$HERE/out/run}
FAKE_NAMES="api.github.com github.com registry.npmjs.org pypi.org files.pythonhosted.org mcp.example.com docs.example.com echo.example.com api.anthropic.com"
GW_NAMES="api.gw git.gw npm.gw pypi.gw files.gw mcp.gw model.gw docs.gw echo.gw graphql.gw pypirw.gw api.github.localhost"

down() {
  ids=$(docker ps -aq --filter label=kp2.lab=1)
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 || true
  nets=$(docker network ls -q --filter label=kp2.lab=1)
  [ -n "$nets" ] && docker network rm $nets >/dev/null 2>&1 || true
  return 0
}

aliases() { for n in $2; do printf -- '%s %s ' "$1" "$n"; done; }

wait_log() { # container pattern
  for i in $(seq 1 60); do docker logs "$1" 2>&1 | grep -q "$2" && return 0; sleep 0.5; done
  echo "$1 did not start"; docker logs "$1" 2>&1 | tail -20; return 1
}

up() {
  down
  docker image inspect $IMG >/dev/null 2>&1 || docker build -q -t $IMG "$HERE" >/dev/null
  sh "$HERE/scripts/certs.sh" "$HERE/out/certs"
  mkdir -p "$OUT"
  docker network create --label kp2.lab=1 h2-ext >/dev/null
  docker network create --internal --label kp2.lab=1 h2-int >/dev/null

  docker run -d --name h2-fakes --label kp2.lab=1 --network h2-ext $(aliases --network-alias "$FAKE_NAMES") \
    -e CANARY_REAL=$CANARY -v "$HERE/fakes:/fakes:ro" -v "$HERE/out/certs:/certs:ro" -v "$OUT:/out" \
    $IMG bun /fakes/fakes.ts >/dev/null

  # Base-URL gateway: on h2-ext under its own name, on h2-int under the *.gw aliases.
  docker create --name h2-gw --label kp2.lab=1 --network h2-ext \
    -e CANARY_REAL=$CANARY -e GW_NAME=gw \
    -v "$HERE/fakes:/fakes:ro" -v "$HERE/out/certs:/certs:ro" -v "$OUT:/out" \
    $IMG bun /fakes/gw.ts >/dev/null
  docker network connect $(aliases --alias "$GW_NAMES") h2-int h2-gw
  docker start h2-gw >/dev/null

  # iron-proxy MITM: on h2-int as "iron"; upstream TLS trusts the fake public CA via SSL_CERT_FILE.
  sed "s|\${UPSTREAM_TIMEOUT}|${IRON_UPSTREAM_TIMEOUT:-30s}|" "$HERE/fakes/iron.yaml" > "$OUT/iron.yaml"
  docker create --name h2-iron --label kp2.lab=1 --network h2-ext \
    -e CANARY_REAL=$CANARY -e SSL_CERT_FILE=/certs/pub-ca.crt \
    -v "$OUT/iron.yaml:/etc/iron-proxy/proxy.yaml:ro" -v "$HERE/out/certs:/certs:ro" \
    ironsh/iron-proxy:0.61.0 -config /etc/iron-proxy/proxy.yaml >/dev/null
  docker network connect --alias iron h2-int h2-iron
  docker start h2-iron >/dev/null

  wait_log h2-fakes listening
  wait_log h2-gw listening
  sleep 2
  docker ps --filter label=kp2.lab=1 --format '{{.Names}} {{.Status}}'
  echo "infra up"
}

"$1"
