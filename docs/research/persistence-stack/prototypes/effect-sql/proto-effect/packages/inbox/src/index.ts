import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import CreateInbound from "./migrations/0001_create_inbound_messages.ts"

export const inboxMigrations = { "0001_create_inbound_messages": CreateInbound }

export const receive = (platformMessageId: string, body: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`INSERT OR IGNORE INTO inbound_messages (platform_message_id, body) VALUES (${platformMessageId}, ${body}) RETURNING id`
    return rows.length === 1
  })

export const insertStrict = (platformMessageId: string, body: string, turnId: number | null = null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO inbound_messages (platform_message_id, body, turn_id) VALUES (${platformMessageId}, ${body}, ${turnId})`
  })

export const assignToTurn = (platformMessageId: string, turnId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE inbound_messages SET turn_id = ${turnId} WHERE platform_message_id = ${platformMessageId}`
  })
