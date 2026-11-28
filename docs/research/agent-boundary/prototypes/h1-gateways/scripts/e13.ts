// E13: startup time (docker start -> ready log line, Mac host clock) and idle RSS of each gateway,
// plus the in-process gateway's RSS delta and time to listen. Also config / code size.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { agConfig } from '../gateway/ag-config.ts'
import { exec, here, show } from './lab.ts'

const ready: Record<string, string> = { 'kh1-ag': 'started bind', 'kh1-mg': 'kurumi-gw listening', 'kh1-iron': 'https proxy starting', 'kh1-sink': 'sink listening' }
const rows: Record<string, unknown>[] = []
for (const [name, line] of Object.entries(ready)) {
  const starts: number[] = []
  for (let i = 0; i < 3; i++) {
    await exec(['docker', 'stop', '-t', '1', name])
    await Bun.sleep(1100)
    const since = new Date().toISOString()
    const t0 = performance.now()
    await exec(['docker', 'start', name])
    for (;;) {
      const logs = await exec(['docker', 'logs', '--since', since, name])
      if (`${logs.stdout}\n${logs.stderr}`.includes(line)) break
      await Bun.sleep(10)
    }
    starts.push(Math.round(performance.now() - t0))
  }
  await Bun.sleep(5000)
  const status = (await exec(['docker', 'exec', name, 'cat', '/proc/1/status'])).stdout
  const rss = /VmRSS:\s+(\d+) kB/.exec(status)?.[1]
  const comm = /Name:\s+(\S+)/.exec(status)?.[1]
  const stats = (await exec(['docker', 'stats', '--no-stream', '--format', '{{.MemUsage}}', name])).stdout
  rows.push({ container: name, pid1: comm, startToReadyMs: starts, idleRssMiB: rss ? +(Number(rss) / 1024).toFixed(1) : null, dockerStatsMem: stats })
}
show('E13 containers (sink = a bare Bun HTTP server, the baseline)', rows)

const hostProbe = await exec(['bun', '-e', `
  const before = process.memoryUsage().rss
  const t0 = performance.now()
  const { startGateway, labRoutes } = await import(${JSON.stringify(join(here, 'gateway', 'kurumi-gw.ts'))})
  const gw = startGateway(labRoutes({ CANARY_GH: 'x', CANARY_MODEL: 'y' }).map((r) => ({ ...r, port: r.port + 40000 })), '127.0.0.1', () => {})
  const t1 = performance.now()
  await Bun.sleep(3000)
  Bun.gc(true)
  console.log(JSON.stringify({ importAndListenMs: +(t1 - t0).toFixed(1), rssDeltaMiB: +((process.memoryUsage().rss - before) / 1048576).toFixed(1), rssTotalMiB: +(process.memoryUsage().rss / 1048576).toFixed(1) }))
  gw.stop()
`])
show('E13 in-process gateway (fresh bun process: RSS before import vs after listening)', hostProbe.stdout || hostProbe.stderr)

const loc = (file: string) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('//')).length
show('config and code size', {
  agentgatewayConfigLines_oneKey: agConfig(['kurumi-fake-x'], 'M', 'G').trim().split('\n').length,
  ironProxyConfigLines: readFileSync(join(here, 'out', 'run', 'iron', 'iron.yaml'), 'utf8').trim().split('\n').length,
  minimalGatewayLoc_total: loc(join(here, 'gateway', 'kurumi-gw.ts')),
  devRelayLoc_startingPoint: loc(join(here, 'repo', 'packages', 'agent-runtime', 'src', 'real', 'dev-relay.ts')),
  hostGlue_agConfigWriterLoc: loc(join(here, 'gateway', 'ag-config.ts')),
})
