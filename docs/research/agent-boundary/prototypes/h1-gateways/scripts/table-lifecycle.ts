// Markdown table of out/lifecycle-<gw>.json.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { outDir } from './lab.ts'

const status = (s: string) => s.replace('HTTP/1.1 ', '').replace('\r', '')
const tally = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} x${v}`).join(', ') || '(none)'
console.log('| gateway | turn-1 token replayed in turn 2 (then turn 2 own token) | revocation: call→first 401, ms (5 runs) | revoke call itself, ms | stream open at revoke | old container in 4 s after host SIGKILL | after host restart empties registry |')
console.log('|---|---|---|---|---|---|---|')
for (const g of ['ag', 'mg-host', 'mg-ctr']) {
  const f = join(outDir, `lifecycle-${g}.json`)
  if (!existsSync(f)) continue
  const r = JSON.parse(readFileSync(f, 'utf8'))
  const lat = r.revocationLatency.samples
  console.log(
    `| ${g} | ${r.replayAfterTurnEnd.turn2ReplaysTurn1Token_then_ownToken.map(status).join(' / ')} | ${lat.map((s: any) => s.callToFirst401Ms).join(', ')} | ${lat.map((s: any) => s.revokeCallMs).join(', ')} | ${r.inflightStream.chunksAfterRevoke} chunks after revoke; ${r.inflightStream.end.slice(0, 40)} | ${tally(r.hostKill.statusesInThe4sAfterKill)} (container: ${r.hostKill.containerAfter4s}) | ${tally(r.hostKill.statusesAfterHostRestartRevokesAll)} |`,
  )
}
