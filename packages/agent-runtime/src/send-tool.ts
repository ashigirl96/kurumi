import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { Effect } from 'effect'
import { z } from 'zod'

import type { TurnId } from './schema.ts'
import { type AgentRuntimeDb, insertOutbound } from './store.ts'

// 型定義に載っていない欄なので、境目で形を検査して版の食い違いを黙って隠さない。
const ToolCallMeta = z.object({ _meta: z.object({ 'claudecode/toolUseId': z.string() }) })

export const sendMessageServer = (turn: {
  readonly sessionId: string
  readonly turnId: TurnId
  readonly notifyOutbound: Effect.Effect<void>
  readonly run: <A, E>(effect: Effect.Effect<A, E, AgentRuntimeDb>) => Promise<A>
}) =>
  createSdkMcpServer({
    name: 'kurumi',
    tools: [
      tool(
        'send_message',
        'Send a progress message to the user while you keep working. Your final answer is delivered automatically, so write it as your last text instead of sending it here.',
        { text: z.string().min(1) },
        async ({ text }, extra) => {
          const meta = ToolCallMeta.safeParse(extra)
          if (!meta.success) {
            return {
              isError: true,
              content: [
                { type: 'text', text: 'The tool call id was missing, so nothing was sent.' },
              ],
            }
          }
          await turn.run(
            insertOutbound({
              sessionId: turn.sessionId,
              turnId: turn.turnId,
              kind: 'progress',
              body: text,
              idempotencyKey: `progress:${meta.data['_meta']['claudecode/toolUseId']}`,
            }).pipe(Effect.andThen(turn.notifyOutbound)),
          )
          return { content: [{ type: 'text', text: 'sent' }] }
        },
      ),
    ],
  })
