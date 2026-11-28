// U6 / I5 / I10: token replay after the turn ends, revocation latency, in-flight streams at revocation,
// and replay after a host kill. bun lifecycle.ts [ag] [mg-host] [mg-ctr]  -> out/lifecycle-<gw>.json
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type GatewayName, gateway } from './gateways.ts'
import { exec, inKurumi, newToken, outDir, sessionDirs, show } from './lab.ts'

const names = (process.argv.slice(2).length ? process.argv.slice(2) : ['ag', 'mg-host', 'mg-ctr']) as GatewayName[]
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

for (const name of names) {
  const result: Record<string, unknown> = { gateway: name }
  const gw = gateway(name)
  const path = '/repos/a/b/issues'

  // 1. Replay after the turn ends: turn 1 stashes its token in the persisted workspace; the host revokes at
  //    turn end; turn 2 (new token) replays turn 1's token.
  const dirs = sessionDirs()
  const t1 = newToken()
  await gw.register(t1)
  const turn1 = await inKurumi(gw.host, t1, `printf %s "$CLAUDE_CODE_OAUTH_TOKEN" > /work/stolen; bun /work/.attack/raw.ts ${gw.host} 8081 $(printf 'GET ${path} HTTP/1.1\\r\\nHost: x\\r\\nAuthorization: Bearer %s\\r\\nConnection: close\\r\\n\\r\\n' "$CLAUDE_CODE_OAUTH_TOKEN" | base64 -w0) | head -1`, dirs)
  await gw.revoke(t1)
  const t2 = newToken()
  await gw.register(t2)
  const turn2 = await inKurumi(gw.host, t2, `bun /work/.attack/raw.ts ${gw.host} 8081 $(printf 'GET ${path} HTTP/1.1\\r\\nHost: x\\r\\nAuthorization: Bearer %s\\r\\nConnection: close\\r\\n\\r\\n' "$(cat /work/stolen)" | base64 -w0) | head -1; bun /work/.attack/raw.ts ${gw.host} 8081 $(printf 'GET ${path} HTTP/1.1\\r\\nHost: x\\r\\nAuthorization: Bearer %s\\r\\nConnection: close\\r\\n\\r\\n' "$CLAUDE_CODE_OAUTH_TOKEN" | base64 -w0) | head -1`, dirs)
  await gw.revoke(t2)
  result['replayAfterTurnEnd'] = { turn1OwnToken: turn1.stdout, turn2ReplaysTurn1Token_then_ownToken: turn2.stdout.split('\n') }

  // 2. Revocation latency, measured from the Mac host on the same data-plane listener (one clock).
  const samples: { callToFirst401Ms: number; returnToFirst401Ms: number; revokeCallMs: number }[] = []
  for (let i = 0; i < 5; i++) {
    const t = newToken()
    await gw.register(t)
    let first401 = Number.NaN
    let stop = false
    const poller = (async () => {
      while (!stop) {
        const s = await fetch(`${gw.hostUrl}${path}`, { headers: { authorization: `Bearer ${t}` } }).then((r) => r.status, () => 0)
        if (s === 401 && Number.isNaN(first401)) first401 = performance.now()
        if (s === 401) stop = true
      }
    })()
    await Bun.sleep(200)
    const t0 = performance.now()
    await gw.revoke(t)
    const t1r = performance.now()
    const timeout = setTimeout(() => (stop = true), 10_000)
    await poller
    clearTimeout(timeout)
    samples.push({ callToFirst401Ms: +(first401 - t0).toFixed(1), returnToFirst401Ms: +(first401 - t1r).toFixed(1), revokeCallMs: +(t1r - t0).toFixed(1) })
  }
  result['revocationLatency'] = { samples, medianCallToFirst401Ms: median(samples.map((s) => s.callToFirst401Ms)) }

  // 3. A stream already open when the token is revoked (/slow sends 10 chunks, 500 ms apart).
  const ts = newToken()
  await gw.register(ts)
  const chunks: string[] = []
  const t0 = performance.now()
  let revokedAt = 0
  const reading = (async () => {
    try {
      const res = await fetch(`${gw.hostUrl}/slow`, { headers: { authorization: `Bearer ${ts}` } })
      const reader = res.body!.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return 'completed'
        chunks.push(`+${(performance.now() - t0).toFixed(0)}ms ${new TextDecoder().decode(value).trim()}`)
      }
    } catch (e) {
      return `error: ${(e as Error).message}`
    }
  })()
  await Bun.sleep(1200)
  revokedAt = performance.now() - t0
  await gw.revoke(ts)
  const end = await reading
  result['inflightStream'] = { revokedAtMs: +revokedAt.toFixed(0), end, chunksAfterRevoke: chunks.filter((c) => Number(c.slice(1).split('ms')[0]) > revokedAt).length, chunks }
  gw.stop()

  // 4. Host kill: the host process dies without revoking; the old turn container keeps calling.
  const child = spawn('bun', [join(import.meta.dir, 'host-kill-child.ts'), name], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  await new Promise<void>((resolve) => child.stdout.on('data', (d) => ((out += d.toString()), out.includes('LOOP_READY') && resolve())))
  const work = /SESSION (\S+)/.exec(out)![1]!
  const container = /CONTAINER (\S+)/.exec(out)![1]!
  const linesBeforeKill = readFileSync(join(work, "loop.log"), "utf8").trim().split("\n").length
  const killedAt = new Date().toISOString()
  child.kill('SIGKILL')
  await Bun.sleep(4000)
  const alive = (await exec(['docker', 'ps', '--filter', `name=${container}`, '--format', '{{.Status}}'])).stdout || '(gone)'
  const afterKill = readFileSync(join(work, 'loop.log'), 'utf8').trim().split('\n')
  // Host restart: a fresh host has no record of the old token, so it writes an empty registry.
  const restartedAt = new Date().toISOString()
  if (name !== 'mg-host') await gateway(name).revokeAll()
  await Bun.sleep(2000)
  const afterRestart = readFileSync(join(work, 'loop.log'), 'utf8').trim().split('\n').slice(afterKill.length)
  await exec(['docker', 'rm', '-f', container])
  const tally = (lines: string[]) => lines.reduce<Record<string, number>>((m, l) => ((m[l.split(' ').slice(1).join(' ')] = (m[l.split(' ').slice(1).join(' ')] ?? 0) + 1), m), {})
  const postKill = afterKill.slice(linesBeforeKill)
  result['hostKill'] = {
    killedAt,
    containerAfter4s: alive,
    statusesInThe4sAfterKill: tally(postKill),
    firstLinesAfterKill: postKill.slice(0, 3),
    restartedAt,
    statusesAfterHostRestartRevokesAll: tally(afterRestart),
  }
  show(`${name}: lifecycle`, result)
  writeFileSync(join(outDir, `lifecycle-${name}.json`), JSON.stringify(result, null, 2))
}
process.exit(0)
