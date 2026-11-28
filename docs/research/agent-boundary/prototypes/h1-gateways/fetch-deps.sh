#!/bin/sh
# Downloads the untrusted gateway binaries into dl/ and checks them against the release checksums.
# They only ever run inside containers on the lab networks.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
D="$HERE/dl"
mkdir -p "$D/agentgateway" "$D/iron-proxy/x"
[ -f "$D/agentgateway/agentgateway-linux-arm64" ] || gh release download v1.7.0 -R agentgateway/agentgateway -p 'agentgateway-linux-arm64*' -D "$D/agentgateway"
[ -f "$D/iron-proxy/iron-proxy_0.61.0_linux_arm64.tar.gz" ] || gh release download v0.61.0 -R paradigmxyz/iron-proxy -p 'iron-proxy_0.61.0_linux_arm64.tar.gz' -p checksums.txt -D "$D/iron-proxy"
(cd "$D/agentgateway" && sed "s# outputs/# #" agentgateway-linux-arm64.sha256 | shasum -a 256 -c -)
(cd "$D/iron-proxy" && grep linux_arm64 checksums.txt | shasum -a 256 -c -)
[ -f "$D/iron-proxy/x/iron-proxy" ] || tar -xzf "$D/iron-proxy/iron-proxy_0.61.0_linux_arm64.tar.gz" -C "$D/iron-proxy/x"
chmod +x "$D/agentgateway/agentgateway-linux-arm64" "$D/iron-proxy/x/iron-proxy"
ls -la "$D/agentgateway" "$D/iron-proxy" "$D/iron-proxy/x"
