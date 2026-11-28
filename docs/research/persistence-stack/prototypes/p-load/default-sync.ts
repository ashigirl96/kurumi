import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
const p = Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; return [yield* sql`PRAGMA journal_mode`, yield* sql`PRAGMA synchronous`, yield* sql`PRAGMA busy_timeout`] })
console.log("client defaults (file DB):", JSON.stringify(await Effect.runPromise(Effect.provide(p, SqliteClient.layer({ filename: `${import.meta.dir}/default.sqlite` })))))
