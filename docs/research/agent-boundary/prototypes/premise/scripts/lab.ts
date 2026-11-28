// Shared helpers: run a command in a container built from Kurumi's real dockerRunArgs.
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

import {
  type DockerConfig,
  type TurnSandbox,
  dockerClientEnv,
  dockerRunArgs,
} from '../repo/packages/agent-runtime/src/sandbox.ts'

export const here = join(import.meta.dir, '..')
export const outDir = join(here, 'out')
export const canary = 'CANARY_REAL_9f1c2e7a5b3d'
export const label = 'kurumi.agent=premise'

export const labConfig: DockerConfig = {
  image: 'kurumi-agent:sdk-0.3.332',
  network: 'kp-internal',
  anthropicBaseUrl: 'http://kp-gw:8080',
  user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  label,
}

export const sessionDirs = () => {
  const root = mkdtempSync(join(outDir, 'sess-'))
  const configDir = join(root, 'cfg')
  const workspaceDir = join(root, 'work')
  mkdirSync(configDir)
  mkdirSync(join(workspaceDir, '.attack'), { recursive: true })
  cpSync(join(here, 'fakes'), join(workspaceDir, '.attack'), { recursive: true })
  return { root, configDir, workspaceDir }
}

/** Kurumi's docker args up to and including the image; `extra` flags go right before the image. */
export const kurumiPrefix = (overrides: Partial<DockerConfig> = {}, extra: string[] = []) => {
  const config = { ...labConfig, ...overrides }
  const turn: TurnSandbox = {
    name: `kp-probe-${crypto.randomUUID().slice(0, 8)}`,
    ...sessionDirs(),
    token: `kurumi-fake-${crypto.randomUUID()}`,
  }
  const options = { command: 'claude', args: [], env: {}, signal: new AbortController().signal }
  const args = dockerRunArgs(config, turn, options)
  const at = args.indexOf(config.image)
  return {
    turn,
    args: [...args.slice(0, at), ...extra, config.image],
    env: { ...process.env, ...dockerClientEnv(config, turn, options) } as Record<string, string>,
  }
}

export const exec = async (cmd: string[], env?: Record<string, string>, timeoutMs = 60_000) => {
  const child = Bun.spawn(cmd, { env: env ?? (process.env as Record<string, string>), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

export const inKurumi = async (script: string, overrides: Partial<DockerConfig> = {}, extra: string[] = []) => {
  const { args, env } = kurumiPrefix(overrides, extra)
  return exec(['docker', ...args, 'sh', '-c', script], env)
}

export const logsOf = async (container: string) => {
  const r = await exec(['docker', 'logs', container])
  return `${r.stdout}\n${r.stderr}`.trim()
}

export const show = (title: string, body: unknown) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  console.log(`\n### ${title}\n${text}`)
}
