#!/bin/sh
# Prints which clients and versions an image has: sh probe-image.sh <image>
docker run --rm --entrypoint sh "$1" -c '
cat /etc/os-release | head -2; id
for c in git gh curl npm node pip pip3 python3 bun claude openssl; do printf "%s: " $c; command -v $c || echo missing; done
git --version 2>&1; curl --version 2>&1 | head -1; bun --version; claude --version 2>&1
node --version 2>&1; npm --version 2>&1; python3 --version 2>&1; pip3 --version 2>&1; gh --version 2>&1 | head -1
ls /usr/lib/git-core/git-http-backend 2>&1
echo "arch: $(uname -m)"
'
docker image inspect "$1" --format '{{json .Config.Env}} {{json .Config.Entrypoint}} {{json .Config.Cmd}} {{.Config.User}}'
