import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { assignToTurn, inboxMigrations, insertStrict, receive } from "@kurumi/inbox"
import { createTurn, turnMigrations, turnMigrationsV1 } from "@kurumi/turn"
import { rmSync } from "node:fs"
import { DbLive, migrate } from "./db.ts"

const file = `${import.meta.dir}/../kurumi.sqlite`
for (const s of ["", "-wal", "-shm"]) rmSync(file + s, { force: true })
const log = (...a: unknown[]) => console.log(...a)
const t0 = performance.now()
const ts = () => `${(performance.now() - t0).toFixed(0)}ms`.padStart(6)

const fileClient = SqliteClient.layer({ filename: file })
const run = <A, E>(eff: Effect.Effect<A, E, SqlClient.SqlClient>, layer: Layer.Layer<SqlClient.SqlClient, any> = fileClient) =>
  Effect.runPromise(Effect.provide(eff, layer) as Effect.Effect<A, E>)

// ---- Check 1: migrations
log("== 1 migrations")
log("run#1 (v1):", JSON.stringify(await run(migrate({ turn: turnMigrationsV1, inbox: inboxMigrations }))))
log("run#2 (v1 again):", JSON.stringify(await run(migrate({ turn: turnMigrationsV1, inbox: inboxMigrations }))))
log("run#3 (v2 adds turns.prompt_uuid):", JSON.stringify(await run(migrate({ turn: turnMigrations, inbox: inboxMigrations }))))
await run(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  log("turns columns:", (yield* sql<{ name: string }>`PRAGMA table_info(turns)`).map((r) => r.name).join(","))
  log("migrations_turn:", JSON.stringify(yield* sql`SELECT migration_id, name FROM migrations_turn`))
  log("migrations_inbox:", JSON.stringify(yield* sql`SELECT migration_id, name FROM migrations_inbox`))
  log("journal_mode:", JSON.stringify(yield* sql`PRAGMA journal_mode`), "foreign_keys(default):", JSON.stringify(yield* sql`PRAGMA foreign_keys`), "sqlite_version:", JSON.stringify(yield* sql`select sqlite_version() v`))
}))
// Hazard: single shared migrator, a migration whose id is below the high-water mark is skipped.
const merged = { "0001_create_turns": turnMigrationsV1["0001_create_turns"], "0003_inbox": inboxMigrations["0001_create_inbound_messages"] }
const late = { ...merged, "0002_turns_add_prompt_uuid": turnMigrations["0002_turns_add_prompt_uuid"] }
const memLayer = SqliteClient.layer({ filename: ":memory:" })
log("hazard (single migrator, id 2 arrives after id 3 applied):", await run(Effect.gen(function* () {
  const a = yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(merged) })
  const b = yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(late) })
  const sql = yield* SqlClient.SqlClient
  const cols = (yield* sql<{ name: string }>`PRAGMA table_info(turns)`).map((r) => r.name).join(",")
  return `first=${JSON.stringify(a)} second=${JSON.stringify(b)} turns cols=${cols}`
}), memLayer))
log("hazard (two packages both use id 1 in one record):", await run(Effect.gen(function* () {
  // distinct keys with the same numeric id reach the migrator; identical keys would collapse silently in the spread
  const r = { ...{ "0001_x": Effect.void }, ...{ "0001_y": Effect.void }, ...{ "1_z": Effect.void } }
  return yield* Effect.exit(SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(r) }))
}), memLayer).then((e) => Exit.isFailure(e) ? String(e.cause) : "ok"))

// The rest of the checks use the host layer: client + PRAGMA foreign_keys + migrations.
const host = DbLive(file)
const count = (where = "1=1") => Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql.unsafe<{ n: number }>(`SELECT count(*) n FROM inbound_messages WHERE ${where}`))[0]!.n
})

log("== 2 idempotent receipt")
log(await run(Effect.gen(function* () {
  const a = yield* receive("P-1", "hi"), b = yield* receive("P-1", "hi again")
  return `first inserted=${a} second inserted=${b} rows=${yield* count("platform_message_id='P-1'")}`
}), host))

log("== 3 cross-domain transaction")
log(await run(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* receive("P-2", "a"); yield* receive("P-3", "b")
  const turnId = yield* sql.withTransaction(Effect.gen(function* () {
    const id = yield* createTurn("s1"); yield* assignToTurn("P-2", id); yield* assignToTurn("P-3", id); return id
  }))
  const ok = `commit: turn=${turnId} assigned=${yield* count(`turn_id=${turnId}`)}`
  const turnsBefore = (yield* sql<{ n: number }>`SELECT count(*) n FROM turns`)[0]!.n
  yield* receive("P-4", "c"); yield* receive("P-5", "d")
  const exit = yield* Effect.exit(sql.withTransaction(Effect.gen(function* () {
    const id = yield* createTurn("s2"); yield* assignToTurn("P-4", id)
    return yield* Effect.fail("boom after first assignment")
  })))
  const turnsAfter = (yield* sql<{ n: number }>`SELECT count(*) n FROM turns`)[0]!.n
  // nested withTransaction = SAVEPOINT: inner failure rolls back only the inner part
  const nested = yield* sql.withTransaction(Effect.gen(function* () {
    yield* receive("P-N1", "outer")
    yield* Effect.exit(sql.withTransaction(Effect.andThen(receive("P-N2", "inner"), Effect.fail("inner boom"))))
    return `nested: outer kept=${yield* count("platform_message_id='P-N1'")} inner kept=${yield* count("platform_message_id='P-N2'")}`
  }))
  return `${ok}\nrollback: exit=${exit._tag} turns ${turnsBefore}->${turnsAfter} P-4 assigned=${yield* count("platform_message_id='P-4' AND turn_id IS NOT NULL")}\n${nested}`
}), host))

log("== 4 concurrency on one client")
log(await run(Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const failing = sql.withTransaction(Effect.gen(function* () {
    log(ts(), "A begin"); yield* insertStrict("A-1", "a1"); log(ts(), "A inserted A-1, sleeping 50ms")
    yield* Effect.sleep("50 millis")
    yield* insertStrict("A-2", "a2"); log(ts(), "A inserted A-2, failing")
    return yield* Effect.fail("A fails")
  }))
  const committing = Effect.andThen(Effect.sleep("10 millis"), sql.withTransaction(Effect.gen(function* () {
    log(ts(), "B begin (inside tx)"); yield* insertStrict("B-1", "b1"); log(ts(), "B inserted B-1, committing")
  })))
  const plain = Effect.andThen(Effect.sleep("20 millis"), Effect.gen(function* () {
    log(ts(), "C plain insert requested (no tx)"); yield* insertStrict("C-1", "c1"); log(ts(), "C plain insert done")
  }))
  const [a, b, c] = yield* Effect.all([Effect.exit(failing), Effect.exit(committing), Effect.exit(plain)], { concurrency: "unbounded" })
  return `exits A=${a._tag} B=${b._tag} C=${c._tag}; rows A-*=${yield* count("platform_message_id LIKE 'A-%'")} B-1=${yield* count("platform_message_id='B-1'")} C-1=${yield* count("platform_message_id='C-1'")}`
}), host))

log("== 5 FK enforcement")
log("with PRAGMA foreign_keys=ON (host layer):", await run(Effect.exit(insertStrict("FK-1", "x", 9999)), host).then((e) => Exit.isFailure(e) ? "rejected" : "ACCEPTED"))
log("client defaults only (no pragma):", await run(Effect.gen(function* () {
  yield* migrate({ turn: turnMigrations, inbox: inboxMigrations })
  return yield* Effect.exit(insertStrict("FK-2", "x", 9999))
}), memLayer).then((e) => Exit.isFailure(e) ? "rejected" : "ACCEPTED"))

log("== 7 error shape")
const show = (e: any) => JSON.stringify({ ctor: e?.constructor?.name, _tag: e?._tag, reason_tag: e?.reason?._tag, message: e?.message, cause_name: e?.reason?.cause?.name, cause_code: e?.reason?.cause?.code, cause_errno: e?.reason?.cause?.errno, operation: e?.reason?.operation })
log("unique:", await run(Effect.flip(insertStrict("P-1", "dup")), host).then(show))
log("fk:", await run(Effect.flip(insertStrict("FK-3", "x", 9999)), host).then(show))
log("check:", await run(Effect.flip(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; yield* sql`INSERT INTO turns (session_id, state) VALUES ('s','bogus')` })), host).then(show))
