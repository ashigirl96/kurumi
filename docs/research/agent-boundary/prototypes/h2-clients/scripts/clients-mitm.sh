# Generality floor through iron-proxy 0.61.0 MITM: real hostnames, HTTPS_PROXY to the tunnel listener,
# trust in the iron CA. iron-proxy injects CANARY_REAL; clients that insist on a token get the fake one.
. /scripts/lib.sh
export HOME=/tmp
cd /tmp
P=http://iron:8080
export HTTPS_PROXY=$P HTTP_PROXY=$P https_proxy=$P http_proxy=$P
CA=/certs/iron-ca.crt
KURUMI_ARGS="--setting-sources= --strict-mcp-config --permission-mode=bypassPermissions --allow-dangerously-skip-permissions"

t curl-no-ca '"number":7' curl -sS -f -H 'content-type: application/json' -d '{"title":"from curl"}' https://api.github.com/repos/a/b/issues
t curl-SSL_CERT_FILE '"number":7' env SSL_CERT_FILE=$CA curl -sS -f -H 'content-type: application/json' -d '{"title":"from curl"}' https://api.github.com/repos/a/b/issues

t gh-no-ca 'full_name' env GH_TOKEN=$T gh api /repos/a/b
t gh-SSL_CERT_FILE 'full_name' env GH_TOKEN=$T SSL_CERT_FILE=$CA gh api /repos/a/b
t gh-issue-create 'issues/7' env GH_TOKEN=$T SSL_CERT_FILE=$CA gh issue create -R a/b --title 'gh title A' --body 'gh body A'
t gh-graphql-mutation 'number' env GH_TOKEN=$T SSL_CERT_FILE=$CA gh api graphql \
  -f query='mutation($t:String!){createIssue(input:{repositoryId:"R_1",title:$t}){issue{number}}}' -f t='graphql title A'

git config --global user.name agent; git config --global user.email agent@example.invalid
t git-clone-no-ca 'Cloning' git clone https://github.com/a/b.git /tmp/b0
t git-clone-SSL_CERT_FILE 'Cloning' env SSL_CERT_FILE=$CA git clone https://github.com/a/b.git /tmp/b1
t git-clone-GIT_SSL_CAINFO 'Cloning' env GIT_SSL_CAINFO=$CA git clone https://github.com/a/b.git /tmp/b
export GIT_SSL_CAINFO=$CA
cd /tmp/b
echo mitm > mitm.txt; git add mitm.txt; git commit -qm mitm
t git-push '-> main' git push origin main
git reset -q --hard HEAD~1; echo mitm2 > mitm2.txt; git add mitm2.txt; git commit -qm mitm-rewritten
t git-push-force 'forced update' git push --force origin main
cd /tmp

mkdir -p /tmp/proj && cd /tmp/proj && echo '{"name":"proj","version":"1.0.0"}' > package.json
t npm-install-no-ca 'added 1 package' npm install left-pad-fake --no-audit --no-fund
t npm-install-NODE_EXTRA_CA_CERTS 'added 1 package' env NODE_EXTRA_CA_CERTS=$CA npm install left-pad-fake --no-audit --no-fund
mkdir -p /tmp/pub && cd /tmp/pub && echo '{"name":"pub-fake","version":"1.0.0"}' > package.json && echo x > index.js
printf '//registry.npmjs.org/:_authToken=%s\n' $T > .npmrc
t npm-publish 'pub-fake@1.0.0' env NODE_EXTRA_CA_CERTS=$CA npm publish
cd /tmp

t pip-no-ca 'Successfully installed' pip install --no-cache-dir --break-system-packages --target /tmp/py0 fake-pkg
t pip-SSL_CERT_FILE 'Successfully installed' env SSL_CERT_FILE=$CA pip install --no-cache-dir --break-system-packages --target /tmp/py1 fake-pkg
t pip-PIP_CERT 'Successfully installed' env PIP_CERT=$CA pip install --no-cache-dir --break-system-packages --target /tmp/py2 fake-pkg

t node-fetch-NODE_EXTRA_CA_CERTS 'full_name' env NODE_EXTRA_CA_CERTS=$CA node -e \
  "fetch('https://api.github.com/repos/a/b').then(r=>r.text()).then(console.log).catch(e=>{console.log('ERR',e.cause?.code||e.message);process.exit(1)})"

export CLAUDE_CONFIG_DIR=/tmp/cfg CLAUDE_CODE_OAUTH_TOKEN=$T CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
mkdir -p /tmp/cfg
t claude-model-no-ca 'FINAL' claude_run 'say hi' $KURUMI_ARGS
export NODE_EXTRA_CA_CERTS=$CA
t claude-model-NODE_EXTRA_CA_CERTS 'FINAL' claude_run 'say hi' $KURUMI_ARGS
# With the model on the first-party host the CLI offered no WebFetch tool at all (see notes), so the
# WebFetch rows keep the model on the base-URL gateway (Kurumi's shape) and send only the fetch via MITM.
t webfetch-first-party-model-host 'marker-present=true' claude_run 'WEBFETCH_URL=https://docs.example.com/page fetch it' $KURUMI_ARGS \
  --settings '{"skipWebFetchPreflight":true}'
export ANTHROPIC_BASE_URL=http://model.gw NO_PROXY=model.gw no_proxy=model.gw
t webfetch-default-preflight 'marker-present=true' claude_run 'WEBFETCH_URL=https://docs.example.com/page fetch it' $KURUMI_ARGS
t webfetch-skip-preflight 'marker-present=true' claude_run 'WEBFETCH_URL=https://docs.example.com/page fetch it' $KURUMI_ARGS \
  --settings '{"skipWebFetchPreflight":true}'
unset ANTHROPIC_BASE_URL NO_PROXY no_proxy
MCP='{"mcpServers":{"fake":{"type":"http","url":"https://mcp.example.com/mcp"}}}'
t mcp-remote-http 'MCP-ECHO' claude_run 'USE_MCP call the echo tool' $KURUMI_ARGS --mcp-config "$MCP"
