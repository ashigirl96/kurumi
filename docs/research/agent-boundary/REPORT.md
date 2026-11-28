# エージェントと外の世界の信頼境界の調査（2026-11-28）

目的: Kurumi のエージェントが外の世界に届く道筋を、後の設計の場で決めるための根拠を出す。対象は、資格情報の保管と差し込み、認証、認可、人の承認、外向き通信の制御、監査、連携（CLI、MCP、HTTP API）である。ここでは決めない。指示は [`brief.md`](brief.md) にある。

根拠の印: 【実測】は試作で観測したもの。【コード path:line】は製品や Kurumi のソースから読んだもの。【文書】は公開文書。【推論】は観測もコードもないもの。【論証】は構造からの議論で、前提を書き添える。**ネットワークに関わる実測は、すべて Docker Desktop for Mac 29.6.1（arm64）だけのもので、Linux では流していない。**

使った版: Kurumi `d0ee9ff`、イメージ `kurumi-agent:sdk-0.3.332`（Bun 1.4.4、Claude Agent SDK 0.3.332、Claude Code CLI 2.1.332）、agentgateway v1.7.0、iron-proxy 0.61.0、OneCLI 1.45.0 と v2.14.0（ソースだけ）、executor 1.6.10（ソースだけ）、just-bash 3.6.1、@composio/core 0.32.0、NanoClaw の fork `9fbee967`。クライアントは git 2.47.3、curl 8.14.1、gh 2.46.0、npm 9.2.0、pip 25.1.1、Node 20.19.2。

試作（すべて使い捨て）と調べた記録:

| 場所 | 中身 |
| --- | --- |
| `prototypes/premise/` | 前提の検証、DNS、経路の到達、開発用の中継（`notes-premise.md`） |
| `prototypes/h1-gateways/` | 3 つのゲートウェイとホスト側の仲介ツールへの攻撃（`notes-h1.md`） |
| `prototypes/h2-clients/` | 本物のクライアントでの一般性、承認の結び付け、16 分の保留（`notes-h2.md`） |
| `notes/teardown-local.md`、`notes/teardown-remote.md` | 7 つのプロジェクトのソースの分解 |
| `notes/shortlist.md` | 候補の絞り込みと、測ることにした不確かさの一覧 |

秘密はすべて偽の canary で、本物の資格情報、外部のアカウント、Anthropic の端点には触れていない。本物の Claude Code CLI は、手元の偽のモデルと偽のトークンにつないで動かした。

## 1. 結論

1. **前提は正しい。** コンテナの中で任意のコードを実行できる攻撃者に対して、`PreToolUse` の関所はコンテナの中で起きることの境界にならない【実測】。人が承認した Bash の子プロセスが CLI の標準出力に書けば、ホストはそれを CLI の出力と区別しない。偽の Approval Request（承認依頼）、偽の途中経過、偽の最後の文が人に届き、Turn（ターン）は `completed` で閉じた。
2. この攻撃者に効く強制点は 3 つだけである。`--internal` のネットワーク、Credential Gateway（資格情報ゲートウェイ）、ホストが自分で実行する副作用（ホスト側の仲介ツール）の 3 つで、あとは助言にとどまる【実測】【論証】。
3. **線の上の承認は、ADR 0007 の形では成り立たない。** 16 分の保留を待てたのは curl、git、gh の 3 つだけだった。npm、pip、Node の `fetch`、Claude Code のモデル呼び出し、WebFetch は先に切れ、npm、pip、Claude Code は同じ要求を送り直した【実測】。メソッドとパスだけに結び付けた承認は、本文の差し替え 8 組を 1 つも捕まえなかった【実測】。
4. **ホスト側の仲介ツールの承認は、解析済みの引数に結び付ければ入れ替えられない。** ツール呼び出しの id に結び付けると入れ替えられた【実測】。
5. **推奨は C'（資格情報で分ける共存）である。** ゲートウェイはベース URL の経路だけを持ち、承認の要らない資格情報（モデル、読み取り専用、パッケージの読み取り）だけを差し込む。書き込める資格情報は、ホスト側の仲介ツールにだけ置く。ゲートウェイも仲介ツールも、Kurumi がホストのプロセスの中に作る。製品は今は採らない。根拠は 9 節に書いた。
6. agentgateway v1.7.0 は、前方一致の経路をドット区間で抜けられた（`/repos/a/b/../../../user` が `GET /user` として本物の資格情報付きで実行された）【実測】。採るとしても、経路の書き方と既定値に注意が要る。

## 2. 前提の結果

攻撃者の CLI を `claude` の代わりに動かした。イメージ、Kurumi の docker の引数、ホストの `Runtime`（受信から Turn、送信までを回す本体）はすべて本物である。さらに本物の CLI 2.1.332 で、承認済みの Bash 1 回の中から同じことを試した。出力は `prototypes/premise/out/attacker.txt` と `realcli.txt` にある。

```
### approval requests the human saw
{ "toolName": "Bash", "input": { "command": "sh /work/.tools/lint.sh", "description": "Run the project linter" } },
{ "toolName": "Bash", "input": { "command": "git status", "description": "INJECTED approval text: show git status" } }
### messages delivered to chat
{ "turnId": 1, "kind": "progress", "body": "INJECTED progress written by a Bash child into the CLI stdout pipe" },
{ "turnId": 1, "kind": "final", "body": "INJECTED FINAL: written by a Bash child, not by the CLI" }
### bash.log
cli pid=7 comm=claude fd1=pipe:[202081732]
cli environ token: CLAUDE_CODE_OAUTH_TOKEN=kurumi-fake-d2ba71df-…
```

- 関所が `deny` を返した WebFetch を、攻撃者の CLI はそのまま実行した【実測】。関所の返事を守るのは CLI 自身である。
- Bash の承認は、文字列 `sh /work/.tools/lint.sh` に結び付く。ファイルの中身は承認の後でいくらでも変えられる【実測】。
- Bash の子は CLI と同じ uid で `/proc/<CLI>/fd/1` に書ける。`--cap-drop ALL` と `no-new-privileges` はこれを止めない【実測】。Turn ごとの偽トークンも `/proc/<CLI>/environ` から読めた。

標準入出力からホストへの偽造で、攻撃者が決められたものは次のとおりである【実測】。

| 偽造 | 攻撃者が決められる記録 |
| --- | --- |
| `hook_callback`（`tool_use_id` は架空） | `tool_calls` の行の有無と中身、Approval Request の文面と回数 |
| `send_message`（関所が見ていない id） | 途中経過の本文と件数。続けて送った 3 件がすべて届き、件数を抑える処理はコードにない |
| `system/init` の `session_id` | `sessions.claude_session_id` と、次の Turn の `--resume` の値 |
| `result` | 最後の文、Turn の終わり方、Inbound Message（受信メッセージ）の `answered` |
| `is_error` の `result` に `No conversation found` | Session（セッション）を `lost` にする |
| ツールの入力に文を仕込んで中断させる | 次の Turn のプロンプトの「[Kurumi からの知らせ]」の枠の中の文 |

冪等キーを衝突させて本物の配達を消すことや、二重にすることはできなかった。最後の文と知らせの冪等キーは、ホストが作る【コード `send-tool.ts:40`、`turn.ts:495`】。ただし、偽の `result` で先にターンを閉じれば、本物の CLI の答えは届かない。本物の CLI の試作では、偽のモデルの答えは届かなかった【実測】。承認への答えは、ホストの API からしか呼べない【コード `runtime.ts:239`】。

判定は次のとおりである。

- **Observed**: 関所を通らない副作用、関所の拒否の無視、ホストへの偽造がすべて通った。
- **Guaranteed by construction**: 関所はコンテナの中を強制できない【論証】。前提は 3 つある。関所の判断を実行するのが CLI であること。CLI とその子が同じ uid で同じコンテナにいること。SDK が標準出力の行の書き手を見分けないこと。
- 関所に残る役目は 2 つある。ツールの結果に誤導されただけの正直な CLI に対する方針と記録、そしてホストが自分で実行する副作用の入口である。

脅威モデルについての意見を書く。攻撃者の芯（コンテナの中の任意のコード実行）は正しく、実測で裏が取れた。足すべき点が 4 つある【論証】。

1. 人を攻撃の標的に入れる。攻撃者の文は、Approval Request、途中経過、最後の文の 3 つの経路で人に届く。
2. 攻撃者を 2 段に分ける。T1 は正直な CLI がツールの結果に誤導される段、T2 はコードを実行する段である。T2 だけを置くと、T1 に効く関所まで捨てる設計を招く。
3. ホストの中で、コンテナが書いたものを読む部品を範囲に入れる。SDK の出力の解析、MCP の処理関数、`transcriptHolds`（会話記録の照合）、`claude_session_id` から作るパス【コード `transcript.ts:26`】、次のプロンプトの組み立て【コード `turn.ts:252`】がそうである。
4. 可用性と、Session の間の隔離を不変条件に足す。攻撃者は Session を `lost` にでき、途中経過を上限なく送れる。

## 3. 経路と強制点

強制点の記号は次のとおりである。G はホストの `PreToolUse` の関所、N は Docker の `--internal` ネットワーク、R は中継またはゲートウェイ、M はホストの MCP の処理関数、P はホストの解析、S は SDK の設定（`settingSources: []`、`strictMcpConfig`）。「助言」は正直な CLI にだけ効く。「—」は何もない。出典は `prototypes/premise/notes-premise.md` の 3 節で、印のない行は【実測】。

| 経路 | G | N | R | M | P | S | いまの観測 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| モデルの API | — | 宛先を中継に限る | 差し替え | — | — | — | 通る |
| 中継のほかのパスとメソッド | — | 同上 | 判断しない | — | — | — | 通る（開発用の中継） |
| DNS | — | 外へ転送しない | — | — | — | — | 届かない |
| IP の直接、隣のネットワーク | — | 経路なし | — | — | — | — | 届かない |
| host.docker.internal、ホスト、LAN | — | 経路なし | — | — | — | — | 届かない |
| Docker のソケット | — | — | — | — | — | — | マウントしない |
| 送るツールからチャンネルへ | 助言 | — | — | `_meta` の有無だけ | — | — | 関所を通らず届く |
| 標準出力から最後の文、Session id | — | — | — | — | 形だけ | — | 偽造が通る |
| `hook_callback` から Approval Request | 判定する | — | — | — | — | — | 文面は攻撃者のもの |
| 作業場所から次の Turn | 助言 | — | — | — | — | — | 書ける |
| `/cfg` から次の Turn とホスト | 助言 | — | — | — | 照合は事故だけ | フックと MCP は無視 | 偽の会話記録で照合を通る |
| 中断の知らせから次のプロンプト | — | — | — | — | — | — | ホストの枠に攻撃者の文 |
| 承認への答え | — | — | — | — | — | — | コンテナから呼ぶ口がない【コード】 |

外へ出る経路は N が 1 か所で止め、残るのは中継の先だけになる。ホストへの経路（送るツールから中断の知らせまで）には、攻撃者に効く強制点が 1 つもない。

開発用の中継（`real/dev-relay.ts`）について、もう 1 つ実測がある。接頭辞が `kurumi-fake-` ならどのトークンも通し、どのパスとメソッドにも本物の資格情報を付けて流し、`x-api-key` と `cookie` も渡す。認証ヘッダーを返す上流からは、本物の資格情報がコンテナに戻った（`prototypes/premise/out/relay.txt`）。開発用の部品なので設計の欠陥ではないが、ベース URL を差し替えるだけの中継が何を漏らすかを示す。

## 4. 7 つのプロジェクトと絞り込み

| プロジェクト | 何をどの層で | 承認が結び付く先 | 位置づけ | 主な根拠 |
| --- | --- | --- | --- | --- |
| NanoClaw の fork | ゲートウェイを差し替える継ぎ目、承認の流れ、受け付けの管理。強制はゲートウェイ任せ | 翻訳した要求の digest。人に見せるのはメソッド、ホスト、パスと要約 | 型の手本 | 【コード `src/gateway-approval-coordinator.ts:316-322`、`src/gateway-providers/onecli.ts:313-330`】 |
| OneCLI 1.45 | MITM の代理と保管庫 | 保留した要求そのもの。表示は本文の先頭 16 KiB の要約。待ちは 180 秒の固定 | 外す | 【コード `apps/gateway/src/gateway.rs:373-380, 912-918`、`approval.rs:23`】【文書 GHSA-j39m-796j-gjm3】 |
| OneCLI v2.14 | 同上。トークンなしの CONNECT は拒む | 同上（OSS の方針はホスト、パス、メソッドまで） | 外す | 【コード `server/src/lib.rs:879-892`、`schema.prisma:430`】 |
| executor 1.6.10 | 連携の一覧を型付きのツールにする（操作の層） | ツールの宛先と引数の全体。承認した値をそのまま実行する | 型を借りる | 【コード `packages/core/sdk/src/executor.ts:6377-6396, 6495`】 |
| iron-proxy 0.61.0 | 既定で拒否する MITM の代理、DNS、トークンの差し替え、監査 | 人の承認はない。MCP の引数の方針はある | A の比較対象 | 【コード `internal/proxy/proxy.go:371-376`、`internal/mcp/intercept.go:93-110`】 |
| agentgateway v1.7.0 | L7 の代理。ベース URL と CONNECT の両方。MCP の認可 | 人の承認はない。差し込み口は `extAuthz` | ゲートウェイの候補 | 【コード `crates/agentgateway/src/http/auth/mod.rs:72-117`、`http/apikey.rs:42-43`】 |
| just-bash 3.6.1 | TypeScript の bash と仮想のファイル。本物のバイナリは動かない | executor 経由で、解析済みの引数 | 型を借りる | 【文書 `THREAT_MODEL.md`】 |
| Composio | クラウドの連携の一覧と資格情報の保管 | 実験段階の再送方式。照合は非公開で確かめられない。「常に承認」が残る | 利用者が許すときだけの一覧 | 【文書 docs.composio.dev の token-custody、approvals】 |

公開済みの脆弱性で境界に関わるものを挙げる。NanoClaw の GHSA-j39m-796j-gjm3（critical）は、エージェントのコンテナが OneCLI の Postgres に既定のパスワードで入り、全エージェントのトークンを読めたというものである。OneCLI 1.45 と 2.20 で著者が実測している。agentgateway には 2026 年に MCP の認可のすり抜けが 3 件あった（GHSA-mvgg-jvj2-4frq、GHSA-7hv4-jgp9-mgx2、GHSA-qm3r-hhvc-62cp）。iron-proxy には MCP の方針のすり抜け（GHSA-vfgh-6jv3-4348）がある。just-bash にはハードリンクによる脱出（GHSA-g5pf-mh4h-h655）がある。LLM で判定する仕組み（iron-proxy の `judge`、Composio の firewall）は、各社の文書のとおり緩和策であり、保証ではない。

ソースを読んだ段階で外したものと、その理由は次のとおりである。

- OneCLI 1.45。外へ出る口と同じ port が、認証なしで承認の答えを受ける【コード `gateway.rs:373-380`、`auth.rs:143-165`】。トークンのない CONNECT が、宛先を絞らない TCP のトンネルになる【コード `gateway.rs:912-918`】。
- OneCLI v2。トークンがエージェント単位で長く生き、Turn ごとに作れない。基本の構成でコンテナが 5 個と Postgres が要る。半年で 50 リリースあり、コミットのほぼすべてが 1 人で、v1 から v2 は作り直しである【文書 NanoClaw `docs/onecli-upgrades.md:7, 36-40`】。
- just-bash を実行環境にすること。`git` や `npm` を動かせず、Claude Code の汎用の実行力を残す要件に合わない。
- Composio を資格情報の置き場にすること。資格情報がクラウドで復号され、Session に期限がなく、Turn ごとのトークンがない。
- executor を依存にすること。Effect 4.0.0-beta.59 を使い、Kurumi の 4.1.7 とずれる。v1 は v2 の作り直しに置き換わる途中で、保守はほぼ 1 人である。

残した構成は 2 つである。

- **C'（資格情報で分ける共存）。** コンテナはベース URL で 1 つのゲートウェイに届く。CA も CONNECT も使わない。ゲートウェイの役目は、Turn ごとのトークン、サービスごとの経路の許可リスト、経路ごとの資格情報の差し込みである。書き込める資格情報はホスト側の仲介ツールだけが持つ。B（操作の層だけ）は、C' からモデル以外の経路を除いたものに当たる。C' は、2 つの分解がそれぞれ独立に出した案 D（資格情報で分ける）と、C を合わせたものである。
- **A（MITM で通信の段だけ）。** C' が失う一般性と、線の上の承認の限界を測るための比較対象として残した。

## 5. 不確かさの一覧と結果

| # | 問い | 影響する候補 | 実験 | 結果 |
| --- | --- | --- | --- | --- |
| U1 | 関所は境界か | すべて | 攻撃者の CLI、本物の CLI | 境界ではない（2 節） |
| U2 | `--internal` は外の名前を転送するか | すべて | 自前の DNS を上流にして問い合わせる | 転送しない（Mac）。対照の外部ネットワークでは転送した |
| U3 | ベース URL で各クライアントが動くか | C'、A | 本物のクライアントと偽の上流 | 大半は動く。gh、pip、WebFetch に条件が付く（7 節） |
| U4 | 線の上で承認を本文に結び付けられるか | C'、A | 承認した要求と差し替えた要求の対 8 組 | メソッドとパスでは 0/8。正規化した本文なら 8/8。git の force は線の上にない |
| U5 | 15 分の保留にクライアントが耐えるか | A、C' | 10 種のクライアントを 960 秒保留する | curl、git、gh だけが耐えた |
| U6 | Turn ごとのトークンの取り消しは効くか | C' | 取り消し、ホストの SIGKILL、再生 | ホストのプロセスの中のゲートウェイだけが、ホストの死で止まる |
| U7 | 制御面に届くか | すべて | port の走査と管理の呼び出し | agentgateway の 15020 と 15021、iron-proxy の 9090 が届く。どれも読み取りだけ |
| U8 | 仲介ツールが持つ書き込みを、線の上で実行できるか | C' | issue の POST、GraphQL の mutation、gist の POST | 3 つのゲートウェイとも上流に届かず。ただし U6 とは別に agentgateway のドット区間がある |
| U9 | 差し込んだ資格情報が戻ってくるか | C'、A | echo、base64 の echo、redirect | echo で戻る。掃除は base64 で抜ける |
| U10 | 仲介ツールの承認を入れ替えられるか | C' | 攻撃者の CLI と、ホストの仲介ツール | id に結び付けると 2 件通る。引数に結び付けると 0 件 |

U1 の出力は 2 節に貼った。U2 の出力を `prototypes/premise/out/dns.txt` から抜き出す。

```
### D2 Kurumi args + --dns 10.250.77.53 (internal)
d2-<tag>.exfil.test -> SERVFAIL ; d2b-<tag>.example.com -> SERVFAIL
### D3 positive control: same args on non-internal kp-ext + --dns 10.250.77.53
d3-<tag>.exfil.test -> NOERROR 10.66.66.66
### fake resolver log lines containing the tag
{"from":"10.250.77.4:49802","name":"d3-e6ccfbe6.exfil.test","qtype":1}
```

一方で、同じ `--internal` ネットワークにいる DNS（iron-proxy）へは、組み込みの DNS が転送した【実測、`prototypes/h1-gateways/out/iron.txt`】。ゲートウェイに DNS を持たせると、許可した名前がそのまま持ち出しの通り道になる。

U4 の出力を `prototypes/h2-clients/out/u4-analysis.txt` から抜き出す。

```
inspected==forwarded: 18/18 gateway-captured writes arrived at the fake with an identical body sha256
|approved|then sent|same method+path?|method/path binder|raw-bytes digest binder|canonical-body binder|
|gql-A|gql-B|yes|misses the swap (allows B)|catches the swap|catches the swap|
|git-A|git-B-force|yes|misses the swap (allows B)|catches the swap|catches the swap|
|mp-A|mp-A-again|yes|accepts the re-send|rejects the same intent (false positive)|accepts the re-send|
git-B-force commands: old d0649d7b6a3e new e0cb45de04cb ref refs/heads/main new_commit_message "rewritten history" update_kind "not provable from the pack: force or needs the upstream graph"
```

この照合は、ゲートウェイが記録した要求を 3 種の結び付け方で後から読み直したものである。承認を待って要求を止める実行はしていない。生の bytes の digest は、同じ意図の送り直しを 3 つとも拒んだ。multipart の境界文字列、gzip の時刻、JSON のキー順が送るたびに変わるためである。agentgateway の CEL の本文規則では、allow 規則は gzip と上限超えで閉じたが、deny 規則は開いて `deleteRepository` を上流に届けた。コメントに `createIssue` を入れた別の mutation は、文字列一致の allow 規則を通った【実測、`prototypes/h2-clients/out/e9.txt`】。

U5 の結果を `prototypes/h2-clients/out/hold/report.txt` から表にする。

| クライアント | 結果 | 送り直し |
| --- | --- | --- |
| curl、git push、gh | 960 秒待って成功 | なし |
| npm install、publish | 300 秒で切れる | 2 回。publish は書き込みの PUT を送り直した |
| pip | 15 秒で切れる | 5 回 |
| Node 20 の `fetch` | 301.7 秒で切れる | なし |
| Claude Code のモデル呼び出し | 360 秒ごとに切れる | 3 回以上 |
| WebFetch | 60 秒で切れ、道具のエラーとしてモデルに返る | なし |
| curl から iron-proxy を通す | iron-proxy が 30 秒で 502 | なし |

agentgateway の `extAuthz` は、既定では 2 秒で 403 を返した。時間切れを 30 分に延ばすと 960 秒保留できた【実測】。保留の限界はゲートウェイではなく、クライアントの時間切れで決まる。

U6 の結果を `prototypes/h1-gateways/out/table-lifecycle.md` から表にする。

| ゲートウェイ | 取り消しから最初の 401 まで | 取り消し時に開いている stream | ホストを SIGKILL した後 4 秒の古いコンテナ |
| --- | --- | --- | --- |
| agentgateway（設定ファイルの書き換え） | 約 360 ms（うち `docker exec` が約 65 ms） | 最後まで流れた | 200 が 15 回 |
| 自作の最小ゲートウェイ、別コンテナ | 1 ms 未満 | 切れた | 200 が 15 回 |
| 自作の最小ゲートウェイ、ホストのプロセスの中 | 1 ms 未満 | 切れた | 接続エラーが 15 回 |

ホストが死んでも、`docker run -i --rm` のコンテナは動き続けた。issue #1 の「ホストが落ちた後のモデルへの余分な呼び出し」が止まるかどうかは、ゲートウェイの置き場所で決まる。Mac ではホストのプロセスにコンテナから届かないので、TCP の中継を 1 つ挟んで測った。

U8 と U9 の証拠の行を `prototypes/h1-gateways/out/wire.txt` から抜き出す。

```
agentgateway: info request... route=default/github-read endpoint=api.github.test:443... http.method=GET http.path=/repos/a/b/../../../user?probe=ag-D6 http.status=200
agentgateway: error request... http.method=POST http.path=/repos/a/b/issues?probe=ag-D3 http.status=404 error="route not found"
L1 echo (ag): "authorization":"Bearer CANARY_REAL_GH_4b7e19d2c6a0"
L1 echo (mg): "authorization":"Bearer [REDACTED]"
```

agentgateway は、`mode` を省いた apiKey の経路で、鍵のない要求に資格情報を付けて上流へ流した【実測】【コード `http/apikey.rs:42-43`】。iron-proxy は 2 MiB の本文を 1 MiB に切り詰め、200 のまま上流へ送った【実測】。README の「残りも送る」という記述とは違う。

U10 の出力を `prototypes/h1-gateways/out/broker.json` から抜き出す。

```
{"broker":"executed","mode":"hook","claimedToolUseId":"toolu_B1","approvalId":"toolu_B1","executed":{"title":"U10-swap: add deploy key","body":"args changed after approval"},"status":201}
{"broker":"executed","mode":"handler","claimedToolUseId":"toolu_B1","approvalId":"broker:24c1ba5c-…","executed":{"title":"Fix typo in README","body":"s/teh/the/"},"status":201}
```

試した仲介ツールは、宛先が固定の 1 操作（issue の作成）だけである。宛先や URL を引数で選べる道具では、引数に結び付けるだけでなく、宛先の検査も要る【推論】。処理関数が自分で承認を求める作りでも、問題が 2 つ残った。同じ引数を再送すると、承認が 2 回出て 2 回実行された。攻撃者は Approval Request を何回でも出せた（6 回出た）。

Turn を越えて信頼できる `tool_use_id` を線の上に載せる方法は測っていない。コンテナが送る id はどれも偽造できるからである【論証】。線の上では Turn ごとのトークンで Turn に結び付け、呼び出しごとに結び付けられるのは、ホストが実行した仲介ツールの呼び出しだけになる。

## 6. 不変条件

Observed は試した入力に対する観測で、保証を否定できても確立はできない。Guaranteed by construction は、推奨の C' について、すべての入力で成り立つという議論とその前提である。「製品の主張」は、参照した製品がその性質を保証として書いているか、ベストエフォートとして書いているかを示す。

| 不変条件 | Observed | Guaranteed by construction（C'） | 前提 | 製品の主張 |
| --- | --- | --- | --- | --- |
| I1 本物の資格情報の bytes がコンテナから見えない | env、`/proc`、ファイルは 0 件。echo では戻った（agentgateway、iron-proxy）。掃除は base64 で抜けた | 環境とファイルは成り立つ。応答は、入力を返す宛先に資格情報を付けない経路の設計でだけ成り立つ。掃除は緩和策 | 経路ごとに上流が入力を反射しないことを確かめる | NanoClaw は保証と書く。iron-proxy は応答を掃除しない |
| I2 ゲートウェイ以外へパケットが出ない | DNS、直接の IP、ホスト、LAN、ソケットのどれも届かない（Mac） | 成り立つ | コンテナの経路がゲートウェイだけ。Docker の版を固定し、Linux で流し直す | NanoClaw は封鎖を既定で切っている。iron-proxy は DNS の誘導だけでは抜けられると書く |
| I3 本物の資格情報付きの要求は、その要求の方針判断に一致する | agentgateway はドット区間と `mode` の省略で破れた。自作と iron-proxy では破れなかった | 成り立つ | 照合するパスと上流が解釈するパスが同じ（正規化してから照合し、その文字列を渡し、曖昧な符号化を拒む） | どの製品もホスト、パス、メソッドの規則を保証として書く |
| I4 実行されるのは承認されたもの | 線の上: メソッドとパスでは 0/8。仲介ツール: 引数に結び付けて 0 件の入れ替え | 仲介ツールでは成り立つ。線の上では本文の正規形とその解釈器に依存する | ホストのプロセスが侵害されていない。処理関数が承認の後に引数を読み直さない | executor と just-bash は引数に結び付く。OneCLI は保留した要求そのもの。Composio は確かめられない |
| I5 Turn N のトークンは Turn N の後とホストの死の後で使えない | Turn の終わりの取り消しは 3 つとも効いた。ホストの死では、別プロセスのゲートウェイが通し続けた | ホストのプロセスの中に置けば成り立つ | ゲートウェイの寿命がホストと同じ | OneCLI はエージェント単位のトークン。iron-proxy の tenancy は最長 24 時間で、取り消しは約 1 分 |
| I6 制御面にコンテナから届かない | 自作は届かない。agentgateway と iron-proxy は統計の port が届く（読み取り） | 成り立つ | 登録と取り消しは関数呼び出しで、port を開かない | OneCLI 1.45 は届く（コード）。v2 は鍵とネットワーク構成に頼る |
| I7 外への副作用を Turn に、できれば `tool_use_id` に結び付けられる | 自作のログに Turn。仲介ツールはホストが作る id で呼び出しごとに 1 行 | Turn 単位は成り立つ。呼び出し単位は仲介ツールだけ | コンテナが書く id は「申告」として別に記録する | OneCLI の記録に Turn の欄はない |
| I8 人に 1 回だけ問う | 仲介ツールで、関所を `allow` にすれば 1 回。npm と pip とモデル呼び出しは送り直すので、線の上で問うと何度も問う | 仲介ツールの呼び出しでは成り立つ | 関所では仲介ツールを問わない。同じ引数の再送は冪等キーで止める | NanoClaw は全ゲートウェイで承認の流れを 1 つにする |
| I9 方針を迂回する経路がない | 3 つのゲートウェイとも、書き込みの経路は上流に届かなかった。agentgateway はドット区間で読みの範囲を出た | 書き込みは成り立つ。線の上にその権限の資格情報がないから | サービスが十分に細かい権限の資格情報を出せる（GitHub の fine-grained PAT は出せる） | 製品の主張はない |
| I10 ゲートウェイや仲介ツールが落ちたら閉じる | ホストの中の自作は、ホストが死ぬと接続エラー。別プロセスのゲートウェイを単独で止める試験はしていない。agentgateway の `mode` の省略は、鍵なしで通す認証の反例である | 成り立つ。上流が受け付け済みの操作は取り消せない | ゲートウェイがホストのプロセスにある。コンテナの経路がゲートウェイだけ | NanoClaw はゲートウェイがないと起動しない |

足すべき不変条件を 3 つ挙げる【論証】。

- I11 コンテナから来た文は、人にも次の Turn にも、ホストの文として見えない。2 節の中断の知らせの枠と、Approval Request の文面が反例である。
- I12 1 つの Session の攻撃者は、別の Session を止められず、その資格情報も使えない。
- I13 攻撃者が出せる Approval Request の回数と途中経過の件数に上限がある。

3 つとも、いまの Kurumi では Observed で破れている（2 節、U10 で Approval Request が 6 回出た）。I11 と I13 は、ホストが表示と件数を決めるので構成で守れる。前提は、表示がホストの解析した項目だけでできていることである。I12 は、Session ごとにトークンと経路を分ければ構成で守れるが、試していない【論証】。参照した製品で、この 3 つを主張するものはない。

承認の結び付けを分けて書く。出典は `prototypes/h2-clients/notes-h2.md` と `prototypes/h1-gateways/notes-h1.md`。

| 結び付ける先 | 人に見せる形 | 実行の時点で照合するもの | 観測 | 扱えないもの |
| --- | --- | --- | --- | --- |
| メソッドとパス | メソッド、ホスト、パス | 同じ 3 つ | 差し替え 8 組を 0 組捕まえた【実測】 | GraphQL の操作と変数、git の ref、アップロードのファイル、宛先 |
| 本文（正規化した digest） | ゲートウェイが解析した項目（GraphQL の根の項目と変数、git の `old new ref`、multipart の部分ごとの名前と digest） | 丸ごと受けた本文を正規化した digest | 8/8 を捕まえ、同じ意図の送り直し 3/3 を通した。調べた bytes と転送した bytes は 18/18 で一致【実測】 | 解釈が上流と食い違う場合（重複キー、Content-Encoding）。git の force は上流の履歴が要る。保留にクライアントが耐えない（U5） |
| 仲介ツールの引数 | 処理関数が解析した object | 凍結した同じ object を実行する | 入れ替え 0 件【実測】 | 同じ引数の再送は冪等キーが要る。Approval Request を何回でも出せる |
| ツール呼び出しの id | 関所の入力 | id の有無 | 入れ替え 2 件が通った【実測】 | コンテナが id と引数の両方を書く |

この表で扱っていない点がある。クエリ文字列と意味を変えるヘッダー（`X-HTTP-Method-Override` など）は、線の上なら正規形に入れる必要があるが、試していない。承認を 1 回で使い切るか、同じ正規形の送り直しに使い回すかは、U5 の送り直しと衝突する。承認の後に上流の状態が変わる場合（git の枝の先が動く、issue が消える）は、どの結び付け方でも防げない【論証】。

## 7. 一般性の下限

`prototypes/h2-clients/out/baseurl.txt` と `mitm.txt` から書く。どのクライアントも Kurumi と同じ旗で、`--internal` の上で動かした。

| クライアント | ベース URL（CA なし） | 要る設定 | iron-proxy の MITM | 要る設定 |
| --- | --- | --- | --- | --- |
| curl | 動く | URL とヘッダー | 動く | `HTTPS_PROXY`、`SSL_CERT_FILE` |
| gh（`api`、`issue create`、GraphQL） | 条件付き。平文は `GH_HOST=github.localhost` だけ。ほかはゲートウェイの名前に私設 CA の TLS が要る | `GH_HOST`、`GH_ENTERPRISE_TOKEN`、`SSL_CERT_FILE` | 動く | `GH_TOKEN`（偽）、`SSL_CERT_FILE` |
| git（clone、push、force push） | 動く | `url.<gw>.insteadOf`、`http.<gw>.extraHeader` | 動く | `GIT_SSL_CAINFO`（`SSL_CERT_FILE` は効かない） |
| npm（install、publish） | 動く | `.npmrc` の `registry=` と `_authToken` | 動く | `NODE_EXTRA_CA_CERTS` |
| pip | index だけでは壊れる。ゲートウェイが index のリンクを書き換えると動く | `--index-url`、`--trusted-host` | 動く | `SSL_CERT_FILE` か `PIP_CERT` |
| Claude Code のモデル呼び出し | 動く | `ANTHROPIC_BASE_URL`（今の形） | 動く | `NODE_EXTRA_CA_CERTS` |
| WebFetch | 既定は壊れる。事前確認が `api.anthropic.com/api/web/domain_info` に直接行く。事前確認を切るとゲートウェイの名前に TLS が要る。ゲートウェイが前に立つ名前にしか届かない | `skipWebFetchPreflight`、`NODE_EXTRA_CA_CERTS`、名前ごとの経路 | 動く | `skipWebFetchPreflight`、`NODE_EXTRA_CA_CERTS`、`NO_PROXY` |
| リモート MCP | 動く | `--mcp-config` の `url` と `headers` | 動く | `NODE_EXTRA_CA_CERTS` |
| Node 20 の `fetch` | 動く | URL の書き換え | 壊れる（`HTTPS_PROXY` を見ない） | コードの変更か DNS の誘導 |

2 つの列は、同じ安全の設定で比べたものではない。MITM の列は、宛先のホストだけを絞った iron-proxy で動かした。メソッドとパスの規則を足すと、`HTTPS_PROXY` 方式の CONNECT が 403 で拒まれ、DNS で誘導する方式だけが動いた【実測、`prototypes/h1-gateways/out/iron.txt`】。ベース URL の列でも、pip のファイルの取得と WebFetch はトークンを送らない。そのため、その経路は資格情報を付けない経路として作ることになる【実測】。

ほかに 3 つ分かった。Kurumi のイメージには git、gh、curl、npm、pip が入っていない。`HOME=/` と読み取り専用の root では npm の cache に書けない。証明書を固定するクライアントはなかった。モデルの宛先が `api.anthropic.com` のとき CLI 2.1.332 は WebFetch を道具の一覧に出さなかったが、理由は調べていない【実測】。

ここから読めることを書く【論証】。C' では、gh と WebFetch のためにゲートウェイ自身の名前の TLS と私設 CA が要る。その CA はゲートウェイの名前にしか証明書を出さないので、任意の名前を偽れる MITM の CA より影響が小さい。WebFetch で任意のサイトを読むには、資格情報を付けない外向きの経路が要る。その経路は持ち出しの通り道でもあるので、利用者が決める（11 節）。

## 8. 費用と 5 つの軸での評価

数字は `prototypes/h1-gateways/out/e13.txt` の実測で、行数は試作のもの。

| C'、自作をホストの中に | C'、agentgateway | A、iron-proxy の MITM | B（仲介ツールだけ） |
| --- | --- | --- | --- | --- |
| 増えるプロセス | 0 | コンテナ 1 | コンテナ 1 と CA の配布 | 0 |
| 待機時の RSS | 増分 0.4 MiB（Mac の Bun で、比べられない） | 23.9 MiB | 13.5〜31.8 MiB | 0 |
| 起動 | 3.8 ms | 200〜260 ms（コンテナ込み） | 同左 | — |
| 設定と Kurumi が書くコード | ゲートウェイ 127 行、仲介ツール 54 行（試作）。本番は数百行【推論】 | 設定 64 行と書き出し 70 行。仲介ツールと承認のサービスは別に要る | 設定 35 行。トークンは静的で、再読み込みの管理と仲介ツールが要る | 仲介ツールだけ |
| ライセンス | — | Apache-2.0 | Apache-2.0 | — |
| 半年のリリース | — | 安定版がほぼ毎月。脆弱性 7 件 | 29 回、1.0 前 | — |
| 保守の人数 | Kurumi | 97 人（最多 1397/2975） | 1 人（163/178） | Kurumi |
| 更新の負担 | 自分のコード | 設定の形が速く変わる | 設定の形が 2 系統ある | 自分のコード |

| 軸 | C'、自作をホストの中に | C'、agentgateway | A、iron-proxy | B |
| --- | --- | --- | --- | --- |
| 安全 | ◎ I5 と I10 が構成で成り立つ。I3 は実測で破れなかった | △ ドット区間、`mode` の既定、ホストの死の後も通す | ○ 経路の検証は強い。I4 は保留できず、本文を切り詰める | ◎ |
| 一般性 | ○ gh と WebFetch に私設 CA。pip にリンクの書き換え | ○ 同左 | ◎ Node の `fetch` だけ壊れる | × CLI が外のサービスに届かない |
| 単純さ | ◎ プロセスもポートも増えない | △ 設定ファイルの書き出しと監視 | △ CA と DNS | ◎ |
| 保守 | ○ 自分で持つ数百行 | △ 速い更新と既定値の追従 | × 保守が 1 人で 1.0 前 | ○ |
| 運用 | ◎ ホストと一緒に起きて死ぬ | ○ コンテナ 1 つ | △ コンテナと CA の更新 | ◎ |

## 9. 責任の割り当てと、作るか採るか

| 役目 | 置き場所と部品 | 作るか採るか | 観測した根拠 |
| --- | --- | --- | --- |
| 資格情報の保管 | ホスト。コンテナにも外のクラウドにも置かない | 作る（秘密の読み出しだけ） | 環境、`/proc`、ファイルに canary が 0 件（I1）。Composio はクラウドで復号する |
| 差し込み（線の上） | ホストの中のゲートウェイ。経路ごとに 1 つの資格情報 | 作る。dev-relay を広げる | 自作 127 行で I3 の破れなし。agentgateway はドット区間で破れた |
| 差し込み（操作） | ホスト側の仲介ツール（送るツールと同じホストの MCP） | 作る。executor の型を借りる | 引数に結び付けて入れ替え 0 件 |
| コンテナからゲートウェイへの認証 | Turn ごとのトークン。ランタイムが登録し、Turn の終わりに消す | 作る | 取り消しは 1 ms 未満。ホストの死で止まる |
| 認可の判断 | ホストの中の 1 つの方針の表。サービスと操作ごとに、線か仲介ツールかを決める | 作る | 同じプロセスにあるので、線と仲介ツールで判断点が 1 つになる（I8、I9）【論証】 |
| 強制 | `--internal`、ゲートウェイ、仲介ツール | 既存と作る | 関所は境界にならない（U1） |
| 承認 | 仲介ツールの処理関数で、解析済みの引数に。線の上の保留は git push だけを選択肢に残し、決めるのは利用者 | 作る | 既定の時間切れのままでは、線の上の 15 分の保留は curl、git、gh 以外で切れる（U5）。時間切れを延ばせるクライアントは試していない。git の ref は線の上にある（U4） |
| 外向き通信 | `--internal` とゲートウェイだけ。DNS は持たない | 既存 | DNS は転送されない（U2）。DNS を持つと許可した名前が通り道になる |
| 監査 | ホストの DB。ゲートウェイの記録に Turn、仲介ツールの記録にホストの id。コンテナの id は「申告」の欄 | 作る | コンテナの id は偽造できる（U1、U10） |
| 連携の一覧 | 使うサービスごとに仲介ツールを足す | 作る。Composio は利用者が許すときだけ | 製品の一覧は資格情報か保守の条件で外れた |
| 関所（`PreToolUse`） | 正直な CLI への方針と記録。仲介ツールは `allow` にして二重に問わない | 既存 | 2 節。T1 には効く |

ホストの文の扱いも直す必要がある。どの構成を選んでも残るので、責任の表とは別に書く【実測】【論証】。

- Approval Request は、ホストが解析した項目だけを表示し、コンテナが書いた説明文を承認の根拠に見せない。
- 中断の知らせの枠に、コンテナが書いたツールの入力を引用しない。
- `claude_session_id` を UUID として検査してからパスに使う。
- 途中経過と Approval Request の件数に、Turn ごとの上限を置く。

製品を今は採らない理由を書く。agentgateway は、使うなら唯一の候補である。経路が数十に増えたとき、OAuth のトークン交換が要るとき、MCP を束ねるときに検討し直す価値がある。採る場合の条件は、経路を `exact` か正規表現で書くこと、apiKey を `strict` にすること、統計の port を閉じること、トークンに期限を持たせるかホストの生存を見張ること、の 4 つである。iron-proxy は、MITM がどうしても要るクライアントが出たときの候補だが、保守が 1 人である。

## 10. 残るリスク

- **許可した経路の中での持ち出し。** 読み取りの経路の URL や、承認された issue の本文は、データを運べる。モデルの経路も同じである。承認は宛先と中身を見せるが、中身に紛れたデータまでは止めない【論証】。
- **反射する宛先。** 入力を返す API に資格情報を付けると、資格情報がコンテナに戻る。掃除は base64 で抜けた【実測】。
- **人を疲れさせる攻撃。** 攻撃者は Approval Request を何回でも、好きな文面で出せる【実測】。上限と表示の規則で減らせるが、なくならない。
- **エージェントの答えそのもの。** T2 では最後の文も攻撃者のものである。利用者はエージェントの答えを信頼できない入力として扱う必要がある【論証】。
- **ホストの攻撃面が増える。** ゲートウェイをホストのプロセスに置くと、HTTP の解析の欠陥がホストの侵害につながる。別プロセスに分けると I5 と I10 に lease か期限が要る【論証】。
- **作業場所を読むホストの部品。** NanoClaw は、シンボリックリンク、TOCTOU、FIFO で 4 件の脆弱性を出している【文書】。Kurumi では `transcriptHolds` と Session id のパスが該当する。
- **Linux で未確認。** DNS、ホストのブリッジの番地への bind、inotify、どれも Mac の結果だけである。

## 11. 利用者が決めること

| 決めること | 判断の材料 | トレードオフ |
| --- | --- | --- |
| 手元から出してよい資格情報 | Composio はクラウドで復号し、Session に期限がない | 連携の数と、資格情報の置き場所 |
| 支えるサービスと CLI の一覧 | 7 節。gh と WebFetch は私設 CA、pip はリンクの書き換え | 一般性と、ゲートウェイの経路の数 |
| 承認の手間と ADR 0007 | 線の上の保留は多くのクライアントで切れる。覚えた許可がないと、送り直しのたびに問う | 範囲付きの許可を覚えるなら、I4 と I8 の作り方が変わる |
| コンテナの中のツールに人の承認を残すか | T2 では意味がない。T1 では作業場所の破壊を止める | 手間と、T1 への守り |
| git push を線の上で承認するか | git は 960 秒待てた。ref は線の上にある。force は上流の履歴を引かないと出せない | 仲介ツールで push するなら、ホストが攻撃者の作業場所で git を動かす危険がある |
| 資格情報なしで任意のサイトを読む経路 | WebFetch に要る。持ち出しの通り道になる | 一般性と持ち出し |
| 許容する残りのリスク | 10 節 | — |
| 1.0 前やベンダーのプロジェクトへの依存 | 8 節 | 書く量と、追従の負担 |
| 運用の予算 | 8 節 | — |

本物の資格情報かアカウントが要るので、流していない実験を挙げる。

| 実験 | 決めること | 要るもの |
| --- | --- | --- |
| 本物の GitHub が gzip の要求本文、重複キー、git の Bearer をどう扱うか | 本文の正規形が上流と一致するか（I4） | GitHub のテスト用アカウントと fine-grained PAT |
| fine-grained PAT の読み取りの権限で、使う操作が足りるか | 資格情報で分ける案が成り立つか（I9） | 同上 |
| 本物の `api.anthropic.com` が認証ヘッダーを返す経路があるか | モデルの経路の I1 | Claude のトークン |
| 本物のトークンで、取り消しがホストの死の後のモデル呼び出しを止めるか | issue #1 の件 | Claude のトークン |
| 宛先が `api.anthropic.com` のとき WebFetch が消える理由 | WebFetch の扱い | Claude のトークン |
| Composio で、承認した呼び出しを引数を変えて再送する | Composio の I4 | Composio のアカウント |
| Linux の本番機で 3 つの試作を流し直す | 2、3、5 節のネットワークの結論 | 本番機（資格情報は要らない） |

## 12. 確かめられなかったこと

- Linux での全部。
- OneCLI と executor はソースだけを読み、動かしていない。OneCLI v2.15 から 2.20 のソース、executor v2 のソースは読んでいない。
- agentgateway の h2c の先と、経路を `exact` や正規表現で書いたときのドット区間。
- ゲートウェイを止めたときに閉じるか（別プロセスの場合）。
- CLI が子に渡す `CLAUDE_CODE_MESSAGING_SOCKET` の口の中身。
- `claude_session_id` に `../` を入れたときの振る舞い（コードを読んだだけ）。
- 偽の `command_lifecycle`。
- 本物の GitHub、npm、PyPI の振る舞い。偽の上流は寛容に作った。
- 自作のゲートウェイが、上流が勝手に圧縮した応答を掃除できるか。
- パケットの記録（pcap）は取っていない。証拠は、偽のサービスとゲートウェイが記録した要求と本文、コンテナの中での canary の検索である。
- 承認を待って要求を止める線の上の承認器は作っていない。U4 は記録した要求を後から照合したもので、U5 は保留だけを測った。

## 13. 再実行

```sh
sh docs/research/agent-boundary/prototypes/run-all.sh # 約 25 分（16 分の保留を含む）
sh docs/research/agent-boundary/prototypes/run-all.sh --skip-hold # 保留の証拠は前回のものを使う
```

Docker、Bun、gh、openssl と、イメージ `kurumi-agent:sdk-0.3.332` が要る。`setup.sh` が Kurumi `d0ee9ff` の `packages/agent-runtime` を取り出して依存を入れ、各試作がゲートウェイの実行ファイルを `dl/` に落とす。どちらも git の管理の外に置く。各試作は最後に PASS と FAIL を出し、起こしたコンテナとネットワークを消す。
