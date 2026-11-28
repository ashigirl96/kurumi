# Kurumi の永続化層の調査（2026-11-28）

目的: 各ドメインのパッケージがスキーマを持つモノレポで、Kurumi に合う永続化の組み合わせを選ぶための根拠を出す。決定は後の grill-with-docs で行う。

根拠の印: 【実測】は試作で観測したもの。【コード】はライブラリのソースから読んだもの。【推論】はどちらでもないもの。

使った版: Bun 1.4.4、SQLite 3.54.0、effect と @effect/sql-sqlite-bun 4.1.7（latest）、drizzle-orm 0.45.4 と drizzle-kit 0.31.11（stable）、drizzle-orm と drizzle-kit 1.0.0-rc.6（rc、11-20 公開、7 か月で RC 6 回）。

試作（すべて使い捨て）:
- Effect SQL: `prototypes/effect-sql/proto-effect/`（出力 `checks-output.txt`、`test-output.txt`）
- bun:sqlite 直接: `prototypes/effect-sql/proto-raw/`
- Drizzle stable: `prototypes/drizzle/stable/`、Effect + Drizzle RC: `prototypes/drizzle/rc/`（`sh prototypes/drizzle/run-all.sh` で再実行できる）

共通の筋書き: `packages/turn` が `turns` を、`packages/inbox` が `inbound_messages`（`turn_id` が `turns.id` を参照）を持ち、`apps/host` が組み立てる。

## 1. 結果の一覧

| 確認 | 1 Drizzle + bun:sqlite | 2 Effect SQL | 3 Effect SQL + Drizzle RC | 4 bun:sqlite 直接 |
|---|---|---|---|---|
| 並行トランザクションの分離（確認 4） | async の callback で壊れる。失敗側の行が残った（`["A1","B1","A2"]`）。同期の callback なら正しい【実測】 | 正しい。排他 1 本を握り続け、単発の書き込みも待つ【実測】【コード `SqliteClient.ts:267-272`, `SqlClient.ts:454-505`】 | 正しい。トランザクションを Effect の `withTransaction` に任せる【実測】【コード】 | async にすると壊れる。`db.transaction(async)` は最初の await で commit。手書きの BEGIN の間に、並行した INSERT が混ざって一緒に消えた【実測】 |
| マイグレーションの生成 | drizzle-kit が TS のスキーマから SQL を作る | なし。SQL を手で書く【コード】 | drizzle-kit 1.0 RC が作る。RC 同士で Bun 上で動いた【実測】 | なし |
| マイグレーションの適用 | `migrate()`（同期） | `Migrator.run`。適用済みの最大の番号より小さいものは黙って飛ばす【実測】【コード `Migrator.ts:287`】 | `drizzle-orm/effect-sqlite-bun/migrator` の `migrate`（Effect） | 自作（`PRAGMA user_version` など） |
| FK の強制 | 既定で無効。`PRAGMA foreign_keys = ON` が要る【実測】 | 同じ【実測】 | 同じ【実測】 | 同じ【実測】 |
| エラーの形 | `SQLiteError` を投げる | `SqlError`。理由は `UniqueViolation`、`ConstraintError` など【実測】 | `EffectDrizzleQueryError`。中の `cause` の `SqlError.reason._tag` を見る【実測】 | `SQLiteError` を投げる |
| テスト 1 件（マイグレーション済みの `:memory:` を毎回作る） | 0.4〜1.5ms【実測】 | 0.5〜2.8ms【実測】 | 0.8〜2.5ms【実測】 | 約 0.15ms【実測】 |
| 安定度 | stable | 4.x の latest。ただしモジュールに「不安定」の注記がある。4.1.6 から 4.1.7 で接続、トランザクション、マイグレーションのソースに差分なし【実測】 | Drizzle は RC。SQLite 向け Effect ドライバの公式文書は 404 | Bun の組み込み |
| 増える依存 | drizzle-orm、drizzle-kit | なし（effect のみ） | drizzle-orm、drizzle-kit（RC） | なし |

全案に共通して見つけた落とし穴:
- 表を作り直すマイグレーションは、FK が ON だと失敗する。drizzle-kit は `PRAGMA foreign_keys=OFF` を書き出すが、マイグレーターがトランザクションの中で流すので効かない（SQLite はトランザクションの中ではこの PRAGMA を無視する）。参照している行が 1 行あるだけで巻き戻った【実測、RC】。0.45 も同じ作り【コード、Monica の報告】。対策は、FK を OFF のまま適用し、そのあと ON にして `PRAGMA foreign_key_check` で確かめる順にすること。Monica は作り直しの SQL を手で直す規約を持っている（docs/packages.md:82-83）。
- Effect SQL と Drizzle RC では、トランザクションを開いている間は他の書き込みがすべて待つ（単発の挿入も 40ms 待った）【実測】。Kurumi では、ツールの関所（`PreToolUse` フック）の先書きの記録も待たされ、その間ツールが始まらない【推論】。

## 2. 中心の問い: スキーマを各ドメインに置くとき、接続とマイグレーションはどこに置くか

どの案でも、自然な置き場所は同じだった。

- **ドメインのパッケージ**（`packages/<domain>`）: 表の定義、行の型、そのドメインの読み書きの関数を置く。接続は持たない。読み書きの関数は、接続を引数（案 1、4）か Effect の文脈（案 2、3）から受け取る。
- **アプリ**（`apps/host`）: 接続を 1 つ開き、PRAGMA を設定し、全ドメインのマイグレーションを起動時に適用してから仕事を始める。

Monica も同じ分け方をしている。接続と適用は `apps/backend/src/main.ts:93-110` の 1 か所で、`db` を各ドメインの台帳に引数で渡す。openbot は、全部の表を 1 つの `persistence` パッケージに持つ（ドメインに分けていない）。

マイグレーションの記録の持ち方は、2 通りある。

- **A. 記録を 1 本にまとめる**: `apps/host` に drizzle-kit の設定を 1 つ置き、`schema: ["../../packages/*/src/schema.ts"]` で全ドメインを拾い、`apps/host/drizzle/` に 1 本の履歴を出す。両方の Drizzle の版で動き、inbox から turn への FK も生成された【実測】。スキーマはドメインが持ち、履歴はアプリが持つ。履歴が 1 本なので、FK の順番の問題が起きない。
- **B. ドメインごとに記録を分ける**: ドメインごとに履歴と記録用の表を持つ（Monica の `__drizzle_migrations_<d>`、Effect SQL の `table: "migrations_<d>"`）。記録用の表を共有すると黙って壊れる。
  - Effect SQL の `Migrator` は最大の番号しか見ないので、後から届いた小さい番号は流れない。同じ番号が 2 つあると `Duplicates` のエラーになる【実測】。
  - Drizzle 0.45 は時刻が古いフォルダを飛ばした。1.0 RC は同じ秒、同じ名前のフォルダを重ねた【実測】。

  起動時には、FK の向きに合わせてドメインの順番を手で並べる（Monica は workbench を task より先に流す）。

案 2 には生成器がないので、A を取るなら、全ドメインの SQL を 1 本の番号の列に並べることになる。これはドメインが自分の履歴を持たないことを意味する。案 2 では B が自然で、試作もそうした。

FK のための依存:
- Drizzle（案 1、3）では、inbox が `@k/turn/schema` を import する。依存するのはスキーマだけで、ロジックには依存しない。Monica はこの import を re-export しない（docs/packages.md:56）。
- SQL を手で書く案（案 2、4）では、FK は文字列の `REFERENCES turns(id)` なので、パッケージの依存はできない。代わりに、turns ができる前に inbox に書くと `no such table` で失敗する【実測】。

ドメインをまたぐトランザクション:
- 案 2、3 では、トランザクションは fiber（Effect の軽量な並行処理の単位）にひもづく。だから、呼ぶ側が `sql.withTransaction(Effect.all([turn.create(...), inbox.assign(...)]))` と包むだけで、両ドメインの関数が同じトランザクションに入る。ドメインの関数は `tx` を引数に取らなくてよい【実測。RC では、外側の `db` を使った書き込みもトランザクションに入って一緒に巻き戻った】。
- 案 1、4 では、Monica と同じく「`tx` を第 1 引数に取る同期の関数」にする規約と、async の callback を止める lint が要る（Monica `scripts/oxlint/monica.js:131-170`）。

## 3. 各案の構成と最小限のコード

### 案 1: Drizzle + bun:sqlite（Monica と同じ）

```
apps/host/
  drizzle.config.ts      # schema: ../../packages/*/src/schema.ts, out: ./drizzle
  drizzle/<ts>_init/migration.sql
  src/db.ts              # 接続、PRAGMA、migrate
packages/turn/src/schema.ts
packages/inbox/src/schema.ts   # import { turns } from "@k/turn/schema"
```

```ts
// packages/inbox/src/schema.ts
export const inboundMessages = sqliteTable("inbound_messages", {
  id: integer().primaryKey(),
  platformMessageId: text("platform_message_id").notNull().unique(),
  body: text().notNull(),
  turnId: integer("turn_id").references(() => turns.id),
});

// apps/host/src/db.ts
export function openDb(filename: string) {
  const client = new Database(filename, { strict: true });
  const db = drizzle({ client, schema: { ...turn, ...inbox } });
  migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
  client.run("PRAGMA foreign_keys = ON");
  return db;
}

// 同期の callback だけが正しい。async を渡しても型は通る（tsc 7.0.2 で実測）
db.transaction((tx) => {
  const [t] = tx.insert(turns).values({ sessionId, state: "queued" }).returning().all();
  tx.update(inboundMessages).set({ turnId: t!.id }).where(inArray(inboundMessages.id, ids)).run();
});
```

### 案 2: Effect SQL

```
apps/host/src/db.ts            # SqliteClient.layer、PRAGMA、ドメインごとの Migrator.run
packages/turn/src/
  index.ts                     # turnMigrations と読み書きの関数
  migrations/0001_create_turns.ts
  migrations/0002_turns_add_prompt_uuid.ts
packages/inbox/src/
  index.ts
  migrations/0001_create_inbound_messages.ts   # REFERENCES turns(id) は文字列
```

```ts
// packages/turn/src/index.ts
export const turnMigrations = { "0001_create_turns": CreateTurns, "0002_turns_add_prompt_uuid": AddPromptUuid }
export const createTurn = (sessionId: string) => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const [row] = yield* sql<{ id: number }>`INSERT INTO turns (session_id, state) VALUES (${sessionId}, 'queued') RETURNING id`
  return row!.id
})

// apps/host/src/db.ts
const migrate = Effect.gen(function* () {
  yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(turnMigrations), table: "migrations_turn" })
  yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(inboxMigrations), table: "migrations_inbox" })
})
const Pragmas = Layer.effectDiscard(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`PRAGMA foreign_keys = ON`))
export const DbLive = (filename: string) =>
  Layer.mergeAll(Layer.effectDiscard(migrate), Pragmas).pipe(Layer.provideMerge(SqliteClient.layer({ filename })))

// ドメインをまたぐトランザクション（呼ぶ側で包む）
const assign = Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(
  Effect.gen(function* () {
    const turnId = yield* createTurn(sessionId)
    yield* Effect.forEach(ids, (id) => assignToTurn(id, turnId))
  })))
```

試作では `PRAGMA foreign_keys = ON` を適用より前に流していた。表の作り直しを含めるなら、適用の後に回す。`` sql<T> `` の型引数は、実行時には検査されない【推論】。行を検査するなら、Effect Schema を使う `SqlSchema` を通す。

### 案 3: Effect SQL + Drizzle 1.0 RC

```
apps/host/
  drizzle.config.ts      # 案 1 と同じ（drizzle-kit 1.0 RC）
  drizzle/<ts>_init/{migration.sql,snapshot.json}
  db.ts
packages/turn/src/schema.ts
packages/inbox/src/schema.ts
```

```ts
// apps/host/db.ts
export const makeDb = Effect.gen(function* () {
  const db = yield* Drizzle.makeWithDefaults()        // 下の SqliteClient を使う
  yield* migrate(db, { migrationsFolder: `${import.meta.dir}/drizzle` })
  yield* db.run(sql`PRAGMA foreign_keys = ON`)
  return db
})
export const sqliteLayer = (filename: string) => SqliteClient.layer({ filename })

// トランザクションは Effect を返し、Effect の withTransaction に任せる
db.transaction((tx) => Effect.gen(function* () {
  const [t] = yield* tx.insert(turns).values({ sessionId: "s", state: "queued" }).returning()
  yield* tx.update(inboundMessages).set({ turnId: t!.id })
}))
```

関係の定義（`defineRelationsPart`）と、関係をたどる問い合わせ（RQB v2）も、Effect のドライバ経由で動いた【実測】。

`@effect/sql-drizzle` は `effect ^3.22.4` に依存しているので、Effect 4 では使えない【コード】。

### 案 4: bun:sqlite 直接

```
apps/host/src/db.ts       # open（PRAGMA）、migrations 配列、user_version で適用
packages/turn/src/index.ts     # SQL 文字列と、Database を受け取る関数
packages/inbox/src/index.ts
```

```ts
export const migrations = [turnMigrations.createTurns, inboxMigrations.createInbound, turnMigrations.addPromptUuid]
export const migrate = (db: Database) => db.transaction(() => {
  const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
  for (let v = current; v < migrations.length; v++) db.run(migrations[v]!)
  db.run(`PRAGMA user_version = ${migrations.length}`)
}).immediate()
```

Effect から使うには、`Effect.try` で包む層と、すべての書き込みを通す排他の層を自分で書くことになる。排他の層は試作で正しく動いた（4c）が、案 2 の仕組みを手で作り直すことになる【実測】。

## 4. 評価

| 観点 | 1 Drizzle + bun:sqlite | 2 Effect SQL | 3 Effect SQL + Drizzle RC | 4 bun:sqlite 直接 |
|---|---|---|---|---|
| Effect との親和性 | 低い。同期の世界で、例外で失敗する | 高い。Layer、型付きのエラー、fiber にひもづくトランザクション | 高い。2 の上に乗る | 低い。包む層を自作する |
| ドメインごとのスキーマ | TS の表がドメインに 1 か所。FK のためにスキーマ同士で import する | DDL（SQL）と行の型が別々。ずれは実 DB のテストで拾う | 1 と同じ | 2 と同じで、さらに素朴 |
| マイグレーションの生成と適用 | 生成あり。作り直しの SQL は手で直す | 生成なし。ドメインごとに記録用の表を分ける | 生成あり（RC）。1 と同じ注意点 | すべて自作 |
| ドメインをまたぐトランザクション | `tx` を引数に渡す規約と lint が要る | 呼ぶ側で包むだけ | 呼ぶ側で包むだけ | 1 と同じ |
| 接続と並行処理 | async にした瞬間に壊れ、型は止めない | 作りとして正しい。代わりに長いトランザクションが全書き込みを止める | 2 と同じ | 自分で排他を書けば正しい |
| 型安全とエラー | クエリの型は強い。エラーは例外 | 行の型は宣言だけ。エラーは型付きで、理由で分けられる | クエリの型は強い。エラーは包まれていて、理由は中を掘る | 弱い |
| テストのしやすさ | 速い | 速い。Layer を差し替えるだけ | 速い | 最速 |
| 複雑さと保守 | Monica と同じで見慣れている。規律に頼る | 依存が増えない。SQL を手で書く量が増える | 依存が 2 層の RC と「不安定」注記。公式文書がない | 書く量が最大 |

## 5. 推奨（決定は grill で行う）

**推奨: 案 2（Effect SQL）を既定にする。** 仕様の今の既定を保つが、理由を「RC だから」から下の 3 点に置き換える。

1. Kurumi の書き込みは、同じプロセスの中の fiber が並行して行う（ターン 3 つ、フック、配信、受信）。案 1 と案 4 は、async のトランザクションで黙ってデータを失った【実測】。正しさが作りで保証されるのは、案 2 と案 3 だけである。
2. 案 2 と案 3 の差は、生成器と型付きのクエリビルダーだけである。トランザクションと接続は、どちらも同じ `SqliteClient` が持つ【コード、実測】。Kurumi の表は 5 つ程度で、問い合わせは挿入と状態の更新が中心になる。そのため、生成器の得は小さい。一方で、RC と公式文書のない部品に乗るという負担は、毎日かかる。
3. 案 3 は案 2 の上に乗る。だから、後から Drizzle を足すときは、同じ接続と同じトランザクションの上に足せる【推論】。ただし、マイグレーションの記録を drizzle-kit の形に移す手間は残る。

案 3 を選ぶべき場合もある。スキーマを TS の 1 か所に置くことと、生成器が CI でずれを止めること（Monica の `generate` の確認）を、RC の負担より重く見るなら、案 3 が勝つ。そのときは、記録を 1 本にまとめる A の形が素直になる。

案 1 と案 4 は外すことを勧める。Effect を全体で使う前提と、同期のトランザクションという前提がぶつかる。

どの案でも決めておくこと:
- 接続、PRAGMA、マイグレーションの適用は `apps/host` の 1 か所に置く。`packages/db` のような共有パッケージは作らない。案 2 では、ドメインは `effect` の `SqlClient` だけに依存すればよい。
- トランザクションの中では SQL だけを流し、外の入出力（承認の待ち、docker、ネットワーク）を待たない。待つと、フックの先書きの記録まで止まる。
- 適用は FK を OFF のまま行い、そのあと `PRAGMA foreign_keys = ON` と `PRAGMA foreign_key_check` を流す。
- 案 2 では、ドメインごとに `table: "migrations_<domain>"` を分け、FK の向きの順に流す。番号はドメインの中で単調に増やす。

## 6. 追加の試作の提案

1. **負荷のもとでのフックの書き込みの待ち時間**: file の DB（WAL）で、3 ターン分の書き込みとフックの先書きを同時に流し、フックの書き込みの p99 を測る。排他 1 本の作りが、ツールの開始を目に見えて遅らせないかを確かめる。
2. **トランザクション中の fiber の中断**: `/stop` でトランザクションを持つ fiber を中断し、巻き戻りと排他の解放を確かめる（未測定）。
3. **実際の Store の問い合わせで案 2 と案 3 を比べる**: 仕様の 5 表と主な問い合わせ（ターンの状態遷移、`tool_calls` の先書き、送信の取り出し）を両方で書き、行数と型で捕まる誤りを比べる。決め手が「生成器と型の得」になるので、この試作で数字にする。
4. **表の作り直しのマイグレーション**: 選んだ案で、FK を OFF にして適用し、そのあと検査する手順が通ることを確かめる。

## 7. 確かめていないこと

- 型検査（`tsc`）は、案 1 の async の型の確認しか流していない。
- Effect SQL の `fromGlob` と `fromFileSystem`。
- 0.45 で表の作り直しが失敗すること（同じ作りからの推論）。
- 案 3 で、生の `` sql`` `` と Drizzle を 1 つのトランザクションに混ぜること（fiber にひもづく作りからの推論）。
- 別のプロセスが同じ file を開く場合。
- Effect の上流の変更履歴。
