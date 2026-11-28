// Does Docker's embedded DNS on an --internal network forward outside names upstream?
// Upstream is pinned to a fake resolver we control (--dns), so its log settles forwarding.
import { exec, inKurumi, logsOf, show } from './lab.ts'

const dnsIp = '10.250.77.53'
const tag = crypto.randomUUID().slice(0, 8)
const q = (server: string, name: string) => `bun /work/.attack/dnsq.ts ${server} ${name}`

show('docker', (await exec(['docker', 'version', '--format', 'server={{.Server.Version}} os={{.Server.Os}}/{{.Server.Arch}}'])).stdout)

const d1 = await inKurumi(
  `cat /etc/resolv.conf | grep -v '^#'; ${q('127.0.0.11', 'kp-gw')}; ${q('127.0.0.11', `d1-${tag}.exfil.test`)}; getent hosts example.com; echo getent=$?`,
)
show('D1 Kurumi args (internal, default DNS): resolv.conf, in-network name, outside name', d1)

const d2 = await inKurumi(
  `${q('127.0.0.11', `d2-${tag}.exfil.test`)}; ${q('127.0.0.11', `d2b-${tag}.example.com`)}`,
  {},
  ['--dns', dnsIp],
)
show(`D2 Kurumi args + --dns ${dnsIp} (internal): outside names via embedded DNS`, d2)

const d3 = await inKurumi(`${q('127.0.0.11', `d3-${tag}.exfil.test`)}`, { network: 'kp-ext' }, ['--dns', dnsIp])
show(`D3 positive control: same args on non-internal kp-ext + --dns ${dnsIp}`, d3)

const d4 = await inKurumi(`${q(dnsIp, `d4-${tag}.exfil.test`)}`)
show(`D4 Kurumi args (internal): query the fake resolver ${dnsIp} directly`, d4)

await Bun.sleep(500)
const log = (await logsOf('kp-dns')).split('\n').filter((l) => l.includes(tag))
show(`fake resolver log lines containing tag ${tag}`, log.length === 0 ? '(none)' : log.join('\n'))
const seen = (p: string) => log.some((l) => l.includes(`${p}-${tag}`))
show('verdict', {
  d1_forwarded: seen('d1'),
  d2_forwarded_with_dns_flag: seen('d2') || seen('d2b'),
  d3_control_forwarded: seen('d3'),
  d4_direct_reached: seen('d4'),
})
