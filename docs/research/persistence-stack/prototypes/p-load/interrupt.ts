import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Exit, Fiber } from "effect"
import { SqlClient } from "effect/sql"
import { rmSync } from "node:fs"

const file = `${import.meta.dir}/interrupt.sqlite`
for (const s of ["", "-wal", "-shm"]) rmSync(file + s, { force: true })
const t0 = performance.now()
const ts = () => `${(performance.now() - t0).toFixed(0)}ms`.padStart(7)
const log = (...a: unknown[]) => console.log(ts(), ...a)

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE t (k TEXT PRIMARY KEY)`
  const has = (k: string) => Effect.map(sql<{ n: number }>`SELECT count(*) n FROM t WHERE k = ${k}`, (r) => r[0]!.n)
  const timedInsert = (k: string) => Effect.gen(function* () {
    const t = performance.now()
    yield* sql`INSERT INTO t (k) VALUES (${k})`
    return (performance.now() - t).toFixed(1)
  })
  const probeTx = (k: string) => Effect.map(Effect.exit(sql.withTransaction(sql`INSERT INTO t (k) VALUES (${k})`)), (e) => e._tag === "Success" ? "ok" : String(e.cause))
  const longTx = (k: string) => sql.withTransaction(Effect.gen(function* () {
    yield* sql`INSERT INTO t (k) VALUES (${k})`
    log(`  ${k}: inserted inside tx, sleeping 10s`)
    yield* Effect.sleep("10 seconds")
  }))

  log("== A. Fiber.interrupt on a fiber holding a transaction")
  const a = yield* Effect.forkChild(longTx("A"))
  yield* Effect.sleep(30)
  const waiter = yield* Effect.forkChild(timedInsert("A-waiter"))
  log("  A-waiter: plain insert queued behind the open tx")
  yield* Effect.sleep(70)
  const ti = performance.now()
  yield* Fiber.interrupt(a)
  log(`  Fiber.interrupt returned after ${(performance.now() - ti).toFixed(1)}ms; exit=${(yield* Fiber.await(a))._tag}`)
  log(`  A-waiter insert took ${yield* Fiber.join(waiter)}ms total (queued ~70ms before interrupt)`)
  log(`  row A present=${yield* has("A")}  new insert after: ${yield* timedInsert("A-after")}ms  new tx after: ${yield* probeTx("A-tx-after")}`)

  log("== B. Effect.timeout(100ms) around withTransaction")
  const tb = performance.now()
  const b = yield* Effect.exit(Effect.timeout(longTx("B"), "100 millis"))
  log(`  exit after ${(performance.now() - tb).toFixed(1)}ms: ${Exit.isFailure(b) ? String(b.cause) : "success"}`)
  log(`  row B present=${yield* has("B")}  new insert after: ${yield* timedInsert("B-after")}ms  new tx after: ${yield* probeTx("B-tx-after")}`)

  log("== C. Interrupt the whole fiber while inside a nested transaction (savepoint)")
  const c = yield* Effect.forkChild(sql.withTransaction(Effect.gen(function* () {
    yield* sql`INSERT INTO t (k) VALUES ('C-outer')`
    yield* sql.withTransaction(longTx("C-inner"))
  })))
  yield* Effect.sleep(50)
  yield* Fiber.interrupt(c)
  log(`  exit=${(yield* Fiber.await(c))._tag} C-outer present=${yield* has("C-outer")} C-inner present=${yield* has("C-inner")}  new insert: ${yield* timedInsert("C-after")}ms  new tx: ${yield* probeTx("C-tx-after")}`)

  log("== D. Timeout only the inner savepoint; outer continues and commits")
  const d = yield* Effect.exit(sql.withTransaction(Effect.gen(function* () {
    yield* sql`INSERT INTO t (k) VALUES ('D-outer')`
    const inner = yield* Effect.exit(Effect.timeout(sql.withTransaction(Effect.gen(function* () {
      yield* sql`INSERT INTO t (k) VALUES ('D-inner')`
      yield* Effect.sleep("10 seconds")
    })), "50 millis"))
    log(`  inner exit: ${Exit.isFailure(inner) ? String(inner.cause) : "success"}`)
    yield* sql`INSERT INTO t (k) VALUES ('D-outer-2')`
  })))
  log(`  outer exit=${d._tag} D-outer=${yield* has("D-outer")} D-inner=${yield* has("D-inner")} D-outer-2=${yield* has("D-outer-2")}  new tx: ${yield* probeTx("D-tx-after")}`)

  log("== E. Interrupt a transaction still queued for the lock")
  const holder = yield* Effect.forkChild(sql.withTransaction(Effect.andThen(sql`INSERT INTO t (k) VALUES ('E-holder')`, Effect.sleep(100))))
  yield* Effect.sleep(10)
  const queued = yield* Effect.forkChild(sql.withTransaction(sql`INSERT INTO t (k) VALUES ('E-queued')`))
  yield* Effect.sleep(10)
  yield* Fiber.interrupt(queued)
  yield* Fiber.join(holder)
  log(`  queued exit=${(yield* Fiber.await(queued))._tag} E-holder=${yield* has("E-holder")} E-queued=${yield* has("E-queued")}  new insert: ${yield* timedInsert("E-after")}ms  new tx: ${yield* probeTx("E-tx-after")}`)

  log("== F. Many interrupts in a row (permit leak check): 200 x interrupt mid-tx, then one write")
  for (let i = 0; i < 200; i++) {
    const f = yield* Effect.forkChild(sql.withTransaction(Effect.andThen(sql`INSERT INTO t (k) VALUES (${`F-${i}`})`, Effect.sleep("10 seconds"))))
    yield* Effect.sleep(1)
    yield* Fiber.interrupt(f)
  }
  log(`  F rows left=${(yield* sql<{ n: number }>`SELECT count(*) n FROM t WHERE k LIKE 'F-%'`)[0]!.n}  new insert: ${yield* timedInsert("F-after")}ms  new tx: ${yield* probeTx("F-tx-after")}`)
})

await Effect.runPromise(Effect.provide(program, SqliteClient.layer({ filename: file })))
