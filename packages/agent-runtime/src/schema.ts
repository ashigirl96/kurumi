import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { Brand } from 'effect'

export type TurnId = number & Brand.Brand<'TurnId'>
export const TurnId = Brand.nominal<TurnId>()
export type InboundMessageId = number & Brand.Brand<'InboundMessageId'>
export const InboundMessageId = Brand.nominal<InboundMessageId>()

export const turnStates = [
  'queued',
  'running',
  'closing',
  'completed',
  'failed',
  'interrupted',
] as const
export const inboundOutcomes = ['answered', 'interrupted', 'failed'] as const
export const outboundKinds = ['final', 'progress', 'notice'] as const
export const outboundStates = ['pending', 'sending', 'delivered'] as const
export const sessionStatuses = ['active', 'lost'] as const

export type TurnState = (typeof turnStates)[number]

const oneOf = (name: string, column: AnySQLiteColumn, values: readonly string[]) =>
  check(name, sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(','))})`)

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' })

export const turns = sqliteTable(
  'turns',
  {
    id: integer().$type<TurnId>().primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    state: text({ enum: turnStates }).notNull(),
    startedAt: timestamp('started_at'),
    endedAt: timestamp('ended_at'),
    endReason: text('end_reason'),
    promptUuid: text('prompt_uuid'),
    lastAssistantUuid: text('last_assistant_uuid'),
  },
  (t) => [oneOf('turns_state_check', t.state, turnStates)],
)

export const inboundMessages = sqliteTable(
  'inbound_messages',
  {
    id: integer().$type<InboundMessageId>().primaryKey({ autoIncrement: true }),
    channel: text().notNull(),
    conversation: text().notNull(),
    platformMessageId: text('platform_message_id').notNull(),
    sender: text().notNull(),
    body: text().notNull(),
    receivedAt: timestamp('received_at').notNull(),
    turnId: integer('turn_id')
      .$type<TurnId>()
      .references(() => turns.id),
    answeredAt: timestamp('answered_at'),
    outcome: text({ enum: inboundOutcomes }),
  },
  (t) => [
    unique().on(t.channel, t.platformMessageId),
    oneOf('inbound_messages_outcome_check', t.outcome, inboundOutcomes),
  ],
)

export const toolCalls = sqliteTable('tool_calls', {
  toolUseId: text('tool_use_id').primaryKey(),
  turnId: integer('turn_id')
    .$type<TurnId>()
    .notNull()
    .references(() => turns.id),
  toolName: text('tool_name').notNull(),
  inputSummary: text('input_summary').notNull(),
  startedAt: timestamp('started_at').notNull(),
})

export const outboundMessages = sqliteTable(
  'outbound_messages',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    turnId: integer('turn_id').$type<TurnId>(),
    kind: text({ enum: outboundKinds }).notNull(),
    body: text().notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    state: text({ enum: outboundStates }).notNull(),
  },
  (t) => [
    oneOf('outbound_messages_kind_check', t.kind, outboundKinds),
    oneOf('outbound_messages_state_check', t.state, outboundStates),
  ],
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey(),
    channel: text().notNull(),
    conversation: text().notNull(),
    agent: text().notNull(),
    claudeSessionId: text('claude_session_id'),
    configDir: text('config_dir').notNull(),
    workspaceDir: text('workspace_dir').notNull(),
    status: text({ enum: sessionStatuses }).notNull(),
  },
  (t) => [
    oneOf('sessions_status_check', t.status, sessionStatuses),
    uniqueIndex('sessions_active_channel_conversation')
      .on(t.channel, t.conversation)
      .where(sql`${t.status} = 'active'`),
  ],
)
