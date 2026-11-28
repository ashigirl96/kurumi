import { type HookCallback, type SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk'
import { Data, Deferred, Duration, Effect, Option, Ref, Stream } from 'effect'
import { z } from 'zod'

import { type GateDeps, type Policy, forbiddenTools, makeGate } from './gate.ts'
import type { Sandbox, TurnSandbox } from './sandbox.ts'
import type { TurnId } from './schema.ts'
import { sendMessageServer } from './send-tool.ts'
import {
  type AgentRuntimeDb,
  type DbError,
  type InboundRow,
  type SessionRow,
  type StoreError,
  assignInboundToRunningTurn,
  closeTurn,
  createTurn,
  findLastCompletedTurn,
  findPreviousInterruption,
  insertOutbound,
  setClaudeSessionId,
  type PreviousInterruption,
  transitionTurn,
} from './store.ts'
import { transcriptHolds } from './transcript.ts'

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
  readonly turnTimeout: Duration.Input
  readonly policy: Policy
  readonly onApprovalRequest: GateDeps['onApprovalRequest']
  readonly approvalTimeout: Duration.Input
  readonly approvals: GateDeps['approvals']
}

export type TurnControl = {
  readonly stop: Deferred.Deferred<'stopped' | 'timeout'>
  accept: ((row: InboundRow) => Effect.Effect<boolean, DbError, AgentRuntimeDb>) | undefined
}

class SdkStreamFailed extends Data.TaggedError('SdkStreamFailed')<{ readonly cause: unknown }> {}

type CommandState = 'accepted' | 'queued' | 'started' | 'completed' | 'cancelled'

export type TurnProgress = {
  readonly phase: 'running' | 'closing'
  readonly awaitingResult: boolean
  readonly pushed: ReadonlyMap<string, CommandState>
  readonly openApprovals: number
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
      readonly reason: 'stopped' | 'timeout' | 'sandbox_exit' | 'host_stopped' | 'resume_unreadable'
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

const userInput = (first: SDKUserMessage) => {
  const queue = [first]
  let done = false
  let wake: (() => void) | undefined
  async function* iterable() {
    for (;;) {
      const next = queue.shift()
      if (next) yield next
      else if (done) return
      else await new Promise<void>((resolve) => (wake = resolve))
    }
  }
  const poke = () => wake?.()
  return {
    iterable: iterable(),
    push: (message: SDKUserMessage) => {
      queue.push(message)
      poke()
    },
    end: () => {
      done = true
      poke()
    },
  }
}

// 型定義の interrupt() は引数を取らないが、SDK は実行時に cancelQueued を読んで CLI へ cancel_queued を送る。
type CancelQueuedInterrupt = { interrupt(options: { cancelQueued: boolean }): Promise<unknown> }

const interruptAndCancelQueued = (q: CancelQueuedInterrupt) =>
  Effect.tryPromise(() => q.interrupt({ cancelQueued: true })).pipe(
    Effect.timeout('5 seconds'),
    Effect.ignore,
  )

const lostNotice =
  '会話の記録を読めませんでした。/new で新しいセッションを始められます（これまでの会話の文脈は引き継がれません）。'

export const closing = (turnId: TurnId, sessionId: string, end: TurnEnd) => {
  switch (end._tag) {
    case 'Completed':
      return {
        from: ['closing'],
        to: 'completed',
        endReason: null,
        inboundOutcome: 'answered',
        notice: null,
      } as const
    case 'Failed':
      return {
        from: ['running'],
        to: 'failed',
        endReason: end.terminalReason,
        inboundOutcome: 'failed',
        notice: { idempotencyKey: `notice:failed:${turnId}`, body: 'モデルを呼べませんでした。' },
      } as const
    default:
      if (end.reason === 'resume_unreadable') {
        return {
          from: ['queued', 'running', 'closing'],
          to: 'interrupted',
          endReason: end.reason,
          inboundOutcome: 'interrupted',
          notice: { idempotencyKey: `notice:lost:${sessionId}`, body: lostNotice },
          lostSession: true,
        } as const
      }
      return {
        from: ['queued', 'running', 'closing'],
        to: 'interrupted',
        endReason: end.reason,
        inboundOutcome: 'interrupted',
        notice: {
          idempotencyKey: `notice:interrupted:${turnId}`,
          body: '作業を中断しました。',
        },
      } as const
  }
}

const interruptionNotice = (previous: PreviousInterruption) =>
  [
    '[Kurumi からの知らせ] 前のターンは中断され、最後まで終わっていません。',
    previous.toolCalls.length === 0
      ? '中断の時点で始まっていたツール呼び出しは記録されていません。'
      : [
          '中断の時点で始まっていたツール呼び出し（ツールが最後まで動いたかどうかは分かりません）:',
          ...previous.toolCalls.map((c) => `- ${c.toolName} ${c.inputSummary}`),
        ].join('\n'),
    previous.delivered.length === 0
      ? '前のターンで利用者へ送り終えた文はありません。'
      : [
          '前のターンで利用者へ送り終えた文（同じ内容を送り直さないでください）:',
          ...previous.delivered.map((body) => `- ${body}`),
        ].join('\n'),
    '前のターンの作業を自動ではやり直していません。必要なら、結果を確かめてから続けてください。',
  ].join('\n')

export const runTurn = (
  deps: TurnDeps,
  session: SessionRow,
  inbound: readonly [InboundRow, ...InboundRow[]],
  control: TurnControl,
): Effect.Effect<void, StoreError, AgentRuntimeDb> =>
  Effect.gen(function* () {
    const turnId = yield* createTurn({
      sessionId: session.id,
      inboundIds: [inbound[0].id, ...inbound.slice(1).map((m) => m.id)],
    })
    yield* executeTurn(deps, session, inbound, control, turnId).pipe(
      Effect.onInterrupt(() =>
        closeTurn({
          turnId,
          sessionId: session.id,
          lastAssistantUuid: null,
          ...closing(turnId, session.id, { _tag: 'Interrupted', reason: 'host_stopped' }),
        }).pipe(Effect.ignore),
      ),
    )
  })

const executeTurn = (
  deps: TurnDeps,
  session: SessionRow,
  inbound: readonly [InboundRow, ...InboundRow[]],
  control: TurnControl,
  turnId: TurnId,
): Effect.Effect<void, StoreError, AgentRuntimeDb> =>
  Effect.gen(function* () {
    const promptUuid = crypto.randomUUID()
    yield* transitionTurn(turnId, 'queued', 'running', { startedAt: new Date(), promptUuid })

    if (session.claudeSessionId !== null) {
      const last = yield* findLastCompletedTurn(session.id, turnId)
      const required = [last?.promptUuid, last?.lastAssistantUuid].filter(
        (uuid): uuid is string => typeof uuid === 'string',
      )
      const readable = yield* Effect.promise(() =>
        transcriptHolds(session.configDir, session.claudeSessionId!, required),
      )
      if (!readable) {
        yield* closeTurn({
          turnId,
          sessionId: session.id,
          lastAssistantUuid: null,
          ...closing(turnId, session.id, { _tag: 'Interrupted', reason: 'resume_unreadable' }),
        })
        yield* deps.notifyOutbound
        return
      }
    }
    const previous = yield* findPreviousInterruption(session.id, turnId)

    const sandboxTurn: TurnSandbox = {
      name: `kurumi-turn-${crypto.randomUUID()}`,
      configDir: session.configDir,
      workspaceDir: session.workspaceDir,
      token: `kurumi-fake-${crypto.randomUUID()}`,
    }
    const progress = yield* Ref.make(initialProgress)
    const run = Effect.runPromiseWith(yield* Effect.context<AgentRuntimeDb>())
    const turnOver = yield* Deferred.make<void>()
    const gateClosed = yield* Deferred.make<TurnEnd>()
    const input = userInput({
      type: 'user',
      message: {
        role: 'user',
        content: [
          ...(previous ? [interruptionNotice(previous)] : []),
          ...inbound.map((m) => m.body),
        ].join('\n\n'),
      },
      parent_tool_use_id: null,
      uuid: promptUuid,
    })

    control.accept = (row) =>
      Effect.gen(function* () {
        if (yield* Deferred.isDone(control.stop)) return false
        const uuid = crypto.randomUUID()
        const taken = yield* Ref.modify(progress, (p) =>
          p.phase === 'running'
            ? ([true, advance(p, { type: 'accepted', uuid })] as const)
            : ([false, p] as const),
        )
        if (!taken) return false
        const withdraw = Ref.update(progress, (p) => {
          const pushed = new Map(p.pushed)
          pushed.delete(uuid)
          return { ...p, pushed }
        })
        const assigned = yield* assignInboundToRunningTurn(row.id, turnId).pipe(
          Effect.onError(() => withdraw),
        )
        if (!assigned) {
          yield* withdraw
          return false
        }
        input.push({
          type: 'user',
          message: { role: 'user', content: row.body },
          parent_tool_use_id: null,
          uuid,
          priority: 'next',
        })
        return true
      })

    const approvalClosed = Ref.modify(progress, (p) => {
      const next = advance(p, { type: 'approval-closed' })
      return [{ closes: p.phase === 'running' && next.phase === 'closing' }, next] as const
    }).pipe(
      Effect.flatMap(({ closes }) =>
        closes
          ? transitionTurn(turnId, 'running', 'closing').pipe(
              Effect.andThen(Deferred.succeed(gateClosed, { _tag: 'Completed' })),
            )
          : Effect.void,
      ),
    )
    const gate = makeGate(deps, {
      channel: session.channel,
      conversation: session.conversation,
      sessionId: session.id,
      turnId,
      ended: Effect.raceFirst(Deferred.await(control.stop), Deferred.await(turnOver)),
      approvalOpened: Ref.update(progress, (p) => advance(p, { type: 'approval-opened' })),
      approvalClosed,
    })
    const preToolUse: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name !== 'PreToolUse') return {}
      const permissionDecision = await run(
        gate({
          toolName: hookInput.tool_name,
          toolUseId: hookInput.tool_use_id,
          input: hookInput.tool_input,
        }),
      )
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision } }
    }
    const hookTimeoutSeconds = Math.ceil(Duration.toSeconds(deps.approvalTimeout)) + 60

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
            yield* Ref.update(progress, (p) => ({ ...p, phase: 'closing' as const }))
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
                hooks: {
                  PreToolUse: [
                    { hooks: [preToolUse], timeout: hookTimeoutSeconds, onFailure: 'block' },
                  ],
                },
                mcpServers: {
                  kurumi: sendMessageServer({
                    sessionId: session.id,
                    turnId,
                    notifyOutbound: deps.notifyOutbound,
                    run,
                  }),
                },
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
        yield* Effect.addFinalizer(() => Deferred.succeed(turnOver, undefined))
        yield* Effect.sleep(deps.turnTimeout).pipe(
          Effect.andThen(Deferred.succeed(control.stop, 'timeout')),
          Effect.forkScoped,
        )
        const read = Stream.fromAsyncIterable(q, (cause) => new SdkStreamFailed({ cause })).pipe(
          Stream.mapEffect(handle),
          Stream.filter((result): result is TurnEnd => result !== undefined),
          Stream.runHead,
          Effect.catchTag('SdkStreamFailed', (error) =>
            Effect.logWarning(`sdk stream failed: ${String(error.cause)}`).pipe(
              Effect.as(Option.none<TurnEnd>()),
            ),
          ),
          Effect.map((ended) =>
            Option.getOrElse(ended, (): TurnEnd => ({
              _tag: 'Interrupted',
              reason: 'sandbox_exit',
            })),
          ),
        )
        const hostStop = Deferred.await(control.stop).pipe(
          Effect.tap(() => interruptAndCancelQueued(q)),
          Effect.map((reason): TurnEnd => ({ _tag: 'Interrupted', reason })),
        )
        const raced = yield* Effect.raceAllFirst([read, hostStop, Deferred.await(gateClosed)])
        const stopped = (yield* Deferred.isDone(control.stop))
          ? yield* Deferred.await(control.stop)
          : undefined
        yield* Ref.update(progress, (p) => ({ ...p, phase: 'closing' as const }))
        return raced._tag !== 'Completed' && stopped !== undefined
          ? ({ _tag: 'Interrupted', reason: stopped } satisfies TurnEnd)
          : raced
      }),
    )

    const { lastAssistantUuid } = yield* Ref.get(progress)
    yield* closeTurn({
      turnId,
      sessionId: session.id,
      lastAssistantUuid,
      ...closing(turnId, session.id, end),
    })
    yield* deps.notifyOutbound
  })
