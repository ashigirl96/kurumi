# 永続化層の調査と試作（2026-11-28）

Kurumi の永続化の組み合わせを選ぶときに作った、使い捨ての試作と、その検証結果である。決定は [ADR 0009](../../adr/0009-persistence-effect-sql-and-drizzle-per-package.md) に、実装の仕様は issue #2 にある。ここにあるのは、その根拠と、再実行の手順である。

本番のコードではない。試作の中の `apps/host` や `packages/*` は、Kurumi のワークスペースの一部ではない。

## 中身

| ファイル | 内容 |
|---|---|
| `REPORT.md` | 4 つの案の比較、各案の構成とコード、推奨（調査の時点のもの） |
| `brief.md` | 試作の共通の筋書きと 7 つの確認（調査役に渡した指示、英語） |
| `prototypes/drizzle/stable/` | 案 1: Drizzle 0.45 + bun:sqlite |
| `prototypes/drizzle/rc/` | 案 3: Effect SQL + Drizzle 1.0 RC（採用した組み合わせ） |
| `prototypes/effect-sql/proto-effect/` | 案 2: Effect SQL のみ |
| `prototypes/effect-sql/proto-raw/` | 案 4: bun:sqlite の直接利用 |
| `prototypes/effect-sql/order-probe.ts` | 参照先の表がまだないときの外部キーの振る舞い |
| `prototypes/p-load/` | Effect SQL の負荷、中断、型付きの行の試作 |

各試作の `*-output.txt` と `out-*.txt` は、調査のときの出力である。

調査のときは REPORT の推奨が案 2 だった。grill で案 3 に決めた。理由は ADR 0009 にある。

## 再実行

Bun 1.4.4 で動かした。各試作のディレクトリで、先に依存を入れる。

```sh
bun install --frozen-lockfile
```

| 試作 | コマンド（試作のディレクトリで） | 所要 |
|---|---|---|
| `drizzle/`（stable と rc の両方） | `sh run-all.sh`（結果は `out-stable.txt` と `out-rc.txt` に書き直される） | 数秒 |
| `effect-sql/proto-effect/` | `bun apps/host/src/checks.ts` と `bun test` | 数秒 |
| `effect-sql/proto-raw/` | `bun apps/host/src/checks.ts` と `bun test` | 数秒 |
| `effect-sql/` | `bun order-probe.ts` | 1 秒 |
| `p-load/` | `bun interrupt.ts`、`bun typed.ts`、`bun load.ts load NORMAL 5` | 数秒 |
| `p-load/`（全条件） | `sh run-load.sh` | 約 3 分 |

`drizzle/` の `run-all.sh` は、確認 1 でマイグレーションを生成し直す。そのため、次の 2 つがリポジトリの差分として残る。

- `drizzle/` の下のマイグレーションのファイル
- `packages/turn/src/schema.ts`

元に戻すには `git checkout -- docs/research/persistence-stack` を流す。

2026-11-28 に、リポジトリに入れたこの中身を別の場所に写して、上のコマンドをすべて流した。次の結果が、調査のときと同じに出た。

- 並行トランザクション（確認 4）の行
- 外部キーの振る舞い
- テストの通過数
- 中断の結果

## p-load の結果

Effect SQL（`@effect/sql-sqlite-bun` 4.1.7）で、file の DB を WAL にして 25 秒ずつ流した。負荷は、ターン 3 本、配信、ツールの関所で、合わせて毎秒約 430 回の書き込みである。数字は、ツールの関所の書き込みの待ち時間（ms）である。

| 条件 | p50 | p95 | p99 | 最大 |
|---|---|---|---|---|
| 負荷、NORMAL | 0.16 | 0.31 | 0.44 | 4.94 |
| 負荷、FULL | 0.27 | 0.62 | 0.85 | 3.46 |
| 負荷、FULL と fullfsync | 0.69 | 1.24 | 2.60 | 2.91 |
| 中で 200ms 待つトランザクションあり、NORMAL | 0.16 | 186 | 200 | 201.5 |
| 同じく FULL | 0.34 | 182 | 197 | 198.5 |

- ふだんの待ちは、ツールの関所の書き込み自身の commit の重さで決まる。10 秒ずつ 3 回繰り返した p50 は、3 回とも NORMAL、FULL、fullfsync の順に並んだ。
- 200ms 待つトランザクションがあると、待ちの上限は中の 200ms で決まった。接続は排他 1 本で、トランザクションは終わるまで排他を握るからである。
- 試作のツールの関所は、前の書き込みが終わってから次を出す。そのため、待たされる頻度は実際より少なく出ている。
- 数字は macOS のものである。macOS の `fsync` はディスクのキャッシュまで書き出さないので、Linux の値は fullfsync の列に近いと見ている（推論）。

中断（`interrupt.ts`）の結果は次のとおりである。`Fiber.interrupt` と `Effect.timeout` のどちらでも、次の 3 つが成り立った。

- 書き込みが戻った。
- 排他が解放された。
- 次の書き込みが 1ms 未満で通った。

入れ子のトランザクション、排他の待ちの最中の中断、200 回続けての中断でも、行は残らなかった。

## Monica の調べ

Monica（`ashigirl96/monica` の cea10b2）のソースを読んだ結果である。試作はしていない。

- **DB**: SQLite の file を 1 つ使う。部品は `bun:sqlite` と `drizzle-orm/bun-sqlite` 0.45 で、Effect は使っていない。
- **持ち場**:
  - 接続と、マイグレーションの適用は `apps/backend` の 1 か所にある。
  - スキーマとマイグレーションは、ドメインのパッケージが持つ。
  - 記録用の表は `__drizzle_migrations_<ドメイン>` とドメインごとに分け、起動時に手で並べた順に当てる。
- **ドメインをまたぐ外部キー**: 依存の向きに沿ってだけ張る。他のドメインのスキーマを import するが、re-export しない。
- **ドメインをまたぐ書き込み**:
  - 他のドメインから呼ばれる書き込みは、「`tx` を第 1 引数に取る同期の関数」にする規約である。
  - lint が、transaction に async の関数を渡すことを止める。
- **テスト**: テストごとに、メモリ上の DB に本物のマイグレーションを当てる。CI で `drizzle-kit generate` を流し、差分が出たら落とす。
- **残っている痛み**:
  - drizzle-kit が出す、表を作り直す SQL を手で直す規約がある。
  - revert で消せなかったマイグレーションが残っている。
- **Kurumi に写らない点**: Monica の正しさは、`bun:sqlite` のトランザクションが同期であることに乗っている。Kurumi は Effect の fiber が並行して書くので、ここは写らない。

## 入れていないもの

- `node_modules` と、試作が作った DB ファイル。`.gitignore` で止めている。依存は各試作の `bun.lock` から入れ直せる。
- 調査で写した Bun のソースと文書。上流のものなので、版（Bun 1.4.4）で引けばよい。
- 調査役の作業メモ。
