// Re-derives each H1 verdict from the out/*.json files; prints OBSERVED/NOT-OBSERVED per claim, exit 1 if
// any claim in notes-h1.md no longer reproduces.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { outDir } from './lab.ts'

const j = (f: string) => JSON.parse(readFileSync(join(outDir, f), 'utf8'))
const wire = (g: string, id: string) => (j(`wire-${g}.json`) as any[]).find((r) => r.id === id)
const iron = (id: string) => (j('iron.json') as any[]).find((r) => r.id === id)
const life = (g: string) => j(`lifecycle-${g}.json`)
const broker = j('broker.json')
const up = (r: any) => (r.upstream as string[]).join(' ')

let failed = 0
const claim = (ok: boolean, text: string) => {
  console.log(`${ok ? 'REPRODUCED' : 'NOT REPRODUCED'}  ${text}`)
  if (!ok) failed++
}

for (const g of ['ag', 'mg-host', 'mg-ctr']) {
  claim(wire(g, 'P1').status.includes('200') && up(wire(g, 'P1')).includes('<CANARY_GH>'), `${g}: allowed read reaches the upstream with the injected credential`)
  claim(['T1', 'T2'].every((id) => wire(g, id).status.includes('401')), `${g}: no token / unregistered token -> 401`)
  claim(['D1', 'D2', 'D3', 'D4', 'D5', 'D9'].every((id) => up(wire(g, id)) === ''), `${g}: disallowed method/path and U8 broker-gated writes never reach the upstream`)
  claim(['O1', 'O3', 'O4'].every((id) => wire(g, id).sink.length === 0) && wire(g, 'L3').sink.length === 0 && wire(g, 'L4').followed.length === 0, `${g}: no open proxy, redirects not followed`)
  claim(wire(g, 'L2').canaryAfterBase64Decode === true, `${g}: base64-encoded echo returns the real credential`)
  claim(wire(g, 'G1').hits.length === 0 && !wire(g, 'G1').envHasCanary, `${g}: no canary in env, /proc, files`)
}
claim(['D6', 'D7'].every((id) => up(wire('ag', id)).includes('GET /user auth=Bearer <CANARY_GH>')), 'ag: dot-segment paths escape the pathPrefix route and reach GET /user with the credential')
claim(['D6', 'D7'].every((id) => up(wire('mg-ctr', id)) === '' && up(wire('mg-host', id)) === ''), 'mg: dot-segment paths are refused')
claim(wire('ag', 'L1').canaryInResponse === true, 'ag: plain echo returns the real credential (no response scrubbing)')
claim(wire('mg-ctr', 'L1').canaryInResponse === false && wire('mg-host', 'L1').canaryInResponse === false, 'mg: plain echo is scrubbed')
claim(wire('ag', 'E14').status.includes('200') && up(wire('ag', 'E14')).includes('<CANARY_GH>'), 'ag: apiKey with mode omitted lets a keyless request through with the credential (E14)')
claim(Object.keys(wire('ag', 'C1').ports).filter((p) => wire('ag', 'C1').ports[p] === 'open').join(',') === '8080,8081,8082,15020,15021', 'ag: stats 15020 and readiness 15021 reachable from the container, admin 15000 not')
claim(['mg-ctr', 'mg-host'].every((g) => Object.values(wire(g, 'C1').ports).filter((v) => v === 'open').length === 2), 'mg: only the two data-plane ports reachable')

for (const g of ['ag', 'mg-host', 'mg-ctr']) {
  claim(life(g).replayAfterTurnEnd.turn2ReplaysTurn1Token_then_ownToken[0].includes('401'), `${g}: turn-1 token replayed in turn 2 -> 401`)
}
claim(life('ag').revocationLatency.medianCallToFirst401Ms > 200, `ag: revocation takes ${life('ag').revocationLatency.medianCallToFirst401Ms} ms (file reload)`)
claim(life('mg-host').revocationLatency.medianCallToFirst401Ms < 20 && life('mg-ctr').revocationLatency.medianCallToFirst401Ms < 20, 'mg: revocation effective on the next request')
claim(life('ag').inflightStream.end === 'completed' && life('ag').inflightStream.chunksAfterRevoke > 0, 'ag: a stream open at revocation runs to completion')
claim(['mg-host', 'mg-ctr'].every((g) => life(g).inflightStream.chunksAfterRevoke === 0), 'mg: revocation cuts open streams')
claim((life('ag').hostKill.statusesInThe4sAfterKill['200'] ?? 0) > 0 && (life('mg-ctr').hostKill.statusesInThe4sAfterKill['200'] ?? 0) > 0, 'ag, mg-ctr: after a host SIGKILL the old container keeps getting 200 until a restarted host empties the registry')
claim((life('mg-host').hostKill.statusesInThe4sAfterKill['200'] ?? 0) === 0, 'mg-host: after a host SIGKILL the gateway is gone with it (no 200)')

claim(iron('I0').status === 200 && !!iron('I0b').error, 'iron: DNS mode works; HTTPS_PROXY tunnel refused when the allowlist uses method/path rules')
claim(['I2', 'ID6', 'ID7'].every((id) => iron(id).status.includes('400')) && ['I1', 'I3', 'I4', 'I5', 'I6', 'I7', 'ID3'].every((id) => String(iron(id).status).includes('403')), 'iron: SNI/Host mismatch and dot segments 400, non-allowlisted CONNECT/absolute-form/host 403')
claim(iron('IL1').canaryInResponse === true, 'iron: echo returns the real credential (E2)')
const ironTxt = readFileSync(join(outDir, 'iron.txt'), 'utf8')
claim(ironTxt.includes('probe=E1b auth=Bearer <CANARY_GH> bodyLen=1048576'), 'iron: a 2 MiB body is forwarded truncated to 1 MiB (E1)')
claim(ironTxt.includes('tail-marker-E1a-<CANARY_GH>'), 'iron: a proxy token in the body is swapped for the real secret and sent upstream')
claim(/pass\.test/.test(ironTxt.split('fake authoritative DNS')[1] ?? '') && !/exfil\.test/.test(ironTxt.split('fake authoritative DNS')[1]?.split('###')[0] ?? ''), 'iron: exfil names answered locally; only passthrough names reach the upstream resolver (E3)')

claim(JSON.stringify(broker.hook.executedButNeverApproved) === JSON.stringify(['U10-swap: add deploy key', 'U10-reuse: second call']), 'broker hook mode: swapped args and a reused approval execute with the real credential')
claim(broker.handler.executedButNeverApproved.length === 0, 'broker handler mode: nothing executes that the human did not see and approve')
claim(broker.handler.executedWithRealCredential.length === 2, 'broker handler mode: the approved args re-sent execute twice (two prompts, two side effects)')
process.exit(failed ? 1 : 0)
