import { Effect } from 'effect'

import type { Sandbox } from './sandbox.ts'
import {
  closeTurn,
  listSessionsWithUnassignedInbound,
  listUnfinishedTurns,
  releaseAllSendingOutbound,
} from './store.ts'
import { closing } from './turn.ts'

/**
 * 前の起動の取り残しを片付ける。何度流しても同じ状態になる。
 * 返すのは、起こして未割り当ての受信を処理させるセッションの id。
 */
export const recover = (sandbox: Sandbox) =>
  Effect.gen(function* () {
    yield* sandbox.sweep.pipe(
      Effect.catchCause((cause) => Effect.logError('sandbox sweep failed', cause)),
    )
    for (const turn of yield* listUnfinishedTurns) {
      yield* closeTurn({
        turnId: turn.id,
        sessionId: turn.sessionId,
        lastAssistantUuid: turn.lastAssistantUuid,
        ...closing(turn.id, turn.sessionId, { _tag: 'Interrupted', reason: 'host_stopped' }),
      })
    }
    yield* releaseAllSendingOutbound
    return yield* listSessionsWithUnassignedInbound
  })
