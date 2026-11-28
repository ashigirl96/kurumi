import { Database } from "bun:sqlite"
import { assignToTurn, insertStrict, receive } from "@kurumi/inbox"
import { createTurn } from "@kurumi/turn"
import { rmSync } from "node:fs"
import { migrate, migrations, migrationsV1, open } from "./db.ts"

const file = `${import.meta.dir}/../kurumi.sqlite`
for (const s of ["", "-wal", "-shm"]) rmSync(file + s, { force: true })
const log = console.log
const t0 = performance.now()
const ts = () => `${(performance.now() - t0).toFixed(0)}ms`.padStart(6)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

log("== 1 migrations")
{
  const db = open(file)
  log("run#1 (v1):", JSON.stringify(migrate(db, migrationsV1)))
  log("run#2 (v1 again):", JSON.stringify(migrate(db, migrationsV1)))
  log("run#3 (v2 adds turns.prompt_uuid):", JSON.stringify(migrate(db, migrations)))
  log("turns columns:", db.query<{ name: string }, []>("PRAGMA table_info(turns)").all().map((r) => r.name).join(","))
  log("user_version:", db.query("PRAGMA user_version").get(), "journal_mode:", db.query("PRAGMA journal_mode").get(), "foreign_keys:", db.query("PRAGMA foreign_keys").get())
  db.close()
}
const db = open(file); migrate(db)
const count = (where = "1=1") => db.query<{ n: number }, []>(`SELECT count(*) n FROM inbound_messages WHERE ${where}`).get()!.n

log("== 2 idempotent receipt")
log(`first inserted=${receive(db, "P-1", "hi")} second inserted=${receive(db, "P-1", "again")} rows=${count("platform_message_id='P-1'")}`)

log("== 3 cross-domain transaction (sync db.transaction)")
receive(db, "P-2", "a"); receive(db, "P-3", "b"); receive(db, "P-4", "c")
const start = db.transaction((sessionId: string, ids: string[], failAfterFirst: boolean) => {
  const turnId = createTurn(db, sessionId)
  for (const id of ids) { assignToTurn(db, id, turnId); if (failAfterFirst) throw new Error("boom after first assignment") }
  return turnId
})
const tid = start("s1", ["P-2", "P-3"], false)
log(`commit: turn=${tid} assigned=${count(`turn_id=${tid}`)}`)
const turnsBefore = db.query<{ n: number }, []>("SELECT count(*) n FROM turns").get()!.n
try { start("s2", ["P-4"], true) } catch (e) { log("threw:", (e as Error).message) }
log(`rollback: turns ${turnsBefore}->${db.query<{ n: number }, []>("SELECT count(*) n FROM turns").get()!.n} P-4 assigned=${count("platform_message_id='P-4' AND turn_id IS NOT NULL")}`)

log("== 4a async callback inside db.transaction()")
{
  const tx = db.transaction(async () => {
    insertStrict(db, "AS-1", "before await")
    await sleep(20)
    log(ts(), "after await, inTransaction =", db.inTransaction)
    insertStrict(db, "AS-2", "after await")
    throw new Error("fail after await")
  })
  const p = tx(); log(ts(), "tx() returned; inTransaction =", db.inTransaction)
  await p.catch((e: Error) => log(ts(), "promise rejected:", e.message))
  log(`rows AS-1=${count("platform_message_id='AS-1'")} AS-2=${count("platform_message_id='AS-2'")} (both survive: nothing rolled back)`)
}

log("== 4b hand-rolled async BEGIN/COMMIT, no lock")
{
  const A = (async () => {
    try {
      db.run("BEGIN IMMEDIATE"); log(ts(), "A BEGIN"); insertStrict(db, "A-1", "a1"); log(ts(), "A inserted A-1, sleeping 50ms")
      await sleep(50)
      insertStrict(db, "A-2", "a2"); log(ts(), "A inserted A-2, failing")
      throw new Error("A fails")
    } catch (e) { db.run("ROLLBACK"); log(ts(), "A ROLLBACK:", (e as Error).message) }
  })()
  const B = (async () => {
    await sleep(10)
    try { db.run("BEGIN IMMEDIATE"); insertStrict(db, "B-1", "b1"); db.run("COMMIT"); log(ts(), "B committed") }
    catch (e) { log(ts(), "B BEGIN failed:", (e as Error).message) }
  })()
  const C = (async () => {
    await sleep(20)
    insertStrict(db, "C-1", "c1"); log(ts(), "C plain insert done (no tx); db.inTransaction =", db.inTransaction)
  })()
  await Promise.all([A, B, C])
  log(`rows A-*=${count("platform_message_id LIKE 'A-%'")} B-1=${count("platform_message_id='B-1'")} C-1=${count("platform_message_id='C-1'")} (C-1 joined A's tx and was rolled back with it)`)
}

log("== 4c hand-rolled async BEGIN/COMMIT behind a promise mutex (every write goes through it)")
{
  let tail: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(f: () => Promise<T> | T): Promise<T> => { const r = tail.then(f); tail = r.catch(() => {}); return r }
  const tx = <T>(f: () => Promise<T>) => exclusive(async () => {
    db.run("BEGIN IMMEDIATE")
    try { const r = await f(); db.run("COMMIT"); return r } catch (e) { db.run("ROLLBACK"); throw e }
  })
  const t1 = performance.now()
  const A = tx(async () => {
    log(ts(), "A begin"); insertStrict(db, "MA-1", "a1"); await sleep(50); insertStrict(db, "MA-2", "a2"); log(ts(), "A failing"); throw new Error("A fails")
  }).catch((e) => log(ts(), "A rolled back:", e.message))
  const B = sleep(10).then(() => { log(ts(), "B requested"); return tx(async () => { insertStrict(db, "MB-1", "b1"); log(ts(), "B committed") }) })
  const C = sleep(20).then(() => { log(ts(), "C requested"); return exclusive(() => { insertStrict(db, "MC-1", "c1"); log(ts(), "C done") }) })
  await Promise.all([A, B, C])
  log(`rows MA-*=${count("platform_message_id LIKE 'MA-%'")} MB-1=${count("platform_message_id='MB-1'")} MC-1=${count("platform_message_id='MC-1'")} (${(performance.now() - t1).toFixed(0)}ms)`)
}

log("== 5 FK enforcement")
try { insertStrict(db, "FK-1", "x", 9999); log("with foreign_keys=ON: ACCEPTED") } catch { log("with foreign_keys=ON: rejected") }
{
  const plain = new Database(":memory:"); migrate(plain)
  try { insertStrict(plain, "FK-2", "x", 9999); log("defaults (no pragma): ACCEPTED, foreign_keys =", JSON.stringify(plain.query("PRAGMA foreign_keys").get())) } catch { log("defaults: rejected") }
}

log("== 7 error shape")
const show = (f: () => unknown) => { try { f(); return "no error" } catch (e: any) { return JSON.stringify({ ctor: e?.constructor?.name, name: e?.name, message: e?.message, code: e?.code, errno: e?.errno, byteOffset: e?.byteOffset }) } }
log("unique:", show(() => insertStrict(db, "P-1", "dup")))
log("fk:", show(() => insertStrict(db, "FK-3", "x", 9999)))
log("check:", show(() => db.run("INSERT INTO turns (session_id, state) VALUES ('s','bogus')")))
log("missing named param under strict:", show(() => db.query("SELECT $a AS a").get({})))
