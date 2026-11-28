import { Database } from "bun:sqlite"
import { inboxMigrations } from "@kurumi/inbox"
import { turnMigrations } from "@kurumi/turn"

// Append-only, global order across domains; index+1 is the schema version stored in PRAGMA user_version.
export const migrationsV1 = [turnMigrations.createTurns, inboxMigrations.createInbound]
export const migrations = [...migrationsV1, turnMigrations.addPromptUuid]

export const migrate = (db: Database, list: string[] = migrations) => {
  const applied: number[] = []
  db.transaction(() => {
    const current = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
    for (let v = current; v < list.length; v++) { db.run(list[v]!); applied.push(v + 1) }
    db.run(`PRAGMA user_version = ${list.length}`)
  }).immediate()
  return applied
}

export const open = (filename: string) => {
  const db = new Database(filename, { strict: true, create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA foreign_keys = ON")
  return db
}
