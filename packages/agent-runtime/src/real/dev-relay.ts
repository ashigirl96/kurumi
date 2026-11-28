// 開発用の中継。Credential Gateway の実装ではなく、ターンごとの偽トークンを本物に差し替えて api.anthropic.com へ流すだけ。
export const fakeTokenPrefix = 'kurumi-fake-'
export const relayPort = 8080

const upstream = 'https://api.anthropic.com'

export const startDevRelay = (realToken: string, port = relayPort) =>
  Bun.serve({
    port,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/healthz') return new Response('ok')
      const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
      if (!bearer.startsWith(fakeTokenPrefix)) {
        console.log(`${req.method} ${url.pathname} -> 401 not a turn token`)
        return new Response('unauthorized', { status: 401 })
      }
      const headers = new Headers(req.headers)
      headers.set('authorization', `Bearer ${realToken}`)
      for (const name of ['host', 'accept-encoding', 'connection']) headers.delete(name)
      try {
        const res = await fetch(`${upstream}${url.pathname}${url.search}`, {
          method: req.method,
          headers,
          body: req.body,
          redirect: 'manual',
          duplex: 'half',
        })
        console.log(`${req.method} ${url.pathname} -> ${res.status}`)
        const out = new Headers(res.headers)
        out.delete('content-encoding')
        out.delete('content-length')
        return new Response(res.body, { status: res.status, headers: out })
      } catch (error) {
        console.log(
          `${req.method} ${url.pathname} -> upstream error ${error instanceof Error ? error.name : 'unknown'}`,
        )
        return new Response('upstream error', { status: 502 })
      }
    },
  })

if (import.meta.main) {
  const token = process.env['CLAUDE_REAL_TOKEN']
  delete process.env['CLAUDE_REAL_TOKEN']
  if (!token) {
    console.error('CLAUDE_REAL_TOKEN is missing')
    process.exit(1)
  }
  startDevRelay(token)
  console.log(`relay listening on :${relayPort}`)
}
