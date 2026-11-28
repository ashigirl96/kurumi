# H1: 候補のゲートウェイとホストの broker を攻撃する（2026-11-28）

根拠の印: `[measured]` はこのディレクトリの script で観測したもの（出力は `out/`）。`[code path:line]` はソース（agentgateway と iron-proxy は `dl/src/` の tarball、Kurumi は `repo/` の写し）。`[docs]` は文書。`[inferred]` は観測もコードもないもの。`[argued]` は前提を書いた構造上の議論。**ネットワークの結果はすべて Docker Desktop for Mac 29.6.1（linux/arm64 の VM）だけのもので、Linux では流していない。**

守った規則: 秘密はすべて偽の canary（`CANARY_REAL_GH_4b7e19d2c6a0`、`CANARY_REAL_MODEL_8d2f60a1e93c`）。外部のアカウントにも本物の資格情報にも触れていない。kurumi のリポジトリは編集していない（`repo/` は `../setup.sh` が Kurumi の commit `d0ee9ff` から作る写しで、試験用の `broker/broker-tool.ts` を置き、`broker.diff` を当てる）。落とした実行ファイルは `dl/` に置き、コンテナの中でだけ動かした。

再実行: `sh run-all.sh`（約 4 分。基盤を起こし、5 つの script を流し、43 個の主張を `out/checks.txt` で確かめ、コンテナ・ネットワーク・volume を消す）。最後の実行で 43 個すべて `REPRODUCED`。

## 結論

1. **agentgateway v1.7.0 の pathPrefix の経路は、ドット区間で抜けられる** `[measured]`。`GET /repos/a/b/../../../user` と `/repos/a/b/%2e%2e/%2e%2e/%2e%2e/user` は `github-read`（`/repos/a/b/` で始まる GET だけを通す経路）に一致し、生の path のまま上流へ渡り、上流が正規化して `GET /user` を本物の資格情報付きで実行した。経路の許可リストは I3 と I9 の境界にならない（照合する path と上流が解釈する path が違う）。正規化は Host の付け替えだけで、ドット区間を扱わない `[code crates/agentgateway/src/proxy/httpproxy.rs:4764-4787]`。自作の最小ゲートウェイと iron-proxy は同じ要求を拒んだ。
2. **broker の承認は、引数そのものに結び付ければ入れ替えられない。tool_use_id に結び付けると入れ替えられる（U10）** `[measured]`。関所（PreToolUse）で承認し、処理関数が「承認済みの id か」だけを見る作りでは、承認後に別の引数を送る攻撃と、同じ id での 2 回目の呼び出しが、本物の資格情報で実行された。処理関数が自分で解析済みの引数を見せて承認を求め、凍結したその同じ object を実行する作りでは、人が承認していないものは 1 件も実行されなかった。残ったのは、同じ引数を再送すると承認が 2 回出て 2 回実行されること（冪等性）と、攻撃者が承認依頼をいくらでも出せること（人の疲れ）。
3. **ターンごとのトークンの取り消しは、ゲートウェイがホストのプロセスの中にあれば、ホストの死で自動的に効く。別のコンテナにあると効かない（U6、I5）** `[measured]`。ホストを SIGKILL した後も、古いターンのコンテナは生き続け（`docker run -i` の client が死んでもコンテナは止まらない）、agentgateway と別コンテナの最小ゲートウェイでは 4 秒間 200 を受け続けた。再起動したホストが登録を空にするまで止まらない。ホストのプロセスの中のゲートウェイでは、殺した直後から接続エラーになった。#1 の「クラッシュ後のモデルへの呼び出し」は、配置で決まる。
4. **取り消しの遅れ**: agentgateway は設定ファイルの書き換えで約 360 ms（中央値 359 ms、うち Mac での `docker exec` が約 65 ms）。最小ゲートウェイは 1 ms 未満。agentgateway は取り消しの時点で開いている stream を最後まで流し（取り消し後に 8 個の chunk）、最小ゲートウェイは切った `[measured]`。
5. **応答の掃除（scrubbing）は緩和策にすぎない** `[measured]`。最小ゲートウェイは echo の応答の資格情報を `[REDACTED]` に替えたが、上流が base64 で返すと素通りした。agentgateway と iron-proxy は掃除しないので、echo がそのまま本物の資格情報を返した（I1 の破れ、許可した宛先が反射する限り）。
6. **ワイヤの経路で broker が持つ書き込みを実行できるか（U8）**: 3 つの base-URL ゲートウェイすべてで、`POST /repos/a/b/issues`、GraphQL の mutation、`POST /gists` は上流に届かなかった `[measured]`。ただし 1 のとおり、agentgateway の許可リストの書き方によっては別の path に抜ける。
7. **制御面（U7、I6）**: agentgateway は既定のままだと stats `:15020` と readiness `:15021` がコンテナから届く（読み取りだけ）。admin `:15000` は loopback だけで届かない。最小ゲートウェイはデータ面の 2 つの port だけ。iron-proxy は metrics `:9090` が届く `[measured]`。
8. **agentgateway の apiKey は `mode` を省くと鍵なしの要求を通し、資格情報を付けて上流へ流す（E14）** `[measured]`。既定は `Optional` `[code crates/agentgateway/src/http/apikey.rs:42-43]`。
9. **iron-proxy（MITM の比較対象）**: SNI と Host の食い違い、ドット区間は 400、許可していない CONNECT・absolute-form・宛先は 403 で、開いた代理にはならなかった。**2 MiB の本文は 1 MiB に切り詰められて、200 のまま上流へ送られた（E1。README ではなくコードが正しい）**。本文の中の proxy token は本物の秘密に置き換わって上流へ出た。`--dns <iron>` を付けると、`--internal` の組み込み DNS は同じネットワークの iron へ転送し、iron は持ち出し用の名前を自分の IP で答えて再帰しなかった。passthrough に入れた名前だけが上流の DNS に届いた（E3）`[measured, Mac]`。method と path の規則を書いた許可リストは、HTTPS_PROXY の CONNECT を 403 で拒んだ（DNS 方式だけが動いた）。
10. **費用（E13）**: 待機時の RSS は agentgateway 23.9 MiB、最小ゲートウェイ（別コンテナの Bun）19.0 MiB、iron-proxy 13.5〜31.8 MiB（測るたびに違う）、何もしない Bun の HTTP サーバー 15.2 MiB。起動（`docker start` から準備完了の行まで、コンテナの起動を含む）はどれも 200〜260 ms で、素の Bun は 130〜160 ms `[measured]`。最小ゲートウェイは空行と注釈を除いて 121 行、出発点の dev-relay は 49 行。agentgateway の設定は鍵 1 つで 64 行、iron-proxy は 35 行。

## 版と digest

| もの | 版 | 照合 |
|---|---|---|
| agentgateway | v1.7.0 `agentgateway-linux-arm64` | sha256 `85724a15dc9f5179fb6e2fd85b0ba2d4fea56dd289abb8bf8fefadc3bea8b89e`（release の `.sha256` と一致、`fetch-deps.sh`） |
| iron-proxy | 0.61.0 `iron-proxy_0.61.0_linux_arm64.tar.gz` | sha256 `824441e4982f2ddbd14afa26dfb72a3e61259ab277cdab586e24e1ecd54cca52`（`checksums.txt` と一致）。中身の実行ファイルは `29815707c2886ee2bf06134c5a6fe82a6457cb42891c9c73dc4214a4984cdf50` |
| 読んだソース | agentgateway `v1.7.0` tag、iron-proxy `v0.61.0` tag の tarball（`fetch-src.sh`、build も実行もしていない） | — |
| Kurumi | `d0ee9ffc1c8866455dcffb155a606c2d257eed90`（`repo/KURUMI_COMMIT`） | — |
| イメージ | `kurumi-agent:sdk-0.3.332` | `sha256:000974fa23744c4151ad8ebc13c41eda0c1fefa41a744ad178de319642ff5763`（Debian 13、Bun 1.4.4、glibc 2.41） |
| Docker | Docker Desktop 29.6.1、arm64 | — |
| ホストの Bun | 1.4.4（macOS arm64） | — |

## 構成

```
kh1-int (--internal, 10.251.11.0/24)        kh1-ext (bridge, 10.251.10.0/24)
  ターンのコンテナ (Kurumi の dockerRunArgs)
  kh1-ag   .20 ─────────────────────────────  .20  agentgateway（設定は named volume）
  kh1-mg   .30 ─────────────────────────────  .30  最小ゲートウェイ（admin :9901 は .30 だけ）
  kh1-fwd  .40 ── host.docker.internal:1808x ──    ホストのプロセスの中の最小ゲートウェイへの中継
  kh1-iron .50 ─────────────────────────────  .50  iron-proxy（自分の上流の DNS = 偽の DNS）
                                                   kh1-gh (api.github.test:443, 偽の GitHub)
                                                   kh1-model (model.test:9000) kh1-sink (.80) kh1-dns (.53)
```

- ターンのコンテナは、Kurumi の本物の `dockerRunArgs`（docker の引数を組み立てる関数）で起こし、`--internal` の `kh1-int` に置いた（`scripts/lab.ts`）。トークンは `CLAUDE_CODE_OAUTH_TOKEN` に入る。
- 3 つの base-URL ゲートウェイは同じ形にした: `:8080` はモデルの経路（`POST /v1/messages`、`POST /v1/messages/count_tokens`）、`:8081` は GitHub の読み取りの経路（`GET /repos/a/b/…`、`GET /echo`、`GET /redirect`、`GET /slow`）。ターンごとのトークンを確かめ、外し、経路ごとの本物の資格情報を `Authorization: Bearer` に入れる。
- 偽物: GitHub に似た HTTPS の API（`fakes/fake-github.ts`、`Bearer <CANARY_GH>` を要求、GET と POST `/repos/a/b/issues`、`POST /graphql`、`POST /gists`、echo、redirect、遅い stream、本文の長さと末尾を記録）。モデル、sink、DNS は slice 1 の `premise/fakes/` をそのまま使った。
- **Mac だけの置き換え 3 つ**:
  - ホストのプロセスの中のゲートウェイ（mg-host）は、Mac の `127.0.0.1:18080/18081` で動く。`--internal` のコンテナは Mac のホストに届かない（slice 1 の測定）ので、`kh1-fwd`（ただの TCP 中継、`fakes/tcp-fwd.ts`）を Linux ならホストが bind するブリッジの番地の代わりに置いた。トークンの登録簿・取り消し・寿命はホストのプロセスのものである。
  - agentgateway の設定ファイル: Mac 側から bind mount に書いても VM の inotify が鳴らず、再読み込みが起きなかった（`[measured]`、最初の実行で 401 が続き `loaded config` の行が出なかった）。そこで設定は named volume に置き、ホストは `docker exec` で VM の中から書く（`gateway/ag-config.ts` の `pushAgConfig`）。Linux ではホストが直接書けば済むはず `[inferred]`。取り消しの遅れのうち約 65 ms はこの `docker exec` である。
  - 取り消しの遅れと stream は、ゲートウェイのデータ面の port を Mac の `127.0.0.1` に公開し、Mac 側の 1 つの時計で測った。コンテナから見える面は変わらない。

## 結果 1: ワイヤの攻撃 × base-URL ゲートウェイ

`scripts/wire.ts` が、同じ攻撃 script（`fakes/attack-wire.ts`）をターンのコンテナの中から各ゲートウェイに流す。各行は「コンテナが受け取ったもの / 上流（偽の GitHub）や sink が記録したもの」。上流の行は、要求ごとの印（`probe=<gw>-<id>`）で突き合わせた。`out/table-wire.md`、生の出力は `out/wire.txt` `[measured, Mac]`。

| probe | 試したこと | agentgateway | 最小（ホストの中） | 最小（別コンテナ） |
|---|---|---|---|---|
| P1 | 許可した GET /repos/a/b/issues | 200 / 上流: GET /repos/a/b/issues auth=Bearer <CANARY_GH> | 同左 | 同左 |
| P2 | モデルの経路 POST /v1/messages | 200 / 上流: auth=Bearer <CANARY_MODEL> | 同左 | 同左 |
| T1 | トークンなし | 401 | 401 | 401 |
| T2 | 登録していない `kurumi-fake-` のトークン | 401 | 401 | 401 |
| E14 | `mode` を省いた apiKey の listener（:8082）に鍵なし | **200 / 上流: auth=Bearer <CANARY_GH>** | （その port はない） | （その port はない） |
| D1 | 許可した path に DELETE | 404 | 403 | 403 |
| D2 | GET /user | 404 | 403 | 403 |
| D3 | U8: POST /repos/a/b/issues | 404、上流に届かず | 403 | 403 |
| D4 | U8: GraphQL の mutation | 404、上流に届かず | 403 | 403 |
| D5 | U8: POST /gists | 404、上流に届かず | 403 | 403 |
| D6 | `GET /repos/a/b/../../../user` | **200 / 上流: GET /user auth=Bearer <CANARY_GH>** | 403 | 403 |
| D7 | `GET /repos/a/b/%2e%2e/%2e%2e/%2e%2e/user` | **200 / 上流: GET /user auth=Bearer <CANARY_GH>** | 403 | 403 |
| D8 | `GET /repos/a/b/..%2f..%2f..%2fuser` | 404 / 上流: 生の path のまま auth 付きで届いた（偽物は `%2f` を解かない） | 400 ambiguous path | 400 |
| D9 | HEAD（GET だけ許可） | 404 | 403 | 403 |
| O1 | absolute-URI で sink へ | 404、sink に何も届かず | 403 | 403 |
| O2 | Host に sink を書く | 200、固定の上流（api.github.test）へ。sink に何も届かず | 同左 | 同左 |
| O3 | CONNECT sink.test:80 | 405 | 403 | 403 |
| O4 | `//sink.test/O4` | 404 | 400 | 400 |
| O5 | h2c の前置き | HTTP/2 の SETTINGS が返った（h2c を受ける。その先は試していない） | 400 | 400 |
| L1 | 許可した宛先の echo | **200、応答に本物の資格情報** | 200、`Bearer [REDACTED]` | 200、`Bearer [REDACTED]` |
| L2 | echo を base64 で返させる | **base64 を解くと本物の資格情報** | **同左（掃除をすり抜けた）** | **同左** |
| L3 | sink への redirect | 302 を返すだけ。従わない、sink に何も届かず | 同左 | 同左 |
| L4 | 同じ宛先の echo への redirect | 302 だけ。従わない | 同左 | 同左 |
| C2 | admin :15000 /config_dump | 接続拒否 | 接続拒否 | 接続拒否 |
| C3 | stats :15020 /metrics | **200**（`agentgateway_config_synchronized` など。canary はない） | 接続拒否 | 接続拒否 |
| C4 | readiness :15021 | **200** | 接続拒否 | 接続拒否 |
| C5 | 最小ゲートウェイの admin :9901 /register | 接続拒否 | 接続拒否 | 接続拒否（admin は kh1-ext の番地だけに bind） |
| C6 | admin の制御側の番地 10.251.10.30:9901 へ直接 | 届かない | 届かない | 届かない |
| C1 | ゲートウェイの TCP の port の走査 | 開いていた: 8080, 8081, 8082, 15020, 15021 | 8080, 8081 | 8080, 8081 |
| G1 | env、`/proc/*/environ|cmdline`、`/cfg`、`/work`、`/tmp`、`/etc`、`/root`、`/home` の canary 検索 | 0 件 | 0 件 | 0 件 |

証拠の行（`out/wire.txt`）:

```
agentgateway: info request ... route=default/github-read endpoint=api.github.test:443 ... http.method=GET http.path=/repos/a/b/../../../user?probe=ag-D6 http.status=200
agentgateway: info request ... route=default/github-read-mode-omitted endpoint=api.github.test:443 ... http.path=/repos/a/b/issues?probe=ag-E14 http.status=200
agentgateway: error request ... http.method=POST http.path=/repos/a/b/issues?probe=ag-D3 http.status=404 error="route not found"
kurumi-gw:    {"route":"github","turn":"7e178381","method":"DELETE","path":"/repos/a/b/issues","decision":"deny","status":403,"reason":"route not allowed"}
L1 echo (ag):  "authorization":"Bearer CANARY_REAL_GH_4b7e19d2c6a0"
L1 echo (mg):  "authorization":"Bearer [REDACTED]"
```

読み方:
- 3 つとも、宛先は経路ごとに固定で、Host・absolute-URI・CONNECT・redirect で別の宛先へ向けられなかった。開いた代理ではない `[measured]`。
- 違いは path の照合にある。agentgateway は生の path を前方一致で照合して、生のまま渡す（D6〜D8）。最小ゲートウェイは WHATWG の正規化の後の path を照合し、その同じ文字列を渡し、符号化した区切り（`%2f`、`%5c`、`%2e`、`//`）を拒む `[code gateway/kurumi-gw.ts:16, 54-55]`。iron-proxy はドット区間を検証で拒む `[docs dl/src/iron-proxy/README.md:333-337]`、`[measured]`（結果 3）。agentgateway でも `exact` や正規表現で書けば D6 は通らないはず `[inferred]`。ただ、前方一致を書いた時点で抜けるので、設定の注意に頼ることになる。
- 最小ゲートウェイは転送するヘッダーを許可リストにしている（`x-api-key`、`cookie` などを捨てる）`[code gateway/kurumi-gw.ts:13]`。agentgateway は通す（slice 1 の dev relay と同じ型の問題が残るかは、ヘッダーで振る舞いが変わる上流があるときに効く）`[inferred]`。

## 結果 2: トークンの寿命（U6、I5、I10）

`scripts/lifecycle.ts`。`out/table-lifecycle.md`、生の出力 `out/lifecycle.txt` `[measured, Mac]`。

| ゲートウェイ | ターン 1 のトークンをターン 2 で再生（続けて自分のトークン） | 取り消し: 呼び出しから最初の 401 まで（ms、5 回） | 取り消しの呼び出し自体（ms） | 取り消し時に開いている stream | ホストを SIGKILL した後 4 秒の古いコンテナ | ホストの再起動が登録を空にした後 |
|---|---|---|---|---|---|---|
| agentgateway | 401 / 200 | 358.4, 369.5, 362.9, 358.7, 356.9 | 64.5, 65.7, 60.6, 66.4, 65.2（`docker exec`） | 取り消し後に 8 chunk、最後まで流れた | **200 × 15**（コンテナは動き続けた） | 200 × 2（再読み込みの遅れ）、401 × 7 |
| 最小（ホストの中） | 401 / 200 | 0.5, 0.4, 0.1, 0.2, 0.2 | 0.1, 0, 0, 0, 0 | 0 chunk、ECONNRESET で切れた | 接続エラー × 15 | 接続エラー × 8 |
| 最小（別コンテナ） | 401 / 200 | 0.9, 0.9, 0.4, 0.4, 0.5 | 0.5, 0.4, 0.4, 0.4, 0.4（admin API） | 0 chunk、ECONNRESET | **200 × 15** | 401 × 8 |

- ターンの終わりに取り消せば、作業場所に残したトークンは次のターンで使えない（3 つとも）。
- ホストが死ぬと、別プロセスのゲートウェイは誰にも取り消されない。古いコンテナは `docker run -i --rm` の client が死んでも動き続けた（4 秒後も `Up 4 seconds`）。Kurumi の再起動時の掃除（ラベルでコンテナを消す）までの間、#1 と同じ「クラッシュ後の呼び出し」が通る。測ったのは GitHub の経路だが、モデルの経路も同じ登録簿を引く `[code gateway/kurumi-gw.ts:52]`、`[code gateway/ag-config.ts]`（両方の経路に同じ鍵の一覧）。
- 別コンテナでも I5 を保つには、トークンに期限を持たせる（JWT の `exp` や登録簿の TTL）か、ゲートウェイがホストの生存を見張る（lease）必要がある `[argued]`。ホストのプロセスの中に置けば、ホストの死がそのまま取り消しになる `[measured]`。ただし Linux ではコンテナからホストへ届く番地に bind する必要があり、それが他の番地に開かないことは確かめていない。
- agentgateway の 360 ms は、ファイル監視の 250 ms の debounce `[code crates/agentgateway/src/util.rs:80]` と再読み込みで説明がつく `[inferred]`。

## 結果 3: iron-proxy 0.61.0 の MITM（比較対象 A）

`scripts/iron.ts`、`fakes/attack-iron.ts`。コンテナに `--dns 10.251.11.50`（iron）を足した。CA は `/work/.attack/iron-ca.crt` から信頼させた。proxy token は YAML に固定の 1 つ（`kurumi-fake-iron-static`）で、単独の iron-proxy にはターンごとの登録簿がない。生の出力 `out/iron.txt` `[measured, Mac]`。

| probe | 試したこと | 結果 | 止めた所（iron の監査の行） |
|---|---|---|---|
| I0 | DNS 方式で許可した GET | 200、上流に `Bearer <CANARY_GH>` | `"action":"allow"`、`"swapped":[{"secret":"GH_REAL","locations":["header:Authorization"]}]` |
| I0b | HTTPS_PROXY（tunnel）で同じ要求 | **CONNECT が 403** | `"method":"CONNECT" ... "rejected_by":"allowlist"`。method と path の規則は CONNECT に一致しない |
| I1 | 許可していない宛先 sink.test へ HTTPS | 403 | `rejected_by: allowlist` |
| I2 | SNI api.github.test、Host sink.test | 400 | `"msg":"SNI/Host mismatch"`、`reason: sni_host_mismatch` |
| I3 | CONNECT sink.test:80 | 403 | allowlist |
| I4 | CONNECT api.github.test:443 の中で Host sink.test | 403（CONNECT の段で） | allowlist |
| I5 | absolute-form `GET http://sink.test/` | 403 | allowlist |
| I6 | IP の直書きで CONNECT | 403 | allowlist |
| I7 | :80 に Host sink.test | 403 | allowlist |
| ID3 | U8: POST /repos/a/b/issues | 403 | allowlist |
| ID6、ID7 | ドット区間（生と `%2e`） | 400 | `reason: dot_segments` |
| IL1 | E2: echo | **応答に本物の資格情報** | 掃除しない |
| E1a | 0.5 MiB の本文、末尾に proxy token | 上流は 524291 byte を受け、**末尾が `tail-marker-E1a-<CANARY_GH>`**: 本文の proxy token が本物に置き換わって上流へ出た | `"locations":["header:Authorization","body"]` |
| E1b | 2 MiB の本文、末尾に proxy token | **上流は 1048576 byte だけ受け、200 が返った**。末尾は切れて token も届かない | 本文は置換されず（`locations` は header だけ） |
| IC1 | iron の port の走査 | 開いていた: 80, 443, 8080, 9090 | — |
| IC2 | metrics :9090 `/metrics` | 404（port は届く） | — |

DNS（E3）:

```
resolv.conf: nameserver 127.0.0.11
127.0.0.11  api.github.test       -> NOERROR 10.251.11.50
127.0.0.11  e3a-<tag>.exfil.test  -> NOERROR 10.251.11.50
10.251.11.50 e3b-<tag>.exfil.test -> NOERROR 10.251.11.50
10.251.11.50 e3c-<tag>.pass.test  -> NOERROR 10.66.66.66   (passthrough)
偽の権威 DNS の記録: e3c-<tag>.pass.test だけ（A と AAAA）。exfil.test は 1 件もない
```

- `--internal` の組み込み DNS は、同じ `--internal` ネットワークにいる iron へは転送した。slice 1 の D2（別のネットワークの DNS へは SERVFAIL）とは違う `[measured, Mac]`。
- iron は passthrough でない名前を自分の IP で答え、上流へ問い合わせなかった `[measured]`、`[code internal/dns/server.go:169-173]`（teardown の引用）。passthrough の glob に入れた名前は、そのまま持ち出しの通り道になる `[measured]`。
- E1: 切り詰めて転送する、がコードどおりで、README の「残りも転送する」は違った `[measured]`。上流は短い本文を受け、クライアントには 200 が返るので、黙って壊れる。
- 本文での置換は、攻撃者が proxy token を issue の本文などに書けば、本物の秘密を上流に公開させられることを示した `[measured]`。

## 結果 4: ホストの MCP broker の承認の入れ替え（U10、I4、I8）

`broker/broker-tool.ts`（H1 の試験用で Kurumi のコードではない）を `turn.ts` の `mcpServers` に足し（`broker.diff`、2 行）、Kurumi の本物の `Runtime`（受信からターンを回す本体）で、slice 1 の攻撃者の CLI（scenario `broker` を足した写し、`fakes/attacker-cli.ts`）と戦わせた。偽の人は title が `Fix typo in README` の A だけを許可する。実行の事実は偽の GitHub の `ISSUE_CREATED` の行から取った。生の出力 `out/broker.txt`、`out/broker.json` `[measured]`。

攻撃の順: (1) 関所に A で `hook_callback`（id `toolu_B1`）、(2) id `toolu_B1` で別の引数、(3) 関所が見ていない id、(4) `toolu_B1` で 2 回目、(5) A を再送、(6) 同じ id `toolu_B2` で A と別の引数を同時に。

| 作り | 人が見た承認依頼 | 本物の資格情報で実行されたもの | 人が承認していないのに実行 |
|---|---|---|---|
| hook: 関所が承認、処理関数は `tool_calls` に id があるかだけ見る `[code broker-tool.ts:40]` | A を 1 回（許可） | `U10-swap: add deploy key`、`U10-reuse: second call`、A | **2 件**（入れ替え、再利用） |
| handler: 処理関数が解析済みの引数を見せて承認を求め、凍結した同じ object を実行 `[code broker-tool.ts:44-46]` | 6 回（swap、forged、reuse、race は拒否、A を 2 回許可） | A、A | **0 件** |

```
{"broker":"executed","mode":"hook","claimedToolUseId":"toolu_B1","approvalId":"toolu_B1","executed":{"title":"U10-swap: add deploy key","body":"args changed after approval"},"status":201}
{"broker":"executed","mode":"hook","claimedToolUseId":"toolu_B1","approvalId":"toolu_B1","executed":{"title":"U10-reuse: second call","body":"rides the first approval"},"status":201}
{"broker":"executed","mode":"handler","claimedToolUseId":"toolu_B1","approvalId":"broker:24c1ba5c-…","executed":{"title":"Fix typo in README","body":"s/teh/the/"},"status":201}
```

- id に結び付けた承認は、コンテナが id も引数も書く以上、結び付きにならない `[measured]`、`[argued: slice 1 のとおり、hook_callback と mcp_message はどちらも攻撃者が書く]`。
- 引数に結び付けた承認では、人に見せた object と実行した object が同じプロセスの同じ値なので、表示と実行の間で比べるものがない（正規化・TOCTOU の問題が生じない）`[argued: 前提はホストのプロセスが侵害されていないこと、処理関数が承認の後に引数を読み直さないこと]`。
- handler の作りで関所の方針を `allow` にしたので、人への問いは 1 つの呼び出しに 1 回だった（I8）。関所でも `ask` にすると同じ呼び出しで 2 回問うことになる `[inferred]`。
- 残る問題: 同じ引数の再送は、承認 2 回で 2 回実行された（冪等の鍵が要る）。承認依頼の数と文面は攻撃者が決める（6 回出た）。I4 は守れても、人を疲れさせて誤って許可させる攻撃は残る `[measured]`。
- `tool_calls` には、handler の作りではホストが作った id（`broker:<uuid>`）の行が入り、実行ごとに 1 行になる。I7 の「ツール呼び出し単位の記録」をコンテナが書けない値で取れるのは、この作りだけ `[measured]`。

## 結果 5: 費用（E13）

`scripts/e13.ts`、`out/e13.txt` `[measured, Mac]`。RSS は `/proc/1/status` の VmRSS（コンテナの PID 1 が本体）。

| | 起動（`docker start` → 準備完了の行、ms、3 回） | 待機時の VmRSS | docker stats | 設定・コード |
|---|---|---|---|---|
| agentgateway v1.7.0 | 263, 213, 203 | 23.9 MiB | 31.8 MiB | 設定 64 行（鍵 1 つ、3 listener）。ホスト側の設定書き出し 70 行 |
| 最小ゲートウェイ（別コンテナ、Bun） | 192, 194, 199 | 19.0 MiB | 4.2 MiB | 121 行（dev-relay の 49 行から +72）。経路表を含む |
| 最小ゲートウェイ（ホストの中） | import と listen で 3.8 ms | RSS の増分 0.4 MiB（Mac の Bun の値で、コンテナの値とは比べられない） | — | 同じ 121 行 |
| iron-proxy 0.61.0 | 225, 209, 219 | 13.5〜31.8 MiB（実行ごとに違う） | 15.4〜37.0 MiB | 設定 35 行 |
| 比較: 素の Bun の HTTP サーバー（sink） | 132, 144, 162 | 15.2 MiB | 3.7 MiB | — |

起動の値にはコンテナの起動が入っている。ゲートウェイ自体の差は 50〜100 ms ほどで、ターンの長さに比べて無視できる `[inferred]`。

## 不変条件の Observed（この harness が試した入力に対して）

| 不変条件 | agentgateway | 最小（ホストの中） | 最小（別コンテナ） | iron-proxy（MITM） | broker（handler の作り） |
|---|---|---|---|---|---|
| I1 資格情報がコンテナから見えない | **破れた**: echo（L1）、base64（L2）。env・/proc・ファイルは 0 件 | **破れた**: base64（L2）。素の echo は掃除で止まった | 同左 | **破れた**: echo（IL1）、本文の置換が上流で公開（E1a） | 資格情報はホストの中だけ（応答は試していない） |
| I2 ゲートウェイ以外に出ない | 試していない（slice 1 が測定済み） | 同 | 同 | DNS: 持ち出し名は止まり、passthrough 名だけ出た | — |
| I3 本物の資格情報付きの要求は、その要求の方針判断に一致する | **破れた**: D6、D7（`/user`）、E14（鍵なし） | 破れは観測されず | 破れは観測されず | 破れは観測されず（許可リストの範囲で） | 破れは観測されず |
| I4 承認の結び付き | 承認なし（試していない） | 同 | 同 | 承認なし。E1 で本文が切れる（本文に結び付けるなら破れる） | **破れは観測されず**。hook の作りでは**破れた** |
| I5 ターンの終わり・ホストの死で無効 | ターンの終わり: 守られた（約 360 ms 後）。**ホストの死: 破れた** | 守られた（両方） | ターンの終わり: 守られた。**ホストの死: 破れた** | ターンごとのトークンがない（試していない） | 承認はその呼び出しだけ |
| I6 制御面に届かない | admin は届かない。**stats・readiness は届く**（読み取り） | 届かない（制御面は関数呼び出し） | 届かない（admin は別ネットワーク + 秘密） | metrics :9090 が届く。management は無効のまま | 承認への答えはホストの API だけ（slice 1） |
| I7 副作用がターンと（できれば）tool_use_id に結び付く | トークン単位。ログは鍵を出さない（`turn` の欄なし） | ログに `turn` | ログに `turn` | 静的トークンなのでターン単位でもない | ホストの id で呼び出し単位 |
| I8 1 つの決定は 1 回だけ問う | — | — | — | — | 守られた（関所 allow のとき）。再送は 2 回問う |
| I9 broker が持つ操作をワイヤで実行できない（U8） | 書き込みの path は届かず。ただし D6 の型の抜けがある | 守られた | 守られた | 守られた（ID3） | — |
| I10 落ちたら閉じる | 鍵なしは 401（strict のとき）。**`mode` 省略では開く** | ホストが死ぬと接続エラー | 試していない（ゲートウェイを落とす試験はしていない） | 試していない | — |

Guaranteed by construction の側の短い議論 `[argued]`:
- I3 と I9 は、ゲートウェイが照合する path と上流が実行する path が同じであることを前提にする。最小ゲートウェイは「正規化した path で照合し、その path を渡し、曖昧な符号化を拒む」ことでこれを構成で満たす。agentgateway の前方一致は満たさない（測定で反例）。上流が `%2f` などを独自に解く場合への備えが最小ゲートウェイの拒否の規則で、上流ごとに確かめる必要がある。
- I1 は、許可した宛先が入力を反射する限り、ワイヤのゲートウェイでは構成で守れない。掃除は符号化で抜ける。守れるのは「反射する宛先に資格情報を付けない」経路の設計（C' の分け方）だけ。
- I4 はホストが実行する broker でだけ構成で守れる。前提はホストのプロセスが攻撃者の外にあること。
- I5 は、ゲートウェイの寿命をホストに結ぶか、トークンに期限を持たせることで構成で守れる。

## 確かめていないこと

- Linux での全部（とくに `--internal` の DNS 転送、ホストの中のゲートウェイを Linux のブリッジの番地に bind したときに他から届かないか、inotify の振る舞い）。
- agentgateway の h2c の先（`:authority` の扱い、HTTP/2 での経路の照合）。O5 で h2c を受けることだけを見た。
- agentgateway を `exact`・正規表現の経路で書いたときの D6 の型。
- 最小ゲートウェイの圧縮された応答（`accept-encoding` を上流に渡さない作りで、上流が勝手に圧縮した場合の掃除）。
- 本物の CLI（Claude Code、gh、git）をこれらのゲートウェイに通すこと（U3 は別の slice）。モデルの経路には P2 の 1 要求だけを流した。
- ゲートウェイを止めたときに閉じるか（I10 の別コンテナの側）。
- iron-proxy の `require_tls` を付けない平文の要求で、本物の秘密が平文で上流へ出ること（文書の記述 `[docs dl/src/iron-proxy/README.md:493]` だけ）。
- broker の応答に資格情報が混じる経路（上流が反射する場合）。

## ファイル

| file | 役割 |
|---|---|
| `run-all.sh` | 全部を流し、43 個の主張を確かめ、片付ける |
| `infra.sh` | ネットワーク、PKI、偽物、4 つのゲートウェイと中継 |
| `fetch-deps.sh`、`fetch-src.sh` | 実行ファイルとソースを `dl/` に落とし、checksum を照合 |
| `gateway/kurumi-gw.ts` | 自作の最小ゲートウェイ（dev-relay.ts から） |
| `gateway/ag-config.ts` | agentgateway の設定と、`docker exec` での書き込み |
| `scripts/wire.ts`、`fakes/attack-wire.ts` | 結果 1 |
| `scripts/lifecycle.ts`、`scripts/host-kill-child.ts`、`fakes/loop.ts` | 結果 2 |
| `scripts/iron.ts`、`fakes/attack-iron.ts` | 結果 3 |
| `scripts/broker.ts`、`scripts/host.ts`（slice 1 の写し）、`fakes/attacker-cli.ts`（slice 1 の写し + scenario `broker`）、`broker/broker-tool.ts`、`broker.diff` | 結果 4 |
| `scripts/e13.ts` | 結果 5 |
| `scripts/checks.ts`、`scripts/table*.ts` | 判定と表 |
| `out/` | 最後の `run-all.sh` の出力（`checks.txt`、`table-*.md`、`*.txt`、`*.json`） |
