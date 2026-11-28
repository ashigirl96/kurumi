import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { Deferred, Effect, Exit, Fiber } from 'effect'
import { SqlClient } from 'effect/sql'

import { type ApprovalRequest, Runtime } from './runtime.ts'
import {
  type Harness,
  allInbound,
  allOutbound,
  allSessions,
  allToolCalls,
  allTurns,
  disposeSandboxes,
  eventually,
  harness,
  inbound,
  parked,
  run,
  say,
  turnEnded,
  turnsEnded,
} from './testing/harness.ts'

const write = (name: string, file: string, input: Record<string, unknown> = {}) =>
  ({ kind: 'tool', name, input, writes: { path: file, content: 'x' } }) as const
const holdStep = { kind: 'park', name: 'hold' } as const
const doneStep = { kind: 'say', text: 'done' } as const
const workspace = Effect.map(allSessions, ([session]) => session!.workspaceDir)
const ran = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .toSorted()
const atHold = (h: Harness) => Effect.promise(() => h.sandbox.gate(0).reached('hold'))
const asking = () => {
  const requests: ApprovalRequest[] = []
  return {
    requests,
    onApprovalRequest: (r: ApprovalRequest) => Effect.sync(() => void requests.push(r)),
  }
}
const requested = (requests: ApprovalRequest[]) =>
  eventually(
    'approval requested',
    Effect.sync(() => requests.length === 1),
  )

const askScript = () => ({
  first: { steps: [write('Write', 'ask.txt', { file_path: 'ask.txt' }), holdStep, doneStep] },
})

const hanging = () => {
  const ids: string[] = []
  const notified = Promise.withResolvers<void>()
  return {
    ids,
    notified,
    onApprovalRequest: (r: ApprovalRequest) =>
      Effect.promise(() => {
        ids.push(r.id)
        return notified.promise
      }),
  }
}

const pendingRegister = () => {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  return {
    entered,
    released,
    credentialGateway: {
      register: () =>
        Effect.promise(() => {
          entered.resolve()
          return released.promise
        }),
    },
  }
}

const send = (text: string, extra: { id?: string; dropMeta?: boolean } = {}) =>
  ({
    kind: 'tool',
    name: 'mcp__kurumi__send_message',
    input: { text },
    ...extra,
  }) as const
const deliveredRows = (count: number) =>
  eventually(
    'delivered',
    Effect.map(
      allOutbound,
      (rows) => rows.length === count && rows.every((r) => r.state === 'delivered'),
    ),
  )
const toolResultErrors = Effect.map(allSessions, ([session]) =>
  readdirSync(join(session!.configDir, 'projects'), { recursive: true })
    .filter((f) => String(f).endsWith('.jsonl'))
    .flatMap((f) =>
      readFileSync(join(session!.configDir, 'projects', String(f)), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line): unknown => JSON.parse(line)),
    )
    .filter((row) => JSON.stringify(row).includes('"is_error":true')),
)

afterEach(disposeSandboxes)

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

  test('ある会話の配達が失敗し続けても、ほかの会話の行は届き、失敗した会話の中の順は保たれる', async () => {
    const succeeded: string[] = []
    const h = harness(
      (n) =>
        n === 0
          ? { first: { steps: [send('途中経過'), { kind: 'say', text: '最後の文' }] } }
          : say('別の会話の答え'),
      {
        deliver: (m) =>
          Effect.suspend(() => {
            if (m.conversation === 'broken' && !succeeded.includes('別の会話の答え'))
              return Effect.fail(new Error('この会話には届かない'))
            succeeded.push(m.body)
            return Effect.void
          }),
      },
    )
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        yield* runtime.receive(inbound('やって', { conversation: 'broken' }))
        yield* eventually(
          'broken rows written',
          Effect.map(allOutbound, (rows) => rows.length === 2),
        )
        yield* runtime.receive(inbound('こちらも', { conversation: 'working' }))
        yield* deliveredRows(3)
      }),
    )
    expect(succeeded).toEqual(['別の会話の答え', '途中経過', '最後の文'])
  })

  test('配達関数が返らなくても、時間切れで失敗と同じに扱い、ほかの会話の行は届き、後で配達し直される', async () => {
    let stuck = true
    const succeeded: string[] = []
    const h = harness((n) => say(n === 0 ? '止まった会話の答え' : '別の会話の答え'), {
      deliveryTimeout: '200 millis',
      deliver: (m) =>
        Effect.suspend(() => {
          if (m.conversation === 'stuck' && stuck) {
            stuck = false
            return Effect.never
          }
          succeeded.push(m.body)
          return Effect.void
        }),
    })
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        yield* runtime.receive(inbound('やって', { conversation: 'stuck' }))
        yield* eventually(
          'stuck delivery started',
          Effect.sync(() => !stuck),
        )
        yield* runtime.receive(inbound('こちらも', { conversation: 'working' }))
        yield* deliveredRows(2)
      }),
    )
    expect(succeeded).toEqual(['別の会話の答え', '止まった会話の答え'])
  })

  test('配達に失敗した後に pending へ戻せなくても、戻せるようになったら配達し直される', async () => {
    let attempts = 0
    const succeeded: string[] = []
    const h = harness(() => say('戻してから届く'), {
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
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TRIGGER reject_release BEFORE UPDATE OF state ON outbound_messages WHEN OLD.state = 'sending' AND NEW.state = 'pending' BEGIN SELECT RAISE(ABORT, 'release failed'); END`
        yield* runtime.receive(inbound('届けて'))
        yield* eventually(
          'first attempt failed',
          Effect.sync(() => attempts === 1),
        )
        yield* Effect.sleep('200 millis')
        yield* sql`DROP TRIGGER reject_release`
        yield* deliveredRows(1)
      }),
    )
    expect(succeeded).toEqual(['戻してから届く'])
  })

  test('配達の後に delivered を書けなくても、配達し直さず、書けるようになったら delivered になる', async () => {
    const h = harness(() => say('一度だけ届く'))
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TRIGGER reject_delivered BEFORE UPDATE OF state ON outbound_messages WHEN NEW.state = 'delivered' BEGIN SELECT RAISE(ABORT, 'delivered write failed'); END`
        yield* runtime.receive(inbound('届けて'))
        yield* eventually(
          'channel received',
          Effect.sync(() => h.delivered.length === 1),
        )
        yield* Effect.sleep('200 millis')
        yield* sql`DROP TRIGGER reject_delivered`
        yield* deliveredRows(1)
      }),
    )
    expect(h.delivered.map((m) => m.body)).toEqual(['一度だけ届く'])
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

    test('ターンの途中で DB に書けなくなったら interrupted で閉じて知らせ、やり直さない', async () => {
      const h = harness(() => say('書けない最後の文'))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TRIGGER reject_final BEFORE INSERT ON outbound_messages WHEN NEW.kind = 'final' BEGIN SELECT RAISE(ABORT, 'final write failed'); END`
          yield* runtime.receive(inbound('答えて'))
          yield* eventually('interrupted', turnEnded('interrupted'))
          expect((yield* allTurns)[0]?.endReason).toBe('host_error')
          expect((yield* allInbound).map((m) => m.outcome)).toEqual(['interrupted'])
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
      expect(h.sandbox.alive()).toBe(0)
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

    test('利用者の文は、/ で始まっても CLI のコマンドにせず、最初の入力も押し込みも client_composed で渡す', async () => {
      const h = harness(() => ({
        first: { steps: [holdStep, { kind: 'say', text: '一つ目の答え' }] },
        next: { steps: [{ kind: 'say', text: '二つ目の答え' }] },
      }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('/help'))
          yield* atHold(h)
          yield* runtime.receive(inbound('/compact'))
          h.sandbox.gate(0).release('hold')
          yield* eventually('turn completed', turnsEnded(1))
        }),
      )
      const users = h.sandbox
        .received(0)
        .filter(
          (line) =>
            typeof line === 'object' && line !== null && 'type' in line && line.type === 'user',
        )
      expect(users).toEqual([
        expect.objectContaining({
          client_composed: true,
          message: expect.objectContaining({ content: '/help' }),
        }),
        expect.objectContaining({
          client_composed: true,
          priority: 'next',
          message: expect.objectContaining({ content: '/compact' }),
        }),
      ])
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

    test('押し込みの割り当てが DB の障害で失敗しても、その間に読んだ result でターンは閉じ、受信は次のターンで答えられる', async () => {
      const h = harness((n) => (n === 0 ? { first: { steps: [holdStep] } } : say('二つ目の答え')), {
        turnTimeout: '2 seconds',
      })
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          const sql = yield* SqlClient.SqlClient
          yield* runtime.receive(inbound('最初'))
          yield* atHold(h)
          yield* eventually(
            'init handled',
            Effect.map(allSessions, (rows) => rows[0]?.claudeSessionId != null),
          )
          yield* sql`CREATE TRIGGER reject_push BEFORE UPDATE OF turn_id ON inbound_messages WHEN (SELECT state FROM turns WHERE id = NEW.turn_id) = 'running' BEGIN SELECT RAISE(ABORT, 'push assign failed'); END`
          // DB の鍵を代わる代わるつかみ、receive を 1 文ずつ進めて、押し込みを受け付けてから割り当てるまでの間に result を読ませる。
          const lockDb = Effect.gen(function* () {
            const release = yield* Deferred.make<void>()
            yield* sql.withTransaction(Deferred.await(release)).pipe(Effect.forkChild)
            yield* Effect.sleep('50 millis')
            return Deferred.succeed(release, undefined)
          })
          let unlock = yield* lockDb
          const pushing = yield* runtime.receive(inbound('追加')).pipe(Effect.forkChild)
          for (const _ of ['findSession', 'storeInbound']) {
            yield* Effect.sleep('50 millis')
            const next = yield* lockDb
            yield* unlock
            unlock = next
          }
          yield* Effect.sleep('50 millis')
          h.sandbox.gate(0).release('hold')
          yield* Effect.sleep('300 millis')
          yield* unlock
          expect(yield* Fiber.join(pushing)).toBe('stored')

          yield* eventually(
            'first ended',
            Effect.map(allTurns, (rows) => rows[0]?.endedAt != null),
          )
          expect((yield* allTurns)[0]).toMatchObject({ state: 'completed', endReason: null })
          yield* eventually('pushed answered', turnsEnded(2))
          expect((yield* allInbound).map((m) => [m.body, m.outcome])).toEqual([
            ['最初', 'answered'],
            ['追加', 'answered'],
          ])
        }),
      )
      expect(h.delivered.map((m) => m.body)).toEqual(['二つ目の答え'])
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
          expect((yield* allInbound).map((m) => [m.body, m.outcome, m.turnId !== null])).toEqual([
            ['長い作業', 'interrupted', true],
            ['追加の指示', 'interrupted', true],
            [' /stop\n', 'answered', false],
          ])
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
            ['/stop', 'answered'],
            ['/stop のあとの指示', 'answered'],
          ])
          expect(rows[1]?.turnId).toBeNull()
          expect(rows[2]?.turnId).toBeNull()
          expect(yield* allTurns).toHaveLength(2)
        }),
      )
      expect(h.sandbox.spawns.map((s) => s.resume)).toEqual([false, true])
      expect(h.sandbox.alive()).toBe(0)
    })

    test('ターンが受信を読んだ後、割り当てる前に /stop が取り消した受信は、ターンに渡らない', async () => {
      const h = harness(() => say('答えてはいけない'))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          const sql = yield* SqlClient.SqlClient
          // ターンの行を作った瞬間に /stop の取り消しが割り込んだことにする。取り消しは割り当てに失敗したトランザクションごと戻る。
          yield* sql`CREATE TRIGGER stop_lands BEFORE INSERT ON turns BEGIN UPDATE inbound_messages SET outcome = 'interrupted' WHERE turn_id IS NULL AND outcome IS NULL; END`
          yield* runtime.receive(inbound('取り消される'))
          yield* Effect.sleep('300 millis')
          expect(yield* allTurns).toHaveLength(0)
          expect((yield* allInbound).map((m) => m.turnId)).toEqual([null])
        }),
      )
      expect(h.sandbox.spawns).toHaveLength(0)
    })

    test('再配達された /stop は duplicate で、後から始まったターンを止めない', async () => {
      const h = harness((n) => (n === 0 ? say('答え') : parked()))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          const stop = inbound('/stop')
          yield* runtime.receive(inbound('最初'))
          yield* eventually('first completed', turnsEnded(1))
          expect(yield* runtime.receive(stop)).toBe('stop')
          yield* runtime.receive(inbound('新しい作業'))
          yield* Effect.promise(() => h.sandbox.gate(1).reached('hold'))
          const replayed = yield* runtime.receive(stop)
          yield* Effect.sleep('200 millis')
          expect((yield* allTurns)[1]?.state).toBe('running')
          expect(replayed).toBe('duplicate')
          h.sandbox.gate(1).release('hold')
          yield* eventually('second completed', turnsEnded(2))
        }),
      )
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

    describe('Credential Gateway の登録が戻らないとき', () => {
      for (const [label, endReason] of [
        ['/stop', 'stopped'],
        ['制限時間', 'timeout'],
      ] as const) {
        test(`${label} で interrupted になり、コンテナを起こさない`, async () => {
          const { entered, released, credentialGateway } = pendingRegister()
          const h = harness(() => parked(), { credentialGateway, turnTimeout: '300 millis' })
          try {
            await run(
              h,
              Effect.gen(function* () {
                const runtime = yield* Runtime
                yield* runtime.receive(inbound('作業'))
                yield* Effect.promise(() => entered.promise)
                if (endReason === 'stopped') yield* runtime.receive(inbound('/stop'))
                yield* eventually('interrupted', turnEnded('interrupted'))
                expect((yield* allTurns)[0]?.endReason).toBe(endReason)
                released.resolve()
                yield* Effect.sleep('200 millis')
                expect(h.sandbox.spawns).toHaveLength(0)
              }),
            )
          } finally {
            released.resolve()
          }
        })
      }
    })
  })
  describe('ツールの関所', () => {
    test('許可されたツール呼び出しは、ツールが動いた時点で tool_calls に記録されている', async () => {
      const h = harness(() => ({
        first: { steps: [write('Write', 'ran.txt', { file_path: 'a.txt' }), holdStep, doneStep] },
      }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('書いて'))
          yield* atHold(h)
          expect(ran(yield* workspace)).toEqual(['ran.txt'])
          const [turn] = yield* allTurns
          const rows = yield* allToolCalls
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({ toolName: 'Write', turnId: turn!.id })
          expect(rows[0]?.toolUseId).toStartWith('toolu_')
          expect(JSON.parse(rows[0]!.inputSummary)).toEqual({ file_path: 'a.txt' })
          h.sandbox.gate(0).release('hold')
          yield* eventually('completed', turnsEnded(1))
        }),
      )
    })

    test('入力の要約は長い入力を切り詰める', async () => {
      const h = harness(() => ({
        first: {
          steps: [write('Write', 'ran.txt', { text: 'あ'.repeat(5000) }), holdStep, doneStep],
        },
      }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('長い'))
          yield* atHold(h)
          const [row] = yield* allToolCalls
          expect(row!.inputSummary.length).toBeLessThan(1000)
          expect(row!.inputSummary).toStartWith('{"text":"あああ')
          h.sandbox.gate(0).release('hold')
        }),
      )
    })

    test('tool_calls に書けないとき、ツールは動かない', async () => {
      const h = harness(() => ({
        first: { steps: [write('Write', 'ran.txt'), holdStep, doneStep] },
      }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          const sql = yield* SqlClient.SqlClient
          yield* sql`DROP TABLE tool_calls`
          yield* runtime.receive(inbound('書けない'))
          yield* atHold(h)
          expect(ran(yield* workspace)).toEqual([])
          h.sandbox.gate(0).release('hold')
          yield* eventually('completed', turnsEnded(1))
        }),
      )
    })

    test('方針が deny のツールと禁止ツールは動かず、記録もされない', async () => {
      const h = harness(
        () => ({
          first: {
            steps: [
              write('Bash', 'denied.txt'),
              write('CronCreate', 'cron.txt'),
              write('CronSomethingNew', 'cron-prefix.txt'),
              write('ScheduleWakeup', 'wakeup.txt'),
              write('Monitor', 'monitor.txt'),
              write('Write', 'ok.txt'),
              holdStep,
              doneStep,
            ],
          },
        }),
        { policy: ({ toolName }) => (toolName === 'Bash' ? 'deny' : 'allow') },
      )
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('いろいろ'))
          yield* atHold(h)
          expect(ran(yield* workspace)).toEqual(['ok.txt'])
          expect((yield* allToolCalls).map((r) => r.toolName)).toEqual(['Write'])
          h.sandbox.gate(0).release('hold')
          yield* eventually('completed', turnsEnded(1))
        }),
      )
    })

    describe('ask', () => {
      test('承認依頼は長い入力も切らずに渡す', async () => {
        const { requests, onApprovalRequest } = asking()
        const command = `${'echo ok; '.repeat(500)}rm -rf /work`
        const h = harness(
          () => ({
            first: { steps: [write('Bash', 'ran.txt', { command }), holdStep, doneStep] },
          }),
          { policy: () => 'ask', onApprovalRequest },
        )
        await run(
          h,
          Effect.gen(function* () {
            const runtime = yield* Runtime
            yield* runtime.receive(inbound('長いコマンド'))
            yield* requested(requests)
            expect(requests[0]!.input).toEqual({ command })
            yield* runtime.answerApproval(requests[0]!.id, 'deny')
            yield* atHold(h)
            h.sandbox.gate(0).release('hold')
            yield* eventually('completed', turnsEnded(1))
          }),
        )
      })

      test('依頼が届き、allow でツールが動く。待つ間ターンは閉じず、返事は受信にならない', async () => {
        const { requests, onApprovalRequest } = asking()
        const h = harness(askScript, { policy: () => 'ask', onApprovalRequest })
        await run(
          h,
          Effect.gen(function* () {
            const runtime = yield* Runtime
            yield* runtime.receive(inbound('承認して'))
            yield* requested(requests)
            const [request] = requests
            const [session] = yield* allSessions
            const [turn] = yield* allTurns
            expect(request).toMatchObject({
              channel: 'chat',
              conversation: 'c1',
              sessionId: session!.id,
              turnId: turn!.id,
              toolName: 'Write',
            })
            expect(request!.input).toEqual({ file_path: 'ask.txt' })
            expect(request!.expiresAt.getTime()).toBeGreaterThan(Date.now())

            yield* Effect.sleep('200 millis')
            expect((yield* allTurns)[0]?.state).toBe('running')
            expect(ran(session!.workspaceDir)).toEqual([])
            expect(yield* allToolCalls).toHaveLength(0)
            expect(yield* runtime.answerApproval('unknown', 'allow')).toBe(false)

            const before = (yield* allInbound).length
            expect(yield* runtime.answerApproval(request!.id, 'allow')).toBe(true)
            yield* atHold(h)
            expect(ran(session!.workspaceDir)).toEqual(['ask.txt'])
            expect(yield* allToolCalls).toHaveLength(1)
            expect(yield* allInbound).toHaveLength(before)
            expect(yield* runtime.answerApproval(request!.id, 'allow')).toBe(false)
            h.sandbox.gate(0).release('hold')
            yield* eventually('completed', turnsEnded(1))
            expect(yield* allInbound).toHaveLength(before)
          }),
        )
      })

      test('deny ならツールは動かず、記録もされない', async () => {
        const { requests, onApprovalRequest } = asking()
        const h = harness(askScript, { policy: () => 'ask', onApprovalRequest })
        await run(
          h,
          Effect.gen(function* () {
            const runtime = yield* Runtime
            yield* runtime.receive(inbound('断る'))
            yield* requested(requests)
            expect(yield* runtime.answerApproval(requests[0]!.id, 'deny')).toBe(true)
            yield* atHold(h)
            expect(ran(yield* workspace)).toEqual([])
            expect(yield* allToolCalls).toHaveLength(0)
            h.sandbox.gate(0).release('hold')
            yield* eventually('completed', turnsEnded(1))
          }),
        )
      })

      test('答えが来ないまま時間切れになると deny になり、その後の答えは false', async () => {
        const { requests, onApprovalRequest } = asking()
        const h = harness(askScript, {
          policy: () => 'ask',
          onApprovalRequest,
          approvalTimeout: '300 millis',
        })
        await run(
          h,
          Effect.gen(function* () {
            const runtime = yield* Runtime
            yield* runtime.receive(inbound('放っておく'))
            yield* requested(requests)
            yield* atHold(h)
            expect(ran(yield* workspace)).toEqual([])
            expect(yield* allToolCalls).toHaveLength(0)
            expect(yield* runtime.answerApproval(requests[0]!.id, 'allow')).toBe(false)
            h.sandbox.gate(0).release('hold')
            yield* eventually('completed', turnsEnded(1))
          }),
        )
      })

      test('/stop で待ちが終わり、ターンは interrupted になる', async () => {
        const { requests, onApprovalRequest } = asking()
        const h = harness(askScript, { policy: () => 'ask', onApprovalRequest })
        await run(
          h,
          Effect.gen(function* () {
            const runtime = yield* Runtime
            yield* runtime.receive(inbound('待たせる'))
            yield* requested(requests)
            expect(yield* runtime.receive(inbound('/stop'))).toBe('stop')
            yield* eventually('interrupted', turnEnded('interrupted'))
            expect((yield* allTurns)[0]?.endReason).toBe('stopped')
            expect(ran(yield* workspace)).toEqual([])
            expect(yield* allToolCalls).toHaveLength(0)
            expect(yield* runtime.answerApproval(requests[0]!.id, 'allow')).toBe(false)
          }),
        )
        expect(h.sandbox.alive()).toBe(0)
      })

      describe('依頼の通知が戻らないとき', () => {
        test('/stop の後の答えは false で、通知が戻ってもツールは動かない', async () => {
          const { ids, notified, onApprovalRequest } = hanging()
          const h = harness(askScript, { policy: () => 'ask', onApprovalRequest })
          try {
            await run(
              h,
              Effect.gen(function* () {
                const runtime = yield* Runtime
                yield* runtime.receive(inbound('待たせる'))
                yield* eventually(
                  'approval requested',
                  Effect.sync(() => ids.length === 1),
                )
                yield* runtime.receive(inbound('/stop'))
                yield* eventually('interrupted', turnEnded('interrupted'))
                expect(yield* runtime.answerApproval(ids[0]!, 'allow')).toBe(false)
                notified.resolve()
                yield* Effect.sleep('200 millis')
                expect(yield* allToolCalls).toHaveLength(0)
                expect(ran(yield* workspace)).toEqual([])
              }),
            )
          } finally {
            notified.resolve()
          }
        })

        test('時間切れで deny になり、その後の答えは false', async () => {
          const { ids, notified, onApprovalRequest } = hanging()
          const h = harness(askScript, {
            policy: () => 'ask',
            onApprovalRequest,
            approvalTimeout: '300 millis',
          })
          try {
            await run(
              h,
              Effect.gen(function* () {
                const runtime = yield* Runtime
                yield* runtime.receive(inbound('放っておく'))
                yield* atHold(h).pipe(Effect.timeout('2 seconds'))
                expect(ran(yield* workspace)).toEqual([])
                expect(yield* runtime.answerApproval(ids[0]!, 'allow')).toBe(false)
                h.sandbox.gate(0).release('hold')
                yield* eventually('completed', turnsEnded(1))
              }),
            )
          } finally {
            notified.resolve()
          }
        })
      })
    })
  })

  describe('送るツール', () => {
    test('progress を 1 回、最後の文は final を 1 回だけ書いて配達する', async () => {
      const h = harness(() => ({
        first: { steps: [send('途中経過'), { kind: 'say', text: '最後の文' }] },
      }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('やって'))
          yield* deliveredRows(2)
          expect((yield* allOutbound).map((r) => r.kind)).toEqual(['progress', 'final'])
        }),
      )
      expect(h.delivered.map((m) => [m.kind, m.body])).toEqual([
        ['progress', '途中経過'],
        ['final', '最後の文'],
      ])
    })

    test('同じツール呼び出しの id で 2 度呼ばれても、progress は 1 つ', async () => {
      const h = harness(() => ({
        first: {
          steps: [
            send('途中経過', { id: 'toolu_dup' }),
            send('途中経過', { id: 'toolu_dup' }),
            { kind: 'say', text: '最後の文' },
          ],
        },
      }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('二度呼ぶ'))
          yield* deliveredRows(2)
          yield* Effect.sleep('100 millis')
          expect((yield* allOutbound).map((r) => r.kind)).toEqual(['progress', 'final'])
        }),
      )
      expect(h.delivered.map((m) => m.kind)).toEqual(['progress', 'final'])
    })

    test('_meta に id が無ければツールのエラーになり、送信は書かれない', async () => {
      const h = harness(() => ({
        first: { steps: [send('届かない', { dropMeta: true }), { kind: 'say', text: '最後の文' }] },
      }))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('メタ無し'))
          yield* deliveredRows(1)
          expect((yield* allOutbound).map((r) => r.kind)).toEqual(['final'])
          expect(yield* toolResultErrors).toHaveLength(1)
        }),
      )
    })
  })
})
