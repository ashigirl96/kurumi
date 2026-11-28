# Linux での隔離の確認

エージェントのコンテナの隔離が、Linux の本番機で効いているかを確かめる手順。Mac（Docker Desktop）で測った結果が、本番でも成り立つかを知るためのもの。
隔離に関わる ADR は、この確認の後に書く。

**Linux では、まだ確かめていない。** 下の「Linux での結果」の欄は空で、未確認である。Mac の結果は「Mac での結果」にある。

## 手順

本番機（Linux、Docker が動くこと）で、この repo を checkout して次を流す。

```sh
bun install --frozen-lockfile
docker build -t kurumi-agent:sdk-0.3.332 packages/agent-runtime/container

# 1. 項目 1 から 5。モデルは使わない。
bun packages/agent-runtime/src/real/isolation-check.ts

# 2. 項目 3 の終了コード（プロセスの数を使い切ったとき）。トークンと haiku を使う。
CLAUDE_REAL_TOKEN=<Claude Code の OAuth トークン> \
  bun packages/agent-runtime/src/real/isolation-check.ts --with-model

# 3. 項目 6。本物の確認の流し直し。
CLAUDE_REAL_TOKEN=<Claude Code の OAuth トークン> \
  KURUMI_REAL_CHECKS=1 bun test packages/agent-runtime/src/real/real.test.ts
```

- script は、イメージ `kurumi-agent:sdk-0.3.332`、`--internal` ネットワーク `kurumi-iso-internal`、確認用のゲートウェイのコンテナを自分で作り、終わると消す。ラベルは `kurumi.agent=isolation-check`。
- コンテナの起動の引数は、本番の `dockerRunArgs`（`packages/agent-runtime/src/sandbox.ts`）が作る引数のイメージの手前までを使う。フラグが本番と食い違わない。
- 各行は `PASS`（期待どおり）、`FAIL`（期待と違う）、`INFO`（観測した値。期待は下の表）。`FAIL` が 1 つでもあれば終了コードは 1。
- 先頭の `E0` の行に、Docker の版、カーネル、cgroup の版が出る。結果と一緒に記録する。
- 流した結果は、この文書の「Linux での結果」に、Mac の欄と同じ形で貼る。`FAIL` と、期待と違った `INFO` は、違いの理由が分かるまで ADR に進まない。

## 確かめる項目

### 1. `--internal` ネットワーク上の Docker の DNS

外の名前が引けるなら、コンテナは名前に情報を載せて、上流のリゾルバへ出せる。Mac では外の名前を引くと失敗したが、Linux で上流へ転送するかは確かめていない。

| id | 確かめること | 期待 | 違ったときに壊れているもの |
|---|---|---|---|
| L1a | `getent hosts example.com` | 失敗する（終了コード 0 以外） | 引けたら、`--internal` でも DNS が外へ抜ける。外向き通信の閉じ込めに穴がある。対処は ADR で決める |
| L1b | `getent hosts kurumi-iso-gateway` | 引ける | 引けないと `ANTHROPIC_BASE_URL` のゲートウェイの名前が使えず、すべてのターンがモデルを呼べずに `Failed` になる |
| L1c | `/etc/resolv.conf`（`INFO`） | `nameserver 127.0.0.11`（Docker の内蔵 DNS） | 別の値なら、DNS の経路が想定と違う。L1a の結果と一緒に読む |

### 2. マウントしたディレクトリのファイルの持ち主

Linux では、コンテナの uid がホストからそのまま見えるはずである【推論】。Docker Desktop for Mac は持ち主を変換する（ホストの利用者に見える）。

| id | 確かめること | 期待 | 違ったときに壊れているもの |
|---|---|---|---|
| L2a | ホストの利用者と同じ `uid:gid` で走らせ、`/work` にファイルを書く。ホストから見た持ち主 | ホストの利用者と同じ | 違うと、`Runtime` が作った `cfg` と `work` にコンテナが書けず CLI が起動直後に落ちるか、コンテナが書いた会話記録をホストが読めず、`resume` の照合（`transcriptHolds`）が不一致になって、セッションが `lost` になる |
| L2b | 別の uid（4242）で走らせ、全員が書けるディレクトリに書く（`INFO`） | Linux は `4242:4242`。Mac は `501:20` に変換される | `--user` をホストの利用者と違う値にすると、ホストがそのファイルを読めない・消せない。`--user` をホストの利用者に固定する理由の裏づけ |

### 3. 硬化フラグの下での振る舞い

| id | 確かめること | 期待 | 違ったときに壊れているもの |
|---|---|---|---|
| L3a | ルートに書く | 失敗する（`Read-only file system`） | `--read-only` が効いていない。エージェントがイメージの中身を書き換えられる |
| L3b | `/tmp`、`/work`、`/cfg` に書く | 書ける | 書けないと CLI が起動できない（`/tmp` が無いと起動直後に `EROFS`） |
| L3c | `CapEff` が 0、`NoNewPrivs` が 1 | そのとおり | `--cap-drop ALL`、`no-new-privileges` が効いていない |
| L3d | cgroup の版（`INFO`） | `cgroup2fs`（v2） | v1 だと L3e と L3f が読むファイルの場所が違い、`FAIL` になる。その場合は表示を読み直す |
| L3e | 400 個のプロセスを起こす | 256 で止まり、`Cannot fork`。`pids.current` は 255 | 止まらないと、1 つのコンテナがホストのプロセスの数を使い切れる |
| L3f | `--memory 256m` で `memory.max` と `memory.swap.max` | `268435456` と `0`（`--memory-swap` を `--memory` と同じにすると、メモリと swap の合計が上限になり、swap は 0） | swap が残ると、メモリの上限を超えても swap に逃げて OOM にならない |
| L3g | 上限を超えてメモリを使う | OOM で殺される（終了コード 137） | 殺されないと、ホストのメモリを使い切れる |
| L3h | 孤児のプロセスの後のゾンビの数 | 0。PID 1 は `docker-init` | ゾンビが残ると、プロセスの数の上限を食う |
| L3i | プロセスの数を使い切った後の CLI の終了コード（`--with-model`、`INFO`） | 試作では 134（SIGABRT）が出た。ただし、その試作には背景の仕事を止める設定（`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`、ADR 0008）が無かった。今の構成では、Mac で 0（正常）だった。どちらの値でも、記録して比べる | CLI が異常終了しても、ホストは `Interrupted`（`sandbox_exit`）で閉じ、次のターンが `resume` できる必要がある。134 の後に `resume` が通らないなら、項目 6 の「止めてから `resume`」で見つかる |

### 4. 外向き通信の閉じ込め

`--internal` ネットワークと、ゲートウェイだけの構成。

| id | 確かめること | 期待 | 違ったときに壊れているもの |
|---|---|---|---|
| L4a | ゲートウェイ（確認用の小さなサーバ）に TCP で届く | 届く（`HTTP/1.1 200`） | 届かないと、ターンがモデルを呼べない |
| L4b | 外の IP アドレス（`1.1.1.1:443`）に届く | 届かない（`Network is unreachable`） | 届くと、本物の資格情報が無くても外へ出られる |
| L4c | ホストの待ち受けに、次の宛先から届く: 内部ネットワークのゲートウェイ、`docker0` のゲートウェイ、ホストの LAN の IP、`host.docker.internal` | どれにも届かない | 届くと、ホストの待ち受け（LAN に開いたサービスを含む）にコンテナから触れる。Linux は `docker0` と内部ネットワークのゲートウェイがホストそのものなので、特に見る |
| L4d | ネットワークの参加者（`INFO`） | ゲートウェイと、確認用のコンテナだけ | 別のものがいるなら、そこへ届く |
| L4e | 同じネットワークの別のエージェントのコンテナの待ち受けに届く | 届かない | 届くと、同時に動く別の会話のターンのコンテナに触れる |

### 5. コンテナの起動時間

| id | 確かめること | 期待 | 違ったときに壊れているもの |
|---|---|---|---|
| L5 | コンテナの起動から `claude --version` の終了までを 5 回（`INFO`） | Mac は 300 ミリ秒ほど。Linux は同じか速いはず | 数秒かかるなら、ターンごとにコンテナを起こす設計の待ち時間が目に見えて増える。イメージの層、seccomp、ストレージドライバを疑う |

### 6. 本物での確認の流し直し

`real.test.ts`（`packages/agent-runtime/src/real/README.md`）を Linux で流す。ターンの制御（`next`、`cancelQueued`、`/stop`）、`resume`、送るツール、仕込まれた設定、ホストの強制終了を含む。
期待は、`11 pass`（`test.failing` の 1 つを含む。`/help` の項は README の「分かっていること」）。落ちたテストの名前が、Linux で食い違った依存を指す。

## Mac での結果

2026-11-28、Docker Desktop 29.6.1（macOS arm64、VM のカーネル 6.12.76-linuxkit、cgroup v2、ストレージは overlayfs）。コマンドは `isolation-check.ts --with-model` と `real.test.ts`。

| id | 結果 | 観測 |
|---|---|---|
| L1a | PASS | `getent hosts example.com` は終了コード 2、出力なし |
| L1b | PASS | `kurumi-iso-gateway` が内部ネットワークの IP に引ける |
| L1c | INFO | `nameserver 127.0.0.11`、上流は Docker Desktop の VM のホスト |
| L2a | PASS | ホストから見た持ち主は `501:20`（ホストの利用者と同じ） |
| L2b | INFO | `--user 4242:4242` でも、ホストから見た持ち主は `501:20`（Docker Desktop が変換する） |
| L3a から L3c | PASS | 読み取り専用、`/tmp`・`/work`・`/cfg` に書ける、`CapEff` が 0、`NoNewPrivs` が 1 |
| L3d | INFO | `cgroup2fs` |
| L3e | PASS | `pids.current=255 pids.max=256`、`Cannot fork` |
| L3f | PASS | `memory.max=268435456`、`memory.swap.max=0` |
| L3g | PASS | 終了コード 137 |
| L3h | PASS | ゾンビ 0、PID 1 は `docker-init` |
| L3i | INFO | 3 回とも `docker run` の終了コード 0（結果は `success`）。bash が `fork: retry: Resource temporarily unavailable` を出して待ち、通った。試作の 134 は再現しなかった。134 が出た試作は `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` を渡していなかったので、背景の仕事への切り替えが原因だった可能性があるが、確かめていない【推論】 |
| L4a | PASS | `HTTP/1.1 200 OK` |
| L4b | PASS | `Network is unreachable` |
| L4c | PASS | 内部ネットワークのゲートウェイ、`docker0` のゲートウェイ、LAN の IP、Tailscale の IP、`host.docker.internal` のすべてに届かない |
| L4d | INFO | `kurumi-iso-gateway` と確認用のコンテナ 1 つ |
| L4e | **FAIL** | 同じネットワークの別のエージェントのコンテナの待ち受けに届いた |
| L5 | INFO | 296、313、281、295、291 ミリ秒。中央値 295 |
| 6 | PASS | `real.test.ts` は 11 pass（`test.failing` の 1 つを含む）、0 fail、43 expect |

**L4e は、設計の想定と違う。** ターンごとのコンテナは、すべて同じ `--internal` ネットワークに置かれるので、互いに届く。ネットワークを `-o com.docker.network.bridge.enable_icc=false` で作ると、コンテナどうしだけでなくゲートウェイにも届かなくなった（Mac、確認用の小さなサーバで 1 回）。ゲートウェイだけに届く構成（ターンごとのネットワーク、またはゲートウェイ側のフィルタ）は、この文書の範囲外で、ゲートウェイの設計で決める。

## Linux での結果

**未確認。** 上の手順を本番機で流したら、「Mac での結果」と同じ形の表をここに貼る。
