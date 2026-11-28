import { Duration, Effect, Exit, Queue, Schedule } from 'effect'

import type { TurnId } from './schema.ts'
import { claimNextOutbound, markDelivered, releaseOutbound } from './store.ts'

export type OutboundToDeliver = {
  readonly id: number
  readonly channel: string
  readonly conversation: string
  readonly sessionId: string
  readonly turnId: TurnId | null
  readonly kind: 'final' | 'progress' | 'notice'
  readonly body: string
}

export type Deliver = (message: OutboundToDeliver) => Effect.Effect<void, unknown>

export const makeOutbox = (
  channels: Readonly<Record<string, Deliver>>,
  retryDelay: Duration.Input,
  deliverTimeout: Duration.Input = '60 seconds',
) =>
  Effect.gen(function* () {
    const wake = yield* Queue.sliding<void>(1)
    yield* Queue.offer(wake, undefined)
    // 失敗し続ける会話がほかの会話の配達を止めないよう、失敗したセッションをしばらくよける。
    const backoffUntil = new Map<string, number>()

    const deliverOne = Effect.gen(function* () {
      const now = Date.now()
      for (const [sessionId, until] of backoffUntil)
        if (until <= now) backoffUntil.delete(sessionId)
      const next = yield* claimNextOutbound([...backoffUntil.keys()])
      if (!next) {
        yield* backoffUntil.size === 0
          ? Queue.take(wake)
          : Effect.raceFirst(Queue.take(wake), Effect.sleep(retryDelay))
        return
      }
      const deliver = channels[next.channel]
      const exit = yield* (
        deliver ? deliver(next) : Effect.fail(new Error(`unknown channel: ${next.channel}`))
      ).pipe(Effect.timeout(deliverTimeout), Effect.exit)
      // 配達し直しも取りこぼしもしないよう、記録だけをやり直す。
      const record = Exit.isSuccess(exit) ? markDelivered(next.id) : releaseOutbound(next.id)
      yield* record.pipe(
        Effect.tapError((error) => Effect.logWarning(`outbound ${next.id} not recorded`, error)),
        Effect.retry(Schedule.spaced(retryDelay)),
      )
      if (Exit.isFailure(exit)) {
        backoffUntil.set(next.sessionId, Date.now() + Duration.toMillis(retryDelay))
        yield* Effect.logWarning(`outbound ${next.id} was not delivered`, exit.cause)
      }
    })

    const run = deliverOne.pipe(
      Effect.catchCause((cause) =>
        Effect.logError('outbound loop failed', cause).pipe(
          Effect.andThen(Effect.sleep(retryDelay)),
        ),
      ),
      Effect.forever,
    )

    return { notify: Queue.offer(wake, undefined).pipe(Effect.asVoid), run }
  })
