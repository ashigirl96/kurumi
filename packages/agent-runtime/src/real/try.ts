// ターミナルを 1 つのチャンネルに見立てて Agent Runtime を手元で試す開発用の script。チャンネルの実装ではない。
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { Effect, Layer } from 'effect'
import { SqlClient } from 'effect/sql'

import { type ApprovalRequest, type OutboundToDeliver, Runtime } from '../runtime.ts'
import { dockerSandbox } from '../sandbox.ts'
import { sqliteDbLayer } from '../testing/db.ts'
import { agentImage, down, up } from './dev-env.ts'
import { realDockerConfig } from './support.ts'

const usage = `usage: CLAUDE_REAL_TOKEN=<Claude Code の OAuth トークン> bun packages/agent-runtime/src/real/try.ts [--model haiku] [--ask Bash,Write]`

const args = process.argv.slice(2)
const option = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const model = option('--model') ?? 'haiku'
const ask = new Set((option('--ask') ?? '').split(',').filter(Boolean))

if (!process.env['CLAUDE_REAL_TOKEN']) {
  console.error(usage)
  process.exit(1)
}
if (!execFileSync('docker', ['images', '-q', agentImage]).toString().trim()) {
  console.error(
    `イメージ ${agentImage} がありません。先に作ってください:\n  docker build -t ${agentImage} packages/agent-runtime/container`,
  )
  process.exit(1)
}

await up()
// 本物のトークンは中継だけが持つ。このプロセスと子のコンテナには残さない。
delete process.env['CLAUDE_REAL_TOKEN']

const stateDir = process.env['KURUMI_TRY_DIR'] ?? join(homedir(), '.kurumi', 'try')
mkdirSync(stateDir, { recursive: true })

const channel = 'terminal'
const tty = process.stdout.isTTY
const color = (code: number, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text)
const kindColor = { final: 32, progress: 36, notice: 33 } as const

const rl = createInterface({ input: process.stdin, prompt: process.stdin.isTTY ? '> ' : '' })
const show = (text: string) => {
  if (tty) process.stdout.write('\r\x1b[2K')
  console.log(text)
  if (!ended) rl.prompt(true)
}

// Runtime の起動より前に届いた行も取りこぼさないよう、すぐ聞き始める。
const lines: string[] = []
let ended = false
let drain = true
let wake: (() => void) | undefined
rl.on('line', (l) => {
  lines.push(l)
  wake?.()
})
rl.on('close', () => {
  ended = true
  wake?.()
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    lines.length = 0
    ended = true
    drain = false
    wake?.()
  })
}

const pendingApprovals: ApprovalRequest[] = []

const deliver = (m: OutboundToDeliver) =>
  Effect.sync(() => show(color(kindColor[m.kind], `[${m.kind}]`) + ` ${m.body}`))

const program = Effect.gen(function* () {
  const runtime = yield* Runtime
  const sql = yield* SqlClient.SqlClient

  const idle = Effect.gen(function* () {
    const [inbound] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM inbound_messages WHERE outcome IS NULL`
    const [outbound] = yield* sql<{
      n: number
    }>`SELECT count(*) AS n FROM outbound_messages WHERE state != 'delivered'`
    return inbound!.n === 0 && outbound!.n === 0
  })

  const handle = (line: string) =>
    Effect.gen(function* () {
      const text = line.trim()
      if (!text) return
      const answer =
        pendingApprovals.length > 0
          ? { y: 'allow', yes: 'allow', n: 'deny', no: 'deny' }[text.toLowerCase()]
          : undefined
      if (answer === 'allow' || answer === 'deny') {
        const request = pendingApprovals.shift()!
        const accepted = yield* runtime.answerApproval(request.id, answer)
        show(
          accepted
            ? `承認依頼 ${request.toolName} に ${answer} を渡しました`
            : `承認依頼 ${request.toolName} は時間切れの後でした`,
        )
        return
      }
      yield* runtime.receive({
        channel,
        conversation: 'terminal',
        platformMessageId: crypto.randomUUID(),
        sender: 'terminal-user',
        body: text,
        receivedAt: new Date(),
      })
    })

  while (true) {
    const line = lines.shift()
    if (line !== undefined) {
      yield* handle(line)
      continue
    }
    if (ended) break
    yield* Effect.promise(() => new Promise<void>((resolve) => (wake = resolve)))
  }

  if (drain) {
    let quiet = 0
    while (quiet < 3) {
      quiet = (yield* idle) ? quiet + 1 : 0
      yield* Effect.sleep('300 millis')
    }
  }
})

const config = {
  dataDir: join(stateDir, 'data'),
  agent: 'try',
  sandbox: dockerSandbox({ ...realDockerConfig, label: 'kurumi.agent=try' }),
  channels: { [channel]: deliver },
  onApprovalRequest: (request: ApprovalRequest) =>
    Effect.sync(() => {
      pendingApprovals.push(request)
      show(
        color(35, `[承認依頼] ${request.toolName}`) +
          `\n${JSON.stringify(request.input, null, 2)}\ny/n で答えてください`,
      )
    }),
  policy: ({ toolName }: { toolName: string }) =>
    ask.has(toolName) ? ('ask' as const) : ('allow' as const),
  model,
}

try {
  await Effect.runPromise(
    program.pipe(
      Effect.provide(
        Runtime.layer(config).pipe(Layer.provideMerge(sqliteDbLayer(join(stateDir, 'try.db')))),
      ),
    ),
  )
} finally {
  rl.close()
  await down()
}
