#!/bin/sh
# Fetches the untrusted third-party pieces into dl/ (idempotent). Nothing here is executed on the host.
set -eu
DL=$(cd "$(dirname "$0")/.." && pwd)/dl
mkdir -p "$DL/iron-proxy" "$DL/agentgateway"
docker image inspect ironsh/iron-proxy:0.61.0 >/dev/null 2>&1 || docker pull -q ironsh/iron-proxy:0.61.0
docker image inspect ironsh/iron-proxy:0.61.0 --format '{{.Id}} {{.Architecture}} {{json .RepoDigests}}' > "$DL/iron-proxy/image.txt"
GH=https://github.com/agentgateway/agentgateway/releases/download/v1.7.0
RAW=https://raw.githubusercontent.com/agentgateway/agentgateway/v1.7.0
cd "$DL/agentgateway"
if [ ! -f agentgateway-linux-arm64 ]; then
  curl -fsSL -o agentgateway-linux-arm64 "$GH/agentgateway-linux-arm64"
  curl -fsSL -o agentgateway-linux-arm64.sha256 "$GH/agentgateway-linux-arm64.sha256"
fi
want=$(awk '{print $1}' agentgateway-linux-arm64.sha256)
got=$(shasum -a 256 agentgateway-linux-arm64 | awk '{print $1}')
[ "$want" = "$got" ] || { echo "agentgateway sha256 mismatch"; exit 1; }
echo "agentgateway-linux-arm64 sha256 $got (matches release .sha256)" > sha.txt
chmod +x agentgateway-linux-arm64
for f in schema/config.md schema/cel.md; do
  out=$(echo "$f" | tr / _)
  [ -f "$out" ] || curl -fsSL -o "$out" "$RAW/$f" || echo "missing $f"
done
cd "$DL/iron-proxy"
for f in README.md iron-proxy.example.yaml; do
  [ -f "$f" ] || curl -fsSL -o "$f" "https://raw.githubusercontent.com/paradigmxyz/iron-proxy/v0.61.0/$f"
done
ls -la "$DL"/*
