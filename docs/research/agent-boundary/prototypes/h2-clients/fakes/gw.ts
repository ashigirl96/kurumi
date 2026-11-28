// Throwaway minimal base-URL gateway (shape C'): the container reaches it by name (api.gw, git.gw, ...),
// it checks the per-turn fake token, injects CANARY_REAL, forwards to one fixed https upstream per route,
// and captures every request body exactly as it forwards it. No CA in the client, no CONNECT.
// HOLD (JSON list of {host, method, path?}) holds matching requests for HOLD_SECONDS before forwarding.
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'

const canary = process.env['CANARY_REAL']!
const turnToken = process.env['TURN_TOKEN'] ?? 'kurumi-fake-turn1'
const out = process.env['OUT'] ?? '/out'
const certs = process.env['CERTS'] ?? '/certs'
const name = process.env['GW_NAME'] ?? 'gw'
const hold = JSON.parse(process.env['HOLD'] ?? '[]') as { host: string; method: string; path?: string }[]
const holdSeconds = Number(process.env['HOLD_SECONDS'] ?? '960')
const pubCa = readFileSync(`${certs}/pub-ca.crt`, 'utf8')

type Route = { upstream: string; inject?: string; token: boolean }
const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`
const routes: Record<string, Route> = {
  'api.gw': { upstream: 'api.github.com', inject: `Bearer ${canary}`, token: true },
  'graphql.gw': { upstream: 'api.github.com', inject: `Bearer ${canary}`, token: true },
  'git.gw': { upstream: 'github.com', inject: basic('x-access-token', canary), token: true },
  'npm.gw': { upstream: 'registry.npmjs.org', inject: `Bearer ${canary}`, token: true },
  'api.github.localhost': { upstream: 'api.github.com', inject: `Bearer ${canary}`, token: true },
  'pypi.gw': { upstream: 'pypi.org', token: true },
  // Same upstream, but the gateway rewrites the index's absolute file links to files.gw.
  'pypirw.gw': { upstream: 'pypi.org', token: true },
  // pip sends index credentials only to the index host, so the file host cannot demand the token.
  'files.gw': { upstream: 'files.pythonhosted.org', token: false },
  'mcp.gw': { upstream: 'mcp.example.com', inject: `Bearer ${canary}`, token: true },
  'model.gw': { upstream: 'api.anthropic.com', inject: `Bearer ${canary}`, token: true },
  'modelhold.gw': { upstream: 'api.anthropic.com', inject: `Bearer ${canary}`, token: true },
  // Reached through iron-proxy's tunnel listener in the hold run, so it sees no turn token.
  'holdup.example': { upstream: 'echo.example.com', inject: `Bearer ${canary}`, token: false },
  // WebFetch cannot add headers, so this route cannot demand the turn token.
  'docs.gw': { upstream: 'docs.example.com', token: false },
  'echo.gw': { upstream: 'echo.example.com', inject: `Bearer ${canary}`, token: true },
}

const presented = (h: Headers) => {
  const a = h.get('authorization') ?? ''
  if (a.startsWith('Bearer ')) return a.slice(7)
  if (a.startsWith('token ')) return a.slice(6)
  if (a.startsWith('Basic ')) return atob(a.slice(6)).split(':').slice(1).join(':')
  return ''
}
const log = (o: Record<string, unknown>) => appendFileSync(`${out}/${name}-capture.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
let seq = 0

async function handle(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
  const id = ++seq
  const t0 = Date.now()
  const url = new URL(req.url)
  const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '')
  const route = routes[host]
  const headersIn = Object.fromEntries([...req.headers].map(([k, v]) => [k, k === 'authorization' ? v.split(' ')[0] + ' <redacted>' : v]))
  const matchHold = hold.find((h) => h.host === host && h.method === req.method && (!h.path || (h.path.endsWith('$') ? url.pathname === h.path.slice(0, -1) : url.pathname.startsWith(h.path))))
  if (matchHold) server.timeout(req, 0)
  const raw = new Uint8Array(await req.arrayBuffer())
  const tokenOk = presented(req.headers) === turnToken
  const rec = { id, host, method: req.method, path: url.pathname + url.search, headers: headersIn, len: raw.length, sha256: sha(raw), tokenOk }
  if (!route) { log({ ...rec, verdict: 'no-route' }); return new Response('no route', { status: 404 }) }
  if (route.token && !tokenOk) {
    log({ ...rec, verdict: '401-no-turn-token' })
    return new Response('turn token required', { status: 401, headers: { 'www-authenticate': 'Basic realm="gw"' } })
  }
  log({ ...rec, verdict: 'forward', body_b64: raw.length <= 4 << 20 ? Buffer.from(raw).toString('base64') : null })
  if (matchHold) {
    let aborted = false
    req.signal.addEventListener('abort', () => { aborted = true; log({ id, event: 'client-abort', after_s: (Date.now() - t0) / 1000 }) })
    log({ id, event: 'hold-start', hold_s: holdSeconds })
    const end = Date.now() + holdSeconds * 1000
    while (!aborted && Date.now() < end) await Bun.sleep(1000)
    if (aborted) return new Response('client gone', { status: 499 })
    log({ id, event: 'hold-release', after_s: (Date.now() - t0) / 1000 })
  }
  const fwd = new Headers(req.headers)
  for (const h of ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'authorization']) fwd.delete(h)
  if (route.inject) fwd.set('authorization', route.inject)
  try {
    const res = await fetch(`https://${route.upstream}${url.pathname}${url.search}`, {
      method: req.method, headers: fwd, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
      redirect: 'manual', tls: { ca: pubCa },
    } as RequestInit)
    const outH = new Headers(res.headers)
    outH.delete('content-encoding'); outH.delete('content-length')
    let body: BodyInit | null = res.body
    if (host === 'pypirw.gw' && (res.headers.get('content-type') ?? '').includes('text/html')) {
      body = (await res.text()).replaceAll('https://files.pythonhosted.org/', 'http://files.gw/')
    }
    if (matchHold) log({ id, event: 'upstream-status', status: res.status, after_s: (Date.now() - t0) / 1000 })
    return new Response(body, { status: res.status, headers: outH })
  } catch (e) {
    log({ id, event: 'upstream-error', error: String(e) })
    return new Response('upstream error', { status: 502 })
  }
}

const s1 = Bun.serve({ port: 80, idleTimeout: 255, fetch: (req, srv) => handle(req, srv) })
const s2 = Bun.serve({
  port: 443, idleTimeout: 255,
  tls: { cert: Bun.file(`${certs}/gw.crt`), key: Bun.file(`${certs}/gw.key`) },
  fetch: (req, srv) => handle(req, srv),
})
console.log(`${name} listening on :80 and :443 (hold=${JSON.stringify(hold)} ${holdSeconds}s)`, !!s1 && !!s2)
