// The "host" that gets SIGKILLed: owns the gateway (in-process for mg-host), registers a turn token,
// starts the turn container with Kurumi's args, and reports the session dir. bun host-kill-child.ts <gw>
import { spawn } from 'node:child_process'

import { type GatewayName, gateway } from './gateways.ts'
import { kurumiArgs, newToken, sessionDirs } from './lab.ts'

const gw = gateway(process.argv[2] as GatewayName)
const token = newToken()
await gw.register(token)
const dirs = sessionDirs()
const { args, env } = kurumiArgs(gw.host, token, dirs)
console.log(`SESSION ${dirs.workspaceDir}`)
console.log(`CONTAINER ${args[args.indexOf('--name') + 1]}`)
const child = spawn('docker', [...args, 'bun', '/work/.attack/loop.ts', `http://${gw.host}:8081/repos/a/b/issues`, '/work/loop.log'], {
  env,
  stdio: ['pipe', 'pipe', 'inherit'],
})
child.stdout.on('data', (d) => process.stdout.write(d))
await new Promise(() => {})
