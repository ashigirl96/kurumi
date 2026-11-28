// usage: bun load.ts <idle|load|sleepy> <FULL|NORMAL> <seconds>
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Effect, Fiber } from "effect"
import { SqlClient } from "effect/sql"
import { rmSync } from "node:fs"

const [mode = "load", sync = "FULL", secs = "20"] = process.argv.slice(2)
const file = `${import.meta.dir}/load.sqlite`
for (const s of ["", "-wal", "-shm"]) rmSync(file + s, { force: true })
const durationMs = Number(secs) * 1000
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const payload = "x".repeat(200)
const counts = { stream: 0, txs: 0, sleepyTxs: 0, outbound: 0, hook: 0 }
const hookMs: number[] = []
const lagMs: number[] = []

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA synchronous = ${sql.literal(sync === "FULLFSYNC" ? "FULL" : sync)}`
  if (sync === "FULLFSYNC") yield* sql`PRAGMA fullfsync = 1`
  const info = {
    journal: (yield* sql`PRAGMA journal_mode`)[0],
    synchronous: (yield* sql`PRAGMA synchronous`)[0],
    fullfsync: (yield* sql`PRAGMA fullfsync`)[0],
    version: (yield* sql`select sqlite_version() v`)[0],
  }
  yield* sql`CREATE TABLE turns (id INTEGER PRIMARY KEY, state TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0)`
  yield* sql`CREATE TABLE stream_records (id INTEGER PRIMARY KEY, turn_id INTEGER NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL)`
  yield* sql`CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, turn_id INTEGER NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL, created_at INTEGER NOT NULL)`
  yield* sql`CREATE TABLE outbound_messages (id INTEGER PRIMARY KEY, status TEXT NOT NULL, body TEXT NOT NULL)`
  yield* sql`INSERT INTO turns (id, state) VALUES (1,'running'),(2,'running'),(3,'running')`

  const end = performance.now() + durationMs
  const alive = () => performance.now() < end

  const turn = (id: number) => Effect.gen(function* () {
    let seq = 0
    let nextSleepy = performance.now() + 1000
    while (alive()) {
      yield* Effect.sleep(rand(5, 20))
      if (mode === "sleepy" && id === 1 && performance.now() >= nextSleepy) {
        nextSleepy += 1000
        yield* sql.withTransaction(Effect.gen(function* () {
          yield* sql`INSERT INTO stream_records (turn_id, seq, payload) VALUES (${id}, ${++seq}, ${payload})`
          yield* Effect.sleep(200) // anti-pattern: awaiting something outside SQL while holding the write lock
          yield* sql`UPDATE turns SET last_seq = ${seq} WHERE id = ${id}`
        }))
        counts.sleepyTxs++
      } else if (Math.random() < 0.1) {
        const n = 3 + Math.floor(Math.random() * 3)
        yield* sql.withTransaction(Effect.gen(function* () {
          for (let i = 0; i < n - 1; i++) yield* sql`INSERT INTO stream_records (turn_id, seq, payload) VALUES (${id}, ${++seq}, ${payload})`
          yield* sql`UPDATE turns SET last_seq = ${seq} WHERE id = ${id}`
        }))
        counts.txs++
      } else if (Math.random() < 0.7) {
        yield* sql`INSERT INTO stream_records (turn_id, seq, payload) VALUES (${id}, ${++seq}, ${payload})`
        counts.stream++
      } else {
        yield* sql`UPDATE turns SET last_seq = ${seq} WHERE id = ${id}`
        counts.stream++
      }
    }
  })

  const outbound = Effect.gen(function* () {
    while (alive()) {
      yield* Effect.sleep(30)
      yield* sql`INSERT INTO outbound_messages (status, body) VALUES ('pending', ${payload})`
      const rows = yield* sql<{ id: number }>`SELECT id FROM outbound_messages WHERE status = 'pending' ORDER BY id LIMIT 1`
      if (rows[0]) {
        yield* sql`UPDATE outbound_messages SET status = 'sending' WHERE id = ${rows[0].id}`
        yield* sql`UPDATE outbound_messages SET status = 'delivered' WHERE id = ${rows[0].id}`
      }
      counts.outbound++
    }
  })

  const hook = Effect.gen(function* () {
    while (alive()) {
      yield* Effect.sleep(50)
      const t = performance.now()
      yield* sql`INSERT INTO tool_calls (turn_id, tool, input, created_at) VALUES (1, 'Bash', ${payload}, ${Date.now()})`
      hookMs.push(performance.now() - t)
      counts.hook++
    }
  })

  // Measures event-loop delay independently of the DB lock: how late a 10ms timer fires.
  const lag = Effect.promise(async () => {
    while (alive()) {
      const t = performance.now()
      await new Promise((r) => setTimeout(r, 10))
      lagMs.push(performance.now() - t - 10)
    }
  })

  const fibers = [yield* Effect.forkChild(hook), yield* Effect.forkChild(lag)]
  if (mode !== "idle") {
    fibers.push(yield* Effect.forkChild(outbound))
    for (const id of [1, 2, 3]) fibers.push(yield* Effect.forkChild(turn(id)))
  }
  yield* Fiber.joinAll(fibers)
  return info
})

const info = await Effect.runPromise(Effect.provide(program, SqliteClient.layer({ filename: file })))
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]! }
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 0.5).toFixed(2)} p95=${pct(xs, 0.95).toFixed(2)} p99=${pct(xs, 0.99).toFixed(2)} max=${Math.max(...xs).toFixed(2)}`
const writesPerSec = ((counts.stream + counts.txs * 4 + counts.outbound * 3 + counts.hook) / Number(secs)).toFixed(0)
console.log(`mode=${mode} sync=${sync} secs=${secs} ${JSON.stringify(info)}`)
console.log(`  counts=${JSON.stringify(counts)} approx_writes_per_s=${writesPerSec}`)
console.log(`  hook_ms  ${fmt(hookMs)}`)
console.log(`  hook>50ms=${hookMs.filter((x) => x > 50).length} hook>150ms=${hookMs.filter((x) => x > 150).length}`)
console.log(`  loop_lag_ms ${fmt(lagMs)}`)
