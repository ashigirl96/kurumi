import type { Database } from "bun:sqlite"

export const inboxMigrations = {
  createInbound: `CREATE TABLE inbound_messages (
    id INTEGER PRIMARY KEY,
    platform_message_id TEXT UNIQUE NOT NULL,
    body TEXT NOT NULL,
    turn_id INTEGER NULL REFERENCES turns(id))`,
}

export const receive = (db: Database, platformMessageId: string, body: string) =>
  db.query(`INSERT OR IGNORE INTO inbound_messages (platform_message_id, body) VALUES (?, ?)`).run(platformMessageId, body).changes === 1

export const insertStrict = (db: Database, platformMessageId: string, body: string, turnId: number | null = null) =>
  db.query(`INSERT INTO inbound_messages (platform_message_id, body, turn_id) VALUES (?, ?, ?)`).run(platformMessageId, body, turnId)

export const assignToTurn = (db: Database, platformMessageId: string, turnId: number) =>
  db.query(`UPDATE inbound_messages SET turn_id = ? WHERE platform_message_id = ?`).run(turnId, platformMessageId)
