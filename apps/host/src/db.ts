import { SqliteClient } from '@effect/sql-sqlite-bun'
import { agentRuntimeMigrations } from '@kurumi/agent-runtime/migrations'
import { AgentRuntimeDb } from '@kurumi/agent-runtime/store'
import * as Drizzle from 'drizzle-orm/effect-sqlite-bun'
import { migrate } from 'drizzle-orm/effect-sqlite-bun/migrator'
import { Data, Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'

export type PackageMigrations = {
  readonly migrationsFolder: string
  readonly migrationsTable: string
}

export const packageMigrations: readonly PackageMigrations[] = [agentRuntimeMigrations]

export class ForeignKeyViolations extends Data.TaggedError('ForeignKeyViolations')<{
  readonly rows: readonly unknown[]
}> {}

const startup = (migrations: readonly PackageMigrations[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA journal_mode = WAL`
    yield* sql`PRAGMA synchronous = FULL`
    // 外部キーが切れている間に流す。表の作り直しは、参照する行があると外部キーが有効なままでは失敗する。
    const db = yield* Drizzle.makeWithDefaults()
    for (const m of migrations) yield* migrate(db, m)
    yield* sql`PRAGMA foreign_keys = ON`
    const rows = yield* sql`PRAGMA foreign_key_check`
    if (rows.length > 0) yield* new ForeignKeyViolations({ rows })
  })

export const dbLayer = (
  filename: string,
  migrations: readonly PackageMigrations[] = packageMigrations,
) =>
  AgentRuntimeDb.layer.pipe(
    Layer.provideMerge(Layer.effectDiscard(startup(migrations))),
    Layer.provideMerge(SqliteClient.layer({ filename })),
  )
