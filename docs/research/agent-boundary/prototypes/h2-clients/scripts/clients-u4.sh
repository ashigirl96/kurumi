# U4: real clients' write requests through the base-URL gateway, in approved/swapped pairs.
# A marker request (GET echo.gw/__mark/<label>) precedes each case so the analysis can label captures.
. /scripts/lib.sh
export HOME=/tmp SSL_CERT_FILE=/certs/client-gw-bundle.crt GH_HOST=api.gw GH_ENTERPRISE_TOKEN=$T
cd /tmp
mark() { curl -s -o /dev/null -H "Authorization: Bearer $T" "http://echo.gw/__mark/$1"; }
J='content-type: application/json'
A="Authorization: Bearer $T"

mark gh-issue-A;  t gh-issue-A 'issues/7' gh issue create -R api.gw/a/b --title 'approved title' --body 'approved body'
mark gh-issue-B;  t gh-issue-B 'issues/7' gh issue create -R api.gw/a/b --title 'swapped title' --body 'swapped body'

Q='mutation($t:String!){createIssue(input:{repositoryId:"R_1",title:$t}){issue{number}}}'
mark gql-A;  t gql-A 'number' gh api graphql -f query="$Q" -f t='approved title'
mark gql-B;  t gql-B 'number' gh api graphql -f query="$Q" -f t='swapped title'
mark gql-B-op; t gql-B-op 'data' gh api graphql -f query='mutation($id:ID!){deleteRepository(input:{repositoryId:$id}){clientMutationId}}' -f id=R_1

git config --global url."http://git.gw/".insteadOf https://github.com/
git config --global http.http://git.gw/.extraHeader "Authorization: Bearer $T"
git config --global user.name agent; git config --global user.email agent@example.invalid
git clone -q https://github.com/a/b.git /tmp/b && cd /tmp/b
echo approved > approved.txt; git add approved.txt; git commit -qm 'approved commit'
mark git-A;  t git-A '-> main' git push origin main
echo more > more.txt; git add more.txt; git commit -qm 'second commit'
mark git-B-ref; t git-B-ref '-> release' git push origin HEAD:refs/heads/release
git reset -q --hard HEAD~2; echo rewritten > rw.txt; git add rw.txt; git commit -qm 'rewritten history'
mark git-B-force; t git-B-force 'forced update' git push --force origin main
cd /tmp

printf 'approved file\n' > a.txt; printf 'swapped file!\n' > b.txt
mark mp-A;  t mp-A 'sha256' curl -sS -f -H "$A" -F note=n1 -F file=@a.txt\;filename=report.txt http://echo.gw/upload
mark mp-A-again; t mp-A-again 'sha256' curl -sS -f -H "$A" -F note=n1 -F file=@a.txt\;filename=report.txt http://echo.gw/upload
mark mp-B;  t mp-B 'sha256' curl -sS -f -H "$A" -F note=n1 -F file=@b.txt\;filename=report.txt http://echo.gw/upload

printf '{"title":"approved title","body":"x"}' > ja.json; printf '{"title":"swapped title","body":"x"}' > jb.json
gzip -c ja.json > ja.gz; sleep 1.1; touch ja.json; gzip -c ja.json > ja2.gz; gzip -c jb.json > jb.gz
mark gz-A;  t gz-A 'number' curl -sS -f -H "$A" -H "$J" -H 'Content-Encoding: gzip' --data-binary @ja.gz http://api.gw/repos/a/b/issues
mark gz-A-again; t gz-A-again 'number' curl -sS -f -H "$A" -H "$J" -H 'Content-Encoding: gzip' --data-binary @ja2.gz http://api.gw/repos/a/b/issues
mark gz-B;  t gz-B 'number' curl -sS -f -H "$A" -H "$J" -H 'Content-Encoding: gzip' --data-binary @jb.gz http://api.gw/repos/a/b/issues

mark chunk-A; t chunk-A 'number' curl -sS -f -H "$A" -H "$J" -H 'Transfer-Encoding: chunked' --data-binary @ja.json http://api.gw/repos/a/b/issues
mark chunk-B; t chunk-B 'number' curl -sS -f -H "$A" -H "$J" -H 'Transfer-Encoding: chunked' --data-binary @jb.json http://api.gw/repos/a/b/issues
# Same JSON semantics, different bytes: key order and whitespace.
mark json-A-reordered; t json-A-reordered 'number' curl -sS -f -H "$A" -H "$J" --data-binary '{ "body":"x", "title":"approved title" }' http://api.gw/repos/a/b/issues
mark json-A; t json-A 'number' curl -sS -f -H "$A" -H "$J" --data-binary @ja.json http://api.gw/repos/a/b/issues
mark end
