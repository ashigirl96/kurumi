import { type TurnId, inboundMessages, turns } from '@kurumi/agent-runtime/schema'
import {
  AgentRuntimeDb,
  type NewInboundMessage,
  createTurn,
  saveInbound,
  transitionTurn,
} from '@kurumi/agent-runtime/store'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

import { dbLayer } from './db.ts'

export const inMemory = <A, E>(effect: Effect.Effect<A, E, AgentRuntimeDb | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(dbLayer(':memory:'))))

export const message = (platformMessageId: string, channel = 'slack'): NewInboundMessage => ({
  channel,
  conversation: 'c1',
  platformMessageId,
  sender: 'u1',
  body: 'hello',
  receivedAt: new Date(0),
})

export const inboundIdOf = (platformMessageId: string) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    const rows = yield* db.select().from(inboundMessages)
    return rows.find((r) => r.platformMessageId === platformMessageId)!.id
  })

export const turnState = (id: TurnId) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    return (yield* db.select().from(turns)).find((t) => t.id === id)?.state
  })

export const newTurn = (first: string, ...rest: string[]) =>
  Effect.gen(function* () {
    for (const p of [first, ...rest]) yield* saveInbound(message(p))
    const inboundIds = yield* Effect.all([inboundIdOf(first), ...rest.map(inboundIdOf)])
    return yield* createTurn({ sessionId: 's1', inboundIds })
  })

export const advance = (id: TurnId) =>
  Effect.gen(function* () {
    yield* transitionTurn(id, 'queued', 'running')
    yield* transitionTurn(id, 'running', 'closing')
  })
