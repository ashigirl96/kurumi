// 本物の Docker と Claude Code CLI（haiku）で、偽の CLI では分からない振る舞いを確かめる。
// KURUMI_REAL_CHECKS=1 のときだけ流れる。使い方は README.md を見る。
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Effect } from 'effect'
import { z } from 'zod'

import { Runtime } from '../runtime.ts'
import { dockerSandbox } from '../sandbox.ts'
import {
  allInbound,
  allOutbound,
  allSessions,
  allToolCalls,
  allTurns,
  inbound,
  run,
} from '../testing/harness.ts'
import { down, up } from './dev-env.ts'
import {
  agentContainers,
  askDirectly,
  docker,
  realChecksEnabled,
  realDockerConfig,
  realHarness,
  tappedSandbox,
  toolUseIds,
  until,
} from './support.ts'

const turnTimeout = 300_000
const dataDirs: string[] = []

const harnessOf = () => {
  const h = realHarness()
  dataDirs.push(h.config.dataDir)
  return h
}

const toolCalled = Effect.map(allToolCalls, (rows) => rows.length >= 1)
const turnState = (index: number, state: string) =>
  Effect.map(allTurns, (rows) => rows[index]?.state === state)
const finals = Effect.map(allOutbound, (rows) => rows.filter((r) => r.kind === 'final'))
const resultLines = (lines: readonly { type?: string | undefined }[]) =>
  lines.filter((l) => l.type === 'result')

const hookFor = (who: string) => ({
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: `touch /work/HOOK_${who}_SessionStart` }] },
    ],
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `touch /work/HOOK_${who}_PreToolUse` }],
      },
    ],
  },
})
const plantSettings = (dirs: { configDir: string; workspaceDir: string }) => {
  mkdirSync(join(dirs.workspaceDir, '.claude'), { recursive: true })
  writeFileSync(
    join(dirs.workspaceDir, '.claude', 'settings.json'),
    JSON.stringify(hookFor('project')),
  )
  writeFileSync(join(dirs.configDir, 'settings.json'), JSON.stringify(hookFor('user')))
  const claudeJson = join(dirs.configDir, '.claude.json')
  const existing: Record<string, unknown> = existsSync(claudeJson)
    ? z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(claudeJson, 'utf8')))
    : {}
  writeFileSync(
    claudeJson,
    JSON.stringify({
      ...existing,
      mcpServers: { planted: { command: 'touch', args: ['/work/MCP_FIRED'] } },
    }),
  )
}
const markers = (dir: string) =>
  readdirSync(dir).filter((f) => f.startsWith('HOOK_') || f.startsWith('MCP_'))

describe.skipIf(!realChecksEnabled)('本物の Docker と Claude Code CLI', () => {
  beforeAll(async () => {
    await up()
    delete process.env['CLAUDE_REAL_TOKEN']
  }, 60_000)

  afterEach(async () => {
    const ids = await agentContainers()
    if (ids.length > 0) await docker('rm', '-f', ...ids)
  })

  afterAll(async () => {
    await down()
    for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true })
  })

  test(
    '遅れて押し込んだ next が、別の result で答えられる',
    async () => {
      const h = harnessOf()
      await run(
        h,
        Effect.gen(function* () {
          const { receive } = yield* Runtime
          yield* receive(
            inbound(
              'Run exactly one Bash command: `echo step1`. After it returns, reply with exactly the word DONE and nothing else.',
            ),
          )
          yield* until('the tool call', toolCalled)
          yield* Effect.sleep('300 millis')
          yield* receive(inbound('Side question: what is 17+25? Reply with just the number.'))
          yield* until('the turn completed', turnState(0, 'completed'))

          expect(yield* allTurns).toHaveLength(1)
          expect(resultLines(h.lines)).toHaveLength(2)
          const bodies = (yield* finals).map((r) => r.body)
          expect(bodies).toHaveLength(2)
          expect(bodies[1]).toContain('42')
          const inboundRows = yield* allInbound
          expect(inboundRows.map((r) => r.outcome)).toEqual(['answered', 'answered'])
          expect(new Set(inboundRows.map((r) => r.turnId)).size).toBe(1)
        }),
      )
    },
    turnTimeout,
  )

  describe('ホストを関所の中で強制終了する', () => {
    const outcome: { sawContainer: boolean; gone: boolean; sideEffect: boolean } = {
      sawContainer: false,
      gone: false,
      sideEffect: true,
    }

    beforeAll(async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'kurumi-real-kill-'))
      dataDirs.push(dataDir)
      const { CLAUDE_REAL_TOKEN: _token, ...env } = process.env
      const host = Bun.spawn(['bun', join(import.meta.dir, 'kill-host.ts'), dataDir], {
        env,
        stdout: 'inherit',
        stderr: 'inherit',
      })
      while (host.exitCode === null && host.signalCode === null) {
        if ((await agentContainers()).length > 0) outcome.sawContainer = true
        await Bun.sleep(100)
      }
      expect(host.signalCode).toBe('SIGKILL')
      const deadline = Date.now() + 60_000
      while ((await agentContainers()).length > 0 && Date.now() < deadline) await Bun.sleep(250)
      outcome.gone = (await agentContainers()).length === 0
      await Bun.sleep(3_000)
      const sessionsDir = join(dataDir, 'sessions')
      outcome.sideEffect = readdirSync(sessionsDir).some((id) =>
        existsSync(join(sessionsDir, id, 'work', 'sideeffect.txt')),
      )
    }, turnTimeout)

    test('ツールが動かない', () => {
      expect(outcome.sawContainer).toBe(true)
      expect(outcome.sideEffect).toBe(false)
    })

    test('ホストが落ちると、コンテナも止まる', () => {
      expect(outcome.gone).toBe(true)
    })
  })

  test(
    'result の直後にコンテナを捨てても、resume できる',
    async () => {
      const h = harnessOf()
      const word = `TANGERINE-${Math.floor(Math.random() * 1e6)}`
      await run(
        h,
        Effect.gen(function* () {
          const { receive } = yield* Runtime
          yield* receive(inbound(`Remember this codeword: ${word}. Reply with just OK.`))
          yield* until('the first turn', turnState(0, 'completed'))
          expect(yield* Effect.promise(agentContainers)).toEqual([])
          const [before] = yield* allSessions

          yield* receive(
            inbound('What was the codeword I asked you to remember? Reply with just the codeword.'),
          )
          yield* until('the second turn', turnState(1, 'completed'))

          const [after] = yield* allSessions
          expect(after?.status).toBe('active')
          expect(after?.claudeSessionId).toBe(before?.claudeSessionId ?? '')
          expect((yield* finals)[1]?.body).toContain(word)
        }),
      )
    },
    turnTimeout,
  )

  test(
    'cancelQueued が効く（/stop で、待っていた押し込みが実行されない）',
    async () => {
      const h = harnessOf()
      await run(
        h,
        Effect.gen(function* () {
          const { receive } = yield* Runtime
          yield* receive(
            inbound('Run exactly one Bash command: `sleep 30; echo slept`. Then reply DONE.'),
          )
          yield* until('the tool call', toolCalled)
          yield* Effect.sleep('800 millis')
          yield* receive(inbound('Side question: what is 17+25? Reply with just the number.'))
          yield* until(
            'the push was assigned',
            Effect.map(allInbound, (rows) => rows[1]?.turnId != null),
          )
          yield* Effect.sleep('500 millis')
          yield* receive(inbound('/stop'))
          yield* until('the turn stopped', turnState(0, 'interrupted'))

          const cancelled = h.lines.filter((l) => l.state === 'cancelled')
          expect(cancelled).toHaveLength(2)
          const started = h.lines.filter((l) => l.state === 'started')
          expect(new Set(started.map((l) => l.command_uuid)).size).toBe(1)
          expect(resultLines(h.lines)).toHaveLength(1)
          expect((yield* finals).length).toBe(0)
          expect((yield* allInbound).map((r) => r.outcome)).toEqual(['interrupted', 'interrupted'])
          expect((yield* allTurns)[0]?.endReason).toBe('stopped')
        }),
      )
    },
    turnTimeout,
  )

  test(
    '_meta にツール呼び出しの id が入る（送るツールで progress が届く）',
    async () => {
      const h = harnessOf()
      await run(
        h,
        Effect.gen(function* () {
          const { receive } = yield* Runtime
          yield* receive(
            inbound(
              'Do these in order. 1) Call the mcp__kurumi__send_message tool once with text `progress ok`. 2) Reply with exactly one short sentence.',
            ),
          )
          yield* until('the turn', turnState(0, 'completed'))

          const progress = (yield* allOutbound).filter((r) => r.kind === 'progress')
          expect(progress.map((r) => r.body)).toEqual(['progress ok'])
          const key = progress[0]?.idempotencyKey ?? ''
          expect(key).toStartWith('progress:toolu_')
          const toolUseId = key.slice('progress:'.length)
          expect(toolUseIds(h.lines)).toContain(toolUseId)
          const calls = yield* allToolCalls
          expect(calls.find((c) => c.toolUseId === toolUseId)?.toolName).toBe(
            'mcp__kurumi__send_message',
          )
        }),
      )
    },
    turnTimeout,
  )

  test(
    '硬化フラグの下で、1 つのターンが完走する',
    async () => {
      const h = harnessOf()
      await run(
        h,
        Effect.gen(function* () {
          const { receive } = yield* Runtime
          yield* receive(
            inbound(
              'Run exactly one Bash command: `sleep 6; echo hardened > /work/hardened.txt`. Then reply DONE.',
            ),
          )
          yield* until('the tool call', toolCalled)
          const [id] = yield* Effect.promise(agentContainers)
          const host = z
            .record(z.string(), z.unknown())
            .parse(
              JSON.parse(
                yield* Effect.promise(() =>
                  docker('inspect', '--format', '{{json .HostConfig}}', id!),
                ),
              ),
            )
          expect(host['ReadonlyRootfs']).toBe(true)
          expect(host['CapDrop']).toEqual(['ALL'])
          expect(host['PidsLimit']).toBe(256)
          expect(host['Memory']).toBe(2 * 1024 ** 3)
          expect(host['MemorySwap']).toBe(2 * 1024 ** 3)
          expect(host['NanoCpus']).toBe(2e9)
          expect(host['Init']).toBe(true)
          expect(String(host['SecurityOpt'])).toContain('no-new-privileges')

          yield* until('the turn', turnState(0, 'completed'))
          const [session] = yield* allSessions
          expect(readFileSync(join(session!.workspaceDir, 'hardened.txt'), 'utf8')).toBe(
            'hardened\n',
          )
        }),
      )
    },
    turnTimeout,
  )

  test(
    '仕込まれた設定が無視される',
    async () => {
      const h = harnessOf()
      await run(
        h,
        Effect.gen(function* () {
          const { receive } = yield* Runtime
          yield* receive(inbound('Reply with just OK.'))
          yield* until('the first turn', turnState(0, 'completed'))
          const [session] = yield* allSessions
          plantSettings(session!)

          yield* receive(inbound('Run exactly one Bash command: `ls -a /work`. Then reply DONE.'))
          yield* until('the second turn', turnState(1, 'completed'))
          expect(markers(session!.workspaceDir)).toEqual([])
          expect(h.lines.filter((l) => l.subtype?.startsWith('hook_'))).toEqual([])

          // 対照。同じファイルは、設定を読む指定で動く。
          const control = tappedSandbox(dockerSandbox(realDockerConfig))
          yield* Effect.promise(() =>
            askDirectly(
              control.sandbox,
              session!,
              'Run exactly one Bash command: `ls -a /work`. Then reply DONE.',
              { settingSources: ['user', 'project', 'local'] },
            ),
          )
          expect(markers(session!.workspaceDir)).toEqual(
            expect.arrayContaining(['HOOK_project_PreToolUse', 'HOOK_user_PreToolUse']),
          )
        }),
      )
    },
    turnTimeout,
  )

  test(
    'コンテナを止めてから resume すると、照合が通る（/stop の後の次のターンが lost にならない）',
    async () => {
      const h = harnessOf()
      await run(
        h,
        Effect.gen(function* () {
          const { receive } = yield* Runtime
          yield* receive(inbound('Reply with just OK.'))
          yield* until('the first turn', turnState(0, 'completed'))
          yield* receive(inbound('Run exactly one Bash command: `sleep 60`. Then reply DONE.'))
          yield* until('the tool call', toolCalled)
          yield* receive(inbound('/stop'))
          yield* until('the second turn stopped', turnState(1, 'interrupted'))
          expect(yield* Effect.promise(agentContainers)).toEqual([])

          yield* receive(inbound('Reply with just PONG.'))
          yield* until('the third turn', turnState(2, 'completed'))

          expect((yield* allSessions).map((s) => s.status)).toEqual(['active'])
          expect((yield* allTurns).map((t) => t.endReason)).toEqual([null, 'stopped', null])
          expect((yield* finals).at(-1)?.body).toContain('PONG')
        }),
      )
    },
    turnTimeout,
  )

  // 今の Runtime は client_composed を付けないので、/help は CLI のコマンドとして実行される。付けて直すまで失敗が正しい。
  test.failing(
    '/ で始まる利用者の文が、CLI のコマンドとして実行されず、エージェントへの文として扱われる',
    async () => {
      const h = harnessOf()
      await run(
        h,
        Effect.gen(function* () {
          const { receive } = yield* Runtime
          yield* receive(inbound('/help'))
          yield* until(
            'the turn',
            Effect.map(allTurns, (rows) => rows[0]?.state === 'completed'),
          )
          expect(h.lines.some((l) => l.local_command_outcome !== undefined)).toBe(false)
        }),
      )
    },
    turnTimeout,
  )

  test(
    '/ で始まる文は、client_composed を付けるとエージェントへの文として扱われる（対照）',
    async () => {
      const h = harnessOf()
      const dirs = {
        configDir: join(h.config.dataDir, 'cfg'),
        workspaceDir: join(h.config.dataDir, 'work'),
      }
      mkdirSync(dirs.configDir)
      mkdirSync(dirs.workspaceDir)
      const withFlag = await askDirectly(h.config.sandbox, dirs, '/help', { clientComposed: true })
      expect(withFlag).toMatchObject({ subtype: 'success', is_error: false })
      expect(withFlag.num_turns).toBeGreaterThan(0)
      const withoutFlag = await askDirectly(h.config.sandbox, dirs, '/help')
      expect(withoutFlag.num_turns).toBe(0)
    },
    turnTimeout,
  )
})
