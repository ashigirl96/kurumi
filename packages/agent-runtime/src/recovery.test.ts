import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Effect } from 'effect'
import { z } from 'zod'

import { Runtime } from './runtime.ts'
import {
  claimNextOutbound,
  createTurn,
  insertOutbound,
  insertSession,
  recordToolCall,
  storeInbound,
  transitionTurn,
} from './store.ts'
import type { Script } from './testing/fake-cli.ts'
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
  onSharedDb,
  parked,
  run,
  say,
  turnsEnded,
} from './testing/harness.ts'

afterEach(disposeSandboxes)

const send = (text: string) =>
  ({ kind: 'tool', name: 'mcp__kurumi__send_message', input: { text } }) as const

const UserLine = z.object({ type: z.literal('user'), message: z.object({ content: z.string() }) })

const firstPrompt = (h: Harness, n: number) =>
  h.sandbox.received(n).flatMap((line) => {
    const parsed = UserLine.safeParse(line)
    return parsed.success ? [parsed.data.message.content] : []
  })[0] ?? ''

const interruptedThenSay = (n: number): Script =>
  n === 0
    ? {
        first: {
          steps: [
            { kind: 'tool', name: 'Write', input: { file_path: 'a.txt' } },
            send('途中の報告'),
            { kind: 'hang' },
          ],
        },
      }
    : say('続き')

const deliveredCount = (count: number) =>
  eventually(
    'delivered',
    Effect.map(
      allOutbound,
      (rows) => rows.length === count && rows.every((r) => r.state === 'delivered'),
    ),
  )

describe('中断の知らせ', () => {
  test('中断されたターンの次の最初の入力に、始まっていたツール呼び出しと配信済みの送信の知らせが付き、resume で続く', async () => {
    const h = harness(interruptedThenSay)
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        yield* runtime.receive(inbound('長い作業'))
        yield* deliveredCount(1)
        yield* runtime.receive(inbound('/stop'))
        yield* eventually(
          'interrupted',
          Effect.map(allTurns, (rows) => rows[0]?.state === 'interrupted'),
        )
        yield* deliveredCount(2)
        yield* runtime.receive(inbound('続けて'))
        yield* eventually(
          'second turn completed',
          Effect.map(allTurns, (rows) => rows[1]?.state === 'completed'),
        )
        expect((yield* allSessions)[0]?.status).toBe('active')
      }),
    )
    const prompt = firstPrompt(h, 1)
    expect(prompt).toContain('Write')
    expect(prompt).toContain('a.txt')
    expect(prompt).toContain('途中の報告')
    expect(prompt).toContain('最後まで動いたかどうかは分かりません')
    expect(prompt).not.toContain('作業を中断しました')
    expect(prompt.endsWith('続けて')).toBe(true)
    expect(h.sandbox.spawns.map((s) => s.resume)).toEqual([false, true])
  })

  test('中断でなく終わったターンの後には、知らせは付かない', async () => {
    const h = harness(() => say('答え'))
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        yield* runtime.receive(inbound('一つ目'))
        yield* eventually('first completed', turnsEnded(1))
        yield* runtime.receive(inbound('二つ目'))
        yield* eventually('second completed', turnsEnded(2))
      }),
    )
    expect(firstPrompt(h, 1)).toBe('二つ目')
  })
})

const transcriptFile = (configDir: string) => {
  const dir = join(configDir, 'projects')
  const file = readdirSync(dir, { recursive: true }).find((f) => String(f).endsWith('.jsonl'))
  return join(dir, String(file))
}
const dropLines = (containing: string) => (configDir: string) => {
  const file = transcriptFile(configDir)
  const kept = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.includes(containing))
  writeFileSync(file, kept.join('\n'))
}
describe('resume の照合と /new', () => {
  const damages: [string, (configDir: string, h: { prompt: string; assistant: string }) => void][] =
    [
      ['会話記録の file が無い', (dir) => rmSync(join(dir, 'projects'), { recursive: true })],
      ['利用者の発言の行が壊れている', (dir, t) => dropLines(t.prompt)(dir)],
      ['最後のアシスタントの行が無い', (dir, t) => dropLines(t.assistant)(dir)],
    ]

  for (const [label, damage] of damages) {
    test(`${label}と、ターンを始めずセッションを lost にして知らせ、/new の後に新しいセッションで答える`, async () => {
      const h = harness((n) => say(n === 0 ? '一つ目の答え' : '新しい答え'))
      await run(
        h,
        Effect.gen(function* () {
          const runtime = yield* Runtime
          yield* runtime.receive(inbound('a'))
          yield* eventually('first completed', turnsEnded(1))
          const [first] = yield* allTurns
          const [before] = yield* allSessions
          damage(before!.configDir, {
            prompt: first!.promptUuid!,
            assistant: first!.lastAssistantUuid!,
          })

          yield* runtime.receive(inbound('b'))
          yield* eventually(
            'lost',
            Effect.map(allSessions, (rows) => rows[0]?.status === 'lost'),
          )
          const turns = yield* allTurns
          expect(turns).toHaveLength(2)
          expect(turns[1]).toMatchObject({ state: 'interrupted', endReason: 'resume_unreadable' })
          expect((yield* allInbound).map((m) => m.outcome)).toEqual(['answered', 'interrupted'])
          yield* deliveredCount(2)
          const notices = h.delivered.filter((m) => m.kind === 'notice')
          expect(notices).toHaveLength(1)
          expect(notices[0]?.body).toContain('/new')
          expect(h.sandbox.spawns).toHaveLength(1)

          yield* runtime.receive(inbound('c'))
          yield* Effect.sleep('300 millis')
          expect(yield* allTurns).toHaveLength(2)
          expect((yield* allInbound).map((m) => m.outcome)).toEqual([
            'answered',
            'interrupted',
            null,
          ])
          expect(h.sandbox.spawns).toHaveLength(1)

          expect(yield* runtime.receive(inbound('/new'))).toBe('new-session')
          yield* eventually(
            'c answered',
            Effect.map(allInbound, (rows) => rows[2]?.outcome === 'answered'),
          )
        }),
      )
      expect(h.sandbox.spawns.map((s) => s.resume)).toEqual([false, false])
      expect(h.delivered.map((m) => m.body).at(-1)).toBe('新しい答え')
    })
  }

  test('/new は lost でなければ何もせず、受信としても保存しない', async () => {
    const h = harness(() => say('答え'))
    await run(
      h,
      Effect.gen(function* () {
        const runtime = yield* Runtime
        yield* runtime.receive(inbound('a'))
        yield* eventually('first completed', turnsEnded(1))
        expect(yield* runtime.receive(inbound('/new'))).toBe('new-session')
        expect(yield* allSessions).toHaveLength(1)
        expect(yield* allInbound).toHaveLength(1)
      }),
    )
  })
})

const received = (body: string) =>
  storeInbound({ ...inbound(body), receivedAt: new Date(0) }).pipe(Effect.map((r) => r!))
describe('起動時の復旧', () => {
  test('2 度流しても同じ状態になり、running のターンは interrupted、sending は配達し直され、未割り当ての受信は処理される', async () => {
    const h = harness(() => say('復旧後の答え'))
    const seed = Effect.gen(function* () {
      const dir = join(h.config.dataDir, 'sessions', 's1')
      mkdirSync(join(dir, 'cfg'), { recursive: true })
      mkdirSync(join(dir, 'work'), { recursive: true })
      yield* insertSession({
        id: 's1',
        channel: 'chat',
        conversation: 'c1',
        agent: 'test-agent',
        configDir: join(dir, 'cfg'),
        workspaceDir: join(dir, 'work'),
        status: 'active',
      })
      const running = yield* received('動いていた最中の受信')
      const turnId = yield* createTurn({ sessionId: 's1', inboundIds: [running.id] })
      yield* transitionTurn(turnId, 'queued', 'running', { promptUuid: 'p1' })
      yield* recordToolCall({
        toolUseId: 't1',
        turnId,
        toolName: 'Write',
        inputSummary: '{"file_path":"a.txt"}',
      })
      yield* insertOutbound({
        sessionId: 's1',
        turnId,
        kind: 'progress',
        body: '配達の途中だった送信',
        idempotencyKey: 'progress:t1',
      })
      yield* claimNextOutbound
      yield* received('待っていた受信')
    })
    const snapshot = Effect.all([allTurns, allInbound, allOutbound, allSessions, allToolCalls])

    const [first, second] = await onSharedDb(h, (boot, db) =>
      Effect.gen(function* () {
        yield* seed.pipe(Effect.provide(db))
        const afterFirst = yield* boot(
          Effect.gen(function* () {
            yield* eventually(
              'settled',
              Effect.map(
                Effect.all([allTurns, allOutbound]),
                ([turns, out]) =>
                  turns.length === 2 &&
                  turns.every((t) => t.state !== 'running') &&
                  out.length === 3 &&
                  out.every((o) => o.state === 'delivered'),
              ),
            )
            return yield* snapshot
          }),
        )
        const afterSecond = yield* boot(Effect.sleep('300 millis').pipe(Effect.andThen(snapshot)))
        return [afterFirst, afterSecond] as const
      }),
    )
    expect(second).toEqual(first)
    const [turns, inboundRows, outbound] = first
    expect(turns.map((t) => [t.state, t.endReason])).toEqual([
      ['interrupted', 'host_stopped'],
      ['completed', null],
    ])
    expect(inboundRows.map((m) => m.outcome)).toEqual(['interrupted', 'answered'])
    expect(outbound.map((o) => o.idempotencyKey)).toEqual([
      'progress:t1',
      'notice:interrupted:1',
      'final:2:1',
    ])
    expect(h.delivered.map((m) => m.body).toSorted()).toEqual(
      ['作業を中断しました。', '復旧後の答え', '配達の途中だった送信'].toSorted(),
    )
    expect(h.sandbox.spawns).toHaveLength(1)
    expect(h.sandbox.swept()).toBe(2)
  })

  test('ホストを止めると子プロセスが残らず、次の起動でもそのターンの知らせは 1 つだけ', async () => {
    const h = harness(() => parked())
    await onSharedDb(h, (boot, db) =>
      Effect.gen(function* () {
        yield* boot(
          Effect.gen(function* () {
            const runtime = yield* Runtime
            yield* runtime.receive(inbound('止まったまま'))
            yield* Effect.promise(() => h.sandbox.gate(0).reached('hold'))
          }),
        )
        expect(h.sandbox.alive()).toBe(0)
        const [stopped] = yield* allTurns.pipe(Effect.provide(db))
        expect(stopped).toMatchObject({ state: 'interrupted', endReason: 'host_stopped' })
        yield* boot(
          Effect.gen(function* () {
            yield* eventually(
              'notice delivered',
              Effect.map(
                allOutbound,
                (rows) => rows.length === 1 && rows.every((r) => r.state === 'delivered'),
              ),
            )
            const [turn] = yield* allTurns
            expect(turn).toMatchObject({ state: 'interrupted', endReason: 'host_stopped' })
            expect((yield* allInbound).map((m) => m.outcome)).toEqual(['interrupted'])
          }),
        )
        yield* boot(Effect.sleep('200 millis'))
      }),
    )
    expect(h.delivered.map((m) => m.kind)).toEqual(['notice'])
    expect(h.sandbox.spawns).toHaveLength(1)
  })
})
