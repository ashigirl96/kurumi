// 開発用の中継と --internal ネットワークを作る/片付ける。使い方: bun dev-env.ts up|down
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { relayPort } from './dev-relay.ts'

const execFileAsync = promisify(execFile)

export const agentImage = 'kurumi-agent:sdk-0.3.332'
export const internalNetwork = 'kurumi-dev-internal'
export const relayName = 'kurumi-dev-relay'
export const relayUrl = `http://${relayName}:${relayPort}`

const relaySource = new URL('./dev-relay.ts', import.meta.url).pathname
const devLabel = 'kurumi.dev=relay'

const docker = async (...args: string[]) => (await execFileAsync('docker', args)).stdout.trim()
const dockerQuiet = (...args: string[]) => docker(...args).catch(() => '')

export const down = async () => {
  await dockerQuiet('rm', '-f', relayName)
  await dockerQuiet('network', 'rm', internalNetwork)
}

export const up = async () => {
  if (!process.env['CLAUDE_REAL_TOKEN']) throw new Error('CLAUDE_REAL_TOKEN is missing')
  await down()
  await docker('network', 'create', '--internal', '--label', devLabel, internalNetwork)
  // 値を書かない -e は docker CLI の環境変数から取るので、本物のトークンが引数に出ない。
  await docker(
    'create',
    '--name',
    relayName,
    '--label',
    devLabel,
    '--network',
    'bridge',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '-e',
    'CLAUDE_REAL_TOKEN',
    '-v',
    `${relaySource}:/relay/dev-relay.ts:ro`,
    agentImage,
    'bun',
    '/relay/dev-relay.ts',
  )
  await docker('network', 'connect', internalNetwork, relayName)
  await docker('start', relayName)
  for (let i = 0; i < 50; i++) {
    if ((await dockerQuiet('logs', relayName)).includes('listening')) return
    await Bun.sleep(100)
  }
  throw new Error(`relay did not start: ${await dockerQuiet('logs', relayName)}`)
}

if (import.meta.main) {
  const command = process.argv[2]
  if (command === 'up') await up()
  else if (command === 'down') await down()
  else throw new Error('usage: bun dev-env.ts up|down')
}
