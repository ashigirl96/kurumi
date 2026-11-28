import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const turnStates = ["queued", "running", "closing", "completed", "failed", "interrupted"] as const;

export const turns = sqliteTable(
  "turns",
  {
    id: integer().primaryKey(),
    sessionId: text("session_id").notNull(),
    state: text({ enum: turnStates }).notNull(),
    promptUuid: text("prompt_uuid"),
  },
  (t) => [check("turns_state_check", sql`${t.state} in ('queued','running','closing','completed','failed','interrupted')`)],
);
