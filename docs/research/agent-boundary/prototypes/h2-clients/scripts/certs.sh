#!/bin/sh
# Three throwaway CAs, all generated here (no real key anywhere):
#   pub  = stands in for the public web PKI; signs the fakes' certs (real names like api.github.com)
#   gw   = private CA for the base-URL gateway's own names (*.gw), used only where a client insists on TLS
#   iron = iron-proxy's MITM CA
set -eu
D=${1:?out dir}
mkdir -p "$D"
cd "$D"
[ -f done ] && exit 0
ca() {
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$1-ca.key" -out "$1-ca.crt" -days 30 -subj "/CN=h2 fake $1 CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
}
leaf() { # name ca sans
  openssl req -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -subj "/CN=$1" 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' "$3" > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA "$2-ca.crt" -CAkey "$2-ca.key" -CAcreateserial -out "$1.crt" -days 30 -extfile "$1.ext" 2>/dev/null
}
ca pub; ca gw; ca iron
leaf fakes pub "DNS:api.github.com,DNS:github.com,DNS:registry.npmjs.org,DNS:pypi.org,DNS:files.pythonhosted.org,DNS:mcp.example.com,DNS:docs.example.com,DNS:echo.example.com,DNS:api.anthropic.com"
leaf gw gw "DNS:api.gw,DNS:git.gw,DNS:npm.gw,DNS:pypi.gw,DNS:files.gw,DNS:mcp.gw,DNS:model.gw,DNS:docs.gw,DNS:echo.gw,DNS:graphql.gw"
cat pub-ca.crt gw-ca.crt > client-gw-bundle.crt
chmod 644 ./*
touch done
