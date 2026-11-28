// Inside a turn container: keep calling the gateway with this turn's token and log each status.
// bun loop.ts <url> <logfile> [token]   (token defaults to the turn's CLAUDE_CODE_OAUTH_TOKEN)
import { appendFileSync } from 'node:fs'

const [url = '', file = '/work/loop.log', token = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? ''] = process.argv.slice(2)
let first = true
for (;;) {
  const status = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) }).then(
    (r) => String(r.status),
    (e) => `ERR ${(e as Error).name}`,
  )
  appendFileSync(file, `${new Date().toISOString()} ${status}\n`)
  if (first && status === '200') {
    console.log('LOOP_READY')
    first = false
  }
  await Bun.sleep(250)
}
