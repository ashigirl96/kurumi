import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const turns = sqliteTable('turns', {
  id: integer().primaryKey(),
  sessionId: text('session_id').notNull(),
})

export const inboundMessages = sqliteTable('inbound_messages', {
  id: integer().primaryKey(),
  turnId: integer('turn_id').references(() => turns.id),
})
