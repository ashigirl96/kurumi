import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// The FK to turns is a string in SQL; no import of @kurumi/turn is needed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE inbound_messages (
    id INTEGER PRIMARY KEY,
    platform_message_id TEXT UNIQUE NOT NULL,
    body TEXT NOT NULL,
    turn_id INTEGER NULL REFERENCES turns(id)
  )`
})
