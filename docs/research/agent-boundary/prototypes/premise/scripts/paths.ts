// Cheap egress-path probes from inside a container with Kurumi's real docker args (Mac only).
import { networkInterfaces } from 'node:os'

import { exec, inKurumi, show } from './lab.ts'

const listener = Bun.serve({ port: 0, hostname: '0.0.0.0', fetch: () => new Response('host') })
const port = listener.port
const lan = Object.values(networkInterfaces()).flat().flatMap((i) => (i && i.family === 'IPv4' && !i.internal ? [i.address] : []))
const internalGw = (await exec(['docker', 'network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}', 'kp-internal'])).stdout
const upstreamIp = (await exec(['docker', 'inspect', '--format', '{{(index .NetworkSettings.Networks "kp-ext").IPAddress}}', 'kp-upstream'])).stdout

const targets: [string, string, number][] = [
  ['relay (expected open)', 'kp-gw', 8080],
  ['relay other port', 'kp-gw', 22],
  ['fake upstream by name (not on the internal network)', 'kp-upstream', 9000],
  ['fake upstream by IP', upstreamIp, 9000],
  ['exfil sink by IP', '10.250.77.80', 80],
  ['internet IP', '1.1.1.1', 443],
  ['host.docker.internal (host listener)', 'host.docker.internal', port],
  ['Docker Desktop host gateway 192.168.65.254', '192.168.65.254', port],
  ['internal network gateway IP', internalGw, port],
  ...lan.map((ip): [string, string, number] => [`Mac interface IP (LAN, Tailscale; redacted)`, ip, port]),
  ['cloud metadata', '169.254.169.254', 80],
]

const tcp = targets
  .map(([name, host, p]) => `if timeout 3 bash -c 'exec 3<>/dev/tcp/${host}/${p}' 2>/dev/null; then r=CONNECTED; else r=blocked; fi; echo "${name} ${host}:${p} -> $r"`)
  .join('; ')
const local = [
  'echo "--- docker socket"; ls -la /var/run/docker.sock /run/docker.sock 2>&1',
  'echo "--- routes"; cat /proc/net/route | awk \'NR>1{print $1, $2, $3}\'',
  'echo "--- ipv6 addrs"; cat /proc/net/if_inet6 2>&1; echo "--- ipv6 routes"; cat /proc/net/ipv6_route 2>&1 | head -5',
  'echo "--- interfaces"; ls /sys/class/net',
  'echo "--- canary grep over env, /proc/*/environ, /cfg, /work"; (env; cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n") | grep -c CANARY_REAL; grep -rl CANARY_REAL /cfg /work 2>/dev/null | grep -v "/.attack/" ; echo done',
].join('; ')

const r = await inKurumi(`${tcp}; ${local}`)
listener.stop(true)
const redact = (s: string) => lan.reduce((t, ip, i) => t.replaceAll(ip, `<host-ip-${i}>`), s)
show('egress probes from inside the container (Mac only)', redact(r.stdout) + (r.stderr ? `\nstderr: ${r.stderr}` : ''))
