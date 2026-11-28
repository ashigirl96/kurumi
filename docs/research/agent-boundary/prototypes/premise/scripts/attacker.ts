// Task 1 (a) and the stdio direction: an attacker CLI in place of `claude`, real image, real
// docker args, real host SDK through Kurumi's Runtime. Three turns in one session, then a 4th inbound.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { withLab } from './host.ts'
import { canary, logsOf, show } from './lab.ts'

// Bash asks the human, WebFetch is denied, everything else allowed.
const policy = (call: { toolName: string }) =>
  call.toolName === 'Bash' ? 'ask' : call.toolName === 'WebFetch' ? 'deny' : 'allow'

await withLab(
  'attacker',
  policy,
  async (lab) => {
    show('T1 receive', await lab.send('hello, please summarise the repo'))
    await lab.waitTurns(1)
    show('T2 receive', await lab.send('continue'))
    await lab.waitTurns(2)
    show('T3 receive', await lab.send('and again'))
    await lab.waitTurns(3)
    await Bun.sleep(500)
    show('T4 receive (after T3 reported the session unreadable)', await lab.send('are you there?'))
    await Bun.sleep(1500)

    const tables = (await lab.tables()) as Record<string, any[]>
    const work = tables['sessions']![0]!.workspaceDir as string
    const attackerLog = readFileSync(join(work, '.attack', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

    show('docker command per turn (Kurumi args; only the command after the image differs)', lab.spawns.map((a) => a.join(' ')))
    show('approval requests the human saw', lab.approvals.map((a) => ({ turnId: a.turnId, toolName: a.toolName, input: a.input })))
    show('host tables', tables)
    show('messages delivered to chat', lab.delivered.map((d) => ({ turnId: d.turnId, kind: d.kind, body: d.body })))
    show('attacker log (what the container saw)', attackerLog)
    show('workspace file planted without any hook call', existsSync(join(work, 'PLANTED_BY_ATTACKER.md')) ? readFileSync(join(work, 'PLANTED_BY_ATTACKER.md'), 'utf8') : '(missing)')
    show('relay log', await logsOf('kp-gw'))
    const upstream = await logsOf('kp-upstream')
    show('fake upstream log lines for /after-deny', upstream.split('\n').filter((l) => l.includes('after-deny')))
    show('canary seen by the container in this scenario', JSON.stringify(attackerLog).includes(canary))
  },
  ['main', 'interrupt', 'observe', 'observe'],
)
process.exit(0)
