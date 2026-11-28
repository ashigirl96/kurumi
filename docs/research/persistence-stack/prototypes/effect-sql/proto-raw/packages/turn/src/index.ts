import type { Database } from "bun:sqlite"

export const turnMigrations = {
  createTurns: `CREATE TABLE turns (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','closing','completed','failed','interrupted')))`,
  addPromptUuid: `ALTER TABLE turns ADD COLUMN prompt_uuid TEXT`,
}

export const createTurn = (db: Database, sessionId: string) =>
  db.query<{ id: number }, [string]>(`INSERT INTO turns (session_id, state) VALUES (?, 'queued') RETURNING id`).get(sessionId)!.id
