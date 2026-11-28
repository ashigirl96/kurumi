import { SqliteClient } from '@effect/sql-sqlite-bun'
import * as Drizzle from 'drizzle-orm/effect-sqlite-bun'
import { migrate } from 'drizzle-orm/effect-sqlite-bun/migrator'
import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'

import { agentRuntimeMigrations } from '../migrations.ts'
import { AgentRuntimeDb } from '../store.ts'

const startup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA journal_mode = WAL`
  yield* sql`PRAGMA synchronous = FULL`
  // 表の作り直しは外部キーが有効だと失敗するので、マイグレーションのあとで有効にする。
  yield* migrate(yield* Drizzle.makeWithDefaults(), agentRuntimeMigrations)
  yield* sql`PRAGMA foreign_keys = ON`
})

export const sqliteDbLayer = (filename: string) =>
  AgentRuntimeDb.layer.pipe(
    Layer.provideMerge(Layer.effectDiscard(startup)),
    Layer.provideMerge(SqliteClient.layer({ filename })),
  )

export const testDbLayer = sqliteDbLayer(':memory:')
