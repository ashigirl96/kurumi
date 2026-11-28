// The dev relay (src/real/dev-relay.ts, upstream pointed at a local echo) probed as an open proxy
// from inside a Kurumi container. This is the dev relay, not a gateway design.
import { canary, inKurumi, logsOf, show } from './lab.ts'

const tok = 'kurumi-fake-' + crypto.randomUUID()
const probes: [string, string][] = [
  ['R1 any path, any method (DELETE /v1/organizations/x) with a turn-shaped token', `DELETE /v1/organizations/x HTTP/1.1\r\nHost: kp-gw\r\nAuthorization: Bearer ${tok}\r\nConnection: close\r\n\r\n`],
  ['R2a token never registered, only the prefix matches', `GET /r2a HTTP/1.1\r\nHost: kp-gw\r\nAuthorization: Bearer kurumi-fake-x\r\nConnection: close\r\n\r\n`],
  ['R2b no token', `GET /r2b HTTP/1.1\r\nHost: kp-gw\r\nConnection: close\r\n\r\n`],
  ['R3 absolute-URI to another host', `GET http://kp-sink/r3-absolute HTTP/1.1\r\nHost: kp-sink\r\nAuthorization: Bearer ${tok}\r\nConnection: close\r\n\r\n`],
  ['R4 Host mismatch', `GET /r4-host HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer ${tok}\r\nConnection: close\r\n\r\n`],
  ['R5 CONNECT', `CONNECT kp-sink:80 HTTP/1.1\r\nHost: kp-sink:80\r\nAuthorization: Bearer ${tok}\r\n\r\n`],
  ['R6 scheme-relative and userinfo targets', `GET //kp-sink/r6-a HTTP/1.1\r\nHost: kp-gw\r\nAuthorization: Bearer ${tok}\r\nConnection: close\r\n\r\n`],
  ['R7 extra headers pass through (x-api-key, cookie, x-forwarded-host)', `GET /r7 HTTP/1.1\r\nHost: kp-gw\r\nAuthorization: Bearer ${tok}\r\nx-api-key: attacker-key\r\ncookie: a=b\r\nx-forwarded-host: kp-sink\r\nConnection: close\r\n\r\n`],
  ['R8 h2c prior knowledge', 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'],
  ['R9 dot-segments', `GET /v1/../../r9-dots HTTP/1.1\r\nHost: kp-gw\r\nAuthorization: Bearer ${tok}\r\nConnection: close\r\n\r\n`],
]

const script = probes
  .map(([name, req]) => `echo "=== ${name}"; bun /work/.attack/raw.ts kp-gw 8080 ${Buffer.from(req).toString('base64')}`)
  .join('; ')
const r = await inKurumi(script)
show('probe responses as seen inside the container', r.stdout + (r.stderr ? `\nstderr: ${r.stderr}` : ''))
show('canary visible inside the container', r.stdout.includes(canary))
show('relay log', await logsOf('kp-gw'))
show('fake upstream log (method url auth extra-headers)', (await logsOf('kp-upstream')).split('\n').filter((l) => /r[0-9]|organizations/.test(l)).map((l) => {
  const j = JSON.parse(l)
  return `${j.method} ${j.url} auth=${j.headers.authorization} host=${j.headers.host} x-api-key=${j.headers['x-api-key'] ?? '-'} cookie=${j.headers.cookie ?? '-'} xfh=${j.headers['x-forwarded-host'] ?? '-'}`
}))
show('sink log (should stay empty)', (await logsOf('kp-sink')).split('\n').filter((l) => !l.includes('listening')).join('\n') || '(empty)')
