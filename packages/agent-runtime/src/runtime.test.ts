import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
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
import { inboundMessages, outboundMessages, sessions, turns } from './schema.ts'
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

const allSessions = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db.select().from(sessions)
})

const allOutbound = Effect.gen(function* () {
  const db = yield* AgentRuntimeDb
  return yield* db.select().from(outboundMessages)
})

const turnEnded = (state: 'interrupted' | 'completed') =>
  Effect.map(allTurns, (rows) => rows.length === 1 && rows[0]?.state === state)

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
    test('1 つのセッションで同時に動くターンは 1 つで、閉じ始めたターンの後に届いた受信は次のターンで回る', async () => {
      const h = harness(() => say('答え'))
      const hold = h.sandbox.holdDispose()
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('1 つ目'))
          yield* Effect.promise(() => hold.entered)
          yield* runtime.receive(inbound('2 つ目'))
          yield* Effect.sleep('200 millis')
          expect(h.sandbox.spawns).toHaveLength(1)

          hold.release()
          yield* eventually('both completed', turnsEnded(2))
          expect(h.sandbox.spawns).toHaveLength(2)
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
  test('配達関数が 1 度失敗しても、後で配達されて delivered になる', async () => {
    let attempts = 0
    const succeeded: string[] = []
    const h = harness(() => say('届け直す'), {
      deliver: (m) =>
        Effect.suspend(() => {
          attempts++
          if (attempts === 1) return Effect.fail(new Error('チャンネルが落ちている'))
          succeeded.push(m.body)
          return Effect.void
        }),
    })
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        yield* runtime.receive(inbound('届けて'))
        yield* eventually(
          'delivered',
          Effect.map(allOutbound, (rows) => rows.length === 1 && rows[0]?.state === 'delivered'),
        )
      }),
    )
    expect(attempts).toBe(2)
    expect(succeeded).toEqual(['届け直す'])
  })

  test('同じセッションの 2 つ目のターンは resume で起こされ、作業場所のファイルが残っている', async () => {
    const h = harness((n) =>
      n === 0
        ? {
            first: {
              steps: [
                {
                  kind: 'tool',
                  name: 'Write',
                  writes: { path: 'note.txt', content: '前のターンのメモ' },
                },
                { kind: 'say', text: '書いた' },
              ],
            },
          }
        : say('読んだ'),
    )
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        yield* runtime.receive(inbound('書いて'))
        yield* eventually('first turn completed', turnsEnded(1))
        yield* runtime.receive(inbound('続けて'))
        yield* eventually('second turn completed', turnsEnded(2))

        const [session] = yield* allSessions
        expect(session?.claudeSessionId).toBeString()
        const [first, second] = h.sandbox.spawns
        expect(first?.resume).toBe(false)
        expect(second?.resume).toBe(true)
        expect(second?.args).toContain(`--resume=${session!.claudeSessionId}`)
        expect(second?.turn.workspaceDir).toBe(session!.workspaceDir)
        expect(readFileSync(join(session!.workspaceDir, 'note.txt'), 'utf8')).toBe(
          '前のターンのメモ',
        )
      }),
    )
  })

  test('Runtime.layer の scope を閉じると、動いていたターンの子プロセスが残らない', async () => {
    const h = harness(() => parked())
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        yield* runtime.receive(inbound('止まったまま'))
        yield* Effect.promise(() => h.sandbox.gate(0).reached('hold'))
        expect(h.sandbox.alive()).toBe(1)
      }),
    )
    expect(h.sandbox.alive()).toBe(0)
    expect(h.sandbox.disposed).toHaveLength(1)
  })
  describe('ターンの終わり方', () => {
    test('result が is_error なら failed で、受信は failed、知らせが届く', async () => {
      const h = harness(() => ({
        first: { finish: { isError: true, terminalReason: 'api_error', text: '使われない' } },
      }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('失敗する'))
          yield* eventually(
            'failed',
            Effect.map(allTurns, (rows) => rows.length === 1 && rows[0]?.state === 'failed'),
          )
          expect((yield* allTurns)[0]?.endReason).toBe('api_error')
          expect((yield* allInbound).map((m) => m.outcome)).toEqual(['failed'])
          yield* eventually(
            'notice delivered',
            Effect.map(allOutbound, (rows) => rows.length === 1 && rows[0]?.state === 'delivered'),
          )
          yield* Effect.sleep('200 millis')
          expect(yield* allTurns).toHaveLength(1)
        }),
      )
      expect(h.delivered.map((m) => m.kind)).toEqual(['notice'])
      expect(h.sandbox.spawns).toHaveLength(1)
    })

    test('CLI が途中で落ちたら interrupted で、やり直さない', async () => {
      const h = harness(() => ({ first: { steps: [{ kind: 'crash', code: 1 }] } }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('落ちる'))
          yield* eventually(
            'interrupted',
            Effect.map(allTurns, (rows) => rows.length === 1 && rows[0]?.state === 'interrupted'),
          )
          expect((yield* allTurns)[0]?.endReason).toBe('sandbox_exit')
          expect((yield* allInbound).map((m) => m.outcome)).toEqual(['interrupted'])
          yield* Effect.sleep('200 millis')
          expect(yield* allTurns).toHaveLength(1)
        }),
      )
      expect(h.sandbox.spawns).toHaveLength(1)
    })
  })

  describe('実行中の受信と /stop', () => {
    test('最後のツールの直後に届いた受信は同じターンで押し込まれ、2 つ目の result までターンは閉じない', async () => {
      const h = harness(() => ({
        first: {
          steps: [
            { kind: 'tool', name: 'Bash' },
            { kind: 'park', name: 'hold' },
            { kind: 'say', text: '一つ目の答え' },
          ],
        },
        next: { steps: [{ kind: 'say', text: '二つ目の答え' }] },
      }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('最初'))
          yield* Effect.promise(() => h.sandbox.gate(0).reached('hold'))
          expect(yield* runtime.receive(inbound('途中で追加'))).toBe('stored')
          h.sandbox.gate(0).release('hold')
          yield* eventually('turn completed', turnsEnded(1))
          yield* eventually(
            'both delivered',
            Effect.map(
              allOutbound,
              (rows) => rows.length === 2 && rows.every((r) => r.state === 'delivered'),
            ),
          )
          const [turn] = yield* allTurns
          const rows = yield* allInbound
          expect(rows.map((m) => m.outcome)).toEqual(['answered', 'answered'])
          expect(rows.map((m) => m.turnId)).toEqual([turn!.id, turn!.id])
        }),
      )
      expect(h.delivered.map((m) => [m.kind, m.body])).toEqual([
        ['final', '一つ目の答え'],
        ['final', '二つ目の答え'],
      ])
      expect(h.sandbox.spawns).toHaveLength(1)
      expect(h.sandbox.received(0)).toContainEqual(
        expect.objectContaining({
          priority: 'next',
          message: expect.objectContaining({ content: '途中で追加' }),
        }),
      )
      expect(h.sandbox.alive()).toBe(0)
    })

    test('closing に入った後に届いた受信は押し込まれず、次のターンで答えられる', async () => {
      const h = harness(() => say('答え'))
      const hold = h.sandbox.holdDispose()
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('最初'))
          yield* Effect.promise(() => hold.entered)
          yield* runtime.receive(inbound('窓の間に届いた'))
          expect((yield* allInbound).map((m) => m.turnId)).toEqual([expect.any(Number), null])
          hold.release()
          yield* eventually('two turns completed', turnsEnded(2))
          const rows = yield* allInbound
          expect(rows.map((m) => m.outcome)).toEqual(['answered', 'answered'])
          expect(rows[0]?.turnId).not.toBe(rows[1]?.turnId)
        }),
      )
      expect(h.sandbox.spawns.map((s) => s.resume)).toEqual([false, true])
    })

    test('/stop は押し込みを cancelled にして実行させず、ターンも受信も interrupted になる', async () => {
      const h = harness(() => ({
        first: {
          steps: [
            { kind: 'tool', name: 'Write', writes: { path: 'started.txt', content: '' } },
            { kind: 'hang' },
          ],
        },
        next: {
          steps: [{ kind: 'tool', name: 'Write', writes: { path: 'pushed.txt', content: 'x' } }],
        },
      }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('長い作業'))
          const [session] = yield* allSessions
          yield* eventually(
            'tool started',
            Effect.sync(() => existsSync(join(session!.workspaceDir, 'started.txt'))),
          )
          yield* runtime.receive(inbound('追加の指示'))
          expect((yield* allInbound).map((m) => m.turnId)).toEqual([
            expect.any(Number),
            expect.any(Number),
          ])
          expect(yield* runtime.receive(inbound(' /stop\n'))).toBe('stop')
          yield* eventually('interrupted', turnEnded('interrupted'))
          expect((yield* allTurns)[0]?.endReason).toBe('stopped')
          expect((yield* allInbound).map((m) => m.outcome)).toEqual(['interrupted', 'interrupted'])
          expect(yield* allInbound).toHaveLength(2)
          yield* eventually(
            'notice delivered',
            Effect.map(allOutbound, (rows) => rows.length === 1 && rows[0]?.state === 'delivered'),
          )
          yield* Effect.sleep('300 millis')
          expect(existsSync(join(session!.workspaceDir, 'pushed.txt'))).toBe(false)
          expect(h.sandbox.received(0)).toContainEqual(
            expect.objectContaining({
              request: expect.objectContaining({ subtype: 'interrupt', cancel_queued: true }),
            }),
          )
        }),
      )
      expect(h.delivered.map((m) => m.kind)).toEqual(['notice'])
      expect(h.sandbox.spawns).toHaveLength(1)
      expect(h.sandbox.alive()).toBe(0)
    })

    test('/stop の前から待っていた受信は動かず、/stop の後の受信は新しいコンテナで resume して答えられる', async () => {
      const h = harness(() => say('答え'))
      const hold = h.sandbox.holdDispose()
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('最初'))
          yield* Effect.promise(() => hold.entered)
          yield* runtime.receive(inbound('次のターンを待つ古い指示'))
          expect(yield* runtime.receive(inbound('/stop'))).toBe('stop')
          yield* runtime.receive(inbound('/stop のあとの指示'))
          hold.release()
          yield* eventually('two turns completed', turnsEnded(2))
          yield* Effect.sleep('200 millis')
          const rows = yield* allInbound
          expect(rows.map((m) => [m.body, m.outcome])).toEqual([
            ['最初', 'answered'],
            ['次のターンを待つ古い指示', 'interrupted'],
            ['/stop のあとの指示', 'answered'],
          ])
          expect(rows[1]?.turnId).toBeNull()
          expect(yield* allTurns).toHaveLength(2)
        }),
      )
      expect(h.sandbox.spawns.map((s) => s.resume)).toEqual([false, true])
      expect(h.sandbox.alive()).toBe(0)
    })

    test('制限時間を超えたターンは /stop と同じ結果で、end_reason は timeout', async () => {
      const h = harness(() => parked('forever'), { turnTimeout: '300 millis' })
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('終わらない'))
          yield* eventually('interrupted', turnEnded('interrupted'))
          expect((yield* allTurns)[0]?.endReason).toBe('timeout')
          expect((yield* allInbound).map((m) => m.outcome)).toEqual(['interrupted'])
          yield* eventually(
            'notice delivered',
            Effect.map(allOutbound, (rows) => rows.length === 1 && rows[0]?.state === 'delivered'),
          )
        }),
      )
      expect(h.delivered.map((m) => m.kind)).toEqual(['notice'])
      expect(h.sandbox.spawns).toHaveLength(1)
      expect(h.sandbox.alive()).toBe(0)
    })
  })
})
