# 永続化の規則

ADR 0009 の決定を、コードを書くときの規則と、確認の手順にまとめたもの。

## 構成

- 接続、PRAGMA、マイグレーションの適用は `apps/host/src/db.ts` の `dbLayer` だけが持つ。接続は `@effect/sql-sqlite-bun` で 1 本だけ開く。
- 起動の順番は、`journal_mode = WAL`、`synchronous = FULL`、全パッケージのマイグレーション（外部キーは切ったまま）、`foreign_keys = ON`、`foreign_key_check`。違反が 1 行でもあれば起動を止める。
- 各ドメインのパッケージは、表の定義（`src/schema.ts`）、マイグレーション（`migrations/`）、記録用の表（`__drizzle_migrations_<パッケージ>`）、Drizzle の窓口（Effect のサービス）、Store を持つ。接続は持たない。
- パッケージを足すときは、`apps/host/src/db.ts` の `packageMigrations` に、そのパッケージの `{ migrationsFolder, migrationsTable }` を足す。
- 設定は環境変数 `KURUMI_DB_PATH`（既定は `~/.kurumi/kurumi.db`）。

## 規則

- トランザクションの中では SQL だけを流す。承認の待ち、docker の操作、ネットワークを待たない。接続は排他 1 本で、トランザクションは終わるまで握るので、待つとツールの関所の先書きを含むすべての書き込みが止まる。
- パッケージをまたぐ外部キーとトランザクションは使わない。他のパッケージの行は id で指す。
- 状態遷移は、前の状態を条件にした 1 文の `UPDATE ... WHERE state = <前の状態> RETURNING` で書き、返った行の数で遷移が起きたかを判定する。
- 列の値は CHECK で縛る。Drizzle の表の定義には STRICT がない。
- 読んだ行は実行時に検査しない。検査は、チャンネルの入力や SDK の出力など、外との境目で行う。
- 冪等な挿入は `onConflictDoNothing` で書き、挿入した行が返ったかで判定する。制約違反の見分けが要るときは、パッケージに 1 つだけ置く関数で行う。
- 表の定義を変えたら `bun run generate` でマイグレーションを作る。SQL を手で書かない。

## 表を作り直す SQL

drizzle-kit が `__new_` の表を作って入れ替える SQL を出したら、取り込む前に見直し、`migration.sql` の頭に `-- rebuild reviewed: <何を確かめたか>` と書く。ない場合、CI の `scripts/check-rebuild-migrations.sh` が落ちる。

マイグレーションは外部キーを切ったまま当てるので、参照する行があっても作り直しは通る。`apps/host/src/fixtures/rebuild/` に、その形のマイグレーションの見本がある。

## Drizzle の版を上げるとき

版は `package.json` の catalog に固定してある。上げるのは別の作業にし、次を流し直す。

1. `bun install` のあと `bun run check`。起動の順番、外部キー、並行トランザクション、中断の確認は `apps/host/src/*.test.ts` に入っている。
2. `bun run generate`。差分が出たら、生成の形が変わっている。`packages/*/migrations` を見直す。
3. `bun run --cwd apps/host generate-fixtures` のあと `bun run check`。表の作り直しの見本を作り直しても、起動のテストが通ること。
4. `docs/research/persistence-stack/prototypes/drizzle/rc/` で `sh run-all.sh`、`docs/research/persistence-stack/prototypes/p-load/` で `bun interrupt.ts`。出力を、同じ場所の `out-rc.txt` と `interrupt-output.txt` と見比べる。手順は `docs/research/persistence-stack/README.md` にある。
