import { type SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk'
import { Data, Effect, Option, Ref, Stream } from 'effect'
import { z } from 'zod'

import type { Sandbox, TurnSandbox } from './sandbox.ts'
import type { TurnId } from './schema.ts'
import {
  type AgentRuntimeDb,
  type InboundRow,
  type SessionRow,
  type StoreError,
  closeTurn,
  createTurn,
  insertOutbound,
  setClaudeSessionId,
  transitionTurn,
} from './store.ts'

export type TurnGrant = {
  readonly token: string
  readonly channel: string
  readonly conversation: string
  readonly sessionId: string
  readonly turnId: TurnId
}

export type TurnDeps = {
  readonly sandbox: Sandbox
  readonly register?: (grant: TurnGrant) => Effect.Effect<void>
  readonly model?: string
  readonly notifyOutbound: Effect.Effect<void>
}

class SdkStreamFailed extends Data.TaggedError('SdkStreamFailed')<{ readonly cause: unknown }> {}

type CommandState = 'accepted' | 'queued' | 'started' | 'completed' | 'cancelled'

export type TurnProgress = {
  readonly phase: 'running' | 'closing'
  /** 最後に届いたのが result でなければ true */
  readonly awaitingResult: boolean
  /** ターン中に押し込んだ受信の uuid と状態。最初の入力は含めない */
  readonly pushed: ReadonlyMap<string, CommandState>
  readonly openApprovals: number
  /** 届いた result の数。final の冪等キーに使う */
  readonly cliTurns: number
  readonly lastAssistantUuid: string | null
}

export type TurnEvent =
  | { readonly type: 'accepted'; readonly uuid: string }
  | {
      readonly type: 'lifecycle'
      readonly uuid: string
      readonly state: 'queued' | 'started' | 'completed' | 'cancelled'
    }
  | { readonly type: 'assistant'; readonly uuid: string }
  | { readonly type: 'result'; readonly isError: boolean; readonly text: string }
  | { readonly type: 'approval-opened' }
  | { readonly type: 'approval-closed' }

export type TurnEnd =
  | { readonly _tag: 'Completed' }
  | { readonly _tag: 'Failed'; readonly terminalReason: string | null }
  | {
      readonly _tag: 'Interrupted'
      readonly reason: 'stopped' | 'timeout' | 'sandbox_exit' | 'host_stopped'
    }

export const initialProgress: TurnProgress = {
  phase: 'running',
  awaitingResult: true,
  pushed: new Map(),
  openApprovals: 0,
  cliTurns: 0,
  lastAssistantUuid: null,
}

const withPushed = (p: TurnProgress, uuid: string, state: CommandState): TurnProgress =>
  p.pushed.has(uuid) || state === 'accepted'
    ? { ...p, pushed: new Map(p.pushed).set(uuid, state) }
    : p

const step = (p: TurnProgress, e: TurnEvent): TurnProgress => {
  switch (e.type) {
    case 'accepted':
      return withPushed(p, e.uuid, 'accepted')
    case 'lifecycle':
      return withPushed(p, e.uuid, e.state)
    case 'assistant':
      return { ...p, awaitingResult: true, lastAssistantUuid: e.uuid }
    case 'result':
      return { ...p, awaitingResult: false, cliTurns: p.cliTurns + 1 }
    case 'approval-opened':
      return { ...p, openApprovals: p.openApprovals + 1 }
    default:
      return { ...p, openApprovals: p.openApprovals - 1 }
  }
}

const settled = (state: CommandState) => state === 'completed' || state === 'cancelled'

/** phase は running で 3 条件がそろうと closing になり、戻らない */
export const advance = (p: TurnProgress, e: TurnEvent): TurnProgress => {
  const next = step(p, e)
  const ready =
    !next.awaitingResult && next.openApprovals === 0 && [...next.pushed.values()].every(settled)
  return next.phase === 'running' && ready ? { ...next, phase: 'closing' } : next
}

// SDK の型定義にない command_lifecycle もあるので、使う欄だけをここで検査する。
const SdkOutput = z.union([
  z.object({ type: z.literal('system'), subtype: z.literal('init'), session_id: z.string() }),
  z.object({
    type: z.literal('assistant'),
    uuid: z.string(),
    parent_tool_use_id: z.null().optional(),
  }),
  z.object({
    type: z.literal('result'),
    is_error: z.boolean(),
    result: z.string().optional(),
    terminal_reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('command_lifecycle'),
    command_uuid: z.string(),
    state: z.enum(['queued', 'started', 'completed', 'cancelled']),
  }),
])

// SDK の disallowedTools にも同じ一覧を渡す
export const forbiddenTools = [
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'RemoteTrigger',
  'PushNotification',
  'Monitor',
]

const userInput = (first: SDKUserMessage) => {
  const ended = Promise.withResolvers<void>()
  async function* iterable() {
    yield first
    await ended.promise
  }
  return { iterable: iterable(), end: ended.resolve }
}

const closing = (turnId: TurnId, end: TurnEnd) => {
  switch (end._tag) {
    case 'Completed':
      return {
        from: 'closing',
        to: 'completed',
        endReason: null,
        inboundOutcome: 'answered',
        notice: null,
      } as const
    case 'Failed':
      return {
        from: 'running',
        to: 'failed',
        endReason: end.terminalReason,
        inboundOutcome: 'failed',
        notice: { idempotencyKey: `notice:failed:${turnId}`, body: 'モデルを呼べませんでした。' },
      } as const
    default:
      return {
        from: 'running',
        to: 'interrupted',
        endReason: end.reason,
        inboundOutcome: 'interrupted',
        notice: { idempotencyKey: `notice:interrupted:${turnId}`, body: '作業を中断しました。' },
      } as const
  }
}

export const runTurn = (
  deps: TurnDeps,
  session: SessionRow,
  inbound: readonly [InboundRow, ...InboundRow[]],
): Effect.Effect<void, StoreError, AgentRuntimeDb> =>
  Effect.gen(function* () {
    const turnId = yield* createTurn({
      sessionId: session.id,
      inboundIds: [inbound[0].id, ...inbound.slice(1).map((m) => m.id)],
    })
    const promptUuid = crypto.randomUUID()
    yield* transitionTurn(turnId, 'queued', 'running', { startedAt: new Date(), promptUuid })

    const sandboxTurn: TurnSandbox = {
      name: `kurumi-turn-${crypto.randomUUID()}`,
      configDir: session.configDir,
      workspaceDir: session.workspaceDir,
      token: `kurumi-fake-${crypto.randomUUID()}`,
    }
    const progress = yield* Ref.make(initialProgress)

    const handle = (
      output: unknown,
    ): Effect.Effect<TurnEnd | undefined, StoreError, AgentRuntimeDb> =>
      Effect.gen(function* () {
        const parsed = SdkOutput.safeParse(output)
        if (!parsed.success) return undefined
        const m = parsed.data
        if (m.type === 'system') {
          yield* setClaudeSessionId(session.id, m.session_id)
          return undefined
        }
        const event: TurnEvent =
          m.type === 'assistant'
            ? { type: 'assistant', uuid: m.uuid }
            : m.type === 'result'
              ? { type: 'result', isError: m.is_error, text: m.result ?? '' }
              : { type: 'lifecycle', uuid: m.command_uuid, state: m.state }
        const next = yield* Ref.updateAndGet(progress, (p) => advance(p, event))
        if (event.type === 'result') {
          if (event.isError) {
            return {
              _tag: 'Failed',
              terminalReason: m.type === 'result' ? (m.terminal_reason ?? null) : null,
            } satisfies TurnEnd
          }
          if (event.text !== '') {
            yield* insertOutbound({
              sessionId: session.id,
              turnId,
              kind: 'final',
              body: event.text,
              idempotencyKey: `final:${turnId}:${next.cliTurns}`,
            })
            yield* deps.notifyOutbound
          }
        }
        if (next.phase === 'closing') {
          yield* transitionTurn(turnId, 'running', 'closing')
          return { _tag: 'Completed' } satisfies TurnEnd
        }
        return undefined
      })

    const end = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* (
          deps.register?.({
            token: sandboxTurn.token,
            channel: session.channel,
            conversation: session.conversation,
            sessionId: session.id,
            turnId,
          }) ?? Effect.void
        )
        const input = userInput({
          type: 'user',
          message: { role: 'user', content: inbound.map((m) => m.body).join('\n\n') },
          parent_tool_use_id: null,
          uuid: promptUuid,
        })
        const q = yield* Effect.acquireRelease(
          Effect.sync(() =>
            query({
              prompt: input.iterable,
              options: {
                cwd: '/work',
                settingSources: [],
                strictMcpConfig: true,
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
                disallowedTools: forbiddenTools,
                ...(deps.model === undefined ? {} : { model: deps.model }),
                ...(session.claudeSessionId === null ? {} : { resume: session.claudeSessionId }),
                spawnClaudeCodeProcess: (options) => deps.sandbox.spawn(sandboxTurn, options),
              },
            }),
          ),
          (opened) =>
            Effect.sync(() => {
              input.end()
              opened.close()
            }).pipe(
              Effect.andThen(deps.sandbox.dispose(sandboxTurn)),
              Effect.catchCause((cause) => Effect.logError('sandbox dispose failed', cause)),
            ),
        )
        const ended = yield* Stream.fromAsyncIterable(
          q,
          (cause) => new SdkStreamFailed({ cause }),
        ).pipe(
          Stream.mapEffect(handle),
          Stream.filter((result): result is TurnEnd => result !== undefined),
          Stream.runHead,
          Effect.catchTag('SdkStreamFailed', (error) =>
            Effect.logWarning(`sdk stream failed: ${String(error.cause)}`).pipe(
              Effect.as(Option.none<TurnEnd>()),
            ),
          ),
        )
        return Option.getOrElse(ended, (): TurnEnd => ({
          _tag: 'Interrupted',
          reason: 'sandbox_exit',
        }))
      }),
    )

    const { lastAssistantUuid } = yield* Ref.get(progress)
    yield* closeTurn({
      turnId,
      sessionId: session.id,
      lastAssistantUuid,
      ...closing(turnId, end),
    })
    yield* deps.notifyOutbound
  })
