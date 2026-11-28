// Fake GitHub-like HTTPS API. Requires `Bearer <CANARY_GH>` on the API paths. Also serves an echo
// (/echo, /echo?enc=b64), a redirect (/redirect?to=URL) and a slow stream (/slow). Logs every request,
// with the body's length and sha256 so truncation is visible.
import { createHash } from 'node:crypto'

const canary = process.env['CANARY_GH'] ?? ''
const issues: { number: number; title: string; body: string }[] = []

const authed = (req: Request) => req.headers.get('authorization') === `Bearer ${canary}`

Bun.serve({
  port: Number(process.env['PORT'] ?? 443),
  idleTimeout: 255,
  tls: { cert: Bun.file('/pki/api.crt'), key: Bun.file('/pki/api.key') },
  async fetch(req) {
    const url = new URL(req.url)
    const raw = new Uint8Array(await req.arrayBuffer())
    const body = new TextDecoder().decode(raw)
    const headers = Object.fromEntries(req.headers)
    console.log(JSON.stringify({
      at: new Date().toISOString(), method: req.method, url: req.url, headers,
      bodyLen: raw.length, bodyTail: body.slice(-70), bodySha256: createHash('sha256').update(raw).digest('hex').slice(0, 16), body: body.slice(0, 600),
    }))
    const p = url.pathname
    if (p.startsWith('/echo')) {
      const echo = JSON.stringify({ method: req.method, url: req.url, headers, bodyLen: raw.length })
      return url.searchParams.get('enc') === 'b64' ? new Response(Buffer.from(echo).toString('base64')) : new Response(echo)
    }
    if (p === '/redirect') return new Response(null, { status: 302, headers: { location: url.searchParams.get('to') ?? '/' } })
    if (p === '/slow') {
      let i = 0
      return new Response(new ReadableStream({
        async pull(c) {
          if (i++ >= 10) return c.close()
          await Bun.sleep(500)
          c.enqueue(new TextEncoder().encode(`chunk ${i} at ${new Date().toISOString()}\n`))
        },
      }))
    }
    if (!authed(req)) return Response.json({ message: 'Bad credentials' }, { status: 401 })
    if (p === '/user') return Response.json({ login: 'canary-user' })
    if (p === '/repos/a/b/issues' && req.method === 'GET') return Response.json(issues)
    if (p === '/repos/a/b/issues' && req.method === 'POST') {
      const j = JSON.parse(body || '{}') as { title?: string; body?: string }
      const issue = { number: issues.length + 1, title: j.title ?? '', body: j.body ?? '' }
      issues.push(issue)
      console.log(JSON.stringify({ event: 'ISSUE_CREATED', ...issue }))
      return Response.json(issue, { status: 201 })
    }
    if (p === '/graphql' && req.method === 'POST') {
      const j = JSON.parse(body || '{}') as { query?: string; variables?: Record<string, unknown> }
      if ((j.query ?? '').includes('mutation')) console.log(JSON.stringify({ event: 'GRAPHQL_MUTATION', variables: j.variables }))
      return Response.json({ data: { ok: true } })
    }
    if (p === '/gists' && req.method === 'POST') {
      console.log(JSON.stringify({ event: 'GIST_CREATED', bodyLen: raw.length }))
      return Response.json({ id: 'g1' }, { status: 201 })
    }
    return Response.json({ message: 'Not Found' }, { status: 404 })
  },
})
console.log('fake github listening')
