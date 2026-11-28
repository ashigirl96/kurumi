import { and, asc, defineRelations, eq, exists, inArray, isNull } from 'drizzle-orm'
import * as Drizzle from 'drizzle-orm/effect-sqlite-bun'
import { Context, Data, Effect, Layer } from 'effect'

import * as schema from './schema.ts'
import {
  type InboundMessageId,
  type TurnId,
  type TurnState,
  inboundMessages,
  outboundMessages,
  sessions,
  toolCalls,
  turns,
} from './schema.ts'

const relations = defineRelations(schema)

export class AgentRuntimeDb extends Context.Service<
  AgentRuntimeDb,
  Effect.Success<ReturnType<typeof Drizzle.makeWithDefaults<typeof relations>>>
>()('@kurumi/agent-runtime/AgentRuntimeDb') {
  static readonly layer = Layer.effect(AgentRuntimeDb, Drizzle.makeWithDefaults({ relations }))
}

export class InboundNotAssignable extends Data.TaggedError('InboundNotAssignable')<{
  readonly requested: number
  readonly assigned: number
}> {}

export const turnTransitions = {
  queued: ['running', 'interrupted'],
  running: ['closing', 'failed', 'interrupted'],
  closing: ['completed', 'interrupted'],
  completed: [],
  failed: [],
  interrupted: [],
} as const satisfies Record<TurnState, readonly TurnState[]>

export type NewInboundMessage = Pick<
  typeof inboundMessages.$inferInsert,
  'channel' | 'conversation' | 'platformMessageId' | 'sender' | 'body' | 'receivedAt'
>

export type NewToolCall = Pick<
  typeof toolCalls.$inferInsert,
  'toolUseId' | 'turnId' | 'toolName' | 'inputSummary'
>

/** 新しく書けたときだけ、その行を返す */
export const storeInbound = (message: NewInboundMessage) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    const stored = yield* db
      .insert(inboundMessages)
      .values(message)
      .onConflictDoNothing()
      .returning()
    return stored[0]
  })

export const saveInbound = (message: NewInboundMessage) =>
  Effect.map(storeInbound(message), (row) => row !== undefined)

/** 動いている（running の）ターンにだけ、まだ誰にも割り当てられていない受信を割り当てる。ターンが閉じ始めた後の割り当てで受信が宙に浮かないようにする。 */
export const assignInboundToRunningTurn = (inboundId: InboundMessageId, turnId: TurnId) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    const assigned = yield* db
      .update(inboundMessages)
      .set({ turnId })
      .where(
        and(
          eq(inboundMessages.id, inboundId),
          isNull(inboundMessages.turnId),
          isNull(inboundMessages.outcome),
          exists(
            db
              .select({ id: turns.id })
              .from(turns)
              .where(and(eq(turns.id, turnId), eq(turns.state, 'running'))),
          ),
        ),
      )
      .returning({ id: inboundMessages.id })
    return assigned.length === 1
  })

export const interruptUnassignedInbound = (channel: string, conversation: string) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    yield* db
      .update(inboundMessages)
      .set({ outcome: 'interrupted' })
      .where(
        and(
          eq(inboundMessages.channel, channel),
          eq(inboundMessages.conversation, conversation),
          isNull(inboundMessages.turnId),
          isNull(inboundMessages.outcome),
        ),
      )
  })

export const createTurn = (input: {
  readonly sessionId: string
  readonly inboundIds: readonly [InboundMessageId, ...InboundMessageId[]]
}) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const [turn] = yield* tx
          .insert(turns)
          .values({ sessionId: input.sessionId, state: 'queued' })
          .returning({ id: turns.id })
        const assigned = yield* tx
          .update(inboundMessages)
          .set({ turnId: turn!.id })
          .where(
            and(inArray(inboundMessages.id, [...input.inboundIds]), isNull(inboundMessages.turnId)),
          )
          .returning({ id: inboundMessages.id })
        if (assigned.length !== input.inboundIds.length) {
          return yield* new InboundNotAssignable({
            requested: input.inboundIds.length,
            assigned: assigned.length,
          })
        }
        return turn!.id
      }),
    )
  })

type TurnTarget<From extends TurnState> = From extends TurnState
  ? (typeof turnTransitions)[From][number]
  : never

export const transitionTurn = <From extends TurnState>(
  turnId: TurnId,
  from: From,
  to: TurnTarget<From>,
  fields: Partial<Pick<typeof turns.$inferInsert, 'startedAt' | 'promptUuid'>> = {},
) =>
  Effect.gen(function* () {
    if (!(turnTransitions[from] as readonly TurnState[]).includes(to)) return false
    const db = yield* AgentRuntimeDb
    const moved = yield* db
      .update(turns)
      .set({ ...fields, state: to })
      .where(and(eq(turns.id, turnId), eq(turns.state, from)))
      .returning({ id: turns.id })
    return moved.length === 1
  })

export const recordToolCall = (call: NewToolCall) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    yield* db.insert(toolCalls).values({ ...call, startedAt: new Date() })
  })

export const listInFlightTurns = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db
    .select()
    .from(turns)
    .where(inArray(turns.state, ['running', 'closing']))
})

export type SessionRow = typeof sessions.$inferSelect
export type InboundRow = typeof inboundMessages.$inferSelect
export type DbError = Effect.Error<ReturnType<typeof closeTurn>>
export type StoreError = DbError | InboundNotAssignable

export const findSession = (channel: string, conversation: string) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    // 'active' は 'lost' より辞書順で先にくる
    const [row] = yield* db
      .select()
      .from(sessions)
      .where(and(eq(sessions.channel, channel), eq(sessions.conversation, conversation)))
      .orderBy(asc(sessions.status))
      .limit(1)
    return row
  })

export const getSession = (id: string) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    const [row] = yield* db.select().from(sessions).where(eq(sessions.id, id))
    return row
  })

export const insertSession = (session: typeof sessions.$inferInsert) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    yield* db.insert(sessions).values(session).onConflictDoNothing()
  })

export const setClaudeSessionId = (sessionId: string, claudeSessionId: string) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    yield* db
      .update(sessions)
      .set({ claudeSessionId })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.claudeSessionId)))
  })

export const listUnassignedInbound = (channel: string, conversation: string) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    return yield* db
      .select()
      .from(inboundMessages)
      .where(
        and(
          eq(inboundMessages.channel, channel),
          eq(inboundMessages.conversation, conversation),
          isNull(inboundMessages.turnId),
          isNull(inboundMessages.outcome),
        ),
      )
      .orderBy(asc(inboundMessages.id))
  })

export type NewOutbound = Pick<
  typeof outboundMessages.$inferInsert,
  'sessionId' | 'turnId' | 'kind' | 'body' | 'idempotencyKey'
>

export const insertOutbound = (message: NewOutbound) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    const stored = yield* db
      .insert(outboundMessages)
      .values({ ...message, state: 'pending' })
      .onConflictDoNothing()
      .returning({ id: outboundMessages.id })
    return stored.length > 0
  })

export type TurnClosing = {
  readonly turnId: TurnId
  readonly sessionId: string
  readonly from: readonly ('running' | 'closing')[]
  readonly to: 'completed' | 'failed' | 'interrupted'
  readonly endReason: string | null
  readonly lastAssistantUuid: string | null
  readonly inboundOutcome: 'answered' | 'failed' | 'interrupted'
  readonly notice: { readonly idempotencyKey: string; readonly body: string } | null
}

export const closeTurn = (closing: TurnClosing) =>
  Effect.gen(function* () {
    if (
      !closing.from.every((from) =>
        (turnTransitions[from] as readonly TurnState[]).includes(closing.to),
      )
    )
      return false
    const db = yield* AgentRuntimeDb
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const now = new Date()
        const moved = yield* tx
          .update(turns)
          .set({
            state: closing.to,
            endedAt: now,
            endReason: closing.endReason,
            lastAssistantUuid: closing.lastAssistantUuid,
          })
          .where(and(eq(turns.id, closing.turnId), inArray(turns.state, [...closing.from])))
          .returning({ id: turns.id })
        if (moved.length === 0) return false
        yield* tx
          .update(inboundMessages)
          .set({
            outcome: closing.inboundOutcome,
            answeredAt: closing.inboundOutcome === 'answered' ? now : null,
          })
          .where(eq(inboundMessages.turnId, closing.turnId))
        if (closing.notice) {
          yield* tx
            .insert(outboundMessages)
            .values({
              sessionId: closing.sessionId,
              turnId: closing.turnId,
              kind: 'notice',
              body: closing.notice.body,
              idempotencyKey: closing.notice.idempotencyKey,
              state: 'pending',
            })
            .onConflictDoNothing()
        }
        return true
      }),
    )
  })

export const claimNextOutbound = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  const [next] = yield* db
    .select({
      id: outboundMessages.id,
      channel: sessions.channel,
      conversation: sessions.conversation,
      sessionId: outboundMessages.sessionId,
      turnId: outboundMessages.turnId,
      kind: outboundMessages.kind,
      body: outboundMessages.body,
    })
    .from(outboundMessages)
    .innerJoin(sessions, eq(sessions.id, outboundMessages.sessionId))
    .where(eq(outboundMessages.state, 'pending'))
    .orderBy(asc(outboundMessages.id))
    .limit(1)
  if (!next) return undefined
  const claimed = yield* db
    .update(outboundMessages)
    .set({ state: 'sending' })
    .where(and(eq(outboundMessages.id, next.id), eq(outboundMessages.state, 'pending')))
    .returning({ id: outboundMessages.id })
  return claimed.length === 1 ? next : undefined
})

const moveOutbound = (id: number, from: 'sending', to: 'delivered' | 'pending') =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    yield* db
      .update(outboundMessages)
      .set({ state: to })
      .where(and(eq(outboundMessages.id, id), eq(outboundMessages.state, from)))
  })

export const markDelivered = (id: number) => moveOutbound(id, 'sending', 'delivered')

export const releaseOutbound = (id: number) => moveOutbound(id, 'sending', 'pending')
