import { Duration, Effect, Exit, Queue } from 'effect'

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
) =>
  Effect.gen(function* () {
    const wake = yield* Queue.sliding<void>(1)
    yield* Queue.offer(wake, undefined)

    const deliverOne = Effect.gen(function* () {
      const next = yield* claimNextOutbound
      if (!next) return yield* Queue.take(wake)
      const deliver = channels[next.channel]
      const exit = yield* (
        deliver ? deliver(next) : Effect.fail(new Error(`unknown channel: ${next.channel}`))
      ).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) return yield* markDelivered(next.id)
      yield* releaseOutbound(next.id)
      yield* Effect.logWarning(`outbound ${next.id} was not delivered`, exit.cause)
      return yield* Effect.sleep(retryDelay)
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
