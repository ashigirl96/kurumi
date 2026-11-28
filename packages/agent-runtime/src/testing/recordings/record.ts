import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// 本物の Claude Code CLI を dockerSandbox と開発用の中継で動かし、SDK と CLI の間の行を JSONL に記録する。
// 使い方: CLAUDE_REAL_TOKEN=<本物のトークン> bun record.ts [a] [b] [c]
import { PassThrough } from 'node:stream'

import {
  type HookCallback,
  type Options,
  type SDKUserMessage,
  type SpawnedProcess,
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk'
import { Effect } from 'effect'
import { z } from 'zod'

import { agentImage, down, internalNetwork, relayUrl, up } from '../../real/dev-env.ts'
import { fakeTokenPrefix } from '../../real/dev-relay.ts'
import { dockerSandbox } from '../../sandbox.ts'

type Direction = 'sdk->cli' | 'cli->sdk'
type Entry = { t: string; dir: Direction | 'spawn' | 'exit'; [key: string]: unknown }

const Line = z.looseObject({
  type: z.string().optional(),
  subtype: z.string().optional(),
  message: z.looseObject({ content: z.unknown() }).optional(),
})
type Line = z.infer<typeof Line>
const Blocks = z.array(z.looseObject({ type: z.string() }))

const hasBlock = (line: Line, type: string) =>
  Blocks.safeParse(line.message?.content).data?.some((b) => b.type === type) ?? false

const isResult = (l: Line) => l.type === 'result'
const isToolUse = (l: Line) => l.type === 'assistant' && hasBlock(l, 'tool_use')
const isToolResult = (l: Line) => l.type === 'user' && hasBlock(l, 'tool_result')

const sandbox = dockerSandbox({
  image: agentImage,
  network: internalNetwork,
  anthropicBaseUrl: relayUrl,
  user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
})

const lineSplitter = (emit: (line: string) => void) => {
  let rest = ''
  return (chunk: Buffer | string) => {
    rest += chunk.toString()
    const lines = rest.split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') emit(line)
  }
}

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

const gate: HookCallback = async () => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
})

const sendMessage = createSdkMcpServer({
  name: 'kurumi',
  tools: [
    tool(
      'send_message',
      'Send a progress message to the user.',
      { text: z.string().min(1) },
      async () => ({
        content: [{ type: 'text', text: 'sent' }],
      }),
    ),
  ],
})

type Api = {
  push(text: string, priority?: 'now' | 'next' | 'later'): string
  interrupt(): Promise<unknown>
  waitFor(match: (l: Line) => boolean, count?: number, timeoutMs?: number): Promise<void>
}

type Scenario = { extra?: Partial<Options>; run(api: Api): Promise<void> }

const side = 'Side question: what is 17+25? Reply with just the number.'

const scenarios: Record<string, Scenario> = {
  a: {
    extra: {
      hooks: { PreToolUse: [{ hooks: [gate], timeout: 60, onFailure: 'block' }] },
      mcpServers: { kurumi: sendMessage },
    },
    async run(api) {
      api.push(
        'Do these in order. 1) Run exactly one Bash command: `echo step1`. 2) Call the mcp__kurumi__send_message tool once with text `progress ok`. 3) Reply with exactly one short sentence.',
      )
      await api.waitFor(isResult)
    },
  },
  b: {
    async run(api) {
      api.push(
        'Run exactly one Bash command: `echo step1`. After it returns, reply with exactly the word DONE and nothing else.',
      )
      await api.waitFor(isToolResult)
      api.push(side, 'next')
      await api.waitFor(isResult, 2)
    },
  },
  c: {
    async run(api) {
      api.push('Run exactly one Bash command: `sleep 20; echo slept`. Then reply DONE.')
      await api.waitFor(isToolUse)
      await Bun.sleep(800)
      api.push(side, 'next')
      await Bun.sleep(500)
      await api.interrupt()
      await api.waitFor(isResult)
      await Bun.sleep(1500)
    },
  },
}

const record = async (name: string, scenario: Scenario) => {
  const root = await mkdtemp(join(tmpdir(), `kurumi-rec-${name}-`))
  const configDir = join(root, 'cfg')
  const workspaceDir = join(root, 'work')
  await mkdir(configDir)
  await mkdir(workspaceDir)
  const turn = {
    name: `kurumi-rec-${name}-${Date.now()}`,
    configDir,
    workspaceDir,
    token: `${fakeTokenPrefix}${crypto.randomUUID()}`,
  }

  const entries: Entry[] = []
  const lines: Line[] = []
  const listeners = new Set<() => void>()
  const add = (dir: Direction, raw: string) => {
    const msg = parse(raw)
    entries.push({ t: new Date().toISOString(), dir, msg })
    const line = Line.safeParse(msg)
    if (dir === 'cli->sdk' && line.success) lines.push(line.data)
    for (const l of listeners) l()
  }

  let exited: Promise<void> = Promise.resolve()
  const spawnTee = (
    options: Parameters<NonNullable<Options['spawnClaudeCodeProcess']>>[0],
  ): SpawnedProcess => {
    entries.push({ t: new Date().toISOString(), dir: 'spawn', cliArgs: options.args })
    const child = sandbox.spawn(turn, options)
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    stdin.on(
      'data',
      lineSplitter((l) => add('sdk->cli', l)),
    )
    child.stdout.on(
      'data',
      lineSplitter((l) => add('cli->sdk', l)),
    )
    stdin.pipe(child.stdin)
    child.stdout.pipe(stdout)
    exited = new Promise((resolve) =>
      child.on('exit', (code, signal) => {
        entries.push({ t: new Date().toISOString(), dir: 'exit', code, signal })
        resolve()
      }),
    )
    return {
      stdin,
      stdout,
      get killed() {
        return child.killed
      },
      get exitCode() {
        return child.exitCode
      },
      kill: (signal) => child.kill(signal),
      on: child.on.bind(child),
      once: child.once.bind(child),
      off: child.off.bind(child),
    }
  }

  const queue: SDKUserMessage[] = []
  const waker: { wake: () => void } = { wake: () => {} }
  let closed = false
  async function* input() {
    while (true) {
      const next = queue.shift()
      if (next) yield next
      else if (closed) return
      else await new Promise<void>((resolve) => (waker.wake = resolve))
    }
  }

  const q = query({
    prompt: input(),
    options: {
      cwd: '/work',
      model: 'haiku',
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      disallowedTools: [
        'CronCreate',
        'CronDelete',
        'CronList',
        'ScheduleWakeup',
        'RemoteTrigger',
        'PushNotification',
        'Monitor',
      ],
      spawnClaudeCodeProcess: spawnTee,
      ...scenario.extra,
    },
  })
  const interrupt: (options: { cancelQueued: boolean }) => Promise<unknown> = q.interrupt.bind(q)
  const drain = (async () => {
    const messages = q[Symbol.asyncIterator]()
    while (!(await messages.next()).done);
  })()

  const api: Api = {
    push(text, priority) {
      const uuid = crypto.randomUUID()
      queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        uuid,
        ...(priority ? { priority } : {}),
      })
      waker.wake()
      return uuid
    },
    interrupt: () => interrupt({ cancelQueued: true }),
    waitFor: (match, count = 1, timeoutMs = 120_000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (lines.filter(match).length < count) return
          listeners.delete(check)
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          listeners.delete(check)
          reject(new Error(`${name}: timed out waiting for the stream`))
        }, timeoutMs)
        listeners.add(check)
        check()
      }),
  }

  try {
    await scenario.run(api)
  } finally {
    closed = true
    q.close()
    waker.wake()
    await Promise.race([exited, Bun.sleep(10_000)])
    await Effect.runPromise(sandbox.dispose(turn))
    await Promise.race([drain, Bun.sleep(2_000)])
  }
  return entries
}

const summarize = (entries: Entry[]) => {
  const cli = entries.filter((e) => e.dir === 'cli->sdk').map((e) => Line.safeParse(e['msg']).data)
  const results = cli.filter((l) => l?.type === 'result').length
  const lifecycles = cli
    .filter((l) => l?.type === 'command_lifecycle')
    .map((l) => z.looseObject({ state: z.string() }).safeParse(l).data?.state)
  return { lines: entries.length, results, lifecycles }
}

if (import.meta.main) {
  const names = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(scenarios)
  await up()
  try {
    for (const name of names) {
      const scenario = scenarios[name]
      if (!scenario) throw new Error(`unknown scenario ${name}`)
      const entries = await record(name, scenario)
      await writeFile(
        join(import.meta.dir, `${name}.jsonl`),
        `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
      )
      console.log(name, JSON.stringify(summarize(entries)))
    }
  } finally {
    await down()
  }
}
