import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Exit, Layer } from 'effect'
import { SqlClient } from 'effect/sql'

import {
  type InboundInput,
  type OutboundToDeliver,
  Runtime,
  type RuntimeConfig,
} from './runtime.ts'
import { inboundMessages, outboundMessages, turns } from './schema.ts'
import { AgentRuntimeDb } from './store.ts'
import { testDbLayer } from './testing/db.ts'
import type { Script } from './testing/fake-cli.ts'
import { type FakeSandbox, fakeSandbox } from './testing/fake-sandbox.ts'

const sandboxes: FakeSandbox[] = []

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) {
    for (const spawned of sandbox.spawns) await Effect.runPromise(sandbox.dispose(spawned.turn))
  }
})

const say = (text: string): Script => ({ first: { steps: [{ kind: 'say', text }] } })

const parked = (name = 'hold'): Script => ({
  first: {
    steps: [
      { kind: 'park', name },
      { kind: 'say', text: 'done' },
    ],
  },
})

type Harness = ReturnType<typeof harness>

const harness = (
  scriptFor: (n: number) => Script,
  overrides: Partial<RuntimeConfig> & { deliver?: RuntimeConfig['channels'][string] } = {},
) => {
  const sandbox = fakeSandbox(scriptFor)
  sandboxes.push(sandbox)
  const delivered: OutboundToDeliver[] = []
  const { deliver, ...rest } = overrides
  const config: RuntimeConfig = {
    dataDir: mkdtempSync(join(tmpdir(), 'kurumi-runtime-')),
    agent: 'test-agent',
    sandbox,
    channels: {
      chat:
        deliver ??
        ((m) =>
          Effect.sync(() => {
            delivered.push(m)
          })),
    },
    onApprovalRequest: () => Effect.void,
    ...rest,
  }
  return { sandbox, delivered, config }
}

const run = <A, E>(
  h: Harness,
  body: Effect.Effect<A, E, Runtime | AgentRuntimeDb | SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    body.pipe(Effect.provide(Runtime.layer(h.config).pipe(Layer.provideMerge(testDbLayer)))),
  )

let sequence = 0
const inbound = (body: string, overrides: Partial<InboundInput> = {}): InboundInput => ({
  channel: 'chat',
  conversation: 'c1',
  platformMessageId: `m${++sequence}`,
  sender: 'user',
  body,
  receivedAt: new Date(),
  ...overrides,
})

const eventually = (what: string, check: Effect.Effect<boolean, unknown, AgentRuntimeDb>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      if (yield* check) return
      yield* Effect.sleep('10 millis')
    }
    yield* Effect.die(new Error(`timed out: ${what}`))
  })

const allTurns = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db.select().from(turns)
})

const allInbound = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db.select().from(inboundMessages)
})

const allOutbound = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db.select().from(outboundMessages)
})

const turnsEnded = (count: number) =>
  Effect.map(
    allTurns,
    (rows) => rows.length === count && rows.every((t) => t.state === 'completed'),
  )

describe('Runtime', () => {
  test('1 つの受信が 1 つのターンになり、最後の文が 1 回だけ届く', async () => {
    const h = harness(() => say('こんにちは'))
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        expect(yield* runtime.receive(inbound('やあ'))).toBe('stored')
        yield* eventually('turn completed', turnsEnded(1))
        yield* eventually(
          'delivered',
          Effect.map(allOutbound, (rows) => rows.length === 1 && rows[0]?.state === 'delivered'),
        )
        expect((yield* allInbound).map((m) => m.outcome)).toEqual(['answered'])
        expect((yield* allInbound)[0]?.answeredAt).toBeInstanceOf(Date)
      }),
    )
    expect(h.delivered.map((m) => [m.kind, m.body, m.channel, m.conversation])).toEqual([
      ['final', 'こんにちは', 'chat', 'c1'],
    ])
    expect(h.sandbox.spawns).toHaveLength(1)
    expect(h.sandbox.alive()).toBe(0)
  })
  test('同じ platform_message_id の 2 度目は duplicate で、ターンに渡る受信は 1 つ', async () => {
    const h = harness(() => say('一度だけ'))
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        const message = inbound('同じ')
        expect(yield* runtime.receive(message)).toBe('stored')
        expect(yield* runtime.receive(message)).toBe('duplicate')
        yield* eventually('turn completed', turnsEnded(1))
        expect(yield* allInbound).toHaveLength(1)
        expect(yield* allTurns).toHaveLength(1)
      }),
    )
    expect(h.sandbox.spawns).toHaveLength(1)
  })

  test('receive が返った時点で受信は DB にコミット済み', async () => {
    const h = harness(() => parked())
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        yield* runtime.receive(inbound('すぐ残る'))
        expect((yield* allInbound).map((m) => m.body)).toEqual(['すぐ残る'])
        yield* Effect.promise(() => h.sandbox.gate(0).reached('hold'))
        h.sandbox.gate(0).release('hold')
      }),
    )
  })

  test('DB に書けないとき receive は失敗する', async () => {
    const h = harness(() => say('届かない'))
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        const sql = yield* SqlClient.SqlClient
        yield* sql`DROP TABLE inbound_messages`
        expect(Exit.isFailure(yield* Effect.exit(runtime.receive(inbound('落ちる'))))).toBe(true)
      }),
    )
    expect(h.sandbox.spawns).toHaveLength(0)
  })
  describe('同時実行', () => {
    test('1 つのセッションで同時に動くターンは 1 つで、届いた順に回る', async () => {
      const h = harness(() => parked())
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('1 つ目'))
          yield* Effect.promise(() => h.sandbox.gate(0).reached('hold'))
          yield* runtime.receive(inbound('2 つ目'))
          yield* Effect.sleep('200 millis')
          expect(h.sandbox.spawns).toHaveLength(1)
          expect(h.sandbox.alive()).toBe(1)

          h.sandbox.gate(0).release('hold')
          yield* Effect.promise(() => h.sandbox.gate(1).reached('hold'))
          expect(h.sandbox.spawns).toHaveLength(2)
          h.sandbox.gate(1).release('hold')
          yield* eventually('both completed', turnsEnded(2))
        }),
      )
      expect(h.sandbox.alive()).toBe(0)
    })

    test('セッションをまたいだ同時実行は上限を超えない', async () => {
      const h = harness(() => parked(), { maxConcurrentTurns: 2 })
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          for (const conversation of ['c1', 'c2', 'c3'])
            yield* runtime.receive(inbound('並ぶ', { conversation }))
          yield* Effect.promise(() => h.sandbox.gate(0).reached('hold'))
          yield* Effect.promise(() => h.sandbox.gate(1).reached('hold'))
          yield* Effect.sleep('200 millis')
          expect(h.sandbox.spawns).toHaveLength(2)
          expect(h.sandbox.alive()).toBe(2)

          h.sandbox.gate(0).release('hold')
          yield* Effect.promise(() => h.sandbox.gate(2).reached('hold'))
          expect(h.sandbox.alive()).toBeLessThanOrEqual(2)
          h.sandbox.gate(1).release('hold')
          h.sandbox.gate(2).release('hold')
          yield* eventually('all completed', turnsEnded(3))
        }),
      )
      expect(h.sandbox.spawns).toHaveLength(3)
      expect(h.sandbox.alive()).toBe(0)
    })
  })
})
