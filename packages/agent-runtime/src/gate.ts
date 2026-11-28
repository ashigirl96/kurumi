import { Deferred, Duration, Effect } from 'effect'

import type { TurnId } from './schema.ts'
import { type AgentRuntimeDb, recordToolCall } from './store.ts'

export type ToolDecision = 'allow' | 'deny' | 'ask'

export type Policy = (call: { toolName: string; input: unknown }) => ToolDecision

export type ApprovalDecision = 'allow' | 'deny'

export type ApprovalRequest = {
  readonly id: string
  readonly channel: string
  readonly conversation: string
  readonly sessionId: string
  readonly turnId: TurnId
  readonly toolName: string
  readonly inputSummary: string
  readonly expiresAt: Date
}

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

const isForbidden = (toolName: string) =>
  forbiddenTools.includes(toolName) || toolName.startsWith('Cron')

const summarize = (input: unknown) => (JSON.stringify(input) ?? '').slice(0, 300)

export type GateDeps = {
  readonly policy: Policy
  readonly onApprovalRequest: (request: ApprovalRequest) => Effect.Effect<void>
  readonly approvalTimeout: Duration.Input
  /** 答えを待っている承認依頼。Runtime の `answerApproval` がここへ答えを渡す */
  readonly approvals: Map<string, Deferred.Deferred<ApprovalDecision>>
}

export type GateTurn = {
  readonly channel: string
  readonly conversation: string
  readonly sessionId: string
  readonly turnId: TurnId
  /** /stop・制限時間・ターンの終わりのどれかで完了し、承認の待ちを deny で終わらせる */
  readonly ended: Effect.Effect<unknown>
  readonly approvalOpened: Effect.Effect<void>
  readonly approvalClosed: Effect.Effect<void, unknown, AgentRuntimeDb>
}

export type ToolCall = {
  readonly toolName: string
  readonly toolUseId: string
  readonly input: unknown
}

/** すべてのツール呼び出しが通る唯一の関所。許可を返す前に `tool_calls` をコミットする */
export const makeGate = (deps: GateDeps, turn: GateTurn) => {
  const ask = (call: ToolCall) =>
    Effect.gen(function* () {
      const id = crypto.randomUUID()
      const answer = yield* Deferred.make<ApprovalDecision>()
      deps.approvals.set(id, answer)
      yield* turn.approvalOpened
      // 答え・時間切れ・止める合図のどれが先でも、決めるのはこの Deferred 1 つだけにする
      const expire = Effect.raceFirst(Effect.sleep(deps.approvalTimeout), turn.ended).pipe(
        Effect.andThen(Deferred.succeed(answer, 'deny')),
        Effect.andThen(Deferred.await(answer)),
      )
      return yield* Effect.gen(function* () {
        yield* deps.onApprovalRequest({
          id,
          channel: turn.channel,
          conversation: turn.conversation,
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          toolName: call.toolName,
          inputSummary: summarize(call.input),
          expiresAt: new Date(Date.now() + Duration.toMillis(deps.approvalTimeout)),
        })
        return yield* Effect.raceFirst(Deferred.await(answer), expire)
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            deps.approvals.delete(id)
            return Effect.orDie(turn.approvalClosed)
          }),
        ),
      )
    })

  return (call: ToolCall) =>
    Effect.gen(function* () {
      const decision = isForbidden(call.toolName)
        ? 'deny'
        : deps.policy({ toolName: call.toolName, input: call.input })
      const verdict = decision === 'ask' ? yield* ask(call) : decision
      if (verdict === 'deny') return 'deny' as const
      yield* recordToolCall({
        toolUseId: call.toolUseId,
        turnId: turn.turnId,
        toolName: call.toolName,
        inputSummary: summarize(call.input),
      })
      return 'allow' as const
    })
}
