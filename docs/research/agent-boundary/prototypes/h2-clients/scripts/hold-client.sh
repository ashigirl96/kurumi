# One client against the hold gateway (every *.gw name on h2-hold-int is the hold gateway).
# Prints START/END epoch seconds around the client's own run, with no timeout added by us.
. /scripts/lib.sh
export HOME=/tmp
cd /tmp
setup_git() {
  git config --global url."http://git.gw/".insteadOf https://github.com/
  git config --global http.http://git.gw/.extraHeader "Authorization: Bearer $T"
  git config --global user.name agent; git config --global user.email agent@example.invalid
  git clone -q https://github.com/a/b.git /tmp/b && cd /tmp/b && echo hold > hold.txt && git add hold.txt && git commit -qm hold
}
npmrc() { printf 'registry=http://npm.gw/\n//npm.gw/:_authToken=%s\n' $T > .npmrc; }
case $1 in
  git-push) setup_git ;;
  npm-install) mkdir -p /tmp/p && cd /tmp/p && echo '{"name":"p","version":"1.0.0"}' > package.json && npmrc ;;
  npm-publish) mkdir -p /tmp/p && cd /tmp/p && echo '{"name":"pub-fake","version":"1.0.0"}' > package.json && echo x > index.js && npmrc ;;
  claude-*) export CLAUDE_CONFIG_DIR=/tmp/cfg CLAUDE_CODE_OAUTH_TOKEN=$T CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1; mkdir -p /tmp/cfg ;;
esac
KURUMI_ARGS="--setting-sources= --strict-mcp-config --permission-mode=bypassPermissions --allow-dangerously-skip-permissions"
echo "START $(date +%s)"
case $1 in
  curl) curl -sS -X POST -H "Authorization: Bearer $T" --data hello -w ' http=%{http_code} t=%{time_total}\n' http://echo.gw/curl ;;
  curl-via-iron) curl -sS -x http://iron:8080 -X POST --data hello -w ' http=%{http_code} t=%{time_total}\n' http://holdup.example/curl-iron ;;
  git-push) git push origin HEAD:refs/heads/hold-$(date +%s) ;;
  npm-install) npm install left-pad-fake --no-audit --no-fund ;;
  npm-publish) npm publish ;;
  gh) SSL_CERT_FILE=/certs/client-gw-bundle.crt GH_HOST=api.gw GH_ENTERPRISE_TOKEN=$T gh api -X POST /repos/a/b/issues -f title=hold ;;
  pip) pip install --no-cache-dir --break-system-packages --target /tmp/py --index-url "http://x:$T@pypi.gw/simple" --trusted-host pypi.gw fake-pkg ;;
  node-fetch) node -e "const t=Date.now();fetch('http://echo.gw/node',{method:'POST',body:'hi',headers:{authorization:'Bearer $T'}}).then(r=>r.text()).then(b=>console.log('ok',b,(Date.now()-t)/1000)).catch(e=>{console.log('ERR',e.cause?.code||e.cause?.name||e.message,(Date.now()-t)/1000);process.exit(1)})" ;;
  claude-model) ANTHROPIC_BASE_URL=http://modelhold.gw claude -p 'say hi' --output-format stream-json --verbose $KURUMI_ARGS < /dev/null 2>&1 | node /scripts/summ.js ;;
  claude-webfetch) ANTHROPIC_BASE_URL=http://model.gw NODE_EXTRA_CA_CERTS=/certs/client-gw-bundle.crt \
    claude -p 'WEBFETCH_URL=https://docs.gw/page fetch it' --output-format stream-json --verbose $KURUMI_ARGS \
    --settings '{"skipWebFetchPreflight":true}' < /dev/null 2>&1 | node /scripts/summ.js ;;
esac
code=$?
echo
echo "END $(date +%s) exit=$code"
