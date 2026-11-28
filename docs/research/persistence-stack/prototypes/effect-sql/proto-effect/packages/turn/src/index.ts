import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import CreateTurns from "./migrations/0001_create_turns.ts"
import AddPromptUuid from "./migrations/0002_turns_add_prompt_uuid.ts"

export const turnMigrationsV1 = { "0001_create_turns": CreateTurns }
export const turnMigrations = { ...turnMigrationsV1, "0002_turns_add_prompt_uuid": AddPromptUuid }

export const createTurn = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ id: number }>`INSERT INTO turns (session_id, state) VALUES (${sessionId}, 'queued') RETURNING id`
    return row!.id
  })
