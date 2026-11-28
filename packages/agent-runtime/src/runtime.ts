import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { Context, Deferred, type Duration, Effect, Layer, Semaphore } from 'effect'

import {
  type ApprovalDecision,
  type ApprovalRequest,
  type Policy,
  type ToolDecision,
} from './gate.ts'
import { type Deliver, type OutboundToDeliver, makeOutbox } from './outbound.ts'
import { recover } from './recovery.ts'
import type { Sandbox } from './sandbox.ts'
import {
  AgentRuntimeDb,
  type SessionRow,
  type DbError,
  findSession,
  getSession,
  insertSession,
  interruptUnassignedInbound,
  listUnassignedInbound,
  storeInbound,
} from './store.ts'
import { type TurnControl, type TurnGrant, runTurn } from './turn.ts'

export type {
  ApprovalDecision,
  ApprovalRequest,
  Deliver,
  OutboundToDeliver,
  Policy,
  ToolDecision,
  TurnGrant,
}

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
const defaultTurnTimeout: Duration.Input = '30 minutes'
const defaultApprovalTimeout: Duration.Input = '15 minutes'

const makeRuntime = (config: RuntimeConfig) =>
  Effect.gen(function* () {
    const db = yield* AgentRuntimeDb
    const scope = yield* Effect.scope
    const outbox = yield* makeOutbox(config.channels, deliveryRetryDelay)

    const turnSlots = yield* Semaphore.make(config.maxConcurrentTurns ?? 3)
    const sessionLocks = new Map<string, Semaphore.Semaphore>()
    const lockOf = (sessionId: string) => {
      const existing = sessionLocks.get(sessionId)
      if (existing) return existing
      const created = Semaphore.makeUnsafe(1)
      sessionLocks.set(sessionId, created)
      return created
    }

    const approvals = new Map<string, Deferred.Deferred<ApprovalDecision>>()

    const turnDeps = {
      sandbox: config.sandbox,
      register: config.credentialGateway?.register,
      model: config.model,
      notifyOutbound: outbox.notify,
      turnTimeout: config.turnTimeout ?? defaultTurnTimeout,
      policy: config.policy ?? (() => 'allow' as const),
      onApprovalRequest: config.onApprovalRequest,
      approvalTimeout: config.approvalTimeout ?? defaultApprovalTimeout,
      approvals,
    }

    const activeTurns = new Map<string, TurnControl>()

    const processSession = (sessionId: string) =>
      lockOf(sessionId).withPermit(
        turnSlots.withPermit(
          Effect.gen(function* () {
            const session = yield* getSession(sessionId)
            if (session?.status !== 'active') return
            // 読んだ後に止める合図を置くので、読む前の /stop は受信の取り消しだけで、このターンを止めない。
            const startTurn = Effect.gen(function* () {
              const [first, ...rest] = yield* listUnassignedInbound(
                session.channel,
                session.conversation,
              )
              if (!first) return
              const control: TurnControl = {
                stop: yield* Deferred.make<'stopped' | 'timeout'>(),
                accept: undefined,
              }
              activeTurns.set(sessionId, control)
              yield* runTurn(turnDeps, session, [first, ...rest], control)
            })
            // 読んでから割り当てるまでに /stop が受信を取り消したら、新しい合図で読み直す。
            yield* startTurn.pipe(
              Effect.catchTag('InboundNotAssignable', () => startTurn),
              Effect.ensuring(Effect.sync(() => activeTurns.delete(sessionId))),
            )
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

    const createSession = (channel: string, conversation: string) =>
      Effect.gen(function* () {
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
      })

    const ensureSession = (channel: string, conversation: string) =>
      Effect.gen(function* () {
        let session: SessionRow | undefined = yield* findSession(channel, conversation)
        if (!session) {
          yield* createSession(channel, conversation)
          session = yield* findSession(channel, conversation)
        }
        const found = session!
        yield* Effect.promise(async () => {
          await mkdir(found.configDir, { recursive: true })
          await mkdir(found.workspaceDir, { recursive: true })
        })
        return found
      })

    const newSession = (message: InboundInput) =>
      Effect.gen(function* () {
        const current = yield* findSession(message.channel, message.conversation)
        if (current?.status === 'lost') {
          yield* createSession(message.channel, message.conversation)
          const created = yield* ensureSession(message.channel, message.conversation)
          yield* kick(created.id)
        }
        return 'new-session' as const
      })

    const stop = (message: InboundInput) =>
      Effect.gen(function* () {
        const session = yield* findSession(message.channel, message.conversation)
        if (session) {
          const control = activeTurns.get(session.id)
          if (control) yield* Deferred.succeed(control.stop, 'stopped')
          yield* interruptUnassignedInbound(message.channel, message.conversation)
        }
        return 'stop' as const
      })

    const receive = (message: InboundInput) =>
      Effect.gen(function* () {
        const command = message.body.trim()
        if (command === '/stop' || command === '/new') {
          // 命令の行は答え済みで保存し、ターンに渡さず、再配達を重複として見分ける。
          const fresh = yield* storeInbound({
            ...message,
            outcome: 'answered',
            answeredAt: new Date(),
          })
          if (!fresh) return 'duplicate' as const
          return command === '/stop' ? yield* stop(message) : yield* newSession(message)
        }
        const session = yield* ensureSession(message.channel, message.conversation)
        const stored = yield* storeInbound(message)
        const pushed = stored
          ? yield* (activeTurns.get(session.id)?.accept?.(stored) ?? Effect.succeed(false)).pipe(
              Effect.catchCause((cause) => Effect.as(Effect.logError('push failed', cause), false)),
            )
          : false
        if (!pushed) yield* kick(session.id)
        return stored ? ('stored' as const) : ('duplicate' as const)
      }).pipe(Effect.provideService(AgentRuntimeDb, db))

    const answerApproval = (id: string, decision: ApprovalDecision) => {
      const answer = approvals.get(id)
      return answer ? Deferred.succeed(answer, decision) : Effect.succeed(false)
    }

    const wakeSessions = yield* recover(config.sandbox).pipe(
      Effect.provideService(AgentRuntimeDb, db),
      Effect.orDie,
    )
    yield* outbox.run.pipe(Effect.provideService(AgentRuntimeDb, db), Effect.forkIn(scope))
    for (const sessionId of wakeSessions) yield* kick(sessionId)

    return { receive, answerApproval } satisfies RuntimeApi
  })

export class Runtime extends Context.Service<Runtime, RuntimeApi>()(
  '@kurumi/agent-runtime/Runtime',
) {
  static readonly layer = (config: RuntimeConfig): Layer.Layer<Runtime, never, AgentRuntimeDb> =>
    Layer.effect(Runtime, makeRuntime(config))
}
