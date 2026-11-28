# 調査 slice H2: 本物のクライアントで見るゲートウェイの形（2026-11-28）

対象は shortlist.md の U3（一般性の下限）、U4（線の上での承認の結び付け）、U5（線の上での保留）と、teardown-remote の E9・E10、teardown-local の実験 4・5。攻撃としてのゲートウェイの検証は H1 の担当で、ここでは扱わない。

根拠の印: `[measured]` はこのディレクトリの script で観測したもの（出力は `out/`）。`[docs (path)]` は `dl/` に落とした公式の文書。`[inferred]` は観測もコードもないもの。`[argued]` は前提を書いた構造上の議論。**ネットワークの結果はすべて Docker Desktop for Mac 29.6.1（linux/arm64 の VM）だけで、Linux では確かめていない。**

守った規則: 秘密はすべて偽の canary（`CANARY_REAL_9f1c2e7a5b3d`）。本物の Claude Code CLI は動かしたが、相手は手元の偽のモデル（`fakes/fakes.ts`）と偽のトークン（`kurumi-fake-turn1`）で、Anthropic の端点にも本物の資格情報にも触れていない。クライアントはすべて `--internal` ネットワークの上で、Kurumi のターンと同じ旗（`--cap-drop ALL`、`no-new-privileges`、uid 501:20、読み取り専用の root、`/tmp` だけ tmpfs、`/work` を volume）で動かした（`scripts/client.sh`）。kurumi のリポジトリは編集していない。落としたもの（iron-proxy の image、agentgateway の binary と文書）は `dl/` に置き、コンテナの中でだけ動かした。

再実行: `sh run-all.sh`（約 20 分。16 分の保留を並行で流す）。`sh run-all.sh --skip-hold` は 16 分の保留を飛ばし（E10 は 8 秒版を `out/e10-short` に流す）、前回の `out/hold` と `out/e10` を残したまま残りを流し直す。2 分 16 秒で 32 個の PASS だった `[measured]`。最後に PASS/FAIL を出し、ラベル `kp2.lab=1` のコンテナとネットワークを全部消す。

## 版

| もの | 版 | 根拠 |
|---|---|---|
| Kurumi のターンの image | `kurumi-agent:sdk-0.3.332`（Debian 13、Bun 1.4.4、Claude Code CLI 2.1.332）。**git・gh・curl・npm・pip・python3 は入っていない** | `[measured: scripts/probe-image.sh の出力]` |
| クライアントを足した捨ての image | `kp2-clients:h2` = 上に apt で git 2.47.3、curl 8.14.1（OpenSSL 3.5.9）、gh 2.46.0（Debian 2.46.0-3）、Node 20.19.2、npm 9.2.0、Python 3.13.5、pip 25.1.1 を足したもの（`Dockerfile`） | `[measured: out/versions.txt]` |
| iron-proxy | `ironsh/iron-proxy:0.61.0`、image id `sha256:973b7adf44a1…`（arm64） | `[measured: dl/iron-proxy/image.txt]` |
| agentgateway | v1.7.0 `agentgateway-linux-arm64`、sha256 `85724a15dc9f…`（release の `.sha256` と一致） | `[measured: dl/agentgateway/sha.txt]` |
| 最小の base-URL ゲートウェイ | `fakes/gw.ts`（捨ての Bun、約 110 行）。名前ごとに上流を 1 つ固定し、ターンのトークンを確かめ、canary を差し込み、本文を丸ごと受けてから同じ bytes を転送する。CA なし、CONNECT なし | `[code fakes/gw.ts]` |

偽の上流（`fakes/fakes.ts`）は本物の名前（`api.github.com`、`github.com`、`registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org`、`mcp.example.com`、`docs.example.com`、`echo.example.com`、`api.anthropic.com`）で、偽の「公開」CA の証明書を持つ TLS サーバー。GitHub 風の API は `Bearer|token CANARY` か Basic の password が canary のときだけ答え、git は本物の `git http-backend` を CGI で動かす。npm は `npm pack` で作った本物の tarball、PyPI は手で組んだ本物の wheel を、本物と同じく絶対 URL（`https://registry.npmjs.org/...`、`https://files.pythonhosted.org/...`）で指す。CA は 3 つ作った（`scripts/certs.sh`）: 公開 PKI の代わり（pub）、ゲートウェイ自身の名前用の私設 CA（gw）、iron-proxy の MITM 用（iron）。

## 結論

1. **U3: base-URL ゲートウェイ（CA なし）で、curl・git（clone、push、force push）・npm（install、publish）・Claude Code のモデル呼び出し・リモート MCP はそのまま動く** `[measured: out/baseurl.txt]`。設定は道具ごとに 1〜2 行で、どれも利用者の設定ファイルか環境変数で足りる。**壊れるのは 3 つ**: gh（平文 HTTP を許すのは `GH_HOST=github.localhost` の特例だけで、ほかの名前ではゲートウェイの名前に TLS が要る）、pip（本物の PyPI と同じく index が `files.pythonhosted.org` の絶対 URL を返すと、その名前は内部ネットワークで引けない。ゲートウェイが index の HTML のリンクを書き換えれば動く）、WebFetch（既定では `api.anthropic.com/api/web/domain_info` への事前確認で止まり、事前確認を切っても http を https に格上げするので、ゲートウェイの名前に私設 CA の TLS と `NODE_EXTRA_CA_CERTS` が要り、しかもゲートウェイが前に立つ名前にしか届かない）。
2. **U3: iron-proxy の MITM では、CA を信頼させれば全クライアントが本物の名前のまま動く。ただし Node 20 の `fetch` は `HTTPS_PROXY` を見ないので壊れ、git は `SSL_CERT_FILE` を無視して `GIT_SSL_CAINFO` を要る** `[measured: out/mitm.txt]`。もう一つ、**モデルの宛先が既定の `api.anthropic.com` のとき、CLI 2.1.332 は WebFetch を道具の一覧に出さない**（`ANTHROPIC_BASE_URL=https://api.anthropic.com` と明示しても同じ。宛先を `http://model.gw` にすると出る）`[measured: out/webfetch-tool.txt]`。理由は確かめていない。
3. **U4: 線の上のゲートウェイは、本物のクライアントの書き込みを人が読める形に戻せる。ただし GraphQL・git・multipart・gzip のどれでも、メソッドとパスだけに結び付けた承認は 8 個の差し替えを 1 つも捕まえない。正規化した本文の digest に結び付けると 8 個とも捕まえ、同じ意図の送り直し 3 個は通した** `[measured: out/u4-analysis.txt]`。生の bytes の digest だと、送り直しのたびに変わる multipart の境界文字列・gzip の時刻・JSON のキー順で、同じ意図を 3 個とも拒んだ。調べた bytes と転送した bytes は 18/18 で一致した（ゲートウェイが本文を丸ごと受けてから転送したので）。
4. **U4: `git push --force` の「force」は線の上に無い** `[measured]`。送られるのは `old new ref` の行で、普通の push と同じ形をしている。fast-forward かどうかは、pack の中で親をたどって `old` に届くときだけ pack だけから言え、届かないときは上流の履歴が無いと決められない。新しい枝の push では、pack に上流にしか無い object を指す `ref-delta` が入っていた（thin pack）。
5. **E9: agentgateway v1.7.0 の CEL `json(request.body)` の allow 規則は、gzip・上限超えで閉じる（403）。chunked は丸ごと受けてから評価して通す。deny 規則は gzip・上限超えで開く（`deleteRepository` が上流に届いた）。文字列一致の規則は、コメントに `createIssue` を含めた別の mutation を通した** `[measured: out/e9.txt]`。v1.7.0 の設定の型には要求本文を展開する項目が無い `[docs dl/agentgateway/schema_config.md: "compress" の grep が 0 件]`。
6. **U5: 16 分の保留を待てたのは curl・git push・gh だけだった。npm は 300 秒、Node の `fetch` は 300 秒、Claude Code のモデル呼び出しは 360 秒、WebFetch は 60 秒、pip は 15 秒で切れた。npm（publish の PUT を含む）・pip・Claude Code は同じ要求を送り直した** `[measured: out/hold/report.txt]`。iron-proxy を挟むと、既定の `upstream_response_header_timeout` で 30 秒で 502 になった。線の上で要求ごとに 15 分待つ承認は、ADR 0007 のままでは主要なクライアントの半分以上で成り立たず、再送が同じ書き込みの承認依頼を何度も出す。
7. **E10: agentgateway v1.7.0 の extAuthz は、既定では 2 秒で切れて 403 になる。認可呼び出しと経路の時間切れを 30 分に延ばすと、960 秒保留してから流した** `[measured: out/e10/client.txt]`。ゲートウェイの側は 16 分持つので、保留の限界はクライアントの時間切れで決まる。

## U3: 一般性の下限

### 表（Mac だけ）

| クライアント | base-URL ゲートウェイ（CA なし） | そのとき要る設定 | iron-proxy MITM | そのとき要る設定 |
|---|---|---|---|---|
| curl 8.14.1 | **動く** | URL を `http://api.gw/…` に、`-H "Authorization: Bearer <ターンのトークン>"` | **動く** | `HTTPS_PROXY`、`SSL_CERT_FILE=<iron CA>`（無いと exit 60） |
| gh 2.46.0（`gh api`、`gh issue create`、GraphQL mutation） | **条件付き**。`GH_HOST=github.localhost` だけが平文の `http://api.github.localhost/` を使う（ゲートウェイに `api.github.localhost` の別名を付けて動いた）。ほかの `GH_HOST` は `https://<host>/api/v3/` 固定で、CA が無いと `x509: certificate signed by unknown authority` | `GH_HOST`、`GH_ENTERPRISE_TOKEN=<ターンのトークン>`。TLS の場合はゲートウェイの名前に私設 CA の証明書と `SSL_CERT_FILE` | **動く** | `GH_TOKEN=<偽>`（無いと gh が動かない）、`SSL_CERT_FILE` |
| git 2.47.3（clone、push、force push） | **動く** | `url."http://git.gw/".insteadOf https://github.com/`、`http.http://git.gw/.extraHeader "Authorization: Bearer <ターンのトークン>"` | **動く** | `GIT_SSL_CAINFO`。`SSL_CERT_FILE` は効かない（`CAfile: /etc/ssl/certs/ca-certificates.crt` のまま失敗） |
| npm 9.2.0（install、publish） | **動く**。packument の tarball URL は `https://registry.npmjs.org/…` のままだが、npm が設定した registry に置き換えて `npm.gw` から取った | `.npmrc` に `registry=http://npm.gw/` と `//npm.gw/:_authToken=<ターンのトークン>` | **動く** | `NODE_EXTRA_CA_CERTS`。publish は手元に（偽の）`_authToken` が無いと送る前に止まる |
| pip 25.1.1 | **index だけでは壊れる**（`HTTPSConnectionPool(host='files.pythonhosted.org')`）。ゲートウェイが index の HTML の `https://files.pythonhosted.org/` を `http://files.gw/` に書き換えると **動く** | `--index-url http://x:<トークン>@pypi.gw/simple`、`--trusted-host` を 2 つ。pip は資格情報を index の名前にしか送らないので、ファイルの名前ではトークンを要求できない | **動く** | `SSL_CERT_FILE` か `PIP_CERT`（無いと `No matching distribution`） |
| Claude Code 2.1.332 のモデル呼び出し | **動く** | `ANTHROPIC_BASE_URL=http://model.gw`（今の Kurumi と同じ） | **動く** | `NODE_EXTRA_CA_CERTS`（無いと `SELF_SIGNED_CERT_IN_CHAIN`） |
| WebFetch | **既定は壊れる**: `Unable to verify if domain docs.gw is safe to fetch`。`skipWebFetchPreflight` を足すと `http://` を `https://` に格上げして `unable to verify the first certificate`。ゲートウェイの名前に私設 CA の TLS と `NODE_EXTRA_CA_CERTS` を足すと **動く**。ゲートウェイが前に立たない名前（`docs.example.com`）は `EAI_AGAIN` | `--settings '{"skipWebFetchPreflight":true}'`（Kurumi は `--setting-sources=` で設定ファイルを読まないので旗で渡す）、`NODE_EXTRA_CA_CERTS`、名前ごとの経路 | **動く**（モデルは base URL のまま） | `skipWebFetchPreflight`、`NODE_EXTRA_CA_CERTS`、`NO_PROXY=model.gw`。既定の事前確認は proxy 経由で `api.anthropic.com/api/web/domain_info?domain=docs.example.com` に行き、偽の 404 で止まった |
| リモート MCP（Streamable HTTP） | **動く** | `--mcp-config` の `url` と `headers.Authorization` | **動く** | `NODE_EXTRA_CA_CERTS` |
| Node 20.19 の `fetch` | 動く（保留の実験で使った） | URL の書き換え | **壊れる**: `EAI_AGAIN`。`HTTPS_PROXY` を見ずに自分で名前を引く | コードの変更（proxy の dispatcher）か DNS で向ける方式 |
| どれでも | Kurumi の起こし方では `HOME=/` で root が読み取り専用なので、npm の cache（`/.npm`）に書けない | `HOME=/tmp` か書ける場所 | 同じ | 同じ |

証明書を固定するクライアントは無かった。どのクライアントも、CA を設定すると私設 CA を受け入れた `[measured]`。ゲートウェイが受けた認証の形は、gh が `token`、curl・git・npm・Claude Code・MCP が `Bearer`、pip が `Basic`、WebFetch と pip のファイル取得は無し `[measured: out/run/gw-capture.jsonl の集計]`。

`out/baseurl.txt` と `out/mitm.txt` の判定行:

```
RESULT home-default-npm breaks (exit 1): touch: cannot touch '/.npm/x': No such file or directory
RESULT curl-post-issue works
RESULT gh-http-github.localhost works
RESULT gh-tls-no-ca breaks (exit 1): Get "https://api.gw/api/v3/repos/a/b": tls: failed to verify certificate: x509: certificate signed by unknown authority
RESULT gh-tls-private-ca works
RESULT gh-issue-create works
RESULT gh-graphql-mutation works
RESULT git-clone works
RESULT git-push works
RESULT git-push-force works
RESULT npm-install works
RESULT npm-require works
RESULT npm-publish works
RESULT pip-install-index-only breaks (exit 1): ERROR: Could not install packages due to an OSError: HTTPSConnectionPool(host='files.pythonhosted.org', port=443): ...
RESULT pip-install-gw-rewrites-links works
RESULT claude-model-call works
RESULT webfetch-http-default breaks (exit 0): ... "Unable to verify if domain docs.gw is safe to fetch. This may be due to network restrictions o
RESULT webfetch-http-skip-preflight breaks (exit 0): ... "unable to verify the first certificate"
RESULT webfetch-https-gw-ca-skip-preflight works
RESULT webfetch-other-host breaks (exit 0): ... "getaddrinfo EAI_AGAIN docs.example.com"
RESULT mcp-remote-http works
---- MITM
RESULT curl-no-ca breaks (exit 60)
RESULT curl-SSL_CERT_FILE works
RESULT gh-no-ca breaks (exit 1): ... x509: certificate signed by unknown authority
RESULT gh-SSL_CERT_FILE works
RESULT gh-issue-create works
RESULT gh-graphql-mutation works
RESULT git-clone-no-ca breaks (exit 128): ... certificate signer not trusted. (CAfile: /etc/ssl/certs/ca-certificates.crt CRLfile: none)
RESULT git-clone-SSL_CERT_FILE breaks (exit 128): ... (same)
RESULT git-clone-GIT_SSL_CAINFO works
RESULT git-push works
RESULT git-push-force works
RESULT npm-install-no-ca breaks (exit 1)
RESULT npm-install-NODE_EXTRA_CA_CERTS works
RESULT npm-publish works
RESULT pip-no-ca breaks (exit 1): ERROR: No matching distribution found for fake-pkg
RESULT pip-SSL_CERT_FILE works
RESULT pip-PIP_CERT works
RESULT node-fetch-NODE_EXTRA_CA_CERTS breaks (exit 1): ERR EAI_AGAIN
RESULT claude-model-no-ca breaks (exit 0): ... Self-signed certificate detected (SELF_SIGNED_CERT_IN_CHAIN)
RESULT claude-model-NODE_EXTRA_CA_CERTS works
RESULT webfetch-first-party-model-host breaks (exit 0): ... "TOOL WebFetch NOT OFFERED; tools=Agent,Bash,Edit,..."
RESULT webfetch-default-preflight breaks (exit 0): ... "Unable to verify if domain docs.example.com is safe to fetch..."
RESULT webfetch-skip-preflight works
RESULT mcp-remote-http works
```

### WebFetch について分かったこと

- WebFetch の事前確認は `ANTHROPIC_BASE_URL` を使わず、`api.anthropic.com/api/web/domain_info?domain=<名前>` に直接行く `[measured: out/run/fakes.jsonl と iron-proxy の監査記録 "path":"/api/web/domain_info"]`。Kurumi の形（`--internal`、base URL だけ）では名前が引けず、既定のままでは WebFetch が必ず止まる。iron-proxy の inject を `api.anthropic.com` に掛けると、この事前確認にも本物の資格情報が付く（偽の上流が `authorization: Bearer CANARY_REAL…` を受けた）`[measured]`。
- WebFetch は Claude Code 2.1.332 では遅延読み込みの道具で、モデルが `ToolSearch`（`select:WebFetch`）で読み込んでから呼ぶ。MCP の道具も同じ `[measured: out/baseurl.txt の tool_use 行]`。
- 取ったページの要約は、2 回目のモデル呼び出し（道具なし）で同じ base URL に行く `[measured: SUMMARY marker-present=true が偽のモデルから返った]`。
- モデルの宛先が `api.anthropic.com` のとき WebFetch が一覧に無い件は、宛先だけを変えた 3 通りで再現した（`out/webfetch-tool.txt`: `model-on-base-url-gateway works`、`model-base-url-set-to-api.anthropic.com breaks`、`model-base-url-unset breaks`）。そのときの要求の `tools` には、サーバー側の web fetch の道具も入っていなかった `[measured: out/run/model-bodies/*.json]`。その場合 CLI は `/api/claude_code/settings` と `/api/claude_code/policy_limits` も取りに来ていて、偽の上流は 404 を返した。この 404 が原因かどうかは確かめていない `[inferred: 未確認]`。Kurumi の形（base URL）では WebFetch は出る。

## U4: 線の上での承認の結び付け

`scripts/clients-u4.sh` が本物のクライアントで「承認した要求」と「差し替えた要求」を対にして base-URL ゲートウェイに送り、`scripts/u4-analyze.py` がゲートウェイの記録（受けて転送した bytes そのもの）を読み直す。

### ゲートウェイが人に見せられたもの

| 書き込み | メソッドとパス | 本文から取り出せたもの | ほかの引数 |
|---|---|---|---|
| `gh issue create` | `POST /api/graphql`（GraphQL の操作はすべて同じパス） | `mutation IssueCreate`、根の項目 `createIssue`、`variables.input = {title, body, repositoryId}` | gh は先に読みの GraphQL（repository の問い合わせ）を同じパスに送る |
| `gh api graphql`（変数あり） | `POST /api/graphql` | 根の項目（`createIssue` / `deleteRepository`）、`variables` | 操作名は無いこともある |
| `git push` | `POST /a/b.git/git-receive-pack` | pkt-line の `old new ref`（と `report-status-v2 side-band-64k quiet object-format=sha1`）、pack の object の種類、delta でない commit の本文（`approved commit` など） | force の旗は無い。新しい枝の pack は `ref-delta` を含み、中身を戻すには上流の object が要る |
| multipart（`curl -F`） | `POST /upload` | 部分ごとの name、filename、大きさ、digest | 境界文字列は送るたびに乱数 |
| gzip（`Content-Encoding: gzip`） | `POST /repos/a/b/issues` | 展開すると JSON の `title`、`body` | gzip の時刻で bytes が変わる |
| chunked（`Transfer-Encoding: chunked`） | `POST /repos/a/b/issues` | 丸ごと受ければ JSON | ゲートウェイは Content-Length で送り直した（上流には `content-length` が付いて届いた） |

`out/u4-analysis.txt` から git の 3 つ:

```
git-A        commands: old 59252d3512ae new d0649d7b6a3e ref refs/heads/main  new_commit_message "approved commit"   update_kind "fast-forward (provable from the pack)"
git-B-ref    commands: old 000000000000 new b5ed994b7811 ref refs/heads/release new_commit_message "second commit"  update_kind "create"   pack_objects [commit, ref-delta, blob]
git-B-force  commands: old d0649d7b6a3e new e0cb45de04cb ref refs/heads/main  new_commit_message "rewritten history" update_kind "not provable from the pack: force or needs the upstream graph"
（3 つとも caps は同じ: report-status-v2, side-band-64k, quiet, object-format=sha1）
```

### 差し替えを捕まえたか

```
inspected==forwarded: 18/18 gateway-captured writes arrived at the fake with an identical body sha256

| approved | then sent | same method+path? | method/path binder | raw-bytes digest binder | canonical-body binder |
|---|---|---|---|---|---|
| gh-issue-A | gh-issue-B | yes | misses the swap (allows B) | catches the swap | catches the swap |
| gql-A | gql-B | yes | misses the swap (allows B) | catches the swap | catches the swap |
| gql-A | gql-B-op | yes | misses the swap (allows B) | catches the swap | catches the swap |
| git-A | git-B-ref | yes | misses the swap (allows B) | catches the swap | catches the swap |
| git-A | git-B-force | yes | misses the swap (allows B) | catches the swap | catches the swap |
| mp-A | mp-B | yes | misses the swap (allows B) | catches the swap | catches the swap |
| gz-A | gz-B | yes | misses the swap (allows B) | catches the swap | catches the swap |
| chunk-A | chunk-B | yes | misses the swap (allows B) | catches the swap | catches the swap |
| mp-A | mp-A-again | yes | accepts the re-send | rejects the same intent (false positive) | accepts the re-send |
| gz-A | gz-A-again | yes | accepts the re-send | rejects the same intent (false positive) | accepts the re-send |
| json-A | json-A-reordered | yes | accepts the re-send | rejects the same intent (false positive) | accepts the re-send |
```

正規化の中身 `[code scripts/u4-analyze.py]`: JSON はキーを並べ替えて空白を除く、gzip は展開してから、multipart は部分ごとの（name、filename、大きさ、digest）の並び、git は `old new ref` の並びと pack の digest。

### 結び付けの内訳（I4 の分解）

| 結び付ける先 | 観測 | 構造上の保証（前提つき） |
|---|---|---|
| 宛先とメソッドとパス | 8 個の差し替えを 0 個捕まえた `[measured]` | GraphQL・git・アップロードのように 1 つのパスに多くの操作が乗る API では、何も保証しない `[argued]` |
| 本文（正規化した digest） | 8/8 捕まえ、同じ意図の送り直し 3/3 を通した `[measured]` | 次の前提が全部成り立つときだけ: (a) ゲートウェイの解釈が上流と同じ（重複キー、Content-Encoding、文字コード、GraphQL の文法）、(b) 人に見せた表示が digest の元の正規形から作られている、(c) 本文を丸ごと受けてから決め、同じ bytes を送る（ストリームを諦め、大きな push もメモリに載せる）、(d) 承認を 1 回で使い切るか、使い回しを許すかを決める（下の U5 の再送と衝突する）`[argued]` |
| git の ref と force | ref と `old`/`new` は線の上にある。force の旗は無い `[measured]` | non-fast-forward の判定は、上流の履歴を引くか、pack の中で親をたどって届く場合に限る。Kurumi 側で上流の写しを持たない限り「force か」を人に正しく見せられない `[argued]` |
| multipart のファイル | 部分ごとの digest で区別できた `[measured]` | 境界文字列を正規化から外す前提 `[argued]` |

## E9: agentgateway v1.7.0 の CEL 本文規則

設定は `fakes/agw.yaml`。`:80` は allow 規則（`json(request.body).query.contains("createIssue") && json(request.body).variables.t == "approved title"`）、`:3001` は deny 規則（`json(request.body).query.contains("deleteRepository")`）。`maxBufferSize` は 8192 にした。

```
CASE allow-ok port=80 bytes=134 -> HTTP 200
CASE allow-swapped-variables port=80 bytes=133 -> HTTP 403 authorization failed
CASE allow-opswap-comment port=80 bytes=147 -> HTTP 200        （deleteRepository の mutation に "# createIssue" のコメント）
CASE allow-ok-chunked port=80 bytes=134 -> HTTP 200
CASE allow-ok-gzip port=80 bytes=143 -> HTTP 403 authorization failed
CASE allow-ok-over-limit port=80 bytes=9143 -> HTTP 403 authorization failed
CASE allow-dup-key-last-swapped port=80 bytes=154 -> HTTP 403  （{"t":"approved title","t":"swapped title"}）
CASE allow-dup-key-last-approved port=80 bytes=154 -> HTTP 200 （{"t":"swapped title","t":"approved title"}）
CASE deny-del port=3001 bytes=120 -> HTTP 403
CASE deny-del-chunked port=3001 bytes=120 -> HTTP 403
CASE deny-del-gzip port=3001 bytes=135 -> HTTP 200             （上流に deleteRepository が gzip のまま届いた）
CASE deny-del-over-limit port=3001 bytes=9129 -> HTTP 200      （上流に届いた）
RESULT gh-graphql-approved works
RESULT gh-graphql-swapped breaks (exit 1): authorization failedgh: HTTP 403
RESULT gh-issue-create-approved-title breaks (exit 1): HTTP 403: 403 Forbidden (http://api.github.localhost/graphql)
```

- 上流（偽）が受けた本文を照らすと、`deleteRepository` は gzip のものと 9129 bytes のものが届いていた。chunked の要求は `content-length` を付けて届いた（agentgateway が丸ごと受けて送り直した）`[measured: out/run/fakes.jsonl]`。
- 重複キーは後の値が勝った。偽の上流（JS の `JSON.parse`）も後勝ちなので、ここでは食い違いは出なかった。先勝ちの上流なら承認と実行が食い違う `[inferred]`。
- 本物の gh の `gh issue create` は、先に送る読みの GraphQL（repository の問い合わせ）が allow 規則に合わず 403 で止まった。本文規則で書き込みを絞ると、同じパスの読みも全部規則に書く必要がある `[measured]`。
- 承認者に見せる表示と照合の両方を CEL の文字列一致で作ると、別の mutation を通す（`allow-opswap-comment`）。CEL に GraphQL の構文解析は無い `[measured; docs dl/agentgateway/schema_cel.md に GraphQL の関数は無い]`。

## U5: 保留（ADR 0007 の 15 分）

`scripts/hold.sh` が、`fakes/gw.ts` を保留つきで起こし（`HOLD_SECONDS=960`、合う要求を 960 秒止めてから上流へ転送する）、10 個のクライアントを別々のコンテナで同時に走らせた。こちらからはクライアントに時間切れを足していない。ゲートウェイは要求の到着、クライアントが接続を切った時刻（`req.signal` の abort）、解放と上流の答えを記録する（`out/hold/hold-capture.jsonl`）。窓は 960 + 180 秒で、その時点で残ったものは消した。positive control は curl で、960 秒後に 200 を受けたので、保留の仕組みそのものは 16 分持った。

### 表（Mac だけ、`out/hold/report.txt`）

| クライアント | 止めた要求 | 何が起きたか | 再送（人にもう一度聞くことになる要求） |
|---|---|---|---|
| curl 8.14.1 | `POST echo.gw/curl` | 960 秒待って 200 を受けた | なし |
| git 2.47.3 `push` | `POST git-receive-pack` | 960 秒待って push が成功した | なし |
| gh 2.46.0 `api -X POST` | `POST /api/v3/repos/a/b/issues` | 960 秒待って 201 を受けた | なし |
| npm 9.2.0 `install` | `GET /left-pad-fake` | 300 秒で切れた（`network timeout`） | 2 回（+311 秒、+671 秒）、3 回とも 300 秒で切れ、exit 1 |
| npm 9.2.0 `publish` | `PUT /pub-fake` | 300 秒で切れた | **書き込みを 2 回送り直した**（+310 秒、+670 秒）、exit 1 |
| pip 25.1.1 | `GET /simple/fake-pkg/` | 15 秒で切れた（`read timeout=15`） | 5 回（計 6 回）、98 秒で exit 1 |
| Node 20.19 `fetch` | `POST echo.gw/node` | 301.7 秒で `UND_ERR_HEADERS_TIMEOUT` | なし |
| Claude Code 2.1.332 のモデル呼び出し | `POST /v1/messages` | 360 秒ごとに切れた | 3 回（+361、+723、+1086 秒）。窓の終わりでもまだ再送中 |
| Claude Code の WebFetch | `GET docs.gw/page` | 60 秒で `timeout of 60000ms exceeded`。モデルにはエラーの道具結果として返った | なし（ターンは続いた） |
| curl → iron-proxy 0.61.0 → 保留 | `POST holdup.example/curl-iron` | **iron-proxy が 30 秒で 502**（既定の `upstream_response_header_timeout`）を返した | なし |

`out/hold/report.txt` の抜粋:

```
## npm-publish
client ran 970 s, exit=1
  held request #9 PUT npm.gw/pub-fake arrived +0.4s: client-abort@300.077s
  held request #24 PUT npm.gw/pub-fake arrived +310.5s: client-abort@300.021s
  held request #27 PUT npm.gw/pub-fake arrived +670.6s: client-abort@300.008s
## claude-model
client did not finish inside the window
  held request #13 POST modelhold.gw/v1/messages?beta=true arrived +0.3s: client-abort@360.454s
  held request #25 POST modelhold.gw/v1/messages?beta=true arrived +361.4s: client-abort@360.39s
  held request #28 POST modelhold.gw/v1/messages?beta=true arrived +722.9s: client-abort@360.428s
  held request #29 POST modelhold.gw/v1/messages?beta=true arrived +1085.7s: still held at collection
## curl-via-iron
client ran 30 s, exit=0
  held request #2 POST holdup.example/curl-iron arrived +0.4s: client-abort@30.01s
  |  http=502 t=30.011657
## claude-webfetch
  held request #16 GET docs.gw/page arrived +0.6s: client-abort@60.001s
  | tool_result: "timeout of 60000ms exceeded"
```

### E10: agentgateway の extAuthz を保留に使えるか

`scripts/e10.sh` は agentgateway v1.7.0 の `extAuthz`（HTTP）を、答えるまで寝ている認可サービス（`fakes/authz.ts`）に向け、curl（時間切れなし）で 2 つの bind を叩く。

```
port 80 started 1795870112 ended 1795870114: authorization failed http=403 t=2.011339
port 3002 started 1795870112 ended 1795871073: {"method":"POST","path":"/x","len":10,...} http=200 t=960.659597
2026-11-28T12:48:34.837Z authz caller aborted after 2.004s
2026-11-28T13:04:33.473Z authz answering 200 after 960.64s (caller gone=false)
```

- 既定の設定では、extAuthz の呼び出しは 2 秒で切れて 403（閉じる側）になる `[measured: out/e10/client.txt]`。
- extAuthz の `policies.http.requestTimeout: 30m` と経路の `timeout.requestTimeout: 30m` を足すと、960 秒保留して認可サービスの 200 の後に上流へ流した `[measured]`（`fakes/agw-e10.yaml`）。どちらか片方だけで足りるかは分けて測っていない。
- 認可サービスには既定で本文が渡った（`includeRequestBody: {}`、`body=approve-me`）。上限は既定 8192 bytes `[docs dl/agentgateway/schema_config.md "maxRequestBytes"]`。
- つまり agentgateway 自身は 16 分持つ。持たないのはクライアントの側（上の表）。

### 読み方

- 15 分の保留を、全クライアントが待てるわけではない。待てたのは curl・git・gh の 3 つだけで、npm（300 秒）、Node の `fetch`（300 秒）、Claude Code のモデル呼び出し（360 秒）、WebFetch（60 秒）、pip（15 秒）は先に切れる `[measured]`。
- 切れたクライアントのうち npm・pip・Claude Code は同じ要求を送り直す。線の上の保留が要求ごとに人に聞くなら、npm publish 1 回で書き込みの承認依頼が 3 回出る（I8 の破れ）。承認を「同じ正規形の本文は 1 回だけ聞く」にすれば 2 回目以降は聞かずに済むが、そうすると承認を使い回すことになり、承認した書き込みの重複（同じ issue を 2 つ作る）は止められない `[argued]`。
- MITM の iron-proxy を間に挟むと、既定では 30 秒で切れる。`upstream_response_header_timeout` を延ばせる `[docs dl/iron-proxy/iron-proxy.example.yaml:35-39]` が、延ばしたかどうかに関係なく上の各クライアントの時間切れは残る `[argued]`。

## 未確認のこと

- Linux の Docker では一つも流していない。
- WebFetch がモデルの宛先 `api.anthropic.com` で消える理由。
- 本物の GitHub・npm・PyPI の振る舞い（gzip の要求本文を受けるか、重複キーをどう読むか、Bearer の git を受けるか）。偽の上流は寛容に作った。
- iron-proxy の `body_capture` と secrets の `match_body` は使っていない（本文の検査は自前のゲートウェイで測った）。
- E10 で、extAuthz の時間切れと経路の時間切れのどちらが効いているかは分けていない。E10 のクライアントは curl だけ（他のクライアントの時間切れは U5 で測った）。
- 保留中に Claude Code が出した stderr は取っていない（再送の間隔はゲートウェイ側の記録から出した）。
