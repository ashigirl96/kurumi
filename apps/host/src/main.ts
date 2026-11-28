import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { Cause, Config, Effect, Exit, Fiber, Layer } from 'effect'

import { dbLayer } from './db.ts'

const app = Layer.unwrap(
  Effect.gen(function* () {
    const filename = yield* Config.String('KURUMI_DB_PATH').pipe(
      Config.withDefault(join(homedir(), '.kurumi', 'kurumi.db')),
    )
    yield* Effect.sync(() => mkdirSync(dirname(filename), { recursive: true }))
    return dbLayer(filename)
  }),
)

// Effect.never は event loop を握らないので、timer で process を生かす。
setInterval(() => {}, 2 ** 30)
const main = Effect.runFork(Layer.launch(app))
main.addObserver((exit) => {
  const stopped = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
  process.exit(stopped ? 0 : 1)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void Effect.runFork(Fiber.interrupt(main)))
}
