// 本物の確認用のホスト。別のプロセスで Runtime を動かし、関所の中で自分を SIGKILL する。使い方: bun kill-host.ts <dataDir>
import { Effect, Layer } from 'effect'

import { Runtime } from '../runtime.ts'
import { dockerSandbox } from '../sandbox.ts'
import { testDbLayer } from '../testing/db.ts'
import { realDockerConfig } from './support.ts'

const dataDir = process.argv[2]
if (dataDir === undefined) throw new Error('usage: bun kill-host.ts <dataDir>')

const runtime = Runtime.layer({
  dataDir,
  agent: 'real-checks',
  sandbox: dockerSandbox(realDockerConfig),
  channels: { chat: () => Effect.void },
  onApprovalRequest: () => Effect.void,
  model: 'haiku',
  policy: ({ toolName }) => {
    if (toolName === 'Bash') process.kill(process.pid, 'SIGKILL')
    return 'allow'
  },
}).pipe(Layer.provideMerge(testDbLayer))

await Effect.runPromise(
  Effect.gen(function* () {
    const { receive } = yield* Runtime
    yield* receive({
      channel: 'chat',
      conversation: 'c1',
      platformMessageId: 'm1',
      sender: 'user',
      body: 'Run exactly one Bash command: `echo ran > /work/sideeffect.txt`. Then reply DONE.',
      receivedAt: new Date(),
    })
    return yield* Effect.never
  }).pipe(Effect.provide(runtime)),
)
