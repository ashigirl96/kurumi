import { and, defineRelations, eq, inArray, isNull } from 'drizzle-orm'
import * as Drizzle from 'drizzle-orm/effect-sqlite-bun'
import { Context, Data, Effect, Layer } from 'effect'

import * as schema from './schema.ts'
import {
  type InboundMessageId,
  type TurnId,
  type TurnState,
  inboundMessages,
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

export const saveInbound = (message: NewInboundMessage) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    const stored = yield* db
      .insert(inboundMessages)
      .values(message)
      .onConflictDoNothing()
      .returning({ id: inboundMessages.id })
    return stored.length > 0
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

export const transitionTurn = <From extends TurnState>(
  turnId: TurnId,
  from: From,
  to: (typeof turnTransitions)[From][number],
) =>
  Effect.gen(function* () {
    if (!(turnTransitions[from] as readonly TurnState[]).includes(to)) return false
    const db = yield* AgentRuntimeDb
    const moved = yield* db
      .update(turns)
      .set({ state: to })
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
