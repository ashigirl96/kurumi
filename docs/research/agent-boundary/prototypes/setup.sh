#!/bin/sh
# Builds what the slices need but the repo does not carry (idempotent): premise/repo and h1-gateways/repo,
# each a copy of Kurumi at KURUMI_COMMIT with its dependencies, and the agent image.
# h1 adds its broker test tool and broker.diff. The gateway binaries in dl/ are fetched by each slice.
set -eu
P=$(cd "$(dirname "$0")" && pwd)
KURUMI_COMMIT=d0ee9ffc1c8866455dcffb155a606c2d257eed90
IMAGE=kurumi-agent:sdk-0.3.332
ROOT=$(git -C "$P" rev-parse --show-toplevel)

build_repo() { # slice
  R="$P/$1/repo"
  ln -sfn ../repo/packages/agent-runtime/node_modules "$P/$1/scripts/node_modules"
  [ -f "$R/KURUMI_COMMIT" ] && return 0
  rm -rf "$R"
  mkdir -p "$R"
  git -C "$ROOT" archive "$KURUMI_COMMIT" package.json tsconfig.json bun.lock packages/agent-runtime | tar -x -C "$R"
  (cd "$R" && bun install >/dev/null)
  if [ "$1" = h1-gateways ]; then
    cp "$P/h1-gateways/broker/broker-tool.ts" "$R/packages/agent-runtime/src/broker-tool.ts"
    patch -s -p0 -d "$R/packages/agent-runtime/src" < "$P/h1-gateways/broker.diff"
  fi
  # Written last, so an interrupted build is redone on the next run.
  echo "$KURUMI_COMMIT" > "$R/KURUMI_COMMIT"
}

build_repo premise
build_repo h1-gateways
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || docker build -q -t "$IMAGE" "$P/premise/repo/packages/agent-runtime/container" >/dev/null
echo "setup done: Kurumi $KURUMI_COMMIT, image $IMAGE"
