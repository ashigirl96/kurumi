import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Schema } from "effect"
import { Model } from "effect/schema"
import { SqlClient, SqlModel, SqlSchema } from "effect/sql"

// ---- the domain code being measured (BEGIN-COUNT)
const TurnState = Schema.Literals(["queued", "running", "closing", "completed", "failed", "interrupted"])
const Turn = Schema.Struct({ id: Schema.Number, session_id: Schema.String, state: TurnState, prompt_uuid: Schema.NullOr(Schema.String) })

const makeTurnStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const bySession = SqlSchema.findAll({
    Request: Schema.String,
    Result: Turn,
    execute: (sessionId) => sql`SELECT * FROM turns WHERE session_id = ${sessionId}`,
  })
  const create = SqlSchema.findOne({
    Request: Schema.Struct({ session_id: Schema.String, state: TurnState }),
    Result: Turn,
    execute: (row) => sql`INSERT INTO turns ${sql.insert(row)} RETURNING *`,
  })
  const startClosing = (id: number) =>
    Effect.map(sql`UPDATE turns SET state = 'closing' WHERE id = ${id} AND state = 'running' RETURNING id`, (rows) => rows.length === 1)
  return { bySession, create, startClosing }
})
// (END-COUNT)

// Model variant: one class gives select/insert/update schemas; makeRepository gives insert/findById/update/delete.
class TurnModel extends Model.Class<TurnModel>("TurnModel")({
  id: Model.GeneratedByDb(Schema.Number),
  session_id: Schema.String,
  state: TurnState,
  prompt_uuid: Schema.NullOr(Schema.String),
}) {}

const show = (e: unknown) => {
  const x = e as any
  return `ctor=${x?.constructor?.name} _tag=${x?._tag}\n${String(x?.message ?? x).split("\n").map((l) => "    | " + l).join("\n")}`
}

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, prompt_uuid TEXT, created_at)`
  const store = yield* makeTurnStore

  const t = yield* store.create({ session_id: "s1", state: "running" })
  console.log("insert-returning:", JSON.stringify(t))
  console.log("findAll:", JSON.stringify(yield* store.bySession("s1")))
  console.log("transition running->closing first:", yield* store.startClosing(t.id), " second:", yield* store.startClosing(t.id))

  console.log("== error: column missing from result (SELECT without state)")
  const missing = SqlSchema.findAll({ Request: Schema.Void, Result: Turn, execute: () => sql`SELECT id, session_id, prompt_uuid FROM turns` })
  console.log("  " + show(yield* Effect.flip(missing(undefined))))

  console.log("== error: wrong type (state value outside the literal union; no CHECK constraint on this table)")
  yield* sql`INSERT INTO turns (session_id, state) VALUES ('s2', 'runing')`
  console.log("  " + show(yield* Effect.flip(store.bySession("s2"))))

  console.log("== error: wrong type (id read back as TEXT)")
  const textId = SqlSchema.findAll({ Request: Schema.Void, Result: Turn, execute: () => sql`SELECT CAST(id AS TEXT) id, session_id, state, prompt_uuid FROM turns WHERE session_id='s1'` })
  console.log("  " + show(yield* Effect.flip(textId(undefined))))

  console.log("== error: bad request value is rejected before SQL runs (encode side)")
  console.log("  " + show(yield* Effect.flip(store.create({ session_id: "s3", state: "bogus" as any }))))
  console.log("  rows for s3:", (yield* sql`SELECT count(*) n FROM turns WHERE session_id='s3'`)[0])

  console.log("== error channel type: SchemaError is a typed failure, catchable by tag")
  console.log("  " + (yield* store.bySession("s2").pipe(Effect.as("no error"), Effect.catchTag("SchemaError", (e) => Effect.succeed(`caught SchemaError, issue._tag=${(e as any).issue?._tag}`)))))

  console.log("== Model + SqlModel.makeRepository")
  const repo = yield* SqlModel.makeRepository(TurnModel, { tableName: "turns", spanPrefix: "TurnRepo", idColumn: "id" })
  const m = yield* repo.insert(TurnModel.insert.make({ session_id: "s4", state: "queued", prompt_uuid: null }))
  console.log("  repo.insert ->", m.constructor.name, JSON.stringify(m))
  console.log("  repo.findById ->", JSON.stringify(yield* repo.findById(m.id)))
})

await Effect.runPromise(Effect.provide(program, SqliteClient.layer({ filename: ":memory:" })))
