import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type HookCallback,
  type Options,
  type Query,
  type SDKUserMessage,
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk'
import { Effect } from 'effect'
import { z } from 'zod'

import type { TurnSandbox } from '../sandbox.ts'
import type { Script } from './fake-cli.ts'
import { type FakeSandbox, fakeSandbox } from './fake-sandbox.ts'

type Msg = Record<string, any>

const timeout = (what: string) =>
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out: ${what}`)), 4_000),
  )

const makeTurn = (): TurnSandbox => {
  const root = mkdtempSync(join(tmpdir(), 'kurumi-fake-cli-'))
  mkdirSync(join(root, 'cfg'))
  mkdirSync(join(root, 'work'))
  return {
    name: `turn-${crypto.randomUUID()}`,
    configDir: join(root, 'cfg'),
    workspaceDir: join(root, 'work'),
    token: 'x',
  }
}

// SDK の型定義に cancelQueued が載っていないので、Reflect.apply の any を zod で受ける。
const InterruptReceipt = z.object({
  cancelled: z.array(z.string()).optional(),
  still_queued: z.array(z.string()).optional(),
})
const interruptCancellingQueued = async (q: Query) =>
  InterruptReceipt.parse(await Reflect.apply(q.interrupt.bind(q), q, [{ cancelQueued: true }]))

type Session = ReturnType<typeof open>
const opened: { session: Session; sandbox: FakeSandbox; turn: TurnSandbox }[] = []

const open = (sandbox: FakeSandbox, options: Options = {}, turn = makeTurn()) => {
  const inbox: SDKUserMessage[] = []
  let wake: (() => void) | undefined
  let closed = false
  async function* input() {
    for (;;) {
      const next = inbox.shift()
      if (next) yield next
      else if (closed) return
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  }
  const q = query({
    prompt: input(),
    options: { spawnClaudeCodeProcess: (o) => sandbox.spawn(turn, o), ...options },
  })
  const messages: Msg[] = []
  let failure: unknown
  const done = (async () => {
    try {
      for await (const m of q) messages.push(m)
    } catch (error) {
      failure = error
    }
  })()
  const session = {
    q,
    turn,
    messages,
    done,
    failure: () => failure,
    push(text: string, priority?: 'next') {
      const uuid = crypto.randomUUID()
      inbox.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        uuid,
        ...(priority ? { priority } : {}),
      })
      wake?.()
      return uuid
    },
    end() {
      closed = true
      wake?.()
    },
    async waitFor(match: (m: Msg) => boolean, count = 1) {
      await Promise.race([
        (async () => {
          while (messages.filter(match).length < count) await Bun.sleep(5)
        })(),
        timeout('message'),
      ])
    },
    of: (type: string) => messages.filter((m) => m['type'] === type),
    lifecycle: (uuid: string) =>
      messages
        .filter((m) => m['type'] === 'command_lifecycle' && m['command_uuid'] === uuid)
        .map((m) => m['state']),
  }
  opened.push({ session, sandbox, turn })
  return session
}

const MetaOf = z.object({ _meta: z.record(z.string(), z.unknown()).optional() })

const isResult = (m: Msg) => m['type'] === 'result'
const toolResults = (s: Session) =>
  s
    .of('user')
    .flatMap((m) => m['message'].content)
    .filter((c: Msg) => c['type'] === 'tool_result')
const toolUseIds = (s: Session) =>
  s
    .of('assistant')
    .flatMap((m) => m['message'].content)
    .filter((c: Msg) => c['type'] === 'tool_use')
    .map((c: Msg) => c['id'])

afterEach(async () => {
  for (const { session, sandbox, turn } of opened.splice(0)) {
    session.end()
    session.q.close()
    await Effect.runPromise(sandbox.dispose(turn))
    expect(sandbox.alive()).toBe(0)
  }
})

const one = (first: Script['first'], next?: Script['next']) =>
  fakeSandbox(() => ({ first, ...(next ? { next } : {}) }))

const hookOptions = (hook: HookCallback): Options => ({
  hooks: { PreToolUse: [{ hooks: [hook], timeout: 60, onFailure: 'block' }] },
})
const proof = (s: Session) => join(s.turn.workspaceDir, 'proof.txt')
const scenario = () => {
  const sandbox = one(
    {
      steps: [
        { kind: 'tool', name: 'Bash' },
        { kind: 'park', name: 'after-tool' },
        { kind: 'say', text: 'first done' },
      ],
    },
    { steps: [{ kind: 'say', text: 'second done' }] },
  )
  return { sandbox, s: open(sandbox) }
}

describe('fake CLI over the real SDK', () => {
  test('completes the initialize handshake and answers with a result', async () => {
    const sandbox = one({ steps: [{ kind: 'say', text: 'hello' }] })
    const s = open(sandbox)
    const uuid = s.push('hi')
    await s.waitFor(isResult)
    expect(s.of('result')[0]).toMatchObject({
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      result: 'hello',
      user_message_uuids: [uuid],
    })
    await s.waitFor((m) => m['type'] === 'command_lifecycle' && m['state'] === 'completed')
    expect(s.lifecycle(uuid)).toEqual(['queued', 'started', 'completed'])
    expect(s.of('system')[0]).toMatchObject({ subtype: 'init' })
  })

  test('reports is_error results with the chosen terminal_reason', async () => {
    const sandbox = one({ steps: [], finish: { isError: true, terminalReason: 'api_error' } })
    const s = open(sandbox)
    s.push('hi')
    await s.waitFor(isResult)
    expect(s.of('result')[0]).toMatchObject({
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
    })
  })

  describe('PreToolUse hook', () => {
    const bash = {
      kind: 'tool',
      name: 'Bash',
      input: { command: 'echo hi' },
      output: 'hi',
      writes: { path: 'proof.txt', content: 'ran' },
    } as const

    test('delays the tool result until the host answers', async () => {
      const sandbox = one({ steps: [bash] })
      const hookCalled = Promise.withResolvers<unknown>()
      const answer = Promise.withResolvers<void>()
      const s = open(
        sandbox,
        hookOptions(async (input) => {
          hookCalled.resolve(input)
          await answer.promise
          return {
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
          }
        }),
      )
      s.push('go')
      expect(await Promise.race([hookCalled.promise, timeout('hook')])).toMatchObject({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
      })
      await Bun.sleep(50)
      expect(toolResults(s)).toEqual([])
      expect(existsSync(proof(s))).toBe(false)
      answer.resolve()
      await s.waitFor(isResult)
      expect(toolResults(s)).toMatchObject([{ content: 'hi', is_error: false }])
      expect(readFileSync(proof(s), 'utf8')).toBe('ran')
    })

    test('does not run the tool when the host denies it', async () => {
      const sandbox = one({ steps: [bash] })
      const s = open(
        sandbox,
        hookOptions(async () => ({
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
        })),
      )
      s.push('go')
      await s.waitFor(isResult)
      expect(toolResults(s)).toMatchObject([{ is_error: true }])
      expect(existsSync(proof(s))).toBe(false)
    })
  })

  test('passes the tool_use id to the host MCP tool handler as _meta', async () => {
    const seen = Promise.withResolvers<Record<string, unknown> | undefined>()
    const server = createSdkMcpServer({
      name: 'kurumi',
      tools: [
        tool('send_message', 'send', { text: z.string() }, async (args, extra) => {
          seen.resolve(MetaOf.parse(extra)['_meta'])
          return { content: [{ type: 'text', text: `sent ${args.text}` }] }
        }),
      ],
    })
    const sandbox = one({
      steps: [{ kind: 'tool', name: 'mcp__kurumi__send_message', input: { text: 'progress' } }],
    })
    const s = open(sandbox, { mcpServers: { kurumi: server } })
    s.push('go')
    await s.waitFor(isResult)
    const [id] = toolUseIds(s)
    expect((await seen.promise)?.['claudecode/toolUseId']).toBe(id)
    expect(toolResults(s)).toMatchObject([
      { tool_use_id: id, content: [{ type: 'text', text: 'sent progress' }], is_error: false },
    ])
  })

  test('lets the script choose the tool_use id and drop _meta from MCP calls', async () => {
    const metas: unknown[] = []
    const server = createSdkMcpServer({
      name: 'kurumi',
      tools: [
        tool('send_message', 'send', { text: z.string() }, async (_args, extra) => {
          metas.push(MetaOf.parse(extra)['_meta'])
          return { content: [{ type: 'text', text: 'sent' }] }
        }),
      ],
    })
    const send = { kind: 'tool', name: 'mcp__kurumi__send_message', input: { text: 'p' } } as const
    const sandbox = one({
      steps: [
        { ...send, id: 'toolu_same' },
        { ...send, id: 'toolu_same' },
        { ...send, dropMeta: true },
      ],
    })
    const s = open(sandbox, { mcpServers: { kurumi: server } })
    s.push('go')
    await s.waitFor(isResult)
    expect(toolUseIds(s).slice(0, 2)).toEqual(['toolu_same', 'toolu_same'])
    expect(metas).toMatchObject([
      { 'claudecode/toolUseId': 'toolu_same' },
      { 'claudecode/toolUseId': 'toolu_same' },
      undefined,
    ])
  })

  describe('priority: next', () => {
    test('answers a pushed message in a separate result and completes its lifecycle', async () => {
      const { sandbox, s } = scenario()
      const first = s.push('go')
      await sandbox.gate(0).reached('after-tool')
      const pushed = s.push('side', 'next')
      await s.waitFor((m) => m['command_uuid'] === pushed && m['state'] === 'queued')
      sandbox.gate(0).release('after-tool')
      await s.waitFor(isResult, 2)
      await s.waitFor((m) => m['command_uuid'] === pushed && m['state'] === 'completed')
      expect(s.of('result').map((r) => [r['result'], r['user_message_uuids']])).toEqual([
        ['first done', [first]],
        ['second done', [pushed]],
      ])
      expect(s.lifecycle(pushed)).toEqual(['queued', 'started', 'completed'])
      expect(s.lifecycle(first)).toEqual(['queued', 'started', 'completed'])
    })

    test('interrupt({ cancelQueued: true }) cancels the pushed message and ends the running turn in an error', async () => {
      const { sandbox, s } = scenario()
      const first = s.push('go')
      await sandbox.gate(0).reached('after-tool')
      const pushed = s.push('side', 'next')
      await s.waitFor((m) => m['command_uuid'] === pushed && m['state'] === 'queued')
      expect(await interruptCancellingQueued(s.q)).toMatchObject({
        still_queued: [],
        cancelled: [pushed],
      })
      await s.waitFor(isResult)
      await s.waitFor((m) => m['command_uuid'] === first && m['state'] === 'cancelled')
      expect(s.lifecycle(pushed)).toEqual(['queued', 'cancelled'])
      expect(s.of('result')).toHaveLength(1)
      expect(s.of('result')[0]).toMatchObject({
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_tools',
      })
    })
  })

  describe('--resume', () => {
    test('continues the recorded session and appends to its transcript', async () => {
      const sandbox = one({ steps: [{ kind: 'say', text: 'one' }] })
      const turn = makeTurn()
      const a = open(sandbox, {}, turn)
      const firstUuid = a.push('hi')
      await a.waitFor(isResult)
      const sessionId = a.of('result')[0]!['session_id']
      const transcript = () => {
        const dir = join(
          turn.configDir,
          'projects',
          readdirSync(join(turn.configDir, 'projects'))[0]!,
        )
        return readFileSync(join(dir, `${sessionId}.jsonl`), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      }
      const lastAssistant = a.of('assistant').at(-1)!['uuid']
      expect(transcript().map((r) => r.uuid)).toEqual([firstUuid, lastAssistant])
      a.end()
      await a.done

      const b = open(sandbox, { resume: sessionId }, turn)
      const secondUuid = b.push('again')
      await b.waitFor(isResult)
      expect(sandbox.spawns.map((x) => x.resume)).toEqual([false, true])
      expect(b.of('result')[0]).toMatchObject({ session_id: sessionId, is_error: false })
      expect(transcript().map((r) => r.uuid)).toContain(secondUuid)
    })

    test('fails with "No conversation found" when there is no transcript', async () => {
      const sandbox = one({ steps: [{ kind: 'say', text: 'unused' }] })
      const s = open(sandbox, { resume: crypto.randomUUID() })
      s.push('hi')
      await s.waitFor(isResult)
      expect(s.of('result')[0]).toMatchObject({
        subtype: 'error_during_execution',
        is_error: true,
        errors: [expect.stringContaining('No conversation found')],
      })
      expect(s.of('system')).toEqual([])
    })
  })

  test('surfaces a crash mid-turn as an exception from the SDK iterator', async () => {
    const sandbox = one({
      steps: [
        { kind: 'say', text: 'about to die' },
        { kind: 'crash', code: 134 },
      ],
    })
    const s = open(sandbox)
    s.push('hi')
    await Promise.race([s.done, timeout('iterator')])
    expect(String(s.failure())).toContain('134')
    expect(s.of('result')).toEqual([])
  })

  test('dispose can be held open, then kills the child', async () => {
    const sandbox = one({ steps: [{ kind: 'hang' }] })
    const s = open(sandbox)
    s.push('hi')
    await s.waitFor((m) => m['type'] === 'system')
    const hold = sandbox.holdDispose()
    const disposing = Effect.runPromise(sandbox.dispose(s.turn))
    await hold.entered
    expect(sandbox.disposed).toEqual([s.turn])
    expect(sandbox.alive()).toBe(1)
    hold.release()
    await disposing
    expect(sandbox.alive()).toBe(0)
  })
})
