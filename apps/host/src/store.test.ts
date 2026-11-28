import { describe, expect, test } from 'bun:test'

import { InboundMessageId, TurnId, inboundMessages, turns } from '@kurumi/agent-runtime/schema'
import {
  AgentRuntimeDb,
  createTurn,
  listInFlightTurns,
  recordToolCall,
  saveInbound,
  transitionTurn,
} from '@kurumi/agent-runtime/store'
import { Effect } from 'effect'
import { SqlClient } from 'effect/sql'

import { advance, inMemory, inboundIdOf, message, newTurn, turnState } from './test-support.ts'

const call = (turnId: TurnId, toolUseId = 'tu1') => ({
  toolUseId,
  turnId,
  toolName: 'Bash',
  inputSummary: 'ls',
})

describe('saveInbound', () => {
  test('storing the same message twice keeps one record and reports the second as not new', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const first = yield* saveInbound(message('m1'))
        const second = yield* saveInbound(message('m1'))
        const db = yield* AgentRuntimeDb
        return { first, second, rows: (yield* db.select().from(inboundMessages)).length }
      }),
    )
    expect(result).toEqual({ first: true, second: false, rows: 1 })
  })

  test('the same platform message id on another channel is a new message', async () => {
    const result = await inMemory(
      Effect.all([saveInbound(message('m1', 'slack')), saveInbound(message('m1', 'discord'))]),
    )
    expect(result).toEqual([true, true])
  })
})

describe('createTurn', () => {
  test('creates a queued turn and assigns the messages to it', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const id = yield* newTurn('a', 'b')
        const db = yield* AgentRuntimeDb
        const rows = yield* db.select().from(inboundMessages)
        return { state: yield* turnState(id), assigned: rows.map((r) => r.turnId === id) }
      }),
    )
    expect(result).toEqual({ state: 'queued', assigned: [true, true] })
  })

  test('a failed assignment leaves no turn and no assignment', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const first = yield* newTurn('a')
        yield* saveInbound(message('b'))
        const [a, b] = yield* Effect.all([inboundIdOf('a'), inboundIdOf('b')])
        const failure = yield* Effect.flip(createTurn({ sessionId: 's2', inboundIds: [a, b] }))
        const db = yield* AgentRuntimeDb
        const rows = yield* db.select().from(inboundMessages)
        return {
          tag: failure._tag,
          turns: (yield* db.select().from(turns)).map((t) => t.id),
          first,
          turnIds: rows.map((r) => r.turnId),
        }
      }),
    )
    expect(result.tag).toBe('InboundNotAssignable')
    expect(result.turns).toEqual([result.first])
    expect(result.turnIds).toEqual([result.first, null])
  })

  test('an unknown message id fails without leaving a turn', async () => {
    const turnCount = await inMemory(
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          createTurn({ sessionId: 's', inboundIds: [InboundMessageId(999)] }),
        )
        expect(failure._tag).toBe('InboundNotAssignable')
        const db = yield* AgentRuntimeDb
        return (yield* db.select().from(turns)).length
      }),
    )
    expect(turnCount).toBe(0)
  })
})

describe('transitionTurn', () => {
  test('moves a turn along the table', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const id = yield* newTurn('a')
        const moved = yield* transitionTurn(id, 'queued', 'running')
        return { moved, state: yield* turnState(id) }
      }),
    )
    expect(result).toEqual({ moved: true, state: 'running' })
  })

  test('a pair outside the table reports no transition and changes nothing', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const id = yield* newTurn('a')
        yield* advance(id)
        yield* transitionTurn(id, 'closing', 'completed')
        // @ts-expect-error completed has no way out; the type forbids this pair
        const moved = yield* transitionTurn(id, 'completed', 'running')
        return { moved, state: yield* turnState(id) }
      }),
    )
    expect(result).toEqual({ moved: false, state: 'completed' })
  })

  test('a transition from a state the turn is not in reports no transition', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const id = yield* newTurn('a')
        const moved = yield* transitionTurn(id, 'running', 'closing')
        return { moved, state: yield* turnState(id) }
      }),
    )
    expect(result).toEqual({ moved: false, state: 'queued' })
  })

  test('calling the same transition twice moves the turn only the first time', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const id = yield* newTurn('a')
        return yield* Effect.all([
          transitionTurn(id, 'queued', 'running'),
          transitionTurn(id, 'queued', 'running'),
        ])
      }),
    )
    expect(result).toEqual([true, false])
  })

  test('a state outside the known set cannot be stored', async () => {
    const failure = await inMemory(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* Effect.flip(sql`INSERT INTO turns (session_id, state) VALUES ('s', 'bogus')`)
      }),
    )
    expect(failure.reason._tag).toBe('ConstraintError')
  })
})

describe('recordToolCall', () => {
  test('recording the same tool_use_id twice fails the second time with a typed error', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const id = yield* newTurn('a')
        yield* recordToolCall(call(id))
        return yield* Effect.flip(recordToolCall(call(id)))
      }),
    )
    expect(result._tag).toBe('EffectDrizzleQueryError')
  })

  test('a call for a turn that does not exist is refused', async () => {
    const result = await inMemory(Effect.flip(recordToolCall(call(TurnId(999)))))
    expect(result._tag).toBe('EffectDrizzleQueryError')
  })
})

describe('listInFlightTurns', () => {
  test('lists only running and closing turns', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const [, running, closing, completed, interrupted] = yield* Effect.all(
          ['q', 'r', 'cl', 'co', 'i'].map((p) => newTurn(p)),
        )
        yield* transitionTurn(running!, 'queued', 'running')
        yield* advance(closing!)
        yield* advance(completed!)
        yield* transitionTurn(completed!, 'closing', 'completed')
        yield* transitionTurn(interrupted!, 'queued', 'interrupted')
        const inFlight = yield* listInFlightTurns
        return { ids: inFlight.map((t) => t.id).toSorted((a, b) => a - b), running, closing }
      }),
    )
    expect(result.ids).toEqual([result.running!, result.closing!])
  })
})
