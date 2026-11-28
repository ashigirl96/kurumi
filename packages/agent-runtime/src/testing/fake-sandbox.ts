import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { Effect } from 'effect'

import type { Sandbox, TurnSandbox } from '../sandbox.ts'
import type { Script } from './fake-cli.ts'

const fakeCliPath = join(import.meta.dir, 'fake-cli.ts')

export type Gate = {
  /** 筋書きの `park` の段に着くまで待つ */
  reached(name: string): Promise<void>
  /** `park` の段で止まっているのを先へ進める */
  release(name: string): void
}

export type FakeSandbox = Sandbox & {
  readonly spawns: {
    readonly turn: TurnSandbox
    readonly args: readonly string[]
    readonly resume: boolean
  }[]
  readonly disposed: TurnSandbox[]
  /** n 番目（0 始まり）に起こした子プロセスの合図 */
  gate(n: number): Gate
  /** n 番目（0 始まり）の CLI が標準入力から受け取った行（JSON として読めたもの） */
  received(n: number): unknown[]
  /** 次の `dispose` を、`release` が呼ばれるまで子プロセスを殺す前で止める */
  holdDispose(): { entered: Promise<void>; release: () => void }
  alive(): number
  /** `sweep` が呼ばれた回数 */
  swept(): number
}

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once('exit', () => resolve()))

export const fakeSandbox = (scriptFor: (n: number) => Script): FakeSandbox => {
  const root = join(tmpdir(), `kurumi-fake-sandbox-${crypto.randomUUID()}`)
  const children: { turn: TurnSandbox; child: ChildProcess }[] = []
  const spawns: FakeSandbox['spawns'] = []
  const disposed: TurnSandbox[] = []
  let sweeps = 0
  let hold: { entered: () => void; released: Promise<void> } | undefined

  const dirOf = (n: number) => {
    const dir = join(root, String(n))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  return {
    spawns,
    disposed,
    spawn(turn: TurnSandbox, options: SpawnOptions): SpawnedProcess {
      const n = spawns.length
      spawns.push({
        turn,
        args: options.args,
        resume: options.args.some((a) => a.startsWith('--resume')),
      })
      const child = spawn(process.execPath, [fakeCliPath, ...options.args], {
        cwd: turn.workspaceDir,
        env: {
          PATH: process.env['PATH'],
          CLAUDE_CONFIG_DIR: turn.configDir,
          FAKE_CLI_SCRIPT: JSON.stringify(scriptFor(n)),
          FAKE_CLI_SIGNAL_DIR: dirOf(n),
        },
        stdio: ['pipe', 'pipe', 'inherit'],
        signal: options.signal,
      })
      children.push({ turn, child })
      return child
    },
    dispose: (turn) =>
      Effect.promise(async () => {
        disposed.push(turn)
        if (hold) {
          hold.entered()
          await hold.released
        }
        const mine = children.filter((c) => c.turn.name === turn.name).map((c) => c.child)
        for (const child of mine) child.kill('SIGKILL')
        await Promise.all(mine.map(exited))
      }),
    sweep: Effect.sync(() => {
      sweeps++
    }),
    gate: (n) => ({
      reached: async (name) => {
        const file = join(dirOf(n), `${name}.reached`)
        while (!existsSync(file)) await Bun.sleep(5)
      },
      release: (name) => writeFileSync(join(dirOf(n), `${name}.go`), ''),
    }),
    received: (n) => {
      const file = join(dirOf(n), 'received.jsonl')
      return existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line): unknown => JSON.parse(line))
        : []
    },
    holdDispose: () => {
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      hold = { entered: entered.resolve, released: released.promise }
      return {
        entered: entered.promise,
        release: () => {
          hold = undefined
          released.resolve()
        },
      }
    },
    swept: () => sweeps,
    alive: () =>
      children.filter(({ child }) => child.exitCode === null && child.signalCode === null).length,
  }
}
