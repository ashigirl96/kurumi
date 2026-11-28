// Task 1 (b): the real Claude Code CLI 2.1.332 in the real image with Kurumi's args, driven by
// Kurumi's Runtime, talking to a fake model (behind the dev relay) that asks for one Bash call.
// The human approves that call. No Anthropic endpoint and no real credential are involved.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { withLab } from './host.ts'
import { here, logsOf, show } from './lab.ts'

const policy = (call: { toolName: string }) => (call.toolName === 'Bash' ? 'ask' : 'allow')
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '(missing)')

await withLab(
  'real',
  policy,
  async (lab) => {
    show('receive', await lab.send('please lint the project'))
    await lab.waitTurns(1)
    await Bun.sleep(4000)
    const tables = (await lab.tables()) as Record<string, any[]>
    const work = tables['sessions']![0]!.workspaceDir as string
    const cfg = tables['sessions']![0]!.configDir as string
    show('docker command (unmodified Kurumi args, real claude)', lab.spawns.map((a) => a.join(' ')))
    show('approval requests the human saw', lab.approvals.map((a) => ({ toolName: a.toolName, input: a.input })))
    show('host tables', tables)
    show('messages delivered to chat', lab.delivered.map((d) => ({ turnId: d.turnId, kind: d.kind, body: d.body })))
    show('bash.log written by the approved Bash call', read(join(work, '.attack', 'bash.log')))
    show('files left behind', {
      PLANTED_BY_BASH: read(join(work, 'PLANTED_BY_BASH.md')),
      BACKGROUND_PROCESS_WRITE: read(join(work, 'BACKGROUND_PROCESS_WRITE.txt')),
      cfg_planted: read(join(cfg, 'projects', '-work', 'planted-by-bash.jsonl')),
    })
    show('relay log', await logsOf('kp-gw'))
    show('fake upstream log (paths only)', (await logsOf('kp-upstream')).split('\n').map((l) => {
      try { const j = JSON.parse(l); return `${j.method} ${j.url} auth=${j.headers?.authorization ?? '-'}` } catch { return l }
    }))
  },
  ['real'],
  (work) => {
    mkdirSync(join(work, '.tools'), { recursive: true })
    copyFileSync(join(here, 'fakes', 'lint.sh'), join(work, '.tools', 'lint.sh'))
  },
)
process.exit(0)
