import { describe, expect, test } from 'bun:test'

import { turns } from '@kurumi/agent-runtime/schema'
import { AgentRuntimeDb, saveInbound } from '@kurumi/agent-runtime/store'
import { Effect, Exit, Fiber } from 'effect'

import { inMemory, message, newTurn } from './test-support.ts'

const insertTurn = (sessionId: string) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    return yield* db.transaction((tx) => tx.insert(turns).values({ sessionId, state: 'queued' }))
  })

const transactionThatWaits = (sessionId: string) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.insert(turns).values({ sessionId, state: 'queued' })
        yield* Effect.sleep('10 seconds')
      }),
    )
  })

const sessionIds = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return (yield* db.select().from(turns)).map((t) => t.sessionId)
})

const nextWriteGoesThrough = saveInbound(message('after')).pipe(Effect.timeout('1 second'))

describe('concurrent writes', () => {
  test('a failing transaction does not take other fibers writes down with it', async () => {
    const order: string[] = []
    const result = await inMemory(
      Effect.gen(function* () {
        const db = yield* AgentRuntimeDb
        const failing = db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(turns).values({ sessionId: 'A', state: 'queued' })
              yield* Effect.sleep('50 millis')
              return yield* Effect.fail('A fails')
            }),
          )
          .pipe(
            Effect.exit,
            Effect.tap(() => Effect.sync(() => order.push('A'))),
          )
        const plainWrite = Effect.sleep('10 millis').pipe(
          Effect.andThen(saveInbound(message('b'))),
          Effect.tap(() => Effect.sync(() => order.push('B'))),
        )
        const transactionalWrite = Effect.sleep('10 millis').pipe(
          Effect.andThen(newTurn('c')),
          Effect.tap(() => Effect.sync(() => order.push('C'))),
        )
        const [a, b] = yield* Effect.all([failing, plainWrite, transactionalWrite], {
          concurrency: 'unbounded',
        })
        const inbound = (yield* db.query.inboundMessages.findMany()).map((r) => r.platformMessageId)
        return { aFailed: Exit.isFailure(a), b, sessions: yield* sessionIds, inbound }
      }),
    )
    expect(result.aFailed).toBe(true)
    expect(result.b).toBe(true)
    expect(result.sessions).toEqual(['s1'])
    expect(result.inbound.toSorted()).toEqual(['b', 'c'])
    expect(order[0]).toBe('A')
  })
})

describe('interrupting a fiber that holds a transaction', () => {
  test('Fiber.interrupt rolls the writes back and frees the connection', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(transactionThatWaits('A'))
        yield* Effect.sleep('30 millis')
        yield* Fiber.interrupt(fiber)
        return { sessions: yield* sessionIds, next: yield* nextWriteGoesThrough }
      }),
    )
    expect(result).toEqual({ sessions: [], next: true })
  })

  test('Effect.timeout around a transaction rolls the writes back and frees the connection', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Effect.timeout(transactionThatWaits('B'), '100 millis'))
        return {
          timedOut: Exit.isFailure(exit),
          sessions: yield* sessionIds,
          next: yield* nextWriteGoesThrough,
        }
      }),
    )
    expect(result).toEqual({ timedOut: true, sessions: [], next: true })
  })

  test('a transaction interrupted while queued for the connection writes nothing and leaves the holder intact', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        const db = yield* AgentRuntimeDb
        const holder = yield* Effect.forkChild(
          db.transaction((tx) =>
            tx
              .insert(turns)
              .values({ sessionId: 'holder', state: 'queued' })
              .pipe(Effect.andThen(Effect.sleep('100 millis'))),
          ),
        )
        yield* Effect.sleep('10 millis')
        const queued = yield* Effect.forkChild(insertTurn('queued'))
        yield* Effect.sleep('10 millis')
        yield* Fiber.interrupt(queued)
        yield* Fiber.join(holder)
        return { sessions: yield* sessionIds, next: yield* nextWriteGoesThrough }
      }),
    )
    expect(result).toEqual({ sessions: ['holder'], next: true })
  })

  test('200 interruptions in a row leave no rows and no stuck connection', async () => {
    const result = await inMemory(
      Effect.gen(function* () {
        for (let i = 0; i < 200; i++) {
          const fiber = yield* Effect.forkChild(transactionThatWaits(`F-${i}`))
          yield* Effect.sleep('1 millis')
          yield* Fiber.interrupt(fiber)
        }
        return { sessions: yield* sessionIds, next: yield* nextWriteGoesThrough }
      }),
    )
    expect(result).toEqual({ sessions: [], next: true })
  })
})
