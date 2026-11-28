import { describe, expect, test } from 'bun:test'

import { type DockerConfig, type TurnSandbox, dockerRunArgs } from './sandbox.ts'

const config: DockerConfig = {
  image: 'kurumi-agent:sdk-0.3.332',
  network: 'kurumi-egress',
  anthropicBaseUrl: 'http://gateway:8080',
  user: '1001:1001',
  label: 'kurumi.agent=1',
}

const turn: TurnSandbox = {
  name: 'kurumi-turn-1',
  configDir: '/host/cfg',
  workspaceDir: '/host/work',
  token: 'fake-token-1',
}

const spawnOptions = (env: Record<string, string | undefined> = {}) => ({
  command: 'claude',
  args: ['--output-format', 'stream-json'],
  env,
  signal: new AbortController().signal,
})

const run = (env?: Record<string, string | undefined>, c: DockerConfig = config) =>
  dockerRunArgs(c, turn, spawnOptions(env))

const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

const envOf = (args: string[]) =>
  Object.fromEntries(
    args.flatMap((a, i) =>
      args[i - 1] === '-e' ? [[a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]] : [],
    ),
  )

describe('dockerRunArgs', () => {
  test('carries every hardening flag of the container spec', () => {
    const args = run()
    expect(args.slice(0, 2)).toEqual(['run', '-i'])
    expect(args).toContain('--rm')
    expect(args).toContain('--init')
    expect(args).toContain('--read-only')
    expect(valueOf(args, '--name')).toBe('kurumi-turn-1')
    expect(valueOf(args, '--label')).toBe('kurumi.agent=1')
    expect(valueOf(args, '--cap-drop')).toBe('ALL')
    expect(valueOf(args, '--security-opt')).toBe('no-new-privileges')
    expect(valueOf(args, '--user')).toBe('1001:1001')
    expect(valueOf(args, '--pids-limit')).toBe('256')
    expect(valueOf(args, '--memory')).toBe('2g')
    expect(valueOf(args, '--cpus')).toBe('2')
    expect(valueOf(args, '--tmpfs')).toBe('/tmp')
    expect(valueOf(args, '-w')).toBe('/work')
    expect(valueOf(args, '--network')).toBe('kurumi-egress')
  })

  test('caps swap at the memory limit so the limit cannot be escaped by swapping', () => {
    const args = run(undefined, { ...config, limits: { memory: '512m', cpus: '1', pids: 64 } })
    expect(valueOf(args, '--memory')).toBe('512m')
    expect(valueOf(args, '--memory-swap')).toBe(valueOf(args, '--memory'))
    expect(valueOf(args, '--pids-limit')).toBe('64')
  })

  test('mounts the session config and the workspace and nothing else', () => {
    const args = run()
    const mounts = args.flatMap((a, i) => (args[i - 1] === '-v' ? [a] : []))
    expect(mounts).toEqual(['/host/cfg:/cfg', '/host/work:/work'])
    expect(args.join(' ')).not.toContain('docker.sock')
  })

  test('puts the image first and the SDK arguments last, after the CLI command', () => {
    const args = run()
    expect(args.slice(-4)).toEqual([
      'kurumi-agent:sdk-0.3.332',
      'claude',
      '--output-format',
      'stream-json',
    ])
  })

  test('passes only the allowlisted environment, whatever the SDK offers', () => {
    const env = envOf(
      run({
        CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
        ANTHROPIC_API_KEY: 'sk-ant-host-secret',
        AWS_SECRET_ACCESS_KEY: 'aws-host-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
        CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1',
        HOME: '/Users/someone',
        PATH: '/usr/bin',
      }),
    )
    expect(env).toEqual({
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_CONFIG_DIR: '/cfg',
      CLAUDE_CODE_OAUTH_TOKEN: 'fake-token-1',
      ANTHROPIC_BASE_URL: 'http://gateway:8080',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    })
  })

  test('never lets a host secret reach the command line', () => {
    const joined = run({
      ANTHROPIC_API_KEY: 'sk-ant-host-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-host-secret',
    }).join(' ')
    expect(joined).not.toContain('host-secret')
  })

  test('omits CLAUDE_CODE_ENTRYPOINT when the SDK did not set it', () => {
    expect(envOf(run({}))).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT')
  })
})
