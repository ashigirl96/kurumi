#!/bin/sh
# H1 lab: sh infra.sh up|down. Names start with kh1-, label kh1.lab=1. Mac (Docker Desktop) only.
#   kh1-ext (bridge 10.251.10.0/24): fakes + every gateway's upstream side
#   kh1-int (--internal 10.251.11.0/24): agent containers + gateways' data side
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
IMAGE=kurumi-agent:sdk-0.3.332
CANARY_GH=CANARY_REAL_GH_4b7e19d2c6a0
CANARY_MODEL=CANARY_REAL_MODEL_8d2f60a1e93c
ADMIN_SECRET=adm-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
RUN="$HERE/out/run"
PKI="$HERE/out/pki"

down() {
  ids=$(docker ps -aq --filter label=kh1.lab=1; docker ps -aq --filter label=kurumi.agent=h1)
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1 || true
  docker network rm kh1-int kh1-ext >/dev/null 2>&1 || true
  docker volume rm kh1-agcfg >/dev/null 2>&1 || true
}

pki() {
  mkdir -p "$PKI"
  [ -f "$PKI/api.crt" ] && return 0
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj /CN=kh1-upstream-ca -keyout "$PKI/ca.key" -out "$PKI/ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj /CN=api.github.test -keyout "$PKI/api.key" -out "$PKI/api.csr" 2>/dev/null
  printf 'subjectAltName=DNS:api.github.test,DNS:localhost,IP:127.0.0.1\n' > "$PKI/api.ext"
  openssl x509 -req -in "$PKI/api.csr" -CA "$PKI/ca.crt" -CAkey "$PKI/ca.key" -CAcreateserial -days 7 -extfile "$PKI/api.ext" -out "$PKI/api.crt" 2>/dev/null
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj /CN=kh1-iron-mitm-ca \
    -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign \
    -keyout "$PKI/iron-ca.key" -out "$PKI/iron-ca.crt" 2>/dev/null
  chmod 644 "$PKI"/*
}

iron_config() {
  mkdir -p "$RUN/iron"
  cat > "$RUN/iron/iron.yaml" <<EOF
dns:
  listen: ":53"
  proxy_ip: "10.251.11.50"
  passthrough: ["*.pass.test"]
proxy:
  http_listen: ":80"
  https_listen: ":443"
  tunnel_listen: ":8080"
tls:
  mode: "mitm"
  ca_cert: "/pki/iron-ca.crt"
  ca_key: "/pki/iron-ca.key"
transforms:
  - name: allowlist
    config:
      rules:
        - host: "api.github.test"
          methods: ["GET"]
          paths: ["/repos/a/b/*", "/echo", "/redirect"]
        - host: "api.github.test"
          methods: ["POST"]
          paths: ["/echo"]
  - name: secrets
    config:
      secrets:
        - source: { type: env, var: GH_REAL }
          replace:
            proxy_value: "kurumi-fake-iron-static"
            match_headers: ["Authorization"]
            match_body: true
            require: true
          rules:
            - host: "api.github.test"
log:
  level: "info"
EOF
}

wait_log() { # container pattern
  for i in $(seq 1 40); do docker logs "$1" 2>&1 | grep -q "$2" && return 0; sleep 0.25; done
  echo "$1 did not log '$2'"; docker logs "$1" 2>&1 | tail -20; return 1
}

up() {
  down
  mkdir -p "$RUN/ag"
  pki
  iron_config
  printf '%s' "$ADMIN_SECRET" > "$RUN/admin-secret"
  CANARY_MODEL=$CANARY_MODEL CANARY_GH=$CANARY_GH bun "$HERE/gateway/ag-config.ts"

  docker network create --subnet 10.251.10.0/24 --label kh1.lab=1 kh1-ext >/dev/null
  docker network create --internal --subnet 10.251.11.0/24 --label kh1.lab=1 kh1-int >/dev/null
  L="--label kh1.lab=1"

  docker run -d $L --name kh1-gh --network kh1-ext --network-alias api.github.test -p 127.0.0.1:18443:443 \
    -e CANARY_GH=$CANARY_GH -v "$HERE/fakes:/fakes:ro" -v "$PKI:/pki:ro" $IMAGE bun /fakes/fake-github.ts >/dev/null
  docker run -d $L --name kh1-model --network kh1-ext --network-alias model.test -p 127.0.0.1:19000:9000 \
    -e CANARY_REAL=$CANARY_MODEL -v "$HERE/../premise/fakes:/pf:ro" $IMAGE bun /pf/fake-upstream.ts >/dev/null
  docker run -d $L --name kh1-sink --network kh1-ext --network-alias sink.test --ip 10.251.10.80 \
    -v "$HERE/../premise/fakes:/pf:ro" $IMAGE bun /pf/sink.ts >/dev/null
  docker run -d $L --name kh1-dns --network kh1-ext --ip 10.251.10.53 \
    -v "$HERE/../premise/fakes:/pf:ro" $IMAGE bun /pf/fake-dns.ts >/dev/null

  # A named volume, not a bind mount: Mac-side writes to a bind mount raise no inotify event in the VM.
  docker volume create --label kh1.lab=1 kh1-agcfg >/dev/null
  docker run --rm -i -v kh1-agcfg:/cfg --entrypoint sh $IMAGE -c "cat > /cfg/config.yaml" < "$RUN/ag/config.yaml"
  # (1) agentgateway v1.7.0, binary from dl/ run in the Kurumi image.
  docker create $L --name kh1-ag --network kh1-ext --ip 10.251.10.20 -p 127.0.0.1:28081:8081 \
    --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
    -v "$HERE/dl/agentgateway:/ag:ro" -v kh1-agcfg:/cfg -v "$PKI:/pki:ro" \
    --entrypoint /ag/agentgateway-linux-arm64 $IMAGE -f /cfg/config.yaml >/dev/null
  docker network connect --ip 10.251.11.20 kh1-int kh1-ag
  # (2b) minimal gateway as a separate container; admin on the ext address only.
  docker create $L --name kh1-mg --network kh1-ext --ip 10.251.10.30 -p 127.0.0.1:39901:9901 -p 127.0.0.1:38081:8081 \
    --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp \
    -e CANARY_MODEL=$CANARY_MODEL -e CANARY_GH=$CANARY_GH -e ADMIN_SECRET=$ADMIN_SECRET -e ADMIN_HOST=10.251.10.30 -e GH_CA_FILE=/pki/ca.crt \
    -v "$HERE/gateway:/gw:ro" -v "$PKI:/pki:ro" $IMAGE bun /gw/kurumi-gw.ts >/dev/null
  docker network connect --ip 10.251.11.30 kh1-int kh1-mg
  # (2a) minimal gateway inside the host process: this forwarder stands in for the Linux bridge address.
  docker create $L --name kh1-fwd --network kh1-ext --cap-drop ALL --security-opt no-new-privileges --read-only \
    -v "$HERE/fakes:/fakes:ro" $IMAGE bun /fakes/tcp-fwd.ts 8080:host.docker.internal:18080 8081:host.docker.internal:18081 >/dev/null
  docker network connect --ip 10.251.11.40 kh1-int kh1-fwd
  # (3) iron-proxy 0.61.0 MITM; its own upstream resolver is the fake DNS so any recursion is logged.
  docker create $L --name kh1-iron --network kh1-ext --ip 10.251.10.50 --dns 10.251.10.53 \
    -e GH_REAL=$CANARY_GH -e SSL_CERT_FILE=/pki/ca.crt \
    -v "$HERE/dl/iron-proxy/x:/iron:ro" -v "$RUN/iron:/etc/iron:ro" -v "$PKI:/pki:ro" \
    --entrypoint /iron/iron-proxy $IMAGE -config /etc/iron/iron.yaml >/dev/null
  docker network connect --ip 10.251.11.50 kh1-int kh1-iron

  docker start kh1-ag >/dev/null
  docker start kh1-mg >/dev/null
  docker start kh1-iron >/dev/null
  docker start kh1-fwd >/dev/null
  wait_log kh1-gh listening; wait_log kh1-model listening; wait_log kh1-sink listening; wait_log kh1-dns listening
  wait_log kh1-mg listening; wait_log kh1-fwd 'fwd listening'
  sleep 2
  docker ps --filter label=kh1.lab=1 --format '{{.Names}} {{.Status}}'
  echo "infra up"
}

"$1"
