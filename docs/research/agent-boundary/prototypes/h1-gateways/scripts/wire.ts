// Same attack script (fakes/attack-wire.ts) from a Kurumi turn container against each base-URL gateway.
// bun wire.ts [ag] [mg-host] [mg-ctr]   -> prints evidence and writes out/wire-<gw>.json
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type GatewayName, gateway } from './gateways.ts'
import { canaryGh, inKurumi, logsSince, newToken, outDir, show } from './lab.ts'

const names = (process.argv.slice(2).length ? process.argv.slice(2) : ['ag', 'mg-host', 'mg-ctr']) as GatewayName[]

const upstreamFor = (lines: string[], marker: string) =>
  lines
    .filter((l) => new RegExp(`probe(=|%3D)${marker}(&|%26|"|$)`).test(l))
    .map((l) => {
      try {
        const j = JSON.parse(l) as { method?: string; url?: string; headers?: Record<string, string> }
        const auth = j.headers?.['authorization'] ?? '-'
        return `${j.method} ${new URL(j.url ?? 'http://x/').pathname} auth=${auth.includes(canaryGh) ? 'Bearer <CANARY_GH>' : auth.includes('CANARY_REAL') ? 'Bearer <CANARY other>' : auth}`
      } catch {
        return l.slice(0, 160)
      }
    })

for (const name of names) {
  const gw = gateway(name)
  const token = newToken()
  await gw.register(token)
  const since = new Date(Date.now() - 2000).toISOString()
  const tag = `${name}-`
  const r = await inKurumi(gw.host, token, `bun /work/.attack/attack-wire.ts ${gw.host} ${tag}`)
  await gw.revoke(token)
  await Bun.sleep(500)
  const probes = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>)
  const gh = (await logsSince('kh1-gh', since)).split('\n').filter((l) => l.startsWith('{'))
  const sink = (await logsSince('kh1-sink', since)).split('\n').filter((l) => l.startsWith('{'))
  const model = (await logsSince("kh1-model", since)).split("\n")
  const rows = probes.map((p) => {
    const id = String(p['id'])
    return {
      ...p,
      upstream: id === "P2" ? model.filter((l) => l.includes(`probe=${tag}P2`)).map((l) => (l.includes('CANARY_REAL_MODEL') ? 'POST /v1/messages auth=Bearer <CANARY_MODEL>' : l.slice(0, 120))) : upstreamFor(gh, tag + id),
      followed: id === "L4" ? gh.filter((l) => l.includes(`/echo?probe=${tag}L4-followed`)) : undefined,
      sink: sink.filter((l) => new RegExp(`probe(=|%3D)${tag}${id}(&|%26|"|$)`).test(l)),
    }
  })
  show(`${name}: probes (container view) joined with what the upstream and the sink logged`, rows)
  show(`${name}: gateway log`, await gw.logs(since))
  if (r.stderr) show(`${name}: container stderr`, r.stderr)
  writeFileSync(join(outDir, `wire-${name}.json`), JSON.stringify(rows, null, 2))
  gw.stop()
}
process.exit(0)
