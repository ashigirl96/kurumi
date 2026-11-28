# E9 client: GraphQL bodies against agentgateway's CEL json(request.body) rules (allow :80, deny :3001).
. /scripts/lib.sh
export HOME=/tmp
cd /tmp
Q='mutation($t:String!){createIssue(input:{repositoryId:\"R_1\",title:$t}){issue{number}}}'
D='mutation($t:String!){deleteRepository(input:{repositoryId:\"R_1\"}){clientMutationId}}'
DC='mutation($t:String!){deleteRepository(input:{repositoryId:\"R_1\"}){clientMutationId}} # createIssue'
pad=$(head -c 9000 /dev/zero | tr '\0' 'a')
printf '{"query":"%s","variables":{"t":"approved title"}}' "$Q" > ok.json
printf '{"query":"%s","variables":{"t":"swapped title"}}' "$Q" > swapped.json
printf '{"query":"%s","variables":{"t":"approved title"}}' "$DC" > opswap-comment.json
printf '{"query":"%s","variables":{"t":"approved title","pad":"%s"}}' "$Q" "$pad" > ok-big.json
printf '{"query":"%s","variables":{"t":"approved title","t":"swapped title"}}' "$Q" > dup-last-swapped.json
printf '{"query":"%s","variables":{"t":"swapped title","t":"approved title"}}' "$Q" > dup-last-approved.json
printf '{"query":"%s","variables":{"t":"x"}}' "$D" > del.json
printf '{"query":"%s","variables":{"t":"x","pad":"%s"}}' "$D" "$pad" > del-big.json
gzip -c ok.json > ok.gz; gzip -c del.json > del.gz
send() { # label port file [extra curl args]
  l=$1; p=$2; f=$3; shift 3
  code=$(curl -s -o /tmp/resp -w '%{http_code}' -H 'content-type: application/json' "$@" --data-binary @"$f" "http://agw:$p/graphql")
  echo "CASE $l port=$p bytes=$(wc -c < "$f") -> HTTP $code $(head -c 120 /tmp/resp)"
}
send allow-ok 80 ok.json
send allow-swapped-variables 80 swapped.json
send allow-opswap-comment 80 opswap-comment.json
send allow-ok-chunked 80 ok.json -H 'Transfer-Encoding: chunked'
send allow-ok-gzip 80 ok.gz -H 'Content-Encoding: gzip'
send allow-ok-over-limit 80 ok-big.json
send allow-dup-key-last-swapped 80 dup-last-swapped.json
send allow-dup-key-last-approved 80 dup-last-approved.json
send deny-del 3001 del.json
send deny-del-chunked 3001 del.json -H 'Transfer-Encoding: chunked'
send deny-del-gzip 3001 del.gz -H 'Content-Encoding: gzip'
send deny-del-over-limit 3001 del-big.json
# Real gh through the allow bind: plain http via the github.localhost special host.
export GH_HOST=github.localhost GH_ENTERPRISE_TOKEN=$T GH_TOKEN=$T
t gh-graphql-approved 'number' gh api graphql -f query='mutation($t:String!){createIssue(input:{repositoryId:"R_1",title:$t}){issue{number}}}' -f t='approved title'
t gh-graphql-swapped 'number' gh api graphql -f query='mutation($t:String!){createIssue(input:{repositoryId:"R_1",title:$t}){issue{number}}}' -f t='swapped title'
t gh-issue-create-approved-title 'issues/7' gh issue create -R github.localhost/a/b --title 'approved title' --body b
