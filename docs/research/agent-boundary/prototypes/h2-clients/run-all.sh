#!/bin/sh
# Reruns slice H2 end to end: sh run-all.sh [--skip-hold]
# Needs Docker and kurumi-agent:sdk-0.3.332. Fake canaries and local fakes only; no real credential,
# no Anthropic endpoint, no external account. The 16-minute hold runs in parallel with the rest.
# Leaves evidence in out/, removes every container and network it started (label kp2.lab=1).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
SKIP_HOLD=0; [ "${1:-}" = --skip-hold ] && SKIP_HOLD=1
sh ../setup.sh >/dev/null || exit 1
sh scripts/download.sh >/dev/null || exit 1
docker build -q -t kp2-clients:h2 . >/dev/null || exit 1
# --skip-hold keeps the last 16-minute evidence (out/hold, out/e10) and reruns everything else.
mkdir -p out
if [ $SKIP_HOLD = 1 ]; then
  find out -mindepth 1 -maxdepth 1 ! -name hold ! -name hold-run.log ! -name e10 ! -name e10-run.log -exec rm -rf {} +
else
  rm -rf out/*
fi
trap 'sh infra.sh down' EXIT
sh infra.sh up >/dev/null || exit 1
sh scripts/probe-image.sh kp2-clients:h2 > out/versions.txt 2>&1
docker image inspect ironsh/iron-proxy:0.61.0 --format 'iron-proxy {{.Id}}' >> out/versions.txt

hold_pid=""; e10_pid=""
if [ $SKIP_HOLD = 0 ]; then
  sh scripts/hold.sh 960 > out/hold-run.log 2>&1 & hold_pid=$!
  sh scripts/e10.sh 960 > out/e10-run.log 2>&1 & e10_pid=$!
else
  sh scripts/e10.sh 8 e10-short > out/e10-short-run.log 2>&1
fi

sh scripts/client.sh clients-baseurl.sh baseurl >/dev/null
sh scripts/client.sh clients-mitm.sh mitm >/dev/null
sh scripts/client.sh probe-webfetch-tool.sh webfetch-tool >/dev/null
sh scripts/client.sh clients-u4.sh u4 >/dev/null
python3 -I scripts/u4-analyze.py out/run > out/u4-analysis.txt 2>&1
sh scripts/e9.sh > /dev/null
[ -n "$hold_pid" ] && { echo "waiting for the 16-minute hold runs"; wait $hold_pid; wait $e10_pid; }

fail=0
r() { # file result-name expected(works|breaks) description
  if grep -q "^RESULT $2 $3" "out/$1.txt"; then echo "PASS $4"; else echo "FAIL $4 (wanted $2 $3)"; fail=1; fi
}
c() { if grep -q -- "$2" "out/$1"; then echo "PASS $3"; else echo "FAIL $3"; fail=1; fi; }
r baseurl curl-post-issue works 'base-URL: curl'
r baseurl gh-http-github.localhost works 'base-URL: gh over plain http only via GH_HOST=github.localhost'
r baseurl gh-tls-no-ca breaks 'base-URL: gh with GH_HOST=<gateway> needs TLS on the gateway name'
r baseurl gh-tls-private-ca works 'base-URL: gh works with a private CA in SSL_CERT_FILE'
r baseurl git-push-force works 'base-URL: git clone/push/force-push via url.insteadOf + http.extraHeader'
r baseurl npm-publish works 'base-URL: npm install and publish via registry='
r baseurl pip-install-index-only breaks 'base-URL: pip breaks on absolute files.pythonhosted.org links'
r baseurl pip-install-gw-rewrites-links works 'base-URL: pip works when the gateway rewrites index links'
r baseurl webfetch-http-default breaks 'base-URL: WebFetch blocked by the domain preflight by default'
r baseurl webfetch-http-skip-preflight breaks 'base-URL: WebFetch upgrades http to https, so the gateway name needs TLS'
r baseurl webfetch-https-gw-ca-skip-preflight works 'base-URL: WebFetch works with skipWebFetchPreflight + NODE_EXTRA_CA_CERTS'
r baseurl webfetch-other-host breaks 'base-URL: WebFetch to any host the gateway does not front fails (no DNS)'
r baseurl mcp-remote-http works 'base-URL: remote MCP over http with the token in headers'
r mitm git-clone-SSL_CERT_FILE breaks 'MITM: git ignores SSL_CERT_FILE'
r mitm git-clone-GIT_SSL_CAINFO works 'MITM: git needs GIT_SSL_CAINFO'
r mitm npm-install-NODE_EXTRA_CA_CERTS works 'MITM: npm with NODE_EXTRA_CA_CERTS'
r mitm pip-SSL_CERT_FILE works 'MITM: pip with SSL_CERT_FILE'
r mitm node-fetch-NODE_EXTRA_CA_CERTS breaks 'MITM: Node 20 fetch ignores HTTPS_PROXY'
r mitm claude-model-NODE_EXTRA_CA_CERTS works 'MITM: Claude Code model call with NODE_EXTRA_CA_CERTS'
r mitm webfetch-skip-preflight works 'MITM: WebFetch with skipWebFetchPreflight'
r mitm mcp-remote-http works 'MITM: remote MCP'
r webfetch-tool model-base-url-unset breaks 'CLI offers no WebFetch tool when the model host is api.anthropic.com'
c u4-analysis.txt 'inspected==forwarded: 18/18' 'U4: every captured write reached the fake with identical bytes'
c u4-analysis.txt '| git-A | git-B-force | yes | misses the swap' 'U4: method/path binder misses a force push swap'
c u4-analysis.txt '| mp-A | mp-A-again | yes | accepts the re-send | rejects the same intent' 'U4: raw-bytes binder rejects a re-sent multipart (new boundary)'
c u4-analysis.txt 'not provable from the pack' 'U4: force push is not distinguishable on the wire without the upstream graph'
c e9.txt 'CASE allow-ok-gzip port=80 bytes=143 -> HTTP 403' 'E9: allow rule fails closed on gzip'
c e9.txt 'CASE allow-opswap-comment .* -> HTTP 200' 'E9: string-match CEL rule passes a different mutation'
c e9.txt 'CASE deny-del-over-limit .* -> HTTP 200' 'E9: deny rule fails open over the buffer limit'
c e9.txt 'CASE deny-del-gzip .* -> HTTP 200' 'E9: deny rule fails open on gzip'
E10=e10; [ $SKIP_HOLD = 1 ] && E10=e10-short
c $E10/client.txt 'port 80 .*http=403 t=2' 'E10: extAuthz with default timeouts denies after 2 s'
c $E10/client.txt 'port 3002 .*http=200' 'E10: extAuthz with raised timeouts holds until the authz answers'
if [ $SKIP_HOLD = 0 ]; then
  c hold/report.txt 'client ran 960 s, exit=0' 'U5: curl/git/gh wait out the 960 s hold'
  c hold/report.txt 'PUT npm.gw/pub-fake arrived +3' 'U5: npm publish re-sends the held write'
  c hold/report.txt 'http=502 t=30' 'U5: iron-proxy cuts the hold at 30 s by default'
  c e10/client.txt 't=960' 'E10: agentgateway extAuthz holds 960 s with raised timeouts'
fi
grep -l 'CANARY_REAL' out/*.txt out/hold/*.txt 2>/dev/null | sed 's/^/canary appears in client-side output: /'
exit $fail
