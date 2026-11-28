import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { Context, type Duration, Effect, Layer, Semaphore } from 'effect'

import { type Deliver, type OutboundToDeliver, makeOutbox } from './outbound.ts'
import type { Sandbox } from './sandbox.ts'
import type { TurnId } from './schema.ts'
import {
  AgentRuntimeDb,
  type InboundRow,
  type SessionRow,
  type DbError,
  findSession,
  getSession,
  insertSession,
  listUnassignedInbound,
  saveInbound,
} from './store.ts'
import { type TurnGrant, runTurn } from './turn.ts'

export type { Deliver, OutboundToDeliver, TurnGrant }

export type InboundInput = {
  readonly channel: string
  readonly conversation: string
  readonly platformMessageId: string
  readonly sender: string
  readonly body: string
  readonly receivedAt: Date
}

/** `receive` が成功で返った時点で、受信は DB にコミット済み。チャンネルはこれを待ってから ack する。 */
export type ReceiveOutcome = 'stored' | 'duplicate' | 'stop' | 'new-session'

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

export type ApprovalDecision = 'allow' | 'deny'

export type ToolDecision = 'allow' | 'deny' | 'ask'

export type Policy = (call: { toolName: string; input: unknown }) => ToolDecision

export type RuntimeConfig = {
  /** `sessions/<sessionId>/{cfg,work}` を置く */
  readonly dataDir: string
  readonly agent: string
  readonly sandbox: Sandbox
  readonly channels: Readonly<Record<string, Deliver>>
  readonly onApprovalRequest: (request: ApprovalRequest) => Effect.Effect<void>
  readonly policy?: Policy
  readonly credentialGateway?: { readonly register: (grant: TurnGrant) => Effect.Effect<void> }
  readonly model?: string
  /** 既定は 3 */
  readonly maxConcurrentTurns?: number
  /** 既定は 30 分 */
  readonly turnTimeout?: Duration.Input
  /** 既定は 15 分 */
  readonly approvalTimeout?: Duration.Input
}

export type RuntimeApi = {
  readonly receive: (message: InboundInput) => Effect.Effect<ReceiveOutcome, DbError>
  /** 知らない id と時間切れは false */
  readonly answerApproval: (id: string, decision: ApprovalDecision) => Effect.Effect<boolean>
}

const deliveryRetryDelay = '1 second'

const makeRuntime = (config: RuntimeConfig) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    const scope = yield* Effect.scope
    const outbox = yield* makeOutbox(config.channels, deliveryRetryDelay)
    yield* outbox.run.pipe(Effect.provideService(AgentRuntimeDb, db), Effect.forkIn(scope))

    const turnSlots = yield* Semaphore.make(config.maxConcurrentTurns ?? 3)
    const sessionLocks = new Map<string, Semaphore.Semaphore>()
    const lockOf = (sessionId: string) => {
      const existing = sessionLocks.get(sessionId)
      if (existing) return existing
      const created = Semaphore.makeUnsafe(1)
      sessionLocks.set(sessionId, created)
      return created
    }

    const turnDeps = {
      sandbox: config.sandbox,
      register: config.credentialGateway?.register,
      model: config.model,
      notifyOutbound: outbox.notify,
    }

    const processSession = (sessionId: string) =>
      lockOf(sessionId).withPermit(
        turnSlots.withPermit(
          Effect.gen(function* () {
            const session = yield* getSession(sessionId)
            if (session?.status !== 'active') return
            const [first, ...rest] = yield* listUnassignedInbound(
              session.channel,
              session.conversation,
            )
            if (first) yield* runTurn(turnDeps, session, [first, ...rest])
          }),
        ),
      )

    const kick = (sessionId: string) =>
      processSession(sessionId).pipe(
        Effect.catchCause((cause) => Effect.logError('turn failed', cause)),
        Effect.provideService(AgentRuntimeDb, db),
        Effect.forkIn(scope),
        Effect.asVoid,
      )

    const ensureSession = (channel: string, conversation: string) =>
      Effect.gen(function* () {
        let session: SessionRow | undefined = yield* findSession(channel, conversation)
        if (!session) {
          const id = crypto.randomUUID()
          const dir = join(config.dataDir, 'sessions', id)
          yield* insertSession({
            id,
            channel,
            conversation,
            agent: config.agent,
            configDir: join(dir, 'cfg'),
            workspaceDir: join(dir, 'work'),
            status: 'active',
          })
          session = yield* findSession(channel, conversation)
        }
        const found = session!
        yield* Effect.promise(async () => {
          await mkdir(found.configDir, { recursive: true })
          await mkdir(found.workspaceDir, { recursive: true })
        })
        return found
      })

    const receive = (message: InboundInput) =>
      Effect.gen(function* () {
        // 先に session を作る。受信を書いたあとで失敗すると、再送の受信が重複になって起こされない。
        const session = yield* ensureSession(message.channel, message.conversation)
        const stored = yield* saveInbound(message)
        yield* kick(session.id)
        return stored ? ('stored' as const) : ('duplicate' as const)
      }).pipe(Effect.provideService(AgentRuntimeDb, db))

    return { receive, answerApproval: () => Effect.succeed(false) } satisfies RuntimeApi
  })

export class Runtime extends Context.Service<Runtime, RuntimeApi>()(
  '@kurumi/agent-runtime/Runtime',
) {
  static readonly layer = (config: RuntimeConfig): Layer.Layer<Runtime, never, AgentRuntimeDb> =>
    Layer.effect(Runtime, makeRuntime(config))
}

export type { InboundRow }
