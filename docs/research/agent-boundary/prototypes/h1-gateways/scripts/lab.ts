// Slice 1's lab helpers (premise/scripts/lab.ts), pointed at the H1 networks: a command in a container
// built from Kurumi's real dockerRunArgs on kh1-int.
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

import { type DockerConfig, type TurnSandbox, dockerClientEnv, dockerRunArgs } from '../repo/packages/agent-runtime/src/sandbox.ts'

export const here = join(import.meta.dir, '..')
export const outDir = join(here, 'out')
export const canaryGh = 'CANARY_REAL_GH_4b7e19d2c6a0'
export const canaryModel = 'CANARY_REAL_MODEL_8d2f60a1e93c'
export const label = 'kurumi.agent=h1'

export const labConfig = (gatewayHost: string): DockerConfig => ({
  image: 'kurumi-agent:sdk-0.3.332',
  network: 'kh1-int',
  anthropicBaseUrl: `http://${gatewayHost}:8080`,
  user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  label,
})

export const sessionDirs = () => {
  const root = mkdtempSync(join(outDir, 'sess-'))
  const configDir = join(root, 'cfg')
  const workspaceDir = join(root, 'work')
  mkdirSync(configDir)
  mkdirSync(join(workspaceDir, '.attack'), { recursive: true })
  cpSync(join(here, '..', 'premise', 'fakes'), join(workspaceDir, '.attack'), { recursive: true })
  cpSync(join(here, 'fakes'), join(workspaceDir, '.attack'), { recursive: true })
  return { root, configDir, workspaceDir }
}

/** Kurumi's docker args up to the image, for a turn with `token`; `extra` flags go right before the image. */
export const kurumiArgs = (gatewayHost: string, token: string, dirs = sessionDirs(), extra: string[] = []) => {
  const config = labConfig(gatewayHost)
  const turn: TurnSandbox = { name: `kh1-turn-${crypto.randomUUID().slice(0, 8)}`, ...dirs, token }
  const options = { command: 'claude', args: [], env: {}, signal: new AbortController().signal }
  const args = dockerRunArgs(config, turn, options)
  const at = args.indexOf(config.image)
  return {
    turn,
    args: [...args.slice(0, at), ...extra, config.image],
    env: { ...process.env, ...dockerClientEnv(config, turn, options) } as Record<string, string>,
  }
}

export const exec = async (cmd: string[], env?: Record<string, string>, timeoutMs = 120_000) => {
  const child = Bun.spawn(cmd, { env: env ?? (process.env as Record<string, string>), stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

export const inKurumi = async (gatewayHost: string, token: string, script: string, dirs = sessionDirs(), extra: string[] = []) => {
  const { args, env } = kurumiArgs(gatewayHost, token, dirs, extra)
  return exec(['docker', ...args, 'sh', '-c', script], env)
}

export const logsSince = async (container: string, since: string) => {
  const r = await exec(['docker', 'logs', '--since', since, container])
  return `${r.stdout}\n${r.stderr}`.trim()
}

export const show = (title: string, body: unknown) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  console.log(`\n### ${title}\n${text}`)
}

export const newToken = () => `kurumi-fake-${crypto.randomUUID()}`
