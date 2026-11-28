import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { Data, Effect } from 'effect'

const execFileAsync = promisify(execFile)

export const defaultLabel = 'kurumi.agent=1'

export type TurnSandbox = {
  readonly name: string
  readonly configDir: string
  readonly workspaceDir: string
  readonly token: string
}

export type DockerConfig = {
  readonly image: string
  readonly network: string
  readonly anthropicBaseUrl: string
  /** `uid:gid` */
  readonly user: string
  readonly label?: string
  readonly limits?: Partial<{ memory: string; cpus: string; pids: number }>
}

export class DockerCommandFailed extends Data.TaggedError('DockerCommandFailed')<{
  readonly args: readonly string[]
  readonly cause: unknown
}> {}

export interface Sandbox {
  spawn(turn: TurnSandbox, options: SpawnOptions): SpawnedProcess
  dispose(turn: TurnSandbox): Effect.Effect<void, DockerCommandFailed>
  readonly sweep: Effect.Effect<void, DockerCommandFailed>
}

// SDK はホストの環境変数を丸ごと渡してくるので、許可したものだけをホスト側で組み直す。
const containerEnv = (
  config: DockerConfig,
  turn: TurnSandbox,
  options: SpawnOptions,
): Record<string, string> => {
  const entrypoint = options.env['CLAUDE_CODE_ENTRYPOINT']
  return {
    ...(entrypoint === undefined ? {} : { CLAUDE_CODE_ENTRYPOINT: entrypoint }),
    CLAUDE_CONFIG_DIR: '/cfg',
    CLAUDE_CODE_OAUTH_TOKEN: turn.token,
    ANTHROPIC_BASE_URL: config.anthropicBaseUrl,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
}

const dockerClientVariables = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']

/** docker の client process に渡す環境。値は argv に載せず（host の ps に見える）、ここに入れて `-e KEY` で受け渡す。 */
export const dockerClientEnv = (
  config: DockerConfig,
  turn: TurnSandbox,
  options: SpawnOptions,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> => ({
  ...Object.fromEntries(
    dockerClientVariables.flatMap((key) => {
      const value = hostEnv[key]
      return value === undefined ? [] : [[key, value]]
    }),
  ),
  ...containerEnv(config, turn, options),
})

export const dockerRunArgs = (
  config: DockerConfig,
  turn: TurnSandbox,
  options: SpawnOptions,
): string[] => {
  const { memory = '2g', cpus = '2', pids = 256 } = config.limits ?? {}
  return [
    'run',
    '-i',
    '--rm',
    '--name',
    turn.name,
    '--label',
    config.label ?? defaultLabel,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    config.user,
    '--pids-limit',
    String(pids),
    '--memory',
    memory,
    // --memory だけでは swap に逃げて上限にならない
    '--memory-swap',
    memory,
    '--cpus',
    cpus,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--init',
    '-v',
    `${turn.configDir}:/cfg`,
    '-v',
    `${turn.workspaceDir}:/work`,
    '-w',
    '/work',
    '--network',
    config.network,
    ...Object.keys(containerEnv(config, turn, options)).flatMap((key) => ['-e', key]),
    config.image,
    'claude',
    ...options.args,
  ]
}

const docker = (...args: string[]) =>
  Effect.tryPromise({
    try: async () => (await execFileAsync('docker', args)).stdout,
    catch: (cause) => new DockerCommandFailed({ args, cause }),
  })

export const dockerSandbox = (config: DockerConfig): Sandbox => ({
  spawn: (turn, options) =>
    spawn('docker', dockerRunArgs(config, turn, options), {
      env: dockerClientEnv(config, turn, options),
      stdio: ['pipe', 'pipe', 'inherit'],
      signal: options.signal,
    }),
  dispose: (turn) => Effect.asVoid(docker('rm', '-f', turn.name)),
  sweep: Effect.gen(function* () {
    const ids = (yield* docker('ps', '-aq', '--filter', `label=${config.label ?? defaultLabel}`))
      .split('\n')
      .filter(Boolean)
    if (ids.length > 0) yield* docker('rm', '-f', ...ids)
  }),
})
