# Generality floor through the base-URL gateway (no MITM, no CONNECT). Runs inside the turn container.
. /scripts/lib.sh
echo "HOME as Kurumi starts it: '$HOME' uid=$(id -u)"
t home-default-npm 'cache' sh -c 'npm config get cache && touch "$(npm config get cache)/x" 2>&1 && echo cache-writable'
export HOME=/tmp
cd /tmp
KURUMI_ARGS="--setting-sources= --strict-mcp-config --permission-mode=bypassPermissions --allow-dangerously-skip-permissions"

# curl
t curl-post-issue '"number":7' curl -sS -f -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"title":"from curl","body":"b"}' http://api.gw/repos/a/b/issues

# gh: plain http only via the special github.localhost host; otherwise TLS on the gateway's own name
t gh-http-github.localhost 'full_name' env GH_HOST=github.localhost GH_ENTERPRISE_TOKEN=$T GH_TOKEN=$T gh api /repos/a/b
t gh-tls-no-ca 'full_name' env GH_HOST=api.gw GH_ENTERPRISE_TOKEN=$T gh api /repos/a/b
export SSL_CERT_FILE=/certs/client-gw-bundle.crt
t gh-tls-private-ca 'full_name' env GH_HOST=api.gw GH_ENTERPRISE_TOKEN=$T gh api /repos/a/b
t gh-issue-create 'issues/7' env GH_HOST=api.gw GH_ENTERPRISE_TOKEN=$T gh issue create -R api.gw/a/b --title 'gh title A' --body 'gh body A'
t gh-graphql-mutation 'number' env GH_HOST=api.gw GH_ENTERPRISE_TOKEN=$T gh api graphql \
  -f query='mutation($t:String!){createIssue(input:{repositoryId:"R_1",title:$t}){issue{number}}}' -f t='graphql title A'
unset SSL_CERT_FILE

# git over smart HTTP: url.insteadOf maps github.com to the gateway; the turn token rides in http.extraHeader
git config --global url."http://git.gw/".insteadOf https://github.com/
git config --global http.http://git.gw/.extraHeader "Authorization: Bearer $T"
git config --global user.name agent; git config --global user.email agent@example.invalid
t git-clone 'done|Cloning' git clone https://github.com/a/b.git /tmp/b
cd /tmp/b
echo one > one.txt; git add one.txt; git commit -qm one
t git-push 'main -> main' git push origin main
git reset -q --hard HEAD~1; echo two > two.txt; git add two.txt; git commit -qm two-rewritten
t git-push-force 'forced update' git push --force origin main
cd /tmp

# npm: registry points at the gateway; npm rewrites registry.npmjs.org tarball URLs to it (replace-registry-host)
mkdir -p /tmp/proj && cd /tmp/proj && echo '{"name":"proj","version":"1.0.0"}' > package.json
printf 'registry=http://npm.gw/\n//npm.gw/:_authToken=%s\n' $T > .npmrc
t npm-install 'added 1 package' npm install left-pad-fake --no-audit --no-fund
t npm-require 'ok' node -e "console.log(require('left-pad-fake')('ok'))"
mkdir -p /tmp/pub && cd /tmp/pub && echo '{"name":"pub-fake","version":"1.0.0"}' > package.json && echo 'x' > index.js
cp /tmp/proj/.npmrc .
t npm-publish 'pub-fake@1.0.0' npm publish
cd /tmp

# pip: the index answers with absolute files.pythonhosted.org links, like real PyPI
t pip-install-index-only 'Successfully installed' pip install --no-cache-dir --break-system-packages --target /tmp/py1 \
  --index-url "http://x:$T@pypi.gw/simple" --trusted-host pypi.gw fake-pkg
t pip-install-gw-rewrites-links 'Successfully installed' pip install --no-cache-dir --break-system-packages --target /tmp/py2 \
  --index-url "http://x:$T@pypirw.gw/simple" --trusted-host pypirw.gw --trusted-host files.gw fake-pkg

# Claude Code (real CLI 2.1.332) against the fake model behind the gateway, Kurumi's args
export CLAUDE_CONFIG_DIR=/tmp/cfg ANTHROPIC_BASE_URL=http://model.gw CLAUDE_CODE_OAUTH_TOKEN=$T CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
mkdir -p /tmp/cfg
t claude-model-call 'FINAL' claude_run 'say hi' $KURUMI_ARGS
t webfetch-http-default 'marker-present=true' claude_run 'WEBFETCH_URL=http://docs.gw/page fetch it' $KURUMI_ARGS
t webfetch-http-skip-preflight 'marker-present=true' claude_run 'WEBFETCH_URL=http://docs.gw/page fetch it' $KURUMI_ARGS \
  --settings '{"skipWebFetchPreflight":true}'
t webfetch-https-gw-ca-skip-preflight 'marker-present=true' env NODE_EXTRA_CA_CERTS=/certs/client-gw-bundle.crt \
  sh -c '. /scripts/lib.sh; claude_run "WEBFETCH_URL=https://docs.gw/page fetch it" '"$KURUMI_ARGS"' --settings "{\"skipWebFetchPreflight\":true}"'
t webfetch-other-host 'marker-present=true' claude_run 'WEBFETCH_URL=https://docs.example.com/page fetch it' $KURUMI_ARGS \
  --settings '{"skipWebFetchPreflight":true}'

# remote MCP over Streamable HTTP; the turn token goes in the server's headers
MCP='{"mcpServers":{"fake":{"type":"http","url":"http://mcp.gw/mcp","headers":{"Authorization":"Bearer kurumi-fake-turn1"}}}}'
t mcp-remote-http 'MCP-ECHO' claude_run 'USE_MCP call the echo tool' $KURUMI_ARGS --mcp-config "$MCP"
