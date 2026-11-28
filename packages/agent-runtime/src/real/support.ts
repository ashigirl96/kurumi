import { execFile } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'

import { type SDKUserMessage, type SpawnedProcess, query } from '@anthropic-ai/claude-agent-sdk'
import { Effect } from 'effect'
import { z } from 'zod'

import type { Sandbox } from '../sandbox.ts'
import { dockerSandbox } from '../sandbox.ts'
import { harness } from '../testing/harness.ts'
import { agentImage, internalNetwork, relayUrl } from './dev-env.ts'

const execFileAsync = promisify(execFile)

export const realChecksEnabled = process.env['KURUMI_REAL_CHECKS'] === '1'

/** 利用者の本物のコンテナを、`sweep` が巻き込まないようにする専用のラベル */
export const realLabel = 'kurumi.agent=real-checks'

export const realDockerConfig = {
  image: agentImage,
  network: internalNetwork,
  anthropicBaseUrl: relayUrl,
  user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  label: realLabel,
}

export const Line = z.looseObject({
  type: z.string().optional(),
  subtype: z.string().optional(),
  state: z.string().optional(),
  command_uuid: z.string().optional(),
  result: z.string().optional(),
  is_error: z.boolean().optional(),
  local_command_outcome: z.unknown().optional(),
  terminal_reason: z.string().optional(),
  message: z.looseObject({ content: z.unknown() }).optional(),
})
export type Line = z.infer<typeof Line>

const ToolUseBlocks = z.array(z.looseObject({ type: z.string(), id: z.string().optional() }))

export const toolUseIds = (lines: readonly Line[]) =>
  lines
    .filter((l) => l.type === 'assistant')
    .flatMap((l) => ToolUseBlocks.safeParse(l.message?.content).data ?? [])
    .filter((b) => b.type === 'tool_use')
    .flatMap((b) => (b.id === undefined ? [] : [b.id]))

/** CLI が stdout に出した行を、SDK に渡しながら控える。Runtime から見える動きは変えない */
export const tappedSandbox = (inner: Sandbox) => {
  const lines: Line[] = []
  const sandbox: Sandbox = {
    ...inner,
    spawn: (turn, options) => {
      const child = inner.spawn(turn, options)
      const stdout = new PassThrough()
      let rest = ''
      child.stdout.on('data', (chunk: Buffer | string) => {
        rest += chunk.toString()
        const complete = rest.split('\n')
        rest = complete.pop() ?? ''
        for (const raw of complete) {
          try {
            const parsed = Line.safeParse(JSON.parse(raw))
            if (parsed.success) lines.push(parsed.data)
          } catch {
            // JSON でない行は控えない
          }
        }
      })
      child.stdout.pipe(stdout)
      return {
        stdin: child.stdin,
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
      } satisfies SpawnedProcess
    },
  }
  return { sandbox, lines }
}

/** 本物の Docker と haiku で動く Runtime の道具。`testing/harness.ts` の組み立てに、控えつきの Sandbox を渡す */
export const realHarness = () => {
  const { sandbox, lines } = tappedSandbox(dockerSandbox(realDockerConfig))
  return { ...harness(() => ({ first: { steps: [] } }), { sandbox, model: 'haiku' }), lines }
}

export const until = <R>(
  what: string,
  check: Effect.Effect<boolean, unknown, R>,
  timeoutMs = 120_000,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (yield* check) return
      if (Date.now() > deadline) yield* Effect.die(new Error(`timed out: ${what}`))
      yield* Effect.sleep('200 millis')
    }
  })

export const docker = async (...args: string[]) =>
  (await execFileAsync('docker', args)).stdout.trim()

export const agentContainers = () =>
  docker('ps', '-aq', '--filter', `label=${realLabel}`).then((out) =>
    out.split('\n').filter(Boolean),
  )

/** Runtime を通さずに、本物のコンテナで 1 つの質問に答えさせる。Runtime の設定では試せない `settingSources` の対照に使う */
export const askDirectly = async (
  sandbox: Sandbox,
  dirs: { configDir: string; workspaceDir: string },
  prompt: string,
  options: { settingSources?: ('user' | 'project' | 'local')[]; clientComposed?: true } = {},
) => {
  const turn = {
    name: `kurumi-real-control-${crypto.randomUUID()}`,
    ...dirs,
    token: `kurumi-fake-${crypto.randomUUID()}`,
  }
  const message: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
    ...(options.clientComposed ? { client_composed: true } : {}),
  }
  const q = query({
    prompt: (async function* () {
      yield message
      await new Promise(() => {})
    })(),
    options: {
      cwd: '/work',
      model: 'haiku',
      settingSources: options.settingSources ?? [],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      spawnClaudeCodeProcess: (spawnOptions) => sandbox.spawn(turn, spawnOptions),
    },
  })
  try {
    for await (const output of q) if (output.type === 'result') return output
  } finally {
    q.close()
    await Effect.runPromise(sandbox.dispose(turn))
  }
  throw new Error('the CLI ended without a result')
}
