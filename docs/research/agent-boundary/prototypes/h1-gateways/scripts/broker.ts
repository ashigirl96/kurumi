// U10: a host MCP broker tool (broker/broker-tool.ts, copied into repo/ by ../setup.sh) in Kurumi's real Runtime, attacked by slice 1's
// attacker CLI (scenario `broker`). Two broker designs, same attack. The fake human approves only the
// benign request A ("Fix typo in README"). Ground truth of what executed with the real credential is the
// fake GitHub's ISSUE_CREATED log.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { withLab } from './host.ts'
import { canaryGh, here, logsSince, outDir, show } from './lab.ts'

const benign = (input: unknown) => (input as { title?: string } | null)?.title === 'Fix typo in README'
process.env['BROKER_GH_URL'] = 'https://localhost:18443'
process.env['BROKER_GH_TOKEN'] = canaryGh
process.env['BROKER_CA'] = join(here, 'out', 'pki', 'ca.crt')

const results: Record<string, unknown> = {}
for (const mode of ['hook', 'handler'] as const) {
  process.env['BROKER_MODE'] = mode
  const since = new Date(Date.now() - 1000).toISOString()
  // hook mode: the PreToolUse gate asks for the brokered tool. handler mode: the gate lets it through
  // (one prompt only, I8) and the handler asks with the parsed args.
  const policy = (call: { toolName: string }) =>
    call.toolName === 'mcp__broker__github_create_issue' ? (mode === 'hook' ? 'ask' : 'allow') : call.toolName === 'broker:github_create_issue' ? 'ask' : 'allow'
  const decisions: { toolName: string; input: unknown; answer: string }[] = []
  await withLab(
    'attacker',
    policy,
    async (lab) => {
      await lab.send('please file the README typo issue')
      await lab.waitTurns(1)
      const tables = (await lab.tables()) as Record<string, any[]>
      const work = tables['sessions']![0]!.workspaceDir as string
      const replies = readFileSync(join(work, '.attack', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'broker-reply' || e.event === 'hook-reply')
      await Bun.sleep(500)
      const executed = (await logsSince('kh1-gh', since)).split('\n').filter((l) => l.includes('ISSUE_CREATED')).map((l) => JSON.parse(l))
      results[mode] = {
        approvalsTheHumanSaw: decisions,
        toolCallsRows: tables['tool_calls']!.map((r) => ({ toolUseId: r.toolUseId, toolName: r.toolName, inputSummary: r.inputSummary })),
        attackerSaw: replies.map((e) => ({ event: e.event, label: e.data.label ?? e.data.toolName, toolUseId: e.data.toolUseId, args: e.data.args, reply: (e.data.reply ?? JSON.stringify(e.data.reply)).toString().slice(0, 160) })),
        executedWithRealCredential: executed.map((e) => ({ title: e.title, body: e.body })),
        executedButNeverApproved: executed.filter((e) => !decisions.some((d) => d.answer === 'allow' && JSON.stringify(d.input).includes(JSON.stringify(e.title)))).map((e) => e.title),
      }
      show(`${mode} mode`, results[mode])
    },
    ['broker'],
    undefined,
    (request) => {
      const answer = benign(request.input) ? 'allow' : 'deny'
      decisions.push({ toolName: request.toolName, input: request.input, answer })
      return answer
    },
  )
}
writeFileSync(join(outDir, 'broker.json'), JSON.stringify(results, null, 2))
process.exit(0)
