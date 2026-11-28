// H1 harness only (not Kurumi code): a host MCP broker tool that holds a write credential.
// BROKER_MODE=hook    the PreToolUse gate asked the human; the handler executes the args it receives when
//                     a tool_calls row exists for the claimed toolUseId (approval bound to the id).
// BROKER_MODE=handler the handler asks the human with the parsed args and executes that same frozen object
//                     (approval bound to the args object; the claimed id is only a label).
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { z } from 'zod'

import type { ToolCall } from './gate.ts'
import { toolCalls } from './schema.ts'
import { AgentRuntimeDb } from './store.ts'

type Run = <A, E>(effect: Effect.Effect<A, E, AgentRuntimeDb>) => Promise<A>
type Gate = (call: ToolCall) => Effect.Effect<'allow' | 'deny', unknown, AgentRuntimeDb>

const claimedId = (extra: unknown) =>
  (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.['claudecode/toolUseId'] as string | undefined

const refuse = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

export const brokerServer = (turn: { readonly gate: Gate; readonly run: Run }) =>
  createSdkMcpServer({
    name: 'broker',
    tools: [
      tool('github_create_issue', 'Create an issue in a/b', { title: z.string(), body: z.string() }, async (args, extra) => {
        const mode = process.env['BROKER_MODE']
        const claimed = claimedId(extra)
        let executed: { readonly title: string; readonly body: string }
        let approvalId: string
        if (mode === 'hook') {
          if (claimed === undefined) return refuse('no tool call id')
          const rows = await turn.run(
            Effect.gen(function* () {
              const db = yield* AgentRuntimeDb
              return yield* db.select().from(toolCalls).where(eq(toolCalls.toolUseId, claimed))
            }),
          )
          if (rows.length === 0) return refuse('no approved tool call for this id')
          executed = args
          approvalId = claimed
        } else {
          executed = Object.freeze({ title: args.title, body: args.body })
          approvalId = `broker:${crypto.randomUUID()}`
          const verdict = await turn.run(turn.gate({ toolName: 'broker:github_create_issue', toolUseId: approvalId, input: executed }))
          if (verdict === 'deny') return refuse('the human did not approve this call')
        }
        const res = await fetch(`${process.env['BROKER_GH_URL']}/repos/a/b/issues`, {
          method: 'POST',
          headers: { authorization: `Bearer ${process.env['BROKER_GH_TOKEN']}`, 'content-type': 'application/json' },
          body: JSON.stringify(executed),
          tls: { ca: Bun.file(process.env['BROKER_CA'] ?? '') },
        } as RequestInit)
        console.log(JSON.stringify({ broker: 'executed', mode, claimedToolUseId: claimed ?? null, approvalId, executed, status: res.status }))
        return { content: [{ type: 'text', text: `created: ${await res.text()}` }] }
      }),
    ],
  })
