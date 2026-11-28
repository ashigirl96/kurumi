import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Layer } from 'effect'
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
})
