import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect, Layer } from 'effect'
import type { SqlClient } from 'effect/sql'

import {
  type InboundInput,
  type OutboundToDeliver,
  Runtime,
  type RuntimeConfig,
} from '../runtime.ts'
import { inboundMessages, outboundMessages, sessions, toolCalls, turns } from '../schema.ts'
import { AgentRuntimeDb } from '../store.ts'
import { testDbLayer } from './db.ts'
import type { Script } from './fake-cli.ts'
import { type FakeSandbox, fakeSandbox } from './fake-sandbox.ts'

const sandboxes: FakeSandbox[] = []

export const disposeSandboxes = async () => {
  for (const sandbox of sandboxes.splice(0)) {
    for (const spawned of sandbox.spawns) await Effect.runPromise(sandbox.dispose(spawned.turn))
  }
}

export const say = (text: string): Script => ({ first: { steps: [{ kind: 'say', text }] } })

export const parked = (name = 'hold'): Script => ({
  first: {
    steps: [
      { kind: 'park', name },
      { kind: 'say', text: 'done' },
    ],
  },
})

export type Harness = ReturnType<typeof harness>

export const harness = (
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

export const run = <A, E>(
  h: Harness,
  body: Effect.Effect<A, E, Runtime | AgentRuntimeDb | SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    body.pipe(Effect.provide(Runtime.layer(h.config).pipe(Layer.provideMerge(testDbLayer)))),
  )

let sequence = 0
export const inbound = (body: string, overrides: Partial<InboundInput> = {}): InboundInput => ({
  channel: 'chat',
  conversation: 'c1',
  platformMessageId: `m${++sequence}`,
  sender: 'user',
  body,
  receivedAt: new Date(),
  ...overrides,
})

export const eventually = (what: string, check: Effect.Effect<boolean, unknown, AgentRuntimeDb>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      if (yield* check) return
      yield* Effect.sleep('10 millis')
    }
    yield* Effect.die(new Error(`timed out: ${what}`))
  })

export const allTurns = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db.select().from(turns)
})

export const allInbound = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db.select().from(inboundMessages)
})

export const allSessions = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db.select().from(sessions)
})

export const allOutbound = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db.select().from(outboundMessages)
})

export const allToolCalls = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db.select().from(toolCalls)
})

export const turnEnded = (state: 'interrupted' | 'completed') =>
  Effect.map(allTurns, (rows) => rows.length === 1 && rows[0]?.state === state)

export const turnsEnded = (count: number) =>
  Effect.map(
    allTurns,
    (rows) => rows.length === count && rows.every((t) => t.state === 'completed'),
  )

export const onSharedDb = <A, E>(
  h: Harness,
  body: (
    boot: <A2, E2>(
      effect: Effect.Effect<A2, E2, Runtime | AgentRuntimeDb | SqlClient.SqlClient>,
    ) => Effect.Effect<A2, E2>,
    db: Layer.Layer<AgentRuntimeDb | SqlClient.SqlClient>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const db = Layer.succeedContext(yield* Layer.build(testDbLayer))
        return yield* body(
          (effect) =>
            effect.pipe(Effect.provide(Runtime.layer(h.config).pipe(Layer.provideMerge(db)))),
          db,
        )
      }),
    ),
  )
