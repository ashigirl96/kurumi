// Throwaway minimal Kurumi gateway, grown from packages/agent-runtime/src/real/dev-relay.ts.
// Adds: a per-turn token registry the host registers and revokes, a route allowlist (method + path
// pattern), a credential injected per route, and scrubbing of the credential bytes from responses.
export type Route = {
  readonly name: string
  readonly port: number
  readonly upstream: string
  readonly allow: readonly (readonly [method: string, path: RegExp])[]
  readonly credential: string
  readonly ca?: string
}

const forwardedHeaders = ['content-type', 'accept', 'user-agent', 'anthropic-version', 'anthropic-beta', 'x-github-api-version']
// The matcher sees the WHATWG-normalized path and the same string is forwarded; encoded separators
// would be decoded differently upstream, so they are refused.
const ambiguousPath = /%2f|%5c|%2e|\/\//i

const scrubber = (secret: string) => {
  let carry = ''
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      const text = (carry + Buffer.from(chunk).toString('latin1')).replaceAll(secret, '[REDACTED]')
      const keep = Math.min(secret.length - 1, text.length)
      carry = text.slice(text.length - keep)
      out.enqueue(Buffer.from(text.slice(0, text.length - keep), 'latin1'))
    },
    flush(out) {
      out.enqueue(Buffer.from(carry, 'latin1'))
    },
  })
}

export const startGateway = (routes: readonly Route[], hostname = '0.0.0.0', log = (e: object) => console.log(JSON.stringify(e))) => {
  const tokens = new Map<string, { turn: string; inflight: Set<AbortController> }>()
  const register = (token: string, turn: string) => void tokens.set(token, { turn, inflight: new Set() })
  const revoke = (token: string) => {
    const entry = tokens.get(token)
    tokens.delete(token)
    for (const c of entry?.inflight ?? []) c.abort()
  }
  const revokeAll = () => [...tokens.keys()].forEach(revoke)

  const handle = async (route: Route, req: Request) => {
    const url = new URL(req.url)
    const path = url.pathname
    const at = new Date().toISOString()
    const deny = (status: number, reason: string, turn?: string) => {
      log({ at, route: route.name, turn: turn ?? null, method: req.method, path, decision: 'deny', status, reason })
      return new Response(reason, { status })
    }
    const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? req.headers.get('x-api-key') ?? ''
    const entry = tokens.get(bearer)
    if (!entry) return deny(401, 'not a registered turn token')
    if (ambiguousPath.test(req.url.slice(url.origin.length).split("?")[0]!)) return deny(400, 'ambiguous path', entry.turn)
    if (!route.allow.some(([m, p]) => m === req.method && p.test(path))) return deny(403, 'route not allowed', entry.turn)

    const headers = new Headers()
    for (const name of forwardedHeaders) {
      const v = req.headers.get(name)
      if (v !== null) headers.set(name, v)
    }
    headers.set('authorization', `Bearer ${route.credential}`)
    const abort = new AbortController()
    entry.inflight.add(abort)
    try {
      const res = await fetch(`${route.upstream}${path}${url.search}`, {
        method: req.method,
        headers,
        body: req.body,
        redirect: 'manual',
        signal: abort.signal,
        duplex: 'half',
        ...(route.ca ? { tls: { ca: route.ca } } : {}),
      } as RequestInit)
      log({ at, route: route.name, turn: entry.turn, method: req.method, path, decision: 'allow', status: res.status })
      const out = new Headers()
      res.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'set-cookie'].includes(k)) out.set(k, v.replaceAll(route.credential, '[REDACTED]'))
      })
      const body = res.body?.pipeThrough(scrubber(route.credential))
      const cleanup = new TransformStream({ flush: () => void entry.inflight.delete(abort) })
      return new Response(body?.pipeThrough(cleanup) ?? null, { status: res.status, headers: out })
    } catch (error) {
      entry.inflight.delete(abort)
      log({ at, route: route.name, turn: entry.turn, method: req.method, path, decision: 'error', error: String(error) })
      return new Response('upstream error', { status: 502 })
    }
  }

  const servers = routes.map((route) => Bun.serve({ port: route.port, hostname, idleTimeout: 255, fetch: (req) => handle(route, req) }))
  return { register, revoke, revokeAll, stop: () => servers.forEach((s) => s.stop(true)) }
}

export const labRoutes = (env: Record<string, string | undefined>): Route[] => [
  {
    name: 'model',
    port: 8080,
    upstream: env['MODEL_UPSTREAM'] ?? 'http://model.test:9000',
    allow: [['POST', /^\/v1\/messages$/], ['POST', /^\/v1\/messages\/count_tokens$/]],
    credential: env['CANARY_MODEL'] ?? '',
  },
  {
    name: 'github',
    port: 8081,
    upstream: env['GH_UPSTREAM'] ?? 'https://api.github.test',
    allow: [['GET', /^\/repos\/a\/b\/[^/]+(\/\d+)?$/], ['GET', /^\/echo$/], ['GET', /^\/redirect$/], ['GET', /^\/slow$/]],
    credential: env['CANARY_GH'] ?? '',
    ...(env['GH_CA'] ? { ca: env['GH_CA'] } : {}),
  },
]

// Separate-container mode: the admin listener binds only the control network's address and needs a secret.
if (import.meta.main) {
  const env = { ...process.env, GH_CA: process.env['GH_CA_FILE'] ? await Bun.file(process.env['GH_CA_FILE']).text() : undefined }
  const adminSecret = process.env['ADMIN_SECRET'] ?? ''
  for (const k of ['CANARY_MODEL', 'CANARY_GH', 'ADMIN_SECRET']) delete process.env[k]
  if (adminSecret === '') throw new Error('ADMIN_SECRET is missing')
  const gw = startGateway(labRoutes(env))
  Bun.serve({
    port: 9901,
    hostname: process.env['ADMIN_HOST'] ?? '127.0.0.1',
    async fetch(req) {
      if (req.headers.get('authorization') !== `Bearer ${adminSecret}`) return new Response('no', { status: 401 })
      const p = new URL(req.url).pathname
      const j = req.method === 'POST' ? ((await req.json()) as { token?: string; turn?: string }) : {}
      if (p === '/register' && j.token && j.turn) gw.register(j.token, j.turn)
      else if (p === '/revoke' && j.token) gw.revoke(j.token)
      else if (p === '/revoke-all') gw.revokeAll()
      else return new Response('unknown', { status: 404 })
      console.log(JSON.stringify({ at: new Date().toISOString(), admin: p, turn: j.turn ?? null }))
      return new Response('ok')
    },
  })
  console.log('kurumi-gw listening')
}
