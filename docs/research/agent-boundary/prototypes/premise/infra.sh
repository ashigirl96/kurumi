#!/bin/sh
# Lab infra: --internal agent network with the dev relay as its only other member; fakes on a
# normal bridge. Usage: sh infra.sh up|down. All names start with kp- and carry label kp.lab=1.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=kurumi-agent:sdk-0.3.332
CANARY=CANARY_REAL_9f1c2e7a5b3d
EXT_SUBNET=10.250.77.0/24
DNS_IP=10.250.77.53
SINK_IP=10.250.77.80
FAKE_MODEL_BASH=${FAKE_MODEL_BASH:-sh /work/.tools/lint.sh}

down() {
  docker rm -f kp-gw kp-upstream kp-dns kp-sink >/dev/null 2>&1 || true
  ids=$(docker ps -aq --filter label=kurumi.agent=premise)
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 || true
  docker network rm kp-internal kp-ext >/dev/null 2>&1 || true
}

up() {
  down
  mkdir -p "$HERE/out/run"
  # The only change to the repo's dev relay: the upstream comes from UPSTREAM so it hits a local fake.
  sed "s|^const upstream = 'https://api.anthropic.com'|const upstream = process.env['UPSTREAM'] ?? 'https://api.anthropic.com'|" \
    "$HERE/repo/packages/agent-runtime/src/real/dev-relay.ts" > "$HERE/out/run/dev-relay.ts"
  diff "$HERE/repo/packages/agent-runtime/src/real/dev-relay.ts" "$HERE/out/run/dev-relay.ts" > "$HERE/out/run/dev-relay.diff" || true
  grep -q "process.env\['UPSTREAM'\]" "$HERE/out/run/dev-relay.ts"

  docker network create --internal --label kp.lab=1 kp-internal >/dev/null
  docker network create --subnet $EXT_SUBNET --label kp.lab=1 kp-ext >/dev/null

  docker run -d --name kp-upstream --label kp.lab=1 --network kp-ext \
    -e CANARY_REAL=$CANARY -e FAKE_MODEL_BASH="$FAKE_MODEL_BASH" \
    -v "$HERE/fakes:/fakes:ro" $IMAGE bun /fakes/fake-upstream.ts >/dev/null
  docker run -d --name kp-dns --label kp.lab=1 --network kp-ext --ip $DNS_IP \
    -v "$HERE/fakes:/fakes:ro" $IMAGE bun /fakes/fake-dns.ts >/dev/null
  docker run -d --name kp-sink --label kp.lab=1 --network kp-ext --ip $SINK_IP \
    -v "$HERE/fakes:/fakes:ro" $IMAGE bun /fakes/sink.ts >/dev/null

  # Same flags as dev-env.ts `up`, except the network (kp-ext, so it can resolve kp-upstream).
  CLAUDE_REAL_TOKEN=$CANARY docker create --name kp-gw --label kp.lab=1 --network kp-ext \
    --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
    -e CLAUDE_REAL_TOKEN -e UPSTREAM=http://kp-upstream:9000 \
    -v "$HERE/out/run/dev-relay.ts:/relay/dev-relay.ts:ro" $IMAGE bun /relay/dev-relay.ts >/dev/null
  docker network connect kp-internal kp-gw
  docker start kp-gw >/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    if docker logs kp-gw 2>&1 | grep -q listening && docker logs kp-upstream 2>&1 | grep -q listening \
      && docker logs kp-dns 2>&1 | grep -q listening; then
      echo "infra up"; return 0
    fi
    sleep 0.5
  done
  echo "infra did not start"; docker logs kp-gw; docker logs kp-upstream; docker logs kp-dns; exit 1
}

"$1"
