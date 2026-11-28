# Is WebFetch in the CLI's tool list? Varies only the model host. Tool search off so the list is complete.
. /scripts/lib.sh
export HOME=/tmp CLAUDE_CONFIG_DIR=/tmp/cfg CLAUDE_CODE_OAUTH_TOKEN=$T CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ENABLE_TOOL_SEARCH=false
export HTTPS_PROXY=http://iron:8080 NO_PROXY=model.gw NODE_EXTRA_CA_CERTS=/certs/iron-ca.crt
cd /tmp; mkdir -p /tmp/cfg
KURUMI_ARGS="--setting-sources= --strict-mcp-config --permission-mode=bypassPermissions --allow-dangerously-skip-permissions"
S='{"skipWebFetchPreflight":true}'
P='WEBFETCH_URL=https://docs.example.com/page fetch it'
t model-on-base-url-gateway 'used=WebFetch' env ANTHROPIC_BASE_URL=http://model.gw sh -c ". /scripts/lib.sh; claude_run '$P' $KURUMI_ARGS --settings '$S'"
t model-base-url-set-to-api.anthropic.com 'used=WebFetch' env ANTHROPIC_BASE_URL=https://api.anthropic.com sh -c ". /scripts/lib.sh; claude_run '$P' $KURUMI_ARGS --settings '$S'"
t model-base-url-unset 'used=WebFetch' sh -c ". /scripts/lib.sh; claude_run '$P' $KURUMI_ARGS --settings '$S'"
