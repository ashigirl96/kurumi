// Kurumi's real Runtime (in-memory DB) with Kurumi's real docker args. `attacker` swaps only the
// command (`claude` -> `bun /work/.attack/attacker-cli.ts`); `real` runs the real CLI.
import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Effect, Layer } from 'effect'

import { type ApprovalRequest, type OutboundToDeliver, Runtime, type RuntimeApi } from '../repo/packages/agent-runtime/src/runtime.ts'
import { type Sandbox, dockerClientEnv, dockerRunArgs, dockerSandbox } from '../repo/packages/agent-runtime/src/sandbox.ts'
import { inboundMessages, outboundMessages, sessions, toolCalls, turns } from '../repo/packages/agent-runtime/src/schema.ts'
import { AgentRuntimeDb } from '../repo/packages/agent-runtime/src/store.ts'
import { testDbLayer } from '../repo/packages/agent-runtime/src/testing/db.ts'
import { here, labConfig, outDir } from './lab.ts'

export type Lab = {
  readonly api: RuntimeApi
  readonly approvals: ApprovalRequest[]
  readonly delivered: OutboundToDeliver[]
  readonly spawns: string[][]
  readonly send: (body: string) => Promise<string>
  readonly waitTurns: (n: number) => Promise<void>
  readonly tables: () => Promise<Record<string, unknown>>
}

let seq = 0
export const withLab = (
  mode: 'attacker' | 'real',
  policy: (call: { toolName: string; input: unknown }) => 'allow' | 'deny' | 'ask',
  body: (lab: Lab) => Promise<void>,
  scenarios: string[] = [],
  plant?: (workspaceDir: string) => void,
) => {
  const approvals: ApprovalRequest[] = []
  const delivered: OutboundToDeliver[] = []
  const spawns: string[][] = []
  const base = dockerSandbox(labConfig)
  const sandbox: Sandbox = {
    ...base,
    spawn: (turn, options) => {
      const args = dockerRunArgs(labConfig, turn, options)
      const at = args.indexOf(labConfig.image) + 1
      const cmd = mode === 'attacker' ? [...args.slice(0, at), 'bun', '/work/.attack/attacker-cli.ts', ...args.slice(at + 1)] : args
      // Stands in for what an earlier compromised turn left in the persisted workspace.
      cpSync(join(here, 'fakes'), join(turn.workspaceDir, '.attack'), { recursive: true })
      writeFileSync(join(turn.workspaceDir, '.attack', 'scenario'), scenarios[spawns.length] ?? 'none')
      plant?.(turn.workspaceDir)
      spawns.push(cmd)
      return spawn('docker', cmd, { env: dockerClientEnv(labConfig, turn, options), stdio: ['pipe', 'pipe', 'inherit'], signal: options.signal })
    },
  }
  let api: RuntimeApi
  const layer = Runtime.layer({
    dataDir: mkdtempSync(join(outDir, `data-${mode}-`)),
    agent: 'premise',
    sandbox,
    channels: { chat: (m) => Effect.sync(() => void delivered.push(m)) },
    policy,
    approvalTimeout: '20 seconds',
    turnTimeout: '90 seconds',
    onApprovalRequest: (request) =>
      Effect.sync(() => {
        approvals.push(request)
        // The fake human approves whatever they are shown.
        setTimeout(() => void Effect.runPromise(api.answerApproval(request.id, 'allow')), 100)
      }),
  }).pipe(Layer.provideMerge(testDbLayer))

  return Effect.runPromise(
    Effect.gen(function* () {
      api = yield* Runtime
      const db = yield* AgentRuntimeDb
      const ctx = yield* Effect.context<AgentRuntimeDb>()
      const run = Effect.runPromiseWith(ctx)
      const lab: Lab = {
        api,
        approvals,
        delivered,
        spawns,
        send: (text) =>
          Effect.runPromise(
            api.receive({ channel: 'chat', conversation: mode, platformMessageId: `m${++seq}`, sender: 'user', body: text, receivedAt: new Date() }),
          ),
        waitTurns: async (n) => {
          for (let i = 0; i < 1200; i++) {
            const rows = await run(db.select().from(turns))
            if (rows.length >= n && rows.slice(0, n).every((t) => ['completed', 'failed', 'interrupted'].includes(t.state))) {
              await Bun.sleep(500)
              return
            }
            await Bun.sleep(100)
          }
          throw new Error(`timed out waiting for ${n} turns`)
        },
        tables: async () => ({
          sessions: await run(db.select().from(sessions)),
          turns: await run(db.select().from(turns)),
          tool_calls: await run(db.select().from(toolCalls)),
          outbound_messages: await run(db.select().from(outboundMessages)),
          inbound_messages: await run(db.select().from(inboundMessages)),
        }),
      }
      yield* Effect.promise(() => body(lab))
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}
