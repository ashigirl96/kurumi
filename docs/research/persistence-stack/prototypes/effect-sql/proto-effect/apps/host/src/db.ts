import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { inboxMigrations } from "@kurumi/inbox"
import { turnMigrations } from "@kurumi/turn"

// The client does not set foreign_keys; it must run outside any transaction, once per connection.
const Pragmas = Layer.effectDiscard(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA foreign_keys = ON`
}))

// One migrator per domain, each with its own bookkeeping table, so ids never collide across packages.
// Order matters only for readability here: SQLite accepts REFERENCES to a table that does not exist yet.
export const migrate = (migrations: { turn: Record<string, any>; inbox: Record<string, any> }) =>
  Effect.gen(function* () {
    const turn = yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations.turn), table: "migrations_turn" })
    const inbox = yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(migrations.inbox), table: "migrations_inbox" })
    return { turn, inbox }
  })

export const Migrations = Layer.effectDiscard(migrate({ turn: turnMigrations, inbox: inboxMigrations }))

export const DbLive = (filename: string) =>
  Layer.mergeAll(Pragmas, Migrations).pipe(Layer.provideMerge(SqliteClient.layer({ filename })))
