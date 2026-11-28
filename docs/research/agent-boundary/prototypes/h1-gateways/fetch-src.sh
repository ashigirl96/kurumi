#!/bin/sh
# Source tarballs for reading config schemas only (never built or run).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
D="$HERE/dl/src"
mkdir -p "$D/agentgateway" "$D/iron-proxy"
[ -n "$(ls "$D/agentgateway")" ] || gh api repos/agentgateway/agentgateway/tarball/v1.7.0 | tar -xz -C "$D/agentgateway" --strip-components 1
[ -n "$(ls "$D/iron-proxy")" ] || gh api repos/paradigmxyz/iron-proxy/tarball/v0.61.0 | tar -xz -C "$D/iron-proxy" --strip-components 1
ls "$D/agentgateway" "$D/iron-proxy"
